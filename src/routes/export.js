import express        from 'express';
import Trade          from '../models/Trade.js';
import User           from '../models/User.js';
import { protect }   from '../middleware/auth.js';
import { buildXlsx } from '../lib/xlsxBuilder.js';
import { Op } from 'sequelize';

const router = express.Router();
router.use(protect);

// ── Shared filter builder ──────────────────────────────────────────────────────
function buildFilter(userId, query) {
  const { status, symbol, from, to, optionType, fy } = query;
  const filter = { userId };

  if (status)     filter.status     = status;
  if (optionType) filter.optionType = optionType;
  if (symbol)     filter.underlying = { [Op.iLike]: `%${symbol}%` };

  // Financial Year shortcut: fy=2024 → Apr 2024 – Mar 2025
  if (fy) {
    const yr = parseInt(fy);
    filter.exitDate = {
      [Op.gte]: new Date(`${yr}-04-01`),
      [Op.lte]: new Date(`${yr+1}-03-31T23:59:59.999Z`),
    };
  } else if (from || to) {
    filter.exitDate = {};
    if (from) filter.exitDate[Op.gte] = new Date(from);
    if (to)   filter.exitDate[Op.lte] = new Date(new Date(to).setHours(23,59,59,999));
  }

  return filter;
}

function periodLabel(query) {
  const { fy, from, to } = query;
  if (fy) return `FY ${fy}-${String(parseInt(fy)+1).slice(2)} (Apr–Mar)`;
  if (from && to) return `${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to)   return `Up to ${to}`;
  return 'All Time';
}

function computeSummary(trades) {
  const closed   = trades.filter(t => t.status === 'CLOSED');
  const winners  = closed.filter(t => (t.netPnl||0) > 0);
  const losers   = closed.filter(t => (t.netPnl||0) <= 0);
  const totalPnl = closed.reduce((s,t) => s + (t.netPnl||0), 0);
  const grossPnl = closed.reduce((s,t) => s + (t.pnl||0), 0);
  const charges  = closed.reduce((s,t) => s + (t.charges||0), 0);
  const avgWin   = winners.length ? winners.reduce((s,t)=>s+t.netPnl,0) / winners.length : 0;
  const avgLoss  = losers.length  ? losers.reduce((s,t)=>s+t.netPnl,0)  / losers.length  : 0;
  return {
    totalTrades:  closed.length,
    winners:      winners.length,
    losers:       losers.length,
    winRate:      closed.length ? (winners.length / closed.length) * 100 : 0,
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    grossPnl:     parseFloat(grossPnl.toFixed(2)),
    totalCharges: parseFloat(charges.toFixed(2)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    maxWin:       winners.length ? Math.max(...winners.map(t=>t.netPnl)) : 0,
    maxLoss:      losers.length  ? Math.min(...losers.map(t=>t.netPnl))  : 0,
  };
}

// ── GET /api/export/xlsx ───────────────────────────────────────────────────────
router.get('/xlsx', async (req, res) => {
  try {
    const filter  = buildFilter(req.user.id, req.query);
    const trades  = await Trade.findAll({
      where: filter,
      order: [['exitDate', 'DESC'], ['entryDate', 'DESC']],
      limit: 5000
    });
    const user    = await User.findByPk(req.user.id, {
      attributes: ['name', 'email']
    });
    const summary = computeSummary(trades);
    const period  = periodLabel(req.query);

    const buf = buildXlsx(trades, summary, user, period);

    const safeName = (user?.name || 'trades').replace(/[^a-z0-9]/gi, '_');
    const fileName = `TradeLog_${safeName}_${period.replace(/[^a-z0-9]/gi,'_')}.xlsx`;

    res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length',      buf.length);
    res.end(buf);
  } catch (err) {
    console.error('XLSX export error:', err);
    res.status(500).json({ message: 'Export failed: ' + err.message });
  }
});

// ── GET /api/export/pdf-data ───────────────────────────────────────────────────
// Returns JSON that frontend turns into a printable HTML page (browser PDF)
router.get('/pdf-data', async (req, res) => {
  try {
    const filter  = buildFilter(req.user.id, req.query);
    const trades  = await Trade.findAll({
      where: filter,
      order: [['exitDate', 'DESC'], ['entryDate', 'DESC']],
      limit: 5000
    });
    const user    = await User.findByPk(req.user.id, {
      attributes: ['name', 'email']
    });
    const summary = computeSummary(trades);
    const period  = periodLabel(req.query);

    res.json({
      trades: trades.map(t => ({
        symbol:      t.symbol || t.underlying,
        underlying:  t.underlying,
        tradeType:   t.tradeType,
        optionType:  t.optionType,
        strikePrice: t.strikePrice,
        expiryDate:  t.expiryDate,
        entryDate:   t.entryDate,
        exitDate:    t.exitDate,
        entryPrice:  t.entryPrice,
        exitPrice:   t.exitPrice,
        quantity:    t.quantity,
        lotSize:     t.lotSize,
        strategy:    t.strategy,
        status:      t.status,
        pnl:         t.pnl,
        charges:     t.charges,
        netPnl:      t.netPnl,
        exchange:    t.exchange,
      })),
      summary,
      user,
      period,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
