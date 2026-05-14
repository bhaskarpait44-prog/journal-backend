/**
 * csvParser.js — Universal Indian Broker CSV Parser
 * Supports: Zerodha, Upstox, Angel One, Fyers, Groww, 5paisa,
 *           ICICI Direct, HDFC, Sharekhan, Kotak, AliceBlue, Dhan, Generic
 */

import { calcCharges } from './calcCharges.js';

export const BROKER_NAMES = {
  UPSTOX:    'Upstox',
  ANGEL:     'Angel One',
  FYERS:     'Fyers',
  GROWW:     'Groww',
  FIVEPAISA: '5paisa',
  ICICI:     'ICICI Direct',
  HDFC:      'HDFC Securities',
  SHAREKHAN: 'Sharekhan',
  KOTAK:     'Kotak Securities',
  ALICEBLUE: 'Alice Blue',
  DHAN:      'Dhan',
  DHAN_PNL:  'Dhan (P&L)',
  GENERIC:   'Generic',
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

function parseDate(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  if (!s || s === '-' || s === 'N/A') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s);
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m1) return new Date(`${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`);
  const m2 = s.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{2,4})/);
  if (m2) { const yr = m2[3].length === 2 ? '20' + m2[3] : m2[3]; return new Date(`${m2[1]} ${m2[2]} ${yr}`); }
  const m3 = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m3) return new Date(`${m3[1]}-${m3[2]}-${m3[3]}`);
  const m4 = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m4) return new Date(`${m4[1]} ${m4[2]} ${m4[3]}`);
  return new Date(s);
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
  if (!sym) return '';
  const s = sym.toUpperCase().trim();
  if (s.endsWith('CE') || s.endsWith(' CE')) return 'CE';
  if (s.endsWith('PE') || s.endsWith(' PE')) return 'PE';
  if (s.includes('CALL')) return 'CE';
  if (s.includes('PUT'))  return 'PE';
  const parts = s.split(/\s+/);
  for (const p of parts) {
    if (p === 'CE') return 'CE';
    if (p === 'PE') return 'PE';
  }
  return '';
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
  const m1 = withoutExch.match(/^([A-Z]+)\d{2}[A-Z]{3}\d+(CE|PE)$/i);
  if (m1) return m1[1];
  const m2 = withoutExch.match(/^([A-Z]+)\d{6,}(CE|PE)$/i);
  if (m2) return m2[1];
  const parts = withoutExch.split(/\s+/);
  if (parts.length > 1 && /^[A-Z&]+$/.test(parts[0])) return parts[0];
  return withoutExch.replace(/\d+/g, '').replace(/(CE|PE|CALL|PUT)$/i, '').trim();
}

function normTradeType(v) {
  const s = (v || '').toString().toUpperCase().trim();
  if (['B','BUY','PURCHASE','BOUGHT','BUY_ORDER','LONG'].includes(s)) return 'BUY';
  if (['S','SELL','SOLD','SELL_ORDER','SHORT','SL','SQUARE OFF','SQUAREOFF'].includes(s)) return 'SELL';
  if (s.startsWith('B')) return 'BUY';
  if (s.startsWith('S')) return 'SELL';
  return 'BUY';
}

function inferExpiryFromSymbol(sym) {
  if (!sym) return null;
  const MONTHS = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const m1 = sym.toUpperCase().match(/([A-Z]+)(\d{2})([A-Z]{3})(\d+)(CE|PE)/);
  if (m1) {
    const year = 2000 + parseInt(m1[2]);
    const month = MONTHS[m1[3]];
    if (month !== undefined) {
      const d = new Date(year, month + 1, 0);
      while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
      return d;
    }
  }
  const m2 = sym.toUpperCase().match(/([A-Z]+)(\d{2})(\d)(\d{2})(\d+)(CE|PE)/);
  if (m2) {
    const year = 2000 + parseInt(m2[2]);
    const month = parseInt(m2[3]) - 1;
    const day = parseInt(m2[4]);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return new Date(year, month, day);
  }
  const m3 = sym.match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})/i);
  if (m3) { const yr = m3[3].length === 2 ? '20' + m3[3] : m3[3]; return new Date(`${m3[1]} ${m3[2]} ${yr}`); }
  return null;
}

