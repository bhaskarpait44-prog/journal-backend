import express from 'express';
import { Op } from 'sequelize';
import Trade from '../models/Trade.js';
import User from '../models/User.js';
import sequelize from '../lib/sequelize.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

function parseDateBoundary(value, boundary) {
  if (!value) return null;
  const s = value.toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const time = boundary === 'end' ? '23:59:59.999' : '00:00:00.000';
    return new Date(`${s}T${time}`);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  if (boundary === 'end') d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

// ── GET /api/analytics/summary ────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { from, to, strategy } = req.query;
    const where = { userId: req.user.id, status: { [Op.in]: ['CLOSED', 'EXPIRED'] } };
    
    const fromDate = parseDateBoundary(from, 'start');
    const toDate   = parseDateBoundary(to, 'end');
    if (fromDate || toDate) {
      where.exitDate = {};
      if (fromDate) where.exitDate[Op.gte] = fromDate;
      if (toDate)   where.exitDate[Op.lte] = toDate;
    }
    if (strategy) {
      where.strategy = strategy;
    }

    const openTradesWhere = { userId: req.user.id, status: 'OPEN' };
    if (strategy) openTradesWhere.strategy = strategy;
    const openTrades = await Trade.count({ where: openTradesWhere });

    const [aggResult] = await Trade.findAll({
      where,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
        [sequelize.fn('SUM', sequelize.literal('CASE WHEN "netPnl" > 0 THEN 1 ELSE 0 END')), 'winners'],
        [sequelize.fn('SUM', sequelize.col('netPnl')), 'totalPnl'],
        [sequelize.fn('SUM', sequelize.col('charges')), 'totalCharges'],
        [sequelize.fn('MAX', sequelize.col('netPnl')), 'maxWin'],
        [sequelize.fn('MIN', sequelize.col('netPnl')), 'maxLoss'],
        [sequelize.fn('AVG', sequelize.col('netPnl')), 'avgPnl'],
      ],
      raw: true
    });

    const trades = await Trade.findAll({
      where,
      attributes: ['netPnl', 'exchange', 'charges', 'pnl'],
      order: [['exitDate', 'ASC'], ['entryDate', 'ASC']],
      raw: true
    });

    const winners    = trades.filter(t => (t.netPnl || 0) > 0);
    const losers     = trades.filter(t => (t.netPnl || 0) < 0);
    const grossProfit = winners.reduce((s,t) => s + (t.netPnl || 0), 0);
    const grossLoss   = losers.reduce((s,t) => s + Math.abs(t.netPnl || 0), 0);

    const totalPnl   = parseFloat(aggResult.totalPnl || 0);
    const totalCharges = parseFloat(aggResult.totalCharges || 0);
    const avgWin     = winners.length ? grossProfit / winners.length : 0;
    const avgLoss    = losers.length  ? grossLoss / losers.length  : 0;
    
    // Profit Factor = Total Gross Profit / Total Gross Loss
    let profitFactor = 0;
    if (grossLoss > 0) {
      profitFactor = parseFloat((grossProfit / grossLoss).toFixed(2));
    } else if (grossProfit > 0) {
      profitFactor = 999;
    }

    // Payoff Ratio (Win / Loss ratio) = avgWin / avgLoss
    const payoffRatio = avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : (avgWin > 0 ? 999 : 0);

    const nseCharges   = trades.filter(t => (t.exchange||'NSE') === 'NSE').reduce((s,t) => s + (t.charges||0), 0);
    const bseCharges   = trades.filter(t => t.exchange === 'BSE').reduce((s,t) => s + (t.charges||0), 0);
    const nseTrades    = trades.filter(t => (t.exchange||'NSE') === 'NSE').length;
    const bseTrades    = trades.filter(t => t.exchange === 'BSE').length;

    // ── Streaks & Drawdown ───────────────────────────────────────────────────
    let curWin = 0, curLoss = 0, maxWinStreak = 0, maxLossStreak = 0;
    let curWinPnl = 0, bestStreakPnl = 0, curLossPnl = 0, worstStreakPnl = 0;
    
    let peak = 0, runningPnl = 0, maxDD = 0;

    trades.forEach(t => {
      const pnl = t.netPnl || 0;
      runningPnl += pnl;
      if (runningPnl > peak) peak = runningPnl;
      const dd = peak - runningPnl;
      if (dd > maxDD) maxDD = dd;

      if (pnl > 0) {
        curWin++; curLoss = 0; curLossPnl = 0; curWinPnl += pnl;
        if (curWin > maxWinStreak) { maxWinStreak = curWin; bestStreakPnl = curWinPnl; }
      } else if (pnl < 0) {
        curLoss++; curWin = 0; curWinPnl = 0; curLossPnl += pnl;
        if (curLoss > maxLossStreak) { maxLossStreak = curLoss; worstStreakPnl = curLossPnl; }
      }
    });

    const totalCount = parseInt(aggResult.total || 0);
    const winRate = totalCount ? (winners.length / totalCount) : 0;
    const lossRate = totalCount ? (losers.length / totalCount) : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);

    // Kelly % clamped between 0 and 100%
    let kellyPct = 0;
    if (payoffRatio > 0 && winRate > 0 && payoffRatio !== 999) {
      const rawKelly = winRate - ((1 - winRate) / payoffRatio);
      kellyPct = Math.max(0, Math.min(1, rawKelly));
    }

    const recoveryFactor = maxDD > 0 ? (totalPnl / maxDD) : 0;

    let currentStreak = 0, currentStreakType = 'none', currentStreakPnl = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      const pnl  = trades[i].netPnl || 0;
      if (pnl === 0) continue; 
      const type = pnl > 0 ? 'win' : 'loss';
      if (currentStreak === 0) { currentStreakType = type; currentStreak = 1; currentStreakPnl = pnl; }
      else if (type === currentStreakType) { currentStreak++; currentStreakPnl += pnl; }
      else break;
    }

    res.json({
      totalTrades: totalCount, openTrades, 
      winners: parseInt(aggResult.winners || 0), 
      losers: totalCount - parseInt(aggResult.winners || 0),
      totalPnl: parseFloat(totalPnl.toFixed(2)), 
      totalCharges: parseFloat(totalCharges.toFixed(2)), 
      nseCharges: parseFloat(nseCharges.toFixed(2)), 
      bseCharges: parseFloat(bseCharges.toFixed(2)), 
      nseTrades, bseTrades,
      grossPnl: parseFloat(trades.reduce((s,t) => s + (t.pnl||0), 0).toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)), 
      avgLoss: parseFloat(avgLoss.toFixed(2)), 
      winRate: parseFloat((winRate * 100).toFixed(1)),
      profitFactor: profitFactor === 999 ? null : parseFloat(profitFactor.toFixed(2)),
      payoffRatio: payoffRatio === 999 ? null : parseFloat(payoffRatio.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      kellyPct: parseFloat((kellyPct * 100).toFixed(1)),
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      recoveryFactor: parseFloat(recoveryFactor.toFixed(2)),
      maxWin:  parseFloat(Number(aggResult.maxWin || 0).toFixed(2)),
      maxLoss: parseFloat(Number(aggResult.maxLoss || 0).toFixed(2)),
      bestTrade: parseFloat(Number(aggResult.maxWin || 0).toFixed(2)),
      worstTrade: parseFloat(Number(aggResult.maxLoss || 0).toFixed(2)),
      streaks: {
        currentStreak, currentStreakType,
        currentStreakPnl: parseFloat(currentStreakPnl.toFixed(2)),
        maxWinStreak,  bestStreakPnl:  parseFloat(bestStreakPnl.toFixed(2)),
        maxLossStreak, worstStreakPnl: parseFloat(worstStreakPnl.toFixed(2)),
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/pnl-chart', async (req, res) => {
  try {
    const { days = 30, from: fromQ, to: toQ, strategy } = req.query;
    const fromDate = parseDateBoundary(fromQ, 'start') || (() => { const d = new Date(); d.setDate(d.getDate() - Number(days)); d.setHours(0,0,0,0); return d; })();
    const toDate   = parseDateBoundary(toQ, 'end') || new Date();

    const where = {
      userId: req.user.id,
      status: { [Op.in]: ['CLOSED', 'EXPIRED'] },
      exitDate: { [Op.gte]: fromDate, [Op.lte]: toDate }
    };
    if (strategy) where.strategy = strategy;

    const trades = await Trade.findAll({
      where,
      order: [['exitDate', 'ASC']]
    });
    const dailyMap = {};
    trades.forEach(t => {
      const date = t.exitDate.toISOString().split('T')[0];
      if (!dailyMap[date]) dailyMap[date] = { date, pnl: 0, trades: 0 };
      dailyMap[date].pnl    += t.netPnl || 0;
      dailyMap[date].trades += 1;
    });
    let cumulative = 0;
    let peak = 0;
    const chartData = Object.values(dailyMap).map(d => { 
      cumulative += d.pnl; 
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      return { ...d, cumulative, drawdown: parseFloat(drawdown.toFixed(2)) }; 
    });
    res.json({ chartData });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/by-symbol', async (req, res) => {
  try {
    const { strategy, from, to } = req.query;
    const where = { userId: req.user.id, status: { [Op.in]: ['CLOSED', 'EXPIRED'] } };
    const fromDate = parseDateBoundary(from, 'start');
    const toDate   = parseDateBoundary(to, 'end');
    if (fromDate || toDate) {
      where.exitDate = {};
      if (fromDate) where.exitDate[Op.gte] = fromDate;
      if (toDate)   where.exitDate[Op.lte] = toDate;
    }
    if (strategy) where.strategy = strategy;

    const data = await Trade.findAll({
      where,
      attributes: [
        ['underlying', '_id'],
        [sequelize.fn('count', sequelize.col('id')), 'totalTrades'],
        [sequelize.fn('sum', sequelize.col('netPnl')), 'totalPnl'],
        [sequelize.fn('sum', sequelize.literal('CASE WHEN "netPnl" > 0 THEN 1 ELSE 0 END')), 'wins']
      ],
      group: ['underlying'],
      order: [[sequelize.literal('"totalPnl"'), 'DESC']],
      limit: 10,
      raw: true
    });
    const formatted = data.map(d => ({
      ...d,
      totalTrades: parseInt(d.totalTrades),
      totalPnl: parseFloat(d.totalPnl),
      wins: parseInt(d.wins)
    }));
    res.json({ data: formatted });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/by-strategy', async (req, res) => {
  try {
    const { strategy, from, to } = req.query;
    const where = {
      userId: req.user.id,
      status: { [Op.in]: ['CLOSED', 'EXPIRED'] },
      strategy: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] }
    };
    const fromDate = parseDateBoundary(from, 'start');
    const toDate   = parseDateBoundary(to, 'end');
    if (fromDate || toDate) {
      where.exitDate = {};
      if (fromDate) where.exitDate[Op.gte] = fromDate;
      if (toDate)   where.exitDate[Op.lte] = toDate;
    }
    if (strategy) where.strategy = strategy;

    const trades = await Trade.findAll({
      where,
      order: [['exitDate', 'ASC'], ['entryDate', 'ASC']],
      raw: true
    });

    const stats = {};
    trades.forEach(t => {
      const s = t.strategy;
      if (!stats[s]) {
        stats[s] = {
          _id: s,
          totalTrades: 0,
          totalPnl: 0,
          wins: 0,
          grossWin: 0,
          grossLoss: 0,
          peak: 0,
          runningPnl: 0,
          maxDD: 0,
          totalHoldMins: 0,
          holdCount: 0,
          plannedRRSum: 0,
          plannedRRCount: 0,
          actualRRSum: 0,
          actualRRCount: 0
        };
      }
      const st = stats[s];
      const pnl = t.netPnl || 0;
      st.totalTrades++;
      st.totalPnl += pnl;
      st.runningPnl += pnl;
      if (st.runningPnl > st.peak) st.peak = st.runningPnl;
      const dd = st.peak - st.runningPnl;
      if (dd > st.maxDD) st.maxDD = dd;

      if (pnl > 0) {
        st.wins++;
        st.grossWin += pnl;
      } else if (pnl < 0) {
        st.grossLoss += Math.abs(pnl);
      }

      if (t.entryDate && t.exitDate) {
        const start = new Date(t.entryDate);
        const end = new Date(t.exitDate);
        const diffMs = end - start;
        const diffDays = Math.floor(diffMs / 86400000);
        const mins = diffDays === 0 ? (diffMs / 60000) : (diffDays * 375);
        st.totalHoldMins += mins;
        st.holdCount++;
      }

      if (t.stopLoss && t.target && t.entryPrice) {
        const risk = Math.abs(t.entryPrice - t.stopLoss);
        const reward = Math.abs(t.target - t.entryPrice);
        if (risk > 0) {
          st.plannedRRSum += (reward / risk);
          st.plannedRRCount++;
        }
      }
      if (t.stopLoss && t.entryPrice) {
        const risk = Math.abs(t.entryPrice - t.stopLoss);
        const exit = t.status === 'EXPIRED' ? 0 : (t.exitPrice || 0);
        const actualReward = (t.tradeType === 'BUY' ? 1 : -1) * (exit - t.entryPrice);
        if (risk > 0) {
          st.actualRRSum += (actualReward / risk);
          st.actualRRCount++;
        }
      }
    });

    const formatted = Object.values(stats).map(s => {
      const avgWin = s.wins > 0 ? s.grossWin / s.wins : 0;
      const losses = s.totalTrades - s.wins;
      const avgLoss = losses > 0 ? s.grossLoss / losses : 0;
      
      return {
        _id: s._id,
        totalTrades: s.totalTrades,
        totalPnl: parseFloat(s.totalPnl.toFixed(2)),
        wins: s.wins,
        winRate: parseFloat(((s.wins / s.totalTrades) * 100).toFixed(1)),
        avgWin: parseFloat(avgWin.toFixed(2)),
        avgLoss: parseFloat(avgLoss.toFixed(2)),
        profitFactor: s.grossLoss > 0 ? parseFloat((s.grossWin / s.grossLoss).toFixed(2)) : (s.grossWin > 0 ? null : 0),
        maxDrawdown: parseFloat(s.maxDD.toFixed(2)),
        avgHoldTime: s.holdCount > 0 ? Math.round(s.totalHoldMins / s.holdCount) : 0,
        plannedRR: s.plannedRRCount > 0 ? parseFloat((s.plannedRRSum / s.plannedRRCount).toFixed(2)) : 0,
        actualRR: s.actualRRCount > 0 ? parseFloat((s.actualRRSum / s.actualRRCount).toFixed(2)) : 0
      };
    }).sort((a, b) => b.totalPnl - a.totalPnl);

    res.json({ data: formatted });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/psychology', async (req, res) => {
  try {
    const { from, to, strategy } = req.query;
    const where = {
      userId: req.user.id,
      status: { [Op.in]: ['CLOSED', 'EXPIRED'] },
    };
    const fromDate = parseDateBoundary(from, 'start');
    const toDate   = parseDateBoundary(to, 'end');
    if (fromDate || toDate) {
      where.exitDate = {};
      if (fromDate) where.exitDate[Op.gte] = fromDate;
      if (toDate)   where.exitDate[Op.lte] = toDate;
    }
    if (strategy) where.strategy = strategy;

    const trades = await Trade.findAll({ 
      where,
      order: [['exitDate', 'ASC'], ['entryDate', 'ASC']]
    });
    
    const totalTradesInPeriod = trades.length;

    const loggedTrades = trades.filter(t => t.psychology && (
      (t.psychology.emotionBefore && t.psychology.emotionBefore.trim() !== '') ||
      (t.psychology.emotionAfter && t.psychology.emotionAfter.trim() !== '') ||
      (t.psychology.disciplineRating != null && !isNaN(Number(t.psychology.disciplineRating))) ||
      t.psychology.followedPlan != null ||
      (Array.isArray(t.psychology.mistakeTags) && t.psychology.mistakeTags.length > 0)
    ));

    if (!loggedTrades.length) {
      return res.json({ 
        totalLogged: 0, 
        totalTradesInPeriod,
        avgDiscipline: 0, 
        followedPlanRate: 0, 
        revengeTrades: 0, 
        revengeTradeLoss: 0, 
        fomoTrades: 0, 
        overtradingCount: 0, 
        mostCommonMistake: null, 
        planPerformance: { 
          followed: { total: 0, avg: 0, count: 0, winRate: 0 }, 
          deviated: { total: 0, avg: 0, count: 0, winRate: 0 } 
        },
        totalDeviationCost: 0,
        postLossPerformance: { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
        postWinPerformance: { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
        emotionWinRate: [], 
        mistakeFrequency: [], 
        lossByEmotion: [],
        dayOfWeekPsych: [],
        disciplineTrend: 'flat'
      });
    }

    const withDisc = loggedTrades.filter(t => t.psychology?.disciplineRating != null && !isNaN(Number(t.psychology.disciplineRating)));
    const avgDiscipline = withDisc.length 
      ? parseFloat((withDisc.reduce((s,t) => s + Number(t.psychology.disciplineRating), 0) / withDisc.length).toFixed(1)) 
      : 0;
    
    const withPlan = loggedTrades.filter(t => t.psychology?.followedPlan != null);
    const followedPlanCount = withPlan.filter(t => Boolean(t.psychology.followedPlan)).length;
    const followedPlanRate = withPlan.length 
      ? parseFloat(((followedPlanCount / withPlan.length) * 100).toFixed(1)) 
      : 0;

    const planPerformance = {
      followed: { total: 0, avg: 0, count: 0, wins: 0, winRate: 0 },
      deviated: { total: 0, avg: 0, count: 0, wins: 0, winRate: 0 }
    };
    withPlan.forEach(t => {
      const isFollowed = Boolean(t.psychology.followedPlan);
      const cohort = isFollowed ? planPerformance.followed : planPerformance.deviated;
      const pnl = Number(t.netPnl) || 0;
      cohort.total += pnl;
      cohort.count++;
      if (pnl > 0) cohort.wins++;
    });
    if (planPerformance.followed.count) {
      planPerformance.followed.avg = parseFloat((planPerformance.followed.total / planPerformance.followed.count).toFixed(2));
      planPerformance.followed.total = parseFloat(planPerformance.followed.total.toFixed(2));
      planPerformance.followed.winRate = parseFloat(((planPerformance.followed.wins / planPerformance.followed.count) * 100).toFixed(1));
    }
    if (planPerformance.deviated.count) {
      planPerformance.deviated.avg = parseFloat((planPerformance.deviated.total / planPerformance.deviated.count).toFixed(2));
      planPerformance.deviated.total = parseFloat(planPerformance.deviated.total.toFixed(2));
      planPerformance.deviated.winRate = parseFloat(((planPerformance.deviated.wins / planPerformance.deviated.count) * 100).toFixed(1));
    }

    const deviationPenaltyPerTrade = (planPerformance.followed.avg > planPerformance.deviated.avg)
      ? parseFloat((planPerformance.followed.avg - planPerformance.deviated.avg).toFixed(2))
      : 0;
    const totalDeviationCost = parseFloat((deviationPenaltyPerTrade * planPerformance.deviated.count).toFixed(2));

    const settledTrades = trades.filter(t => t.status !== 'OPEN');
    let postLossCount = 0, postLossWins = 0, postLossPnl = 0;
    let postWinCount = 0, postWinWins = 0, postWinPnl = 0;
    for (let i = 1; i < settledTrades.length; i++) {
      const prev = settledTrades[i-1];
      const curr = settledTrades[i];
      const prevPnl = Number(prev.netPnl) || 0;
      const currPnl = Number(curr.netPnl) || 0;
      if (prevPnl < 0) {
        postLossCount++;
        postLossPnl += currPnl;
        if (currPnl > 0) postLossWins++;
      } else if (prevPnl > 0) {
        postWinCount++;
        postWinPnl += currPnl;
        if (currPnl > 0) postWinWins++;
      }
    }
    const postLossPerformance = {
      count: postLossCount,
      winRate: postLossCount ? parseFloat(((postLossWins / postLossCount) * 100).toFixed(1)) : 0,
      avgPnl: postLossCount ? parseFloat((postLossPnl / postLossCount).toFixed(2)) : 0,
      totalPnl: parseFloat(postLossPnl.toFixed(2))
    };
    const postWinPerformance = {
      count: postWinCount,
      winRate: postWinCount ? parseFloat(((postWinWins / postWinCount) * 100).toFixed(1)) : 0,
      avgPnl: postWinCount ? parseFloat((postWinPnl / postWinCount).toFixed(2)) : 0,
      totalPnl: parseFloat(postWinPnl.toFixed(2))
    };

    const dayPsych = {};
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    loggedTrades.forEach(t => {
      const dateVal = t.exitDate || t.entryDate;
      if (!dateVal) return;
      const day = DAYS[new Date(dateVal).getDay()];
      if (!dayPsych[day]) dayPsych[day] = { disciplineSum: 0, count: 0, negativeEmotions: 0, pnl: 0 };
      const dp = dayPsych[day];
      if (t.psychology?.disciplineRating != null && !isNaN(Number(t.psychology.disciplineRating))) {
        dp.disciplineSum += Number(t.psychology.disciplineRating);
      }
      dp.count++;
      dp.pnl += Number(t.netPnl) || 0;
      if (['fearful', 'frustrated', 'revenge'].includes(t.psychology?.emotionBefore)) {
        dp.negativeEmotions++;
      }
    });
    const dayOfWeekPsych = Object.entries(dayPsych).map(([day, d]) => ({
      day,
      count: d.count,
      avgDiscipline: d.count ? parseFloat((d.disciplineSum / d.count).toFixed(1)) : 0,
      negativeRatio: d.count ? parseFloat(((d.negativeEmotions / d.count) * 100).toFixed(1)) : 0,
      pnl: parseFloat(d.pnl.toFixed(2))
    }));

    let disciplineTrend = 'flat';
    if (withDisc.length >= 5) {
      const recentCount = Math.max(3, Math.ceil(withDisc.length * 0.25));
      const recentAvg = withDisc.slice(-recentCount).reduce((s,t) => s + Number(t.psychology.disciplineRating), 0) / recentCount;
      if (recentAvg > avgDiscipline + 0.4) disciplineTrend = 'up';
      else if (recentAvg < avgDiscipline - 0.4) disciplineTrend = 'down';
    }

    const mistakeMap = {};
    loggedTrades.forEach(t => {
      const tags = Array.isArray(t.psychology?.mistakeTags) ? t.psychology.mistakeTags : [];
      const pnl = Number(t.netPnl) || 0;
      tags.forEach(tag => {
        if (!mistakeMap[tag]) mistakeMap[tag] = { tag, count: 0, totalPnl: 0, losses: 0 };
        mistakeMap[tag].count++;
        mistakeMap[tag].totalPnl += pnl;
        if (pnl < 0) mistakeMap[tag].losses += Math.abs(pnl);
      });
    });
    const mistakeFrequency = Object.values(mistakeMap)
      .map(m => ({
        tag: m.tag,
        count: m.count,
        totalPnl: parseFloat(m.totalPnl.toFixed(2)),
        avgPnl: parseFloat((m.totalPnl / m.count).toFixed(2)),
        totalLoss: parseFloat(m.losses.toFixed(2))
      }))
      .sort((a,b) => a.totalPnl - b.totalPnl);

    const revengeTrades = loggedTrades.filter(t => (t.psychology?.mistakeTags || []).includes('revenge_trade'));
    const revengeTradeLoss = parseFloat(revengeTrades.reduce((s,t) => s + (Number(t.netPnl) || 0), 0).toFixed(2));
    const fomoTrades = loggedTrades.filter(t => (t.psychology?.mistakeTags || []).includes('fomo_entry'));
    const overtradingCount = loggedTrades.filter(t => (t.psychology?.mistakeTags || []).includes('overtrading'));

    const emoMap = {};
    loggedTrades.forEach(t => {
      const em = t.psychology?.emotionBefore;
      if (!em || !em.trim()) return;
      const cleanEm = em.trim().toLowerCase();
      if (!emoMap[cleanEm]) emoMap[cleanEm] = { emotion: cleanEm, wins: 0, total: 0, pnl: 0 };
      const pnl = Number(t.netPnl) || 0;
      emoMap[cleanEm].total++;
      emoMap[cleanEm].pnl += pnl;
      if (pnl > 0) emoMap[cleanEm].wins++;
    });
    const emotionWinRate = Object.values(emoMap).map(d => ({
      emotion: d.emotion,
      trades: d.total,
      wins: d.wins,
      winRate: d.total ? parseFloat(((d.wins / d.total) * 100).toFixed(1)) : 0,
      totalPnl: parseFloat(d.pnl.toFixed(2)),
      avgPnl: parseFloat((d.pnl / d.total).toFixed(2))
    })).sort((a,b) => b.trades - a.trades);

    const afterMap = {};
    loggedTrades.forEach(t => {
      const em = t.psychology?.emotionAfter;
      if (!em || !em.trim()) return;
      const cleanEm = em.trim().toLowerCase();
      if (!afterMap[cleanEm]) afterMap[cleanEm] = { emotion: cleanEm, total: 0, pnl: 0, wins: 0 };
      const pnl = Number(t.netPnl) || 0;
      afterMap[cleanEm].total++;
      afterMap[cleanEm].pnl += pnl;
      if (pnl > 0) afterMap[cleanEm].wins++;
    });
    const lossByEmotion = Object.values(afterMap).map(d => ({
      emotion: d.emotion,
      trades: d.total,
      wins: d.wins,
      winRate: d.total ? parseFloat(((d.wins / d.total) * 100).toFixed(1)) : 0,
      totalPnl: parseFloat(d.pnl.toFixed(2)),
      avgPnl: parseFloat((d.pnl / d.total).toFixed(2)),
      absPnl: parseFloat(Math.abs(d.pnl).toFixed(2))
    })).sort((a,b) => a.totalPnl - b.totalPnl);

    res.json({
      totalLogged: loggedTrades.length,
      totalTradesInPeriod,
      avgDiscipline,
      disciplineTrend,
      followedPlanRate,
      planPerformance,
      totalDeviationCost,
      postLossPerformance,
      postWinPerformance,
      dayOfWeekPsych,
      revengeTrades: revengeTrades.length,
      revengeTradeLoss,
      fomoTrades: fomoTrades.length,
      overtradingCount: overtradingCount.length,
      mostCommonMistake: mistakeFrequency.length ? mistakeFrequency[0].tag : null,
      emotionWinRate,
      mistakeFrequency,
      lossByEmotion,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/psychology-trends', async (req, res) => {
  try {
    const { period = 'week', strategy, from, to } = req.query;
    const where = {
      userId: req.user.id,
      status: { [Op.in]: ['CLOSED', 'EXPIRED'] }
    };
    const fromDate = parseDateBoundary(from, 'start');
    const toDate   = parseDateBoundary(to, 'end');
    if (fromDate || toDate) {
      where.exitDate = {};
      if (fromDate) where.exitDate[Op.gte] = fromDate;
      if (toDate)   where.exitDate[Op.lte] = toDate;
    }
    if (strategy) where.strategy = strategy;

    const allTrades = await Trade.findAll({
      where,
      order: [['entryDate', 'ASC']]
    });

    const trades = allTrades.filter(t => t.psychology && (
      (t.psychology.emotionBefore && t.psychology.emotionBefore.trim() !== '') ||
      (t.psychology.disciplineRating != null && !isNaN(Number(t.psychology.disciplineRating))) ||
      (Array.isArray(t.psychology.mistakeTags) && t.psychology.mistakeTags.length > 0)
    ));

    if (!trades.length) return res.json({ periods: [], discipline: [], winRate: [], tradeCount: [], pnl: [], emotions: {}, mistakes: {} });

    function getISOWeek(d) {
      const date = new Date(d.getTime());
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
      const week1 = new Date(date.getFullYear(), 0, 4);
      return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    }

    const buckets = {};
    const MISTAKES = ['fomo_entry', 'revenge_trade', 'overtrading', 'no_stoploss', 'oversized_position', 'early_exit', 'late_entry'];
    const EMOTIONS  = ['calm', 'confident', 'fearful', 'frustrated', 'overconfident', 'revenge'];

    trades.forEach(t => {
      const d = new Date(t.entryDate);
      let key;
      if (period === 'month') {
        key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      } else {
        const isoW = getISOWeek(d);
        const yr = d.getFullYear();
        const adjustedYr = (isoW === 1 && d.getMonth() === 11) ? yr + 1 : (isoW > 50 && d.getMonth() === 0) ? yr - 1 : yr;
        key = `${adjustedYr}-W${String(isoW).padStart(2,'0')}`;
      }
      if (!buckets[key]) {
        buckets[key] = { key, disciplineSum: 0, disciplineCount: 0, emotions: {}, mistakes: {}, trades: 0, wins: 0, pnl: 0 };
        EMOTIONS.forEach(e => buckets[key].emotions[e] = 0);
        MISTAKES.forEach(m => buckets[key].mistakes[m] = 0);
      }
      const b = buckets[key];
      b.trades++;
      b.pnl += Number(t.netPnl) || 0;
      if ((Number(t.netPnl) || 0) > 0) b.wins++;
      const disc = t.psychology?.disciplineRating;
      if (disc != null && !isNaN(Number(disc))) { b.disciplineSum += Number(disc); b.disciplineCount++; }
      const em = t.psychology?.emotionBefore ? t.psychology.emotionBefore.trim().toLowerCase() : null;
      if (em && b.emotions[em] !== undefined) b.emotions[em]++;
      (t.psychology?.mistakeTags || []).forEach(tag => { if (b.mistakes[tag] !== undefined) b.mistakes[tag]++; });
    });

    const sorted = Object.values(buckets).sort((a,b) => a.key.localeCompare(b.key));

    const fmtLabel = key => {
      if (key.includes('W')) {
        const [yr, wk] = key.split('-W');
        return `W${wk} '${yr.slice(2)}`;
      }
      const [yr, mo] = key.split('-');
      return new Date(+yr, +mo-1, 1).toLocaleString('en', { month:'short', year:'2-digit' });
    };

    res.json({
      periods: sorted.map(b => fmtLabel(b.key)),
      discipline: sorted.map(b => b.disciplineCount > 0 ? parseFloat((b.disciplineSum / b.disciplineCount).toFixed(1)) : null),
      winRate: sorted.map(b => b.trades > 0 ? parseFloat(((b.wins / b.trades) * 100).toFixed(1)) : null),
      tradeCount: sorted.map(b => b.trades),
      pnl: sorted.map(b => parseFloat(b.pnl.toFixed(2))),
      emotions: Object.fromEntries(EMOTIONS.map(e => [e, sorted.map(b => b.emotions[e])])),
      mistakes: Object.fromEntries(MISTAKES.map(m => [m, sorted.map(b => b.mistakes[m])])),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/deep', async (req, res) => {
  try {
    const { from, to, strategy } = req.query;
    const where = { userId: req.user.id, status: { [Op.in]: ['CLOSED', 'EXPIRED'] } };
    const fromDate = parseDateBoundary(from, 'start');
    const toDate   = parseDateBoundary(to, 'end');
    if (fromDate || toDate) {
      where.exitDate = {};
      if (fromDate) where.exitDate[Op.gte] = fromDate;
      if (toDate)   where.exitDate[Op.lte] = toDate;
    }
    if (strategy) where.strategy = strategy;

    const trades = await Trade.findAll({ where, order: [['exitDate', 'ASC']] });
    if (!trades.length) return res.json({ empty: true });

    const withHold = trades.filter(t => t.entryDate && t.exitDate);
    
    function getMarketMins(entry, exit) {
      const start = new Date(entry);
      const end = new Date(exit);
      const diffMs = end - start;
      const diffDays = Math.floor(diffMs / 86400000);
      
      if (diffDays === 0) {
        return diffMs / 60000;
      }
      return diffDays * 375;
    }

    const holdMins = withHold.map(t => getMarketMins(t.entryDate, t.exitDate));
    const avgHoldMins  = holdMins.length ? holdMins.reduce((a,b)=>a+b,0) / holdMins.length : 0;
    const minHoldMins  = holdMins.length ? Math.min(...holdMins) : 0;
    const maxHoldMins  = holdMins.length ? Math.max(...holdMins) : 0;

    function fmtMins(m) {
      if (m < 60)   return `${Math.round(m)}m`;
      if (m < 375)  return `${Math.floor(m/60)}h ${Math.round(m%60)}m`;
      return `${Math.floor(m/375)}d ${Math.floor((m%375)/60)}h`;
    }

    const holdBuckets = { '<15m':0, '15–60m':0, '1–4h':0, '4h-1d':0, '>1d':0 };
    const holdPnl     = { '<15m':0, '15–60m':0, '1–4h':0, '4h-1d':0, '>1d':0 };
    const holdCount   = { '<15m':0, '15–60m':0, '1–4h':0, '4h-1d':0, '>1d':0 };
    withHold.forEach((t, i) => {
      const m   = holdMins[i];
      const pnl = t.netPnl || 0;
      let bucket;
      if      (m < 15)   bucket = '<15m';
      else if (m < 60)   bucket = '15–60m';
      else if (m < 240)  bucket = '1–4h';
      else if (m < 375)  bucket = '4h-1d';
      else               bucket = '>1d';
      holdBuckets[bucket]++;
      holdPnl[bucket]    += pnl;
      holdCount[bucket]  += 1;
    });
    const holdingTime = Object.keys(holdBuckets).map(k => ({
      label:    k,
      trades:   holdBuckets[k],
      totalPnl: parseFloat((holdPnl[k]||0).toFixed(2)),
      avgPnl:   holdCount[k] ? parseFloat((holdPnl[k]/holdCount[k]).toFixed(2)) : 0,
      wins:     withHold.filter((t,i) => {
        const m = holdMins[i]; const pnl = t.netPnl||0;
        if (k==='<15m')   return m<15   && pnl>0;
        if (k==='15–60m') return m>=15  && m<60  && pnl>0;
        if (k==='1–4h')   return m>=60  && m<240 && pnl>0;
        if (k==='4h-1d')  return m>=240 && m<375 && pnl>0;
        return m>=375 && pnl>0;
      }).length,
    })).filter(b => b.trades > 0);

    const hourSlots = {};
    trades.forEach(t => {
      if (!t.entryDate) return;
      const utcH = new Date(t.entryDate).getUTCHours();
      const utcM = new Date(t.entryDate).getUTCMinutes();
      const istMins = utcH * 60 + utcM + 330;
      const istH    = Math.floor((istMins % 1440) / 60);
      const label = `${istH}:00`;
      if (!hourSlots[label]) hourSlots[label] = { label, trades:0, totalPnl:0, wins:0 };
      hourSlots[label].trades++;
      hourSlots[label].totalPnl += t.netPnl || 0;
      if ((t.netPnl||0) > 0) hourSlots[label].wins++;
    });
    const timeOfDay = Object.values(hourSlots)
      .map(s => ({ ...s, totalPnl: parseFloat(s.totalPnl.toFixed(2)), avgPnl: parseFloat((s.totalPnl/s.trades).toFixed(2)), winRate: parseFloat(((s.wins/s.trades)*100).toFixed(1)) }))
      .sort((a,b) => parseInt(a.label) - parseInt(b.label));

    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const daySlots = {};
    trades.forEach(t => {
      if (!t.entryDate) return;
      const istMs  = new Date(t.entryDate).getTime() + 330 * 60000;
      const day    = DAYS[new Date(istMs).getUTCDay()];
      if (!daySlots[day]) daySlots[day] = { label:day, trades:0, totalPnl:0, wins:0 };
      daySlots[day].trades++;
      daySlots[day].totalPnl += t.netPnl || 0;
      if ((t.netPnl||0) > 0) daySlots[day].wins++;
    });
    const dayOfWeek = ['Mon','Tue','Wed','Thu','Fri']
      .filter(d => daySlots[d])
      .map(d => ({
        ...daySlots[d],
        totalPnl: parseFloat(daySlots[d].totalPnl.toFixed(2)),
        avgPnl:   parseFloat((daySlots[d].totalPnl / daySlots[d].trades).toFixed(2)),
        winRate:  parseFloat(((daySlots[d].wins / daySlots[d].trades) * 100).toFixed(1)),
      }));

    const grossPnl      = trades.reduce((s,t) => s + (t.pnl     || 0), 0);
    const totalCharges  = trades.reduce((s,t) => s + (t.charges || 0), 0);
    const netPnl        = trades.reduce((s,t) => s + (t.netPnl  || 0), 0);
    const chargesPct    = Math.abs(grossPnl) > 0 ? Math.abs(totalCharges / grossPnl) * 100 : 0;
    const avgCharges    = trades.length ? totalCharges / trades.length : 0;
    const chargesAteIt  = trades.filter(t => Math.abs(t.charges||0) > Math.abs(t.pnl||0) && Math.abs(t.charges||0) > 0).length;

    const chargesImpact = {
      grossPnl:    parseFloat(grossPnl.toFixed(2)),
      totalCharges:parseFloat(totalCharges.toFixed(2)),
      netPnl:      parseFloat(netPnl.toFixed(2)),
      chargesPct:  parseFloat(chargesPct.toFixed(1)),
      avgCharges:  parseFloat(avgCharges.toFixed(2)),
      chargesAteIt,
    };

    let curWin = 0, curLoss = 0;
    let maxWinStreak = 0, maxLossStreak = 0;
    let curWinPnl = 0, bestStreakPnl = 0;
    let curLossPnl = 0, worstStreakPnl = 0;

    trades.forEach(t => {
      const pnl = t.netPnl || 0;
      if (pnl > 0) {
        curWin++; curLoss = 0; curLossPnl = 0;
        curWinPnl += pnl;
        if (curWin > maxWinStreak) { maxWinStreak = curWin; bestStreakPnl = curWinPnl; }
      } else if (pnl < 0) {
        curLoss++; curWin = 0; curWinPnl = 0;
        curLossPnl += pnl;
        if (curLoss > maxLossStreak) { maxLossStreak = curLoss; worstStreakPnl = curLossPnl; }
      }
    });

    let currentStreak = 0, currentStreakType = 'none';
    for (let i = trades.length - 1; i >= 0; i--) {
      const pnl = trades[i].netPnl || 0;
      if (pnl === 0) continue;
      const type = pnl > 0 ? 'win' : 'loss';
      if (currentStreak === 0) { currentStreakType = type; currentStreak = 1; }
      else if (type === currentStreakType) currentStreak++;
      else break;
    }

    const streaks = {
      maxWinStreak, bestStreakPnl:  parseFloat(bestStreakPnl.toFixed(2)),
      maxLossStreak, worstStreakPnl: parseFloat(worstStreakPnl.toFixed(2)),
      currentStreak, currentStreakType,
    };

    const formatCohort = (cohort, label) => {
      const count = cohort.length;
      const wins = cohort.filter(t => (t.netPnl || 0) > 0).length;
      const totalPnl = cohort.reduce((s, t) => s + (t.netPnl || 0), 0);
      return {
        label,
        trades: count,
        wins,
        winRate: count > 0 ? parseFloat(((wins / count) * 100).toFixed(1)) : 0,
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        avgPnl: count > 0 ? parseFloat((totalPnl / count).toFixed(2)) : 0
      };
    };

    const ceTrades = trades.filter(t => t.optionType === 'CE');
    const peTrades = trades.filter(t => t.optionType === 'PE');
    const optionsBreakdown = [
      formatCohort(ceTrades, 'Calls (CE)'),
      formatCohort(peTrades, 'Puts (PE)')
    ].filter(b => b.trades > 0);

    const buyTrades = trades.filter(t => t.tradeType === 'BUY');
    const sellTrades = trades.filter(t => t.tradeType === 'SELL');
    const sideBreakdown = [
      formatCohort(buyTrades, 'Long (BUY)'),
      formatCohort(sellTrades, 'Short (SELL)')
    ].filter(b => b.trades > 0);

    const morningTrades = [];
    const midDayTrades = [];
    const afternoonTrades = [];
    trades.forEach(t => {
      if (!t.entryDate) return;
      const utcH = new Date(t.entryDate).getUTCHours();
      const utcM = new Date(t.entryDate).getUTCMinutes();
      const istMins = utcH * 60 + utcM + 330;
      const normalizedMins = istMins % 1440;
      if (normalizedMins >= 555 && normalizedMins < 690) morningTrades.push(t);
      else if (normalizedMins >= 690 && normalizedMins < 810) midDayTrades.push(t);
      else if (normalizedMins >= 810 && normalizedMins <= 945) afternoonTrades.push(t);
    });
    const sessionBreakdown = [
      formatCohort(morningTrades, 'Morning (09:15–11:30)'),
      formatCohort(midDayTrades, 'Mid-Day (11:30–13:30)'),
      formatCohort(afternoonTrades, 'Closing (13:30–15:30)')
    ].filter(b => b.trades > 0);

    res.json({
      empty: false,
      avgHold: fmtMins(avgHoldMins),
      minHold: fmtMins(minHoldMins),
      maxHold: fmtMins(maxHoldMins),
      holdingTime, timeOfDay, dayOfWeek, chargesImpact, streaks,
      optionsBreakdown, sideBreakdown, sessionBreakdown,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/daily-risk-status', async (req, res) => {
  try {
    const fromDate = new Date();
    fromDate.setHours(0, 0, 0, 0);
    const toDate = new Date();
    toDate.setHours(23, 59, 59, 999);

    const trades = await Trade.findAll({
      where: {
        userId: req.user.id,
        status: { [Op.in]: ['CLOSED', 'EXPIRED'] },
        exitDate: { [Op.gte]: fromDate, [Op.lte]: toDate }
      }
    });

    const todayPnl = trades.reduce((sum, t) => sum + (t.netPnl || 0), 0);

    const user = await User.findByPk(req.user.id);
    const risk = user.riskManagement || {};
    const totalCapital = Number(risk.totalCapital) || 0;
    const maxDailyLossPct = Number(risk.maxDailyLoss) || 2;
    
    const maxDailyLossAmount = (totalCapital * maxDailyLossPct) / 100;
    
    let percentUsed = 0;
    let isBreached = false;
    let isWarning = false;
    
    if (maxDailyLossAmount > 0 && todayPnl < 0) {
      const lossAmount = Math.abs(todayPnl);
      percentUsed = (lossAmount / maxDailyLossAmount) * 100;
      isBreached = percentUsed >= 100;
      isWarning = percentUsed >= 80;
    }

    res.json({
      todayPnl,
      maxDailyLossAmount,
      percentUsed,
      isBreached,
      isWarning
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
