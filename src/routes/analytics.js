import express from 'express';
import { Op } from 'sequelize';
import Trade from '../models/Trade.js';
import User from '../models/User.js';
import sequelize from '../lib/sequelize.js';
import { protect } from '../middleware/auth.js';
import { planGate } from '../middleware/planGate.js';

const router = express.Router();
router.use(protect);
router.use(planGate('analytics'));

// ── GET /api/analytics/summary ────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = { userId: req.user.id, status: 'CLOSED' };
    if (from || to) {
      where.exitDate = {};
      if (from) where.exitDate[Op.gte] = new Date(from);
      if (to)   where.exitDate[Op.lte] = new Date(to);
    }

    const openTrades = await Trade.count({ where: { userId: req.user.id, status: 'OPEN' } });

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

    const winners    = trades.filter(t => t.netPnl > 0);
    const losers     = trades.filter(t => t.netPnl <= 0);
    const totalPnl   = parseFloat(aggResult.totalPnl || 0);
    const totalCharges = parseFloat(aggResult.totalCharges || 0);
    const avgWin     = winners.length ? winners.reduce((s,t) => s + t.netPnl, 0) / winners.length : 0;
    const avgLoss    = losers.length  ? losers.reduce((s,t)  => s + t.netPnl, 0) / losers.length  : 0;
    
    const nseCharges   = trades.filter(t => (t.exchange||'NSE') === 'NSE').reduce((s,t) => s + (t.charges||0), 0);
    const bseCharges   = trades.filter(t => t.exchange === 'BSE').reduce((s,t) => s + (t.charges||0), 0);
    const nseTrades    = trades.filter(t => (t.exchange||'NSE') === 'NSE').length;
    const bseTrades    = trades.filter(t => t.exchange === 'BSE').length;

    // ── Streaks ───────────────────────────────────────────────────────────────
    let curWin = 0, curLoss = 0, maxWinStreak = 0, maxLossStreak = 0;
    let curWinPnl = 0, bestStreakPnl = 0, curLossPnl = 0, worstStreakPnl = 0;
    trades.forEach(t => {
      const pnl = t.netPnl || 0;
      if (pnl > 0) {
        curWin++; curLoss = 0; curLossPnl = 0; curWinPnl += pnl;
        if (curWin > maxWinStreak) { maxWinStreak = curWin; bestStreakPnl = curWinPnl; }
      } else {
        curLoss++; curWin = 0; curWinPnl = 0; curLossPnl += pnl;
        if (curLoss > maxLossStreak) { maxLossStreak = curLoss; worstStreakPnl = curLossPnl; }
      }
    });
    // Current streak — walk backwards from most recent trade
    let currentStreak = 0, currentStreakType = 'none', currentStreakPnl = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      const pnl  = trades[i].netPnl || 0;
      const type = pnl > 0 ? 'win' : 'loss';
      if (currentStreak === 0) { currentStreakType = type; currentStreak = 1; currentStreakPnl = pnl; }
      else if (type === currentStreakType) { currentStreak++; currentStreakPnl += pnl; }
      else break;
    }

    res.json({
      totalTrades: parseInt(aggResult.total || 0), openTrades, 
      winners: parseInt(aggResult.winners || 0), 
      losers: parseInt(aggResult.total || 0) - parseInt(aggResult.winners || 0),
      totalPnl, totalCharges, nseCharges, bseCharges, nseTrades, bseTrades,
      grossPnl: trades.reduce((s,t) => s + (t.pnl||0), 0),
      avgWin, avgLoss, 
      winRate: parseInt(aggResult.total || 0) ? (parseInt(aggResult.winners || 0) / parseInt(aggResult.total || 0)) * 100 : 0,
      profitFactor: Math.abs(avgLoss) > 0 ? Math.abs(avgWin / avgLoss) : 0,
      maxWin:  parseFloat(aggResult.maxWin || 0),
      maxLoss: parseFloat(aggResult.maxLoss || 0),
      streaks: {
        currentStreak, currentStreakType,
        currentStreakPnl: parseFloat(currentStreakPnl.toFixed(2)),
        maxWinStreak,  bestStreakPnl:  parseFloat(bestStreakPnl.toFixed(2)),
        maxLossStreak, worstStreakPnl: parseFloat(worstStreakPnl.toFixed(2)),
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/pnl-chart ─────────────────────────────────────────────
router.get('/pnl-chart', async (req, res) => {
  try {
    const { days = 30, from: fromQ, to: toQ } = req.query;
    // Accept explicit from/to OR fall back to days-ago
    const fromDate = fromQ ? new Date(fromQ) : (() => { const d = new Date(); d.setDate(d.getDate() - Number(days)); return d; })();
    const toDate   = toQ   ? new Date(toQ)   : new Date();
    toDate.setHours(23, 59, 59, 999); // include full last day
    const trades = await Trade.findAll({
      where: {
        userId: req.user.id,
        status: 'CLOSED',
        exitDate: { [Op.gte]: fromDate, [Op.lte]: toDate }
      },
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
    const chartData = Object.values(dailyMap).map(d => { cumulative += d.pnl; return { ...d, cumulative }; });
    res.json({ chartData });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/by-symbol ─────────────────────────────────────────────
router.get('/by-symbol', async (req, res) => {
  try {
    const data = await Trade.findAll({
      where: { userId: req.user.id, status: 'CLOSED' },
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
    // Convert string numeric fields to numbers
    const formatted = data.map(d => ({
      ...d,
      totalTrades: parseInt(d.totalTrades),
      totalPnl: parseFloat(d.totalPnl),
      wins: parseInt(d.wins)
    }));
    res.json({ data: formatted });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/by-strategy ───────────────────────────────────────────
router.get('/by-strategy', async (req, res) => {
  try {
    const data = await Trade.findAll({
      where: {
        userId: req.user.id,
        status: 'CLOSED',
        strategy: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] }
      },
      attributes: [
        ['strategy', '_id'],
        [sequelize.fn('count', sequelize.col('id')), 'totalTrades'],
        [sequelize.fn('sum', sequelize.col('netPnl')), 'totalPnl'],
        [sequelize.fn('sum', sequelize.literal('CASE WHEN "netPnl" > 0 THEN 1 ELSE 0 END')), 'wins']
      ],
      group: ['strategy'],
      order: [[sequelize.literal('"totalPnl"'), 'DESC']],
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

// ── GET /api/analytics/psychology ─────────────────────────────────────────────
router.get('/psychology', async (req, res) => {
  try {
    const trades = await Trade.findAll({
      where: {
        userId: req.user.id,
        status: 'CLOSED',
        'psychology.emotionBefore': { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] }
      }
    });
    if (!trades.length) return res.json({ totalLogged: 0, avgDiscipline: 0, followedPlanRate: 0, revengeTrades: 0, revengeTradeLoss: 0, fomoTrades: 0, overtradingCount: 0, mostCommonMistake: null, emotionWinRate: [], mistakeFrequency: [], lossByEmotion: [] });

    const withDisc = trades.filter(t => t.psychology?.disciplineRating != null);
    const avgDiscipline = withDisc.length ? withDisc.reduce((s,t) => s + t.psychology.disciplineRating, 0) / withDisc.length : 0;
    const withPlan = trades.filter(t => t.psychology?.followedPlan != null);
    const followedPlanRate = withPlan.length ? (withPlan.filter(t => t.psychology.followedPlan).length / withPlan.length) * 100 : 0;

    const mistakeCount = {};
    trades.forEach(t => (t.psychology?.mistakeTags || []).forEach(tag => { mistakeCount[tag] = (mistakeCount[tag] || 0) + 1; }));
    const mistakeFrequency = Object.entries(mistakeCount).map(([tag, count]) => ({ tag, count })).sort((a,b) => b.count - a.count);

    const revengeTrades = trades.filter(t => (t.psychology?.mistakeTags||[]).includes('revenge_trade'));
    const emoMap = {};
    trades.forEach(t => {
      const em = t.psychology?.emotionBefore; if (!em) return;
      if (!emoMap[em]) emoMap[em] = { wins: 0, total: 0, pnl: 0 };
      emoMap[em].total++; emoMap[em].pnl += t.netPnl || 0;
      if ((t.netPnl||0) > 0) emoMap[em].wins++;
    });
    const emotionWinRate = Object.entries(emoMap).map(([emotion, d]) => ({ emotion, trades: d.total, wins: d.wins, winRate: d.total ? parseFloat(((d.wins/d.total)*100).toFixed(1)) : 0, totalPnl: parseFloat(d.pnl.toFixed(2)) })).sort((a,b) => b.trades - a.trades);

    const afterMap = {};
    trades.forEach(t => {
      const em = t.psychology?.emotionAfter; if (!em) return;
      if (!afterMap[em]) afterMap[em] = { total: 0, pnl: 0 };
      afterMap[em].total++; afterMap[em].pnl += t.netPnl || 0;
    });
    const lossByEmotion = Object.entries(afterMap).map(([emotion, d]) => ({ emotion, trades: d.total, totalPnl: parseFloat(d.pnl.toFixed(2)) })).sort((a,b) => a.totalPnl - b.totalPnl);

    res.json({
      totalLogged: trades.length, avgDiscipline: parseFloat(avgDiscipline.toFixed(1)),
      followedPlanRate: parseFloat(followedPlanRate.toFixed(1)),
      revengeTrades: revengeTrades.length, revengeTradeLoss: parseFloat(revengeTrades.reduce((s,t) => s+(t.netPnl||0), 0).toFixed(2)),
      fomoTrades: trades.filter(t => (t.psychology?.mistakeTags||[]).includes('fomo_entry')).length,
      overtradingCount: trades.filter(t => (t.psychology?.mistakeTags||[]).includes('overtrading')).length,
      mostCommonMistake: mistakeFrequency[0]?.tag || null,
      emotionWinRate, mistakeFrequency, lossByEmotion,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/psychology-trends ─────────────────────────────────────
router.get('/psychology-trends', async (req, res) => {
  try {
    const { period = 'week' } = req.query; // 'week' | 'month'
    const trades = await Trade.findAll({
      where: {
        userId: req.user.id,
        'psychology.emotionBefore': { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] }
      },
      order: [['entryDate', 'ASC']]
    });

    if (!trades.length) return res.json({ periods: [], discipline: [], emotions: [], mistakes: [] });

    // Group trades into weekly or monthly buckets
    const buckets = {};
    const MISTAKES = ['fomo_entry', 'revenge_trade', 'overtrading', 'no_stoploss', 'oversized_position', 'early_exit', 'late_entry'];
    const EMOTIONS  = ['calm', 'confident', 'fearful', 'frustrated', 'overconfident', 'revenge'];

    trades.forEach(t => {
      const d    = new Date(t.entryDate);
      let key;
      if (period === 'month') {
        key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      } else {
        // ISO week: Monday-based
        const day  = d.getDay() || 7; // make Sunday = 7
        const mon  = new Date(d); mon.setDate(d.getDate() - day + 1);
        key = `${mon.getFullYear()}-W${String(Math.ceil((((mon - new Date(mon.getFullYear(),0,1))/86400000)+1)/7)).padStart(2,'0')}`;
      }
      if (!buckets[key]) {
        buckets[key] = { key, disciplineSum: 0, disciplineCount: 0, emotions: {}, mistakes: {}, trades: 0, wins: 0, pnl: 0 };
        EMOTIONS.forEach(e  => buckets[key].emotions[e]  = 0);
        MISTAKES.forEach(m  => buckets[key].mistakes[m]  = 0);
      }
      const b = buckets[key];
      b.trades++;
      b.pnl += t.netPnl || 0;
      if ((t.netPnl||0) > 0) b.wins++;
      const disc = t.psychology?.disciplineRating;
      if (disc != null) { b.disciplineSum += disc; b.disciplineCount++; }
      const em = t.psychology?.emotionBefore;
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
      discipline: sorted.map(b => b.disciplineCount > 0 ? parseFloat((b.disciplineSum / b.disciplineCount).toFixed(2)) : null),
      winRate: sorted.map(b => b.trades > 0 ? parseFloat(((b.wins / b.trades) * 100).toFixed(1)) : null),
      tradeCount: sorted.map(b => b.trades),
      pnl: sorted.map(b => parseFloat(b.pnl.toFixed(2))),
      emotions: Object.fromEntries(EMOTIONS.map(e => [e, sorted.map(b => b.emotions[e])])),
      mistakes: Object.fromEntries(MISTAKES.map(m => [m, sorted.map(b => b.mistakes[m])])),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/deep ───────────────────────────────────────────────────
router.get('/deep', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = { userId: req.user.id, status: 'CLOSED' };
    if (from || to) {
      where.exitDate = {};
      if (from) where.exitDate[Op.gte] = new Date(from);
      if (to)   { const t = new Date(to); t.setHours(23,59,59,999); where.exitDate[Op.lte] = t; }
    }
    const trades = await Trade.findAll({ where, order: [['exitDate', 'ASC']] });
    if (!trades.length) return res.json({ empty: true });

    // ── Holding time ─────────────────────────────────────────────────────────
    const withHold = trades.filter(t => t.entryDate && t.exitDate);
    const holdMins = withHold.map(t => (new Date(t.exitDate) - new Date(t.entryDate)) / 60000);
    const avgHoldMins  = holdMins.length ? holdMins.reduce((a,b)=>a+b,0) / holdMins.length : 0;
    const minHoldMins  = holdMins.length ? Math.min(...holdMins) : 0;
    const maxHoldMins  = holdMins.length ? Math.max(...holdMins) : 0;

    function fmtMins(m) {
      if (m < 60)   return `${Math.round(m)}m`;
      if (m < 1440) return `${Math.floor(m/60)}h ${Math.round(m%60)}m`;
      return `${Math.floor(m/1440)}d ${Math.floor((m%1440)/60)}h`;
    }

    const holdBuckets = { '<15m':0, '15–60m':0, '1–4h':0, '4–24h':0, '>1d':0 };
    const holdPnl     = { '<15m':0, '15–60m':0, '1–4h':0, '4–24h':0, '>1d':0 };
    const holdCount   = { '<15m':0, '15–60m':0, '1–4h':0, '4–24h':0, '>1d':0 };
    withHold.forEach((t, i) => {
      const m   = holdMins[i];
      const pnl = t.netPnl || 0;
      let bucket;
      if      (m < 15)   bucket = '<15m';
      else if (m < 60)   bucket = '15–60m';
      else if (m < 240)  bucket = '1–4h';
      else if (m < 1440) bucket = '4–24h';
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
        if (k==='4–24h')  return m>=240 && m<1440&& pnl>0;
        return m>=1440 && pnl>0;
      }).length,
    })).filter(b => b.trades > 0);

    // ── Time of day (IST = UTC+5:30) ──────────────────────────────────────────
    const hourSlots = {};
    trades.forEach(t => {
      if (!t.entryDate) return;
      const utcH = new Date(t.entryDate).getUTCHours();
      const utcM = new Date(t.entryDate).getUTCMinutes();
      const istMins = utcH * 60 + utcM + 330; // +5:30
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

    // ── Day of week ───────────────────────────────────────────────────────────
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

    // ── Charges impact ────────────────────────────────────────────────────────
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

    // ── Streaks ───────────────────────────────────────────────────────────────
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
      } else {
        curLoss++; curWin = 0; curWinPnl = 0;
        curLossPnl += pnl;
        if (curLoss > maxLossStreak) { maxLossStreak = curLoss; worstStreakPnl = curLossPnl; }
      }
    });

    let currentStreak = 0, currentStreakType = 'none';
    for (let i = trades.length - 1; i >= 0; i--) {
      const pnl = trades[i].netPnl || 0;
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

    res.json({
      empty: false,
      avgHold: fmtMins(avgHoldMins),
      minHold: fmtMins(minHoldMins),
      maxHold: fmtMins(maxHoldMins),
      holdingTime, timeOfDay, dayOfWeek, chargesImpact, streaks,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/daily-risk-status ──────────────────────────────────────
router.get('/daily-risk-status', async (req, res) => {
  try {
    const fromDate = new Date();
    fromDate.setHours(0, 0, 0, 0);
    const toDate = new Date();
    toDate.setHours(23, 59, 59, 999);

    const trades = await Trade.findAll({
      where: {
        userId: req.user.id,
        status: 'CLOSED',
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