function detectBroker(headers) {
  const h = headers.map(norm);
  const any = (...keys) => keys.some(k => h.some(x => x.includes(norm(k))));

  if (any('tradingsymbol') && any('trade_date','order_execution_time') && any('trade_type')) return BROKER_NAMES.ZERODHA;
  if (any('security_name') && (any('buy_avg','avg_buy_price','buy_average') || any('realized_profit','realised_profit'))) return BROKER_NAMES.DHAN_PNL;
  if (any('exchange_segment') && any('tradingsymbol') && any('transaction_type')) return BROKER_NAMES.DHAN;
  if (any('security_id') && any('transaction_type') && any('quantity')) return BROKER_NAMES.DHAN;
  if (any('instrument_name','scrip_name') && any('transaction_type') && any('trade_date','trade_time')) return BROKER_NAMES.UPSTOX;
  if (any('trade_price','tradeprice') && any('side','direction') && any('trade_date')) return BROKER_NAMES.FYERS;
  if (any('name') && any('buy/sell','buy_sell') && any('segment') && any('trade price','trade_price','trade_value','trade value')) return BROKER_NAMES.GROWW;
  if (any('instrument_type') && any('order_execution_date','trade_execution_time')) return BROKER_NAMES.GROWW;
  if (any('symbol_name','scripname') && any('buy_sell','buysell')) return BROKER_NAMES.ANGEL;
  if (any('trade_no','contract_note') && any('traded_qty')) return BROKER_NAMES.HDFC;
  if (any('buy_sell_indicator') && any('order_no')) return BROKER_NAMES.KOTAK;
  if (any('scripname','scrip_name') && any('tradedate') && any('rate')) return BROKER_NAMES.SHAREKHAN;
  if (any('scripcode','scrip_code') && any('rate','traded_price')) return BROKER_NAMES.FIVEPAISA;
  if (any('buy_avg','sell_avg') || (any('scrip_name') && any('buy_qty','sell_qty'))) return BROKER_NAMES.ICICI;
  if (any('avg_prc','avg_price') && any('qty') && any('side')) return BROKER_NAMES.ALICEBLUE;
  return BROKER_NAMES.GENERIC;
}

function normalizeZerodha(row) {
  const sym = pick(row, 'tradingsymbol', 'symbol');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'trade_type')),
    quantity: safeInt(pick(row, 'quantity')), entryPrice: safeFloat(pick(row, 'price', 'average_price')),
    entryDate: parseDate(pick(row, 'trade_date', 'order_execution_time')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'fees')) };
}

function normalizeUpstox(row) {
  const sym = pick(row, 'instrument_name', 'scrip_name', 'symbol', 'trading_symbol', 'tradingsymbol');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'transaction_type', 'buy_sell', 'trade_type')),
    quantity: safeInt(pick(row, 'quantity', 'qty', 'traded_qty')),
    entryPrice: safeFloat(pick(row, 'average_price', 'price', 'trade_price', 'avg_price', 'traded_price')),
    entryDate: parseDate(pick(row, 'trade_date', 'order_time', 'trade_time', 'execution_time')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'fees')) };
}

function normalizeAngel(row) {
  const sym = pick(row, 'symbol_name', 'scripname', 'symbol', 'scrip_name', 'trading_symbol');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy_sell', 'buysell', 'trade_type', 'transaction_type')),
    quantity: safeInt(pick(row, 'net_qty', 'quantity', 'qty', 'traded_qty')),
    entryPrice: safeFloat(pick(row, 'avg_cost', 'average_price', 'price', 'rate', 'traded_rate')),
    entryDate: parseDate(pick(row, 'trade_date', 'date', 'order_date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges')) };
}

