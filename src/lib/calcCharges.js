/**
 * calcCharges.js — Zerodha F&O Options charge calculator
 *
 * Verified against Zerodha brokerage calculator screenshots:
 *   Buy @ 100, Sell @ 110, Qty 400 → Total turnover 84000
 *   NSE: Brokerage 40 | STT 44 | Exchange 29.85 | GST 12.59 | SEBI 0.08 | Stamp 1 → 127.52 ✓
 *   BSE: Brokerage 40 | STT 44 | Exchange 27.30 | GST 12.13 | SEBI 0.08 | Stamp 1 → 124.51 ✓
 *
 * Rules confirmed from screenshot reverse-engineering:
 *   Brokerage  = FLAT ₹20 per executed order (NOT 0.03% — that's equity intraday only)
 *   STT        = 0.1% on SELL side turnover only
 *   Exchange   = 0.03554% (NSE) / 0.03250% (BSE) on total turnover (both legs)
 *   SEBI       = ₹10 per crore = 0.000001 × total turnover
 *   GST        = 18% on (brokerage + exchangeTxn + sebi)  ← SEBI included in GST base
 *   Stamp duty = floor(0.003% × buy-side turnover, max ₹300)  ← floored to whole rupees
 */

const EXCHANGE_RATES = {
  NSE: { exchangePct: 0.0003554 },  // 29.85 / 84000
  BSE: { exchangePct: 0.0003250 },  // 27.30 / 84000
};

/**
 * Calculate Zerodha F&O Options charges.
 * Pass exitPrice > 0 for a closed trade (round trip), 0/null for an open trade (entry only).
 *
 * @param {number} entryPrice  - Entry premium per unit
 * @param {number} exitPrice   - Exit premium (0 or null = open/entry-only)
 * @param {number} lotSize     - Lot size of the instrument
 * @param {number} lots        - Number of lots
 * @param {string} tradeType   - 'BUY' (long) or 'SELL' (short/write)
 * @param {string} exchange    - 'NSE' (default) or 'BSE'
 */
export function calcCharges(entryPrice, exitPrice, lotSize, lots, tradeType, exchange = 'NSE') {
  if (!entryPrice || !lotSize || !lots) return zeroCharges();

  const qty            = lotSize * lots;
  const entryTurnover  = entryPrice * qty;
  const exitTurnover   = (exitPrice && exitPrice > 0) ? exitPrice * qty : 0;
  const totalTurnover  = entryTurnover + exitTurnover;
  const exchRate       = (EXCHANGE_RATES[exchange] || EXCHANGE_RATES.NSE).exchangePct;

  // STT applies to sell-side only, stamp to buy-side only
  const sellTurnover = tradeType === 'SELL' ? entryTurnover : exitTurnover;
  const buyTurnover  = tradeType === 'BUY'  ? entryTurnover : exitTurnover;

  // 1 order for open (entry only), 2 for closed (round trip)
  const orders = exitTurnover > 0 ? 2 : 1;

  const brokerage   = 20 * orders;                                     // FLAT ₹20 per order
  const stt         = 0.001 * sellTurnover;                            // 0.1% sell side
  const exchangeTxn = parseFloat((exchRate * totalTurnover).toFixed(2));
  const sebi        = parseFloat((0.000001 * totalTurnover).toFixed(2)); // ₹10/crore
  const gst         = parseFloat((0.18 * (brokerage + exchangeTxn + sebi)).toFixed(2)); // SEBI in base
  const stampDuty   = Math.min(300, Math.floor(0.00003 * buyTurnover)); // floored, max ₹300

  const total = parseFloat((brokerage + stt + exchangeTxn + sebi + gst + stampDuty).toFixed(2));

  return {
    brokerage,
    stt:           parseFloat(stt.toFixed(2)),
    exchangeTxn,
    gst,
    sebi,
    stampDuty,
    total,
    entryTurnover: parseFloat(entryTurnover.toFixed(2)),
    totalTurnover: parseFloat(totalTurnover.toFixed(2)),
    orders,
  };
}

function zeroCharges() {
  return { brokerage:0, stt:0, exchangeTxn:0, gst:0, sebi:0, stampDuty:0, total:0, entryTurnover:0, totalTurnover:0, orders:0 };
}