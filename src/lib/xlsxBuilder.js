/**
 * xlsxBuilder.js — Zero-dependency XLSX generator
 * Creates a valid .xlsx (Office Open XML) file using Node's built-in zlib.
 * An XLSX is a ZIP containing XML files.
 */

import { deflateRawSync } from 'zlib';
import { Buffer } from 'buffer';

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── ZIP builder ───────────────────────────────────────────────────────────────
function zipEntry(name, data) {
  const nameBuf  = Buffer.from(name, 'utf8');
  const rawBuf   = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const compBuf  = deflateRawSync(rawBuf, { level: 6 });
  const crc      = crc32(rawBuf);
  const now      = new Date();
  const dosDate  = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime  = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);  // local file header sig
  local.writeUInt16LE(20, 4);           // version needed
  local.writeUInt16LE(0, 6);            // flags
  local.writeUInt16LE(8, 8);            // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compBuf.length, 18);
  local.writeUInt32LE(rawBuf.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  return { name: nameBuf, local, comp: compBuf, crc, dosDate, dosTime, rawLen: rawBuf.length };
}

function buildZip(files) {
  const entries = files.map(([name, data]) => zipEntry(name, data));
  const parts = [];
  const offsets = [];
  let offset = 0;

  for (const e of entries) {
    offsets.push(offset);
    parts.push(e.local, e.comp);
    offset += e.local.length + e.comp.length;
  }

  const cdStart = offset;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const cd = Buffer.alloc(46 + e.name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);  cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);   cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(e.dosTime, 12);
    cd.writeUInt16LE(e.dosDate, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.comp.length, 20);
    cd.writeUInt32LE(e.rawLen, 24);
    cd.writeUInt16LE(e.name.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offsets[i], 42);
    e.name.copy(cd, 46);
    parts.push(cd);
    offset += cd.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function esc(v) {
  if (v == null) return '';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Shared strings table
function buildSST(strings) {
  const items = strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

// Column letter from 1-based index
function colLetter(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

// Cell reference
function cellRef(col, row) { return colLetter(col) + row; }

// ── Style definitions ─────────────────────────────────────────────────────────
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="5">
    <font><sz val="10"/><name val="Arial"/></font>
    <font><sz val="10"/><name val="Arial"/><b/></font>
    <font><sz val="11"/><name val="Arial"/><b/><color rgb="FFFFFFFF"/></font>
    <font><sz val="10"/><name val="Arial"/><color rgb="FF22C55E"/></font>
    <font><sz val="10"/><name val="Arial"/><color rgb="FFEF4444"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8F5E9"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFDE8E8"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFDDDDDD"/></left><right style="thin"><color rgb="FFDDDDDD"/></right><top style="thin"><color rgb="FFDDDDDD"/></top><bottom style="thin"><color rgb="FFDDDDDD"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10">
    <xf numFmtId="0"  fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="0"  fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0"  fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
    <xf numFmtId="4"  fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="4"  fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="4"  fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="0"  fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0"  fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

// Style indices
const S = { normal:0, header:1, bold:2, money:3, win:4, loss:5, date:6, center:7, title:8, pct:9 };

/**
 * Build a complete .xlsx file buffer.
 * @param {object[]} trades  - Array of trade objects
 * @param {object}   summary - Summary stats { totalPnl, totalTrades, winners, losers, totalCharges, winRate }
 * @param {object}   user    - { name, email }
 * @param {string}   period  - e.g. "FY 2024-25" or date range string
 */
export function buildXlsx(trades, summary, user, period) {
  // ── Sheet 1: Trade Book ────────────────────────────────────────────────────
  const strings = [];
  const strIdx  = (v) => { const s = String(v ?? ''); const i = strings.length; strings.push(s); return i; };

  const HEADERS = [
    'Date','Symbol','Underlying','Type','Option','Strike','Expiry',
    'Lots','Qty','Entry ₹','Exit ₹','Stop Loss','Target',
    'Gross P&L','Charges','Net P&L','Return %','Status',
    'Strategy','Exchange','Emotion Before','Discipline','Mistakes','Notes'
  ];

  const rows = [];

  // Title row
  rows.push({ cells: [{ v: strIdx(`Trade Journal — ${user?.name || 'Trader'} | ${period}`), t:'s', s:S.title, span: HEADERS.length }] });
  rows.push({ cells: [{ v: strIdx(`Generated: ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}`), t:'s', s:S.normal }] });
  rows.push({ cells: [] }); // blank

  // Header row
  rows.push({ cells: HEADERS.map(h => ({ v: strIdx(h), t:'s', s:S.header })) });

  // Data rows
  for (const t of trades) {
    const pnl     = t.netPnl || 0;
    const gross   = t.pnl    || 0;
    const charges = t.charges || 0;
    const qty     = (t.lotSize||1) * (t.quantity||1);
    const invested = (t.entryPrice||0) * qty;
    const retPct  = invested > 0 && t.exitPrice ? (gross / invested) : null;
    const mStyle  = pnl > 0 ? S.win : pnl < 0 ? S.loss : S.money;
    const mistakes = (t.psychology?.mistakeTags || []).map(m => m.replace(/_/g,' ')).join(', ');

    rows.push({ cells: [
      { v: t.exitDate ? excelDate(new Date(t.exitDate)) : excelDate(new Date(t.entryDate)), t:'n', s:S.date },
      { v: strIdx(t.symbol || t.underlying), t:'s', s:S.normal },
      { v: strIdx(t.underlying || ''), t:'s', s:S.normal },
      { v: strIdx(t.tradeType || ''), t:'s', s:S.center },
      { v: strIdx(t.optionType || ''), t:'s', s:S.center },
      { v: t.strikePrice || 0, t:'n', s:S.normal },
      { v: t.expiryDate ? excelDate(new Date(t.expiryDate)) : '', t: t.expiryDate ? 'n' : 's', s: t.expiryDate ? S.date : S.normal },
      { v: t.quantity || 1, t:'n', s:S.normal },
      { v: qty, t:'n', s:S.normal },
      { v: t.entryPrice || 0, t:'n', s:S.money },
      { v: t.exitPrice  || '', t: t.exitPrice ? 'n' : 's', s: t.exitPrice ? S.money : S.normal },
      { v: t.stopLoss   || '', t: t.stopLoss  ? 'n' : 's', s: t.stopLoss  ? S.money : S.normal },
      { v: t.target     || '', t: t.target    ? 'n' : 's', s: t.target    ? S.money : S.normal },
      { v: gross,   t:'n', s:S.money },
      { v: charges, t:'n', s:S.money },
      { v: pnl,     t:'n', s:mStyle },
      { v: retPct !== null ? retPct : '', t: retPct !== null ? 'n' : 's', s: retPct !== null ? S.pct : S.normal },
      { v: strIdx(t.status || ''), t:'s', s:S.center },
      { v: strIdx(t.strategy || ''), t:'s', s:S.normal },
      { v: strIdx(t.exchange || 'NSE'), t:'s', s:S.center },
      { v: strIdx(t.psychology?.emotionBefore || ''), t:'s', s:S.normal },
      { v: t.psychology?.disciplineRating ?? '', t: t.psychology?.disciplineRating != null ? 'n' : 's', s:S.normal },
      { v: strIdx(mistakes), t:'s', s:S.normal },
      { v: strIdx(t.notes || ''), t:'s', s:S.normal },
    ]});
  }

  // Totals row
  const dataStart = 5, dataEnd = 4 + trades.length;
  rows.push({ cells: [] }); // blank
  const totRow = dataEnd + 2;
  rows.push({ cells: [
    { v: strIdx('TOTALS'), t:'s', s:S.bold },
    ...Array(12).fill({ v:'', t:'s', s:S.normal }),
    { v: summary.grossPnl || trades.reduce((s,t)=>s+(t.pnl||0),0), t:'n', s:S.money },
    { v: summary.totalCharges || trades.reduce((s,t)=>s+(t.charges||0),0), t:'n', s:S.money },
    { v: summary.totalPnl || trades.reduce((s,t)=>s+(t.netPnl||0),0), t:'n', s:S.win },
  ]});

  // ── Sheet 2: Summary ──────────────────────────────────────────────────────
  const summRows = [];
  const sh = (label, value, style=S.normal) => {
    summRows.push({ cells: [
      { v: strIdx(label), t:'s', s:S.bold },
      { v: typeof value === 'number' ? value : strIdx(String(value ?? '—')), t: typeof value === 'number' ? 'n' : 's', s: style },
    ]});
  };

  summRows.push({ cells: [{ v: strIdx('P&L SUMMARY STATEMENT'), t:'s', s:S.title, span:2 }] });
  summRows.push({ cells: [{ v: strIdx(`${user?.name || 'Trader'} | ${user?.email || ''}`), t:'s', s:S.normal }] });
  summRows.push({ cells: [{ v: strIdx(`Period: ${period}`), t:'s', s:S.normal }] });
  summRows.push({ cells: [] });

  sh('Total Trades',    summary.totalTrades || trades.length);
  sh('Winning Trades',  summary.winners || trades.filter(t=>(t.netPnl||0)>0).length);
  sh('Losing Trades',   summary.losers  || trades.filter(t=>(t.netPnl||0)<0).length);
  sh('Win Rate %',      parseFloat((summary.winRate||0).toFixed(2)), S.pct);
  summRows.push({ cells: [] });
  sh('Gross P&L ₹',     parseFloat((summary.grossPnl || trades.reduce((s,t)=>s+(t.pnl||0),0)).toFixed(2)), S.money);
  sh('Total Charges ₹', parseFloat((summary.totalCharges || trades.reduce((s,t)=>s+(t.charges||0),0)).toFixed(2)), S.money);
  sh('Net P&L ₹',       parseFloat((summary.totalPnl    || trades.reduce((s,t)=>s+(t.netPnl||0),0)).toFixed(2)),
     (summary.totalPnl||0) >= 0 ? S.win : S.loss);
  summRows.push({ cells: [] });
  sh('Avg Win ₹',       parseFloat((summary.avgWin  ||0).toFixed(2)), S.win);
  sh('Avg Loss ₹',      parseFloat((summary.avgLoss ||0).toFixed(2)), S.loss);
  sh('Best Trade ₹',    parseFloat((summary.maxWin  ||0).toFixed(2)), S.win);
  sh('Worst Trade ₹',   parseFloat((summary.maxLoss ||0).toFixed(2)), S.loss);
  summRows.push({ cells: [] });
  sh('Note', 'This statement is generated from TradeLog journal. For tax purposes, consult a CA.');

  // ── Build XML worksheets ──────────────────────────────────────────────────
  function buildSheet(sheetRows, colWidths, mergeCells=[]) {
    const rowXml = sheetRows.map((row, ri) => {
      if (!row.cells.length) return `<row r="${ri+1}"/>`;
      const cellsXml = row.cells.map((c, ci) => {
        if (!c || (c.t === 's' && c.v === '' && !c.span)) return '';
        const ref = cellRef(ci+1, ri+1);
        const s   = c.s ?? 0;
        const t   = c.t ?? 'n';
        const val = t === 's' ? `<v>${c.v}</v>` : c.v !== '' ? `<v>${c.v}</v>` : '';
        return `<c r="${ref}" s="${s}"${t==='s'?' t="s"':''}>` + val + `</c>`;
      }).join('');
      return `<row r="${ri+1}">${cellsXml}</row>`;
    }).join('');

    const colsXml = colWidths.map((w,i) =>
      `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`
    ).join('');

    const mergeXml = mergeCells.length
      ? `<mergeCells count="${mergeCells.length}">${mergeCells.map(m=>`<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0" tabSelected="1"><selection activeCell="A1"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${colsXml}</cols>
  <sheetData>${rowXml}</sheetData>
  ${mergeXml}
  <pageSetup paperSize="9" orientation="landscape" fitToPage="1" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
  }

  const sheet1ColWidths = [11,22,14,7,7,9,11,6,6,9,9,9,9,11,9,11,9,8,14,8,14,11,20,30];
  const sheet2ColWidths = [22,18];

  // Merge title rows
  const ncols = HEADERS.length;
  const merges1 = [`A1:${colLetter(ncols)}1`];
  const merges2 = ['A1:B1'];

  const sst  = buildSST(strings);
  const ws1  = buildSheet(rows, sheet1ColWidths, merges1);
  const ws2  = buildSheet(summRows, sheet2ColWidths, merges2);

  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Trade Book" sheetId="1" r:id="rId1"/>
    <sheet name="P&amp;L Summary" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"           ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml"  ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml"  ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml"      ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml"             ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  return buildZip([
    ['[Content_Types].xml',          contentTypes],
    ['_rels/.rels',                  pkgRels],
    ['xl/workbook.xml',              wb],
    ['xl/_rels/workbook.xml.rels',   wbRels],
    ['xl/worksheets/sheet1.xml',     ws1],
    ['xl/worksheets/sheet2.xml',     ws2],
    ['xl/sharedStrings.xml',         sst],
    ['xl/styles.xml',                STYLES_XML],
  ]);
}

// Excel date serial (days since 1900-01-01, with Lotus 1-2-3 leap year bug)
function excelDate(d) {
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((d.getTime() - epoch) / 86400000);
}