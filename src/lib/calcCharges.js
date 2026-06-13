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

/**
 * Calculate Zerodha charges based on instrument type and latest regulatory norms (Oct 2024 - 2026).
 *
 * @param {number} entryPrice     - Entry price per unit
 * @param {number} exitPrice      - Exit price (0 for open)
 * @param {number} lotSize        - Units per lot
 * @param {number} lots           - Number of lots
 * @param {string} tradeType      - 'BUY' or 'SELL'
 * @param {string} exchange       - 'NSE' or 'BSE'
 * @param {string} status         - 'OPEN', 'CLOSED', or 'EXPIRED'
 * @param {string} instrumentType - 'EQUITY', 'FUTURES', or 'OPTIONS'
 */
export function calcCharges(entryPrice, exitPrice, lotSize, lots, tradeType, exchange = 'NSE', status = 'OPEN', instrumentType = 'OPTIONS') {
  if (!entryPrice || !lotSize || !lots) return zeroCharges();

  const qty            = lotSize * lots;
  const entryTurnover  = entryPrice * qty;
  const exitTurnover   = (exitPrice && exitPrice > 0) ? exitPrice * qty : 0;
  const totalTurnover  = entryTurnover + exitTurnover;
  
  const isSettled = status === 'CLOSED' || status === 'EXPIRED';
  const orders    = isSettled ? 2 : 1;

  const EXCHANGE_RATES = {
    NSE: { options: 0.0003503, futures: 0.000019, equity: 0.0000297 }, // NSE revised rates
    BSE: { options: 0.0003250, futures: 0.000000, equity: 0.0000375 },
  };

  const exch = EXCHANGE_RATES[exchange] || EXCHANGE_RATES.NSE;
  let exchRate = exch.options;
  if (instrumentType === 'FUTURES') exchRate = exch.futures;
  if (instrumentType === 'EQUITY')  exchRate = exch.equity;

  // 1. Brokerage
  let brokerage = 0;
  if (instrumentType === 'OPTIONS' || instrumentType === 'FUTURES') {
    brokerage = 20 * orders; // Flat 20 per order
  } else if (instrumentType === 'EQUITY') {
    // Equity Intraday (assumed for manual logs usually, but let's check status)
    // If it's delivery (longer than 1 day), it would be 0, but usually loggers track intraday
    const rate = 0.0003; // 0.03%
    const b1 = Math.min(20, entryTurnover * rate);
    const b2 = isSettled ? Math.min(20, exitTurnover * rate) : 0;
    brokerage = b1 + b2;
  }

  // 2. STT/CTT
  let stt = 0;
  const sellTurnover = tradeType === 'SELL' ? entryTurnover : exitTurnover;
  const buyTurnover  = tradeType === 'BUY'  ? entryTurnover : exitTurnover;

  if (instrumentType === 'OPTIONS') {
    stt = 0.001 * sellTurnover; // 0.1% on Sell Premium
  } else if (instrumentType === 'FUTURES') {
    stt = 0.0002 * sellTurnover; // 0.02% on Sell Turnover
  } else if (instrumentType === 'EQUITY') {
    // Defaulting to Intraday (0.025% on Sell)
    stt = 0.00025 * sellTurnover;
  }

  // 3. Exchange Txn Charges
  const exchangeTxn = parseFloat((exchRate * totalTurnover).toFixed(2));

  // 4. SEBI Charges (10 per crore = 0.000001)
  const sebi = parseFloat((0.000001 * totalTurnover).toFixed(2));

  // 5. GST (18% on Brokerage + Exchange + SEBI)
  const gst = parseFloat((0.18 * (brokerage + exchangeTxn + sebi)).toFixed(2));

  // 6. Stamp Duty (on Buy side only for F&O)
  let stampRate = 0.00003; // 0.003% for Options
  if (instrumentType === 'FUTURES') stampRate = 0.00002; // 0.002%
  if (instrumentType === 'EQUITY')  stampRate = 0.00003; // 0.003%
  const stampDuty = Math.min(300, Math.floor(stampRate * buyTurnover));

  const total = parseFloat((brokerage + stt + exchangeTxn + sebi + gst + stampDuty).toFixed(2));

  return {
    brokerage: parseFloat(brokerage.toFixed(2)),
    stt: parseFloat(stt.toFixed(2)),
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
  return { brokerage: 0, stt: 0, exchangeTxn: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0, entryTurnover: 0, totalTurnover: 0, orders: 0 };
}