function normalizeFyers(row) {
  const rawSym = pick(row, 'symbol', 'scrip', 'tradingsymbol', 'trading_symbol');
  const sym = rawSym.includes(':') ? rawSym.split(':')[1] : rawSym;
  return { symbol: sym, tradeType: normTradeType(pick(row, 'side', 'direction', 'buy_sell', 'type', 'trade_type')),
    quantity: safeInt(pick(row, 'qty', 'quantity', 'traded_qty')),
    entryPrice: safeFloat(pick(row, 'trade_price', 'price', 'avg_price', 'traded_price', 'average_price')),
    entryDate: parseDate(pick(row, 'trade_date', 'orderdate', 'date', 'order_date_time')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'taxes')) };
}

function normalizeGroww(row) {
  const sym = pick(row, 'name', 'instrument_name', 'symbol', 'trading_symbol', 'scrip', 'tradingsymbol');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy/sell', 'buy_sell', 'trade_type', 'transaction_type', 'side')),
    quantity: safeInt(pick(row, 'quantity/lot', 'quantity', 'qty', 'lot', 'traded_quantity')),
    entryPrice: safeFloat(pick(row, 'trade price', 'trade_price', 'price', 'average_price', 'avg_price', 'execution_price')),
    entryDate: parseDate(pick(row, 'date', 'order_execution_date', 'trade_date', 'trade_execution_time', 'order_date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'total_charges')) };
}

function normalize5paisa(row) {
  const sym = pick(row, 'scrip_name', 'scripname', 'symbol', 'scrip', 'trading_symbol', 'instrument_name');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy_sell', 'buysell', 'transaction_type', 'side')),
    quantity: safeInt(pick(row, 'qty', 'quantity', 'traded_qty', 'net_qty')),
    entryPrice: safeFloat(pick(row, 'rate', 'traded_price', 'price', 'avg_price', 'average_price')),
    entryDate: parseDate(pick(row, 'trade_date', 'order_date', 'date', 'execution_date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges')) };
}

function normalizeICICI(row) {
  const sym = pick(row, 'scrip_name', 'symbol', 'description', 'contract_description', 'instrument');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy_sell', 'action', 'transaction_type', 'side')),
    quantity: safeInt(pick(row, 'quantity', 'qty', 'buy_qty', 'sell_qty', 'traded_qty')),
    entryPrice: safeFloat(pick(row, 'average_price', 'price', 'buy_avg', 'sell_avg', 'rate', 'traded_price')),
    entryDate: parseDate(pick(row, 'trade_date', 'date', 'order_date', 'settlement_date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'total_charges')) };
}

function normalizeHDFC(row) {
  const sym = pick(row, 'scrip_name', 'symbol', 'description', 'contract_note', 'instrument');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy_sell', 'transaction_type', 'side', 'action')),
    quantity: safeInt(pick(row, 'traded_qty', 'quantity', 'qty', 'executed_qty')),
    entryPrice: safeFloat(pick(row, 'traded_price', 'price', 'average_price', 'rate')),
    entryDate: parseDate(pick(row, 'trade_date', 'date', 'execution_date', 'order_date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'total_charges', 'net_amount')) };
}

function normalizeSharekhan(row) {
  const sym = pick(row, 'scripname', 'scrip_name', 'symbol', 'contract');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy_sell', 'buysell', 'side', 'transaction')),
    quantity: safeInt(pick(row, 'quantity', 'qty', 'traded_qty')),
    entryPrice: safeFloat(pick(row, 'rate', 'price', 'average_price', 'traded_rate')),
    entryDate: parseDate(pick(row, 'tradedate', 'trade_date', 'date', 'transaction_date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'service_tax', 'total_charges')) };
}

function normalizeKotak(row) {
  const sym = pick(row, 'scrip_name', 'symbol', 'instrument', 'contract');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'buy_sell_indicator', 'buy_sell', 'side', 'transaction_type')),
    quantity: safeInt(pick(row, 'quantity', 'qty', 'traded_qty', 'total_qty')),
    entryPrice: safeFloat(pick(row, 'price', 'average_price', 'rate', 'traded_price')),
    entryDate: parseDate(pick(row, 'trade_date', 'order_date', 'date')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges')) };
}

function normalizeAliceBlue(row) {
  const sym = pick(row, 'symbol', 'scrip', 'trading_symbol', 'tradingsymbol');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'side', 'buy_sell', 'transaction_type', 'trade_type')),
    quantity: safeInt(pick(row, 'qty', 'quantity', 'filled_qty')),
    entryPrice: safeFloat(pick(row, 'avg_prc', 'avg_price', 'price', 'average_price', 'traded_price')),
    entryDate: parseDate(pick(row, 'time', 'trade_date', 'date', 'order_date', 'fill_time')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges')) };
}

function normalizeDhan(row) {
  const sym = pick(row, 'tradingsymbol', 'symbol', 'instrument_name', 'custom_symbol');
  return { symbol: sym, tradeType: normTradeType(pick(row, 'transaction_type', 'buy_sell', 'side')),
    quantity: safeInt(pick(row, 'quantity', 'qty', 'filled_qty', 'traded_quantity')),
    entryPrice: safeFloat(pick(row, 'price', 'avg_price', 'average_price', 'traded_price', 'fill_price')),
    entryDate: parseDate(pick(row, 'exchange_time', 'trade_date', 'create_time', 'order_date', 'dma_trade_time')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage', 'charges', 'fees')) };
}

function normalizeDhanPnl(row) {
  const sym     = pick(row, 'security_name', 'scrip_name', 'symbol', 'tradingsymbol', 'instrument');
  const buyQty  = safeInt(pick(row, 'buy_qty', 'buy_quantity', 'quantity'));
  const sellQty = safeInt(pick(row, 'sell_qty', 'sell_quantity'));
  const qty     = buyQty || sellQty || 1;
  const buyAvg  = safeFloat(pick(row, 'buy_avg', 'avg_buy_price', 'buy_average', 'buy_price'));
  const sellAvg = safeFloat(pick(row, 'sell_avg', 'avg_sell_price', 'sell_average', 'sell_price'));
  const pnl     = safeFloat(pick(row, 'realized_profit', 'realised_profit', 'net_profit', 'profit_loss'));
  const date    = parseDate(pick(row, 'trade_date', 'date', 'settlement_date', 'close_date', 'order_date'));
  const tradeType  = buyQty >= sellQty ? 'BUY' : 'SELL';
  const entryPrice = tradeType === 'BUY' ? buyAvg : sellAvg;
  const exitPrice  = tradeType === 'BUY' ? sellAvg : buyAvg;
  return { symbol: sym, tradeType, quantity: qty, entryPrice, exitPrice,
    entryDate: date, exitDate: date, status: 'CLOSED', pnl, netPnl: pnl,
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'charges', 'brokerage', 'taxes', 'total_charges')) };
}

function normalizeGeneric(row) {
  const sym = pick(row,
    'symbol','tradingsymbol','trading_symbol','scrip','scrip_name','symbol_name',
    'name','instrument','instrument_name','contract','description','product'
  );
  return { symbol: sym,
    tradeType: normTradeType(pick(row, 'trade_type','transaction_type','buy_sell','buysell','buy/sell','side','direction','action','type','b_s')),
    quantity: safeInt(pick(row, 'quantity','qty','quantity/lot','net_qty','traded_qty','filled_qty','executed_qty','lots','no_of_lots')),
    entryPrice: safeFloat(pick(row, 'price','average_price','avg_price','rate','traded_price','trade_price','trade price','execution_price','avg_prc','fill_price','net_rate')),
    entryDate: parseDate(pick(row, 'trade_date','date','order_date','execution_date','transaction_date','order_execution_time','trade_time','fill_time','order_time')),
    underlying: extractUnderlying(sym), optionType: extractOptionType(sym), strikePrice: extractStrike(sym),
    lotSize: 1, charges: safeFloat(pick(row, 'brokerage','charges','fees','total_charges','net_amount')) };
}

const NORMALIZERS = {
  [BROKER_NAMES.ZERODHA]:   normalizeZerodha,
  [BROKER_NAMES.UPSTOX]:    normalizeUpstox,
  [BROKER_NAMES.ANGEL]:     normalizeAngel,
  [BROKER_NAMES.FYERS]:     normalizeFyers,
  [BROKER_NAMES.GROWW]:     normalizeGroww,
  [BROKER_NAMES.FIVEPAISA]: normalize5paisa,
  [BROKER_NAMES.ICICI]:     normalizeICICI,
  [BROKER_NAMES.HDFC]:      normalizeHDFC,
  [BROKER_NAMES.SHAREKHAN]: normalizeSharekhan,
  [BROKER_NAMES.KOTAK]:     normalizeKotak,
  [BROKER_NAMES.ALICEBLUE]: normalizeAliceBlue,
  [BROKER_NAMES.DHAN]:      normalizeDhan,
  [BROKER_NAMES.DHAN_PNL]:  normalizeDhanPnl,
  [BROKER_NAMES.GENERIC]:   normalizeGeneric,
};

export function parseCSVBuffer(buffer, userId) {

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
    'symbol','tradingsymbol','scrip','instrument','qty','quantity','name',
    'price','rate','date','buy','sell','trade','side','type','segment',
    'isin','security','transaction','profit','loss','realized'
  ];
  let headerIdx = 0, bestHits = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const lower = lines[i].toLowerCase();
    const hits = FIELD_KEYWORDS.filter(f => lower.includes(f)).length;
    if (hits > bestHits) { bestHits = hits; headerIdx = i; }
    if (hits >= 3) break;
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

  const broker    = detectBroker(rawHeaders);
  const normalize = NORMALIZERS[broker] || normalizeGeneric;
  const trades    = [];
  const skipped   = [];

  for (let i = 0; i < records.length; i++) {
    try {
      const t = normalize(records[i]);

      if (!t.symbol) { skipped.push({ row: i+2, reason: 'Missing symbol' }); continue; }
      if (!t.entryDate || isNaN(new Date(t.entryDate))) { skipped.push({ row: i+2, reason: 'Invalid date', symbol: t.symbol }); continue; }
      if (!t.entryPrice || t.entryPrice === 0) { skipped.push({ row: i+2, reason: 'Zero price', symbol: t.symbol }); continue; }

      const optionType = t.optionType || extractOptionType(t.symbol);
      if (!optionType) { skipped.push({ row: i+2, reason: 'Not an options trade (CE/PE/CALL/PUT not found)', symbol: t.symbol }); continue; }

      const exchange   = t.exchange || 'NSE';
      const lotSize    = t.lotSize  || 1;
      const qty        = t.quantity || 1;
      const tradeType  = t.tradeType || 'BUY';
      const entryPrice = t.entryPrice;
      const exitPrice  = t.exitPrice && t.exitPrice > 0 ? t.exitPrice : null;

      // Always auto-calculate Zerodha F&O Options charges — ignore any CSV charge columns
      const charges = exitPrice
        ? calcCharges(entryPrice, exitPrice, lotSize, qty, tradeType, exchange).total
        : calcCharges(entryPrice, 0, lotSize, qty, tradeType, exchange).total;

      const tradeDoc = {
        userId,
        source:      'csv',
        broker,
        exchange,
        symbol:      t.symbol,
        underlying:  (t.underlying || extractUnderlying(t.symbol) || t.symbol).toUpperCase(),
        tradeType,
        optionType,
        strikePrice: t.strikePrice || extractStrike(t.symbol),
        expiryDate:  t.expiryDate || inferExpiryFromSymbol(t.symbol) || new Date(),
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
        tradeDoc.netPnl    = t.netPnl || (t.pnl || 0) - charges;
      }

      trades.push(tradeDoc);
    } catch (err) {
      skipped.push({ row: i+2, reason: err.message });
    }
  }

  return { broker, trades, skipped };
}