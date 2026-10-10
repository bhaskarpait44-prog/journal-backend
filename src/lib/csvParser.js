/**
 * csvParser.js — Dedicated Dhan Broker CSV Parser
 * Supported format: Dhan Position / P&L CSV:
 * "Name","Product","Qty","Buy Avg Price","Sell Avg Price","LTP","P&L"
 */

import { calcCharges } from './calcCharges.js';

export const BROKER_NAMES = {
  DHAN: 'Dhan',
};

const norm = (s) => (s || '').toString().toLowerCase().trim().replace(/[\s\-\.\/]+/g, '_');

function pick(row, ...keys) {
  for (const k of keys) {
    for (const variant of [k, k.toLowerCase(), k.toUpperCase(), norm(k)]) {
      if (row[variant] !== undefined && row[variant] !== null && row[variant].toString().trim() !== '') {
        return row[variant].toString().trim();
      }
    }
    const normK = norm(k);
    for (const rowKey of Object.keys(row)) {
      if (norm(rowKey) === normK && row[rowKey] !== undefined && row[rowKey].toString().trim() !== '') {
        return row[rowKey].toString().trim();
      }
    }
  }
  return '';
}

const MONTH_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function parseDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  const s = raw.toString().trim();
  if (!s || s === '-' || s === 'N/A' || s === 'null' || s === 'undefined') return null;

  // 1. ISO or YYYY-MM-DD / YYYY/MM/DD with optional time
  const isoMatch = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mo = parseInt(isoMatch[2], 10) - 1;
    const da = parseInt(isoMatch[3], 10);
    const hr = isoMatch[4] ? parseInt(isoMatch[4], 10) : 0;
    const mi = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0;
    const se = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
    const d = new Date(yr, mo, da, hr, mi, se);
    if (!isNaN(d.getTime())) return d;
  }

  // 2. Numeric DMY: DD/MM/YYYY or DD-MM-YYYY with optional time
  const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmyMatch) {
    const da = parseInt(dmyMatch[1], 10);
    const mo = parseInt(dmyMatch[2], 10) - 1;
    const yr = parseInt(dmyMatch[3], 10);
    const hr = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
    const mi = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
    const se = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;
    const d = new Date(yr, mo, da, hr, mi, se);
    if (!isNaN(d.getTime())) return d;
  }

  // 3. DD-Mon-YYYY or DD Mon YYYY or DD/Mon/YYYY with optional time
  const monMatch = s.match(/^(\d{1,2})[\/\-\s]+([A-Za-z]{3})[\/\-\s]+(\d{2,4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (monMatch) {
    const da = parseInt(monMatch[1], 10);
    const mo = MONTH_MAP[monMatch[2].toLowerCase()];
    if (mo !== undefined) {
      let yr = parseInt(monMatch[3], 10);
      if (yr < 100) yr += 2000;
      const hr = monMatch[4] ? parseInt(monMatch[4], 10) : 0;
      const mi = monMatch[5] ? parseInt(monMatch[5], 10) : 0;
      const se = monMatch[6] ? parseInt(monMatch[6], 10) : 0;
      const d = new Date(yr, mo, da, hr, mi, se);
      if (!isNaN(d.getTime())) return d;
    }
  }

  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function safeFloat(v) {
  if (!v) return 0;
  const n = parseFloat(v.toString().replace(/[,₹\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function safeInt(v) {
  if (!v) return 0;
  const n = parseInt(v.toString().replace(/[,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function extractOptionType(sym) {
  if (!sym) return 'XX';
  const s = sym.toUpperCase().trim();
  if (s.endsWith('CE') || s.endsWith(' CE') || s.includes(' CALL') || s.endsWith('CALL')) return 'CE';
  if (s.endsWith('PE') || s.endsWith(' PE') || s.includes(' PUT') || s.endsWith('PUT')) return 'PE';
  const parts = s.split(/\s+/);
  for (const p of parts) {
    if (p === 'CE' || p === 'CALL') return 'CE';
    if (p === 'PE' || p === 'PUT') return 'PE';
  }
  return 'XX';
}

function detectInstrumentType(sym) {
  if (!sym) return 'EQUITY';
  const s = sym.toUpperCase().trim();
  if (s.includes('CE') || s.includes('PE') || s.includes('CALL') || s.includes('PUT')) return 'OPTIONS';
  if (s.includes('FUT')) return 'FUTURES';
  if (/[A-Z]+\d{2}[A-Z]{3}\d+(CE|PE)/.test(s)) return 'OPTIONS';
  if (/[A-Z]+\d{2}[A-Z]{3}FUT/.test(s)) return 'FUTURES';
  return 'EQUITY';
}

function extractStrike(sym) {
  if (!sym) return 0;
  const m1 = sym.match(/(\d{4,6})(CE|PE|CALL|PUT)$/i);
  if (m1) return parseFloat(m1[1]);
  const m2 = sym.match(/\b(\d{4,6})\b/g);
  if (m2 && m2.length) return parseFloat(m2.reduce((a, b) => parseInt(b) > parseInt(a) ? b : a));
  return 0;
}

function extractUnderlying(sym) {
  if (!sym) return '';
  const s = sym.toUpperCase().trim();
  const withoutExch = s.replace(/^(NSE|BSE|NFO|MCX|BFO)[:_]/, '');

  if (withoutExch.startsWith('OPT ') || withoutExch.startsWith('FUT ')) {
    const parts = withoutExch.split(/\s+/);
    if (parts.length > 1) return parts[1];
  }

  const m1 = withoutExch.match(/^([A-Z]+)\d{2}[A-Z]{3}\d+(CE|PE)$/i);
  if (m1) return m1[1];
  const m2 = withoutExch.match(/^([A-Z]+)\d{6,}(CE|PE)$/i);
  if (m2) return m2[1];
  const parts = withoutExch.split(/\s+/);
  if (parts.length > 1 && /^[A-Z&]+$/.test(parts[0])) return parts[0];
  return withoutExch.replace(/\d+/g, '').replace(/(CE|PE|CALL|PUT)$/i, '').trim();
}

function inferExpiryFromSymbol(sym) {
  if (!sym) return null;
  const MONTHS = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  
  const m0 = sym.match(/\b(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\b/i);
  if (m0) {
    const yr = m0[3].length === 2 ? 2000 + parseInt(m0[3], 10) : parseInt(m0[3], 10);
    const mo = MONTHS[m0[2].toUpperCase()];
    if (mo !== undefined) return new Date(yr, mo, parseInt(m0[1], 10));
  }

  const m0NoYear = sym.match(/\b(\d{1,2})\s+([A-Za-z]{3})\b/i);
  if (m0NoYear) {
    const mo = MONTHS[m0NoYear[2].toUpperCase()];
    if (mo !== undefined) {
      const yr = new Date().getFullYear();
      return new Date(yr, mo, parseInt(m0NoYear[1], 10));
    }
  }

  const m1 = sym.toUpperCase().match(/([A-Z]+)(\d{2})([A-Z]{3})(\d+)(CE|PE)/);
  if (m1) {
    const year = 2000 + parseInt(m1[2], 10);
    const month = MONTHS[m1[3]];
    if (month !== undefined) {
      const d = new Date(year, month + 1, 0);
      while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
      return d;
    }
  }
  return null;
}

function normalizeDhanRow(row, fallbackDate = null) {
  const sym = pick(row, 'name', 'security_name', 'scrip_name', 'symbol', 'tradingsymbol', 'custom_symbol', 'instrument_name');
  if (!sym || sym.toLowerCase().includes('net p&l') || sym.toLowerCase().includes('total')) {
    return { symbol: null };
  }

  const qty = safeInt(pick(row, 'qty', 'quantity', 'buy_qty', 'sell_qty', 'traded_quantity', 'filled_qty'));
  const buyAvg = safeFloat(pick(row, 'buy_avg_price', 'buy_avg', 'avg_buy_price', 'buy_average', 'buy_price', 'price'));
  const sellAvg = safeFloat(pick(row, 'sell_avg_price', 'sell_avg', 'avg_sell_price', 'sell_average', 'sell_price'));
  const pnlVal = pick(row, 'p&l', 'p_l', 'realized_profit', 'realised_profit', 'realised_p_l', 'net_profit', 'profit_loss');
  const pnl = pnlVal !== '' ? safeFloat(pnlVal) : null;
  const product = pick(row, 'product', 'product_type');

  // Trade execution date lookup - NEVER use contract expiry date for trade execution date!
  const entryDateRaw = pick(
    row,
    'date',
    'trade_date',
    'traded_date',
    'trade_date_time',
    'traded_at',
    'entry_date',
    'buy_date',
    'order_date',
    'order_execution_time',
    'execution_date',
    'execution_time',
    'exchange_time',
    'exchange_timestamp',
    'create_time',
    'created_at',
    'transaction_date',
    'txn_date',
    'settlement_date'
  );

  const exitDateRaw = pick(
    row,
    'exit_date',
    'sell_date',
    'exit_time',
    'square_off_date',
    'close_date'
  );

  let date = parseDate(entryDateRaw);
  if (!date || isNaN(date.getTime())) {
    if (fallbackDate) {
      const fb = parseDate(fallbackDate);
      date = (fb && !isNaN(fb.getTime())) ? fb : new Date();
    } else {
      date = new Date();
    }
  }

  const isClosed = buyAvg > 0 && sellAvg > 0;
  let exitDate = parseDate(exitDateRaw);
  if (!exitDate || isNaN(exitDate.getTime())) {
    exitDate = isClosed ? date : null;
  }

  const tradeType = (buyAvg > 0 || sellAvg === 0) ? 'BUY' : 'SELL';
  const entryPrice = tradeType === 'BUY' ? buyAvg : sellAvg;
  const exitPrice = isClosed ? sellAvg : null;
  const status = isClosed ? 'CLOSED' : 'OPEN';

  const calcPnl = pnl !== null ? pnl : (isClosed ? (exitPrice - entryPrice) * (qty || 1) : 0);

  return {
    symbol: sym,
    product,
    tradeType,
    quantity: qty || 1,
    entryPrice,
    exitPrice,
    entryDate: date,
    exitDate,
    status,
    pnl: calcPnl,
    netPnl: calcPnl,
    underlying: extractUnderlying(sym),
    optionType: extractOptionType(sym),
    strikePrice: extractStrike(sym),
    expiryDate: inferExpiryFromSymbol(sym),
    lotSize: 1,
    charges: safeFloat(pick(row, 'charges', 'brokerage', 'taxes', 'total_charges'))
  };
}

export function parseCSVBuffer(buffer, userId, fallbackDate = null) {
  function parseCSVText(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], next = text[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { row.push(field.trim()); field = ''; }
        else if (ch === '\n') {
          row.push(field.trim()); field = '';
          if (row.some(c => c !== '')) rows.push(row);
          row = [];
        } else { field += ch; }
      }
    }
    if (field.trim()) row.push(field.trim());
    if (row.some(c => c !== '')) rows.push(row);
    return rows;
  }

  const csvText = buffer.toString('utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  if (!lines.length) throw new Error('CSV file is empty');

  const FIELD_KEYWORDS = [
    'name', 'product', 'qty', 'quantity', 'buy avg price', 'buy_avg_price', 
    'sell avg price', 'sell_avg_price', 'ltp', 'p&l', 'p_l', 'tradingsymbol', 'symbol'
  ];
  let headerIdx = 0, bestHits = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const lower = lines[i].toLowerCase();
    const hits = FIELD_KEYWORDS.filter(f => lower.includes(f)).length;
    if (hits > bestHits) { bestHits = hits; headerIdx = i; }
    if (hits >= 2) break;
  }

  const allRows = parseCSVText(lines.slice(headerIdx).join('\n'));
  if (!allRows || allRows.length < 2) throw new Error('No data rows found in CSV');

  const rawHeaders = allRows[0].map(h => h.replace(/^["']|["']$/g, '').trim());
  const records = [];
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row.some(c => c !== '')) continue;
    const obj = {};
    rawHeaders.forEach((h, idx) => { obj[h] = (row[idx] || '').trim(); });
    records.push(obj);
  }

  if (records.length === 0) throw new Error('No data rows found in CSV');

  const trades  = [];
  const skipped = [];

  for (let i = 0; i < records.length; i++) {
    try {
      const t = normalizeDhanRow(records[i], fallbackDate);

      if (!t.symbol) { skipped.push({ row: i+2, reason: 'Missing symbol or summary row' }); continue; }
      if (!t.entryDate || isNaN(new Date(t.entryDate))) { skipped.push({ row: i+2, reason: 'Invalid date', symbol: t.symbol }); continue; }
      if (!t.entryPrice || t.entryPrice === 0) { skipped.push({ row: i+2, reason: 'Zero price', symbol: t.symbol }); continue; }

      const instrumentType = detectInstrumentType(t.symbol);
      const optionType     = instrumentType === 'OPTIONS' ? extractOptionType(t.symbol) : 'XX';

      const exchange   = t.exchange || 'NSE';
      const lotSize    = t.lotSize  || 1;
      const qty        = t.quantity || 1;
      const tradeType  = t.tradeType || 'BUY';
      const entryPrice = t.entryPrice;
      const exitPrice  = t.exitPrice && t.exitPrice > 0 ? t.exitPrice : null;

      const status = t.status || (exitPrice ? 'CLOSED' : 'OPEN');
      const charges = calcCharges(
        entryPrice, 
        exitPrice || 0, 
        lotSize, 
        qty, 
        tradeType, 
        exchange, 
        status, 
        instrumentType
      ).total;

      const tradeDoc = {
        userId,
        source:      'csv',
        broker:      BROKER_NAMES.DHAN,
        exchange,
        symbol:      t.symbol,
        underlying:  (t.underlying || extractUnderlying(t.symbol) || t.symbol).toUpperCase(),
        tradeType,
        instrumentType,
        optionType,
        strikePrice: instrumentType === 'OPTIONS' ? (t.strikePrice || extractStrike(t.symbol)) : null,
        expiryDate:  instrumentType !== 'EQUITY' ? (t.expiryDate || inferExpiryFromSymbol(t.symbol) || new Date()) : null,
        lotSize,
        quantity:    qty,
        entryPrice,
        entryDate:   t.entryDate,
        status:      t.status   || 'OPEN',
        charges,
      };

      if (exitPrice) {
        tradeDoc.exitPrice = exitPrice;
        tradeDoc.exitDate  = t.exitDate || t.entryDate;
        tradeDoc.status    = 'CLOSED';
        tradeDoc.pnl       = t.pnl    || 0;
        tradeDoc.netPnl    = (t.pnl || 0) - charges;
      }

      trades.push(tradeDoc);
    } catch (err) {
      skipped.push({ row: i+2, reason: err.message });
    }
  }

  return { broker: BROKER_NAMES.DHAN, trades, skipped };
}