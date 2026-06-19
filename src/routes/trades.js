import express from 'express';
import multer from 'multer';
import Trade from '../models/Trade.js';
import { protect } from '../middleware/auth.js';
import { parseCSVBuffer } from '../lib/csvParser.js';
import { calcCharges } from '../lib/calcCharges.js';
import { Op } from 'sequelize';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.use(protect);

router.get('/tags/popular', async (req, res) => {
  try {
    const trades = await Trade.findAll({
      where: { userId: req.user.id },
      attributes: ['tags'],
      raw: true
    });
    
    const tagCount = {};
    trades.forEach(t => {
      const tags = Array.isArray(t.tags) ? t.tags : [];
      tags.forEach(tag => {
        const normalized = tag.toLowerCase().trim();
        if (normalized) {
          tagCount[normalized] = (tagCount[normalized] || 0) + 1;
        }
      });
    });

    const popular = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);

    res.json(popular);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/latest', async (req, res) => {
  try {
    const trade = await Trade.findOne({
      where: { userId: req.user.id },
      order: [['entryDate', 'DESC']]
    });
    res.json(trade);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/estimate-charges', async (req, res) => {
  try {
    const { entryPrice, exitPrice, lotSize, quantity, tradeType, exchange, status, instrumentType } = req.body;
    const charges = calcCharges(
      parseFloat(entryPrice) || 0,
      parseFloat(exitPrice) || 0,
      parseInt(lotSize) || 0,
      parseInt(quantity) || 0,
      tradeType,
      exchange || 'NSE',
      status || 'OPEN',
      instrumentType || 'OPTIONS'
    );
    res.json(charges);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

function buildPositions(rawTrades, userId, source, brokerName) {
  const paired = [], buyPool = {}, sellPool = {};
  
  const alreadyClosed = rawTrades.filter(t => t.status === 'CLOSED' || t.status === 'EXPIRED');
  const needsPairing  = rawTrades.filter(t => t.status !== 'CLOSED' && t.status !== 'EXPIRED');
  
  paired.push(...alreadyClosed);
  
  needsPairing.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
  for (const t of needsPairing) {
    const key = (t.symbol || '').toUpperCase();
    if (t.tradeType === 'BUY') {
      if (sellPool[key]?.length) {
        let rem = t.quantity;
        while (rem > 0 && sellPool[key].length) {
          const s = sellPool[key][0], mq = Math.min(s.remainingQty, rem);
          const pnl = (s.trade.entryPrice - t.entryPrice) * mq;
          const ch = (s.trade.charges||0)+(t.charges||0);
          paired.push({...s.trade,userId,source,broker:brokerName,quantity:mq,exitPrice:t.entryPrice,exitDate:t.entryDate,status:'CLOSED',charges:ch,pnl,netPnl:pnl-ch});
          s.remainingQty -= mq; rem -= mq; if(s.remainingQty===0) sellPool[key].shift();
        }
        if (rem>0){if(!buyPool[key])buyPool[key]=[];buyPool[key].push({trade:{...t,quantity:rem},remainingQty:rem});}
      } else {
        if(!buyPool[key])buyPool[key]=[];buyPool[key].push({trade:t,remainingQty:t.quantity});
      }
    } else {
      if (buyPool[key]?.length) {
        let rem = t.quantity;
        while (rem > 0 && buyPool[key].length) {
          const o = buyPool[key][0], mq = Math.min(o.remainingQty, rem);
          const pnl = (t.entryPrice - o.trade.entryPrice) * mq;
          const ch = (o.trade.charges||0)+(t.charges||0);
          paired.push({...o.trade,userId,source,broker:brokerName,quantity:mq,exitPrice:t.entryPrice,exitDate:t.entryDate,status:'CLOSED',charges:ch,pnl,netPnl:pnl-ch});
          o.remainingQty -= mq; rem -= mq; if(o.remainingQty===0) buyPool[key].shift();
        }
        if (rem>0){if(!sellPool[key])sellPool[key]=[];sellPool[key].push({trade:{...t,quantity:rem},remainingQty:rem});}
      } else {
        if(!sellPool[key])sellPool[key]=[];sellPool[key].push({trade:t,remainingQty:t.quantity});
      }
    }
  }
  for(const slots of Object.values(buyPool)) for(const s of slots) if(s.remainingQty>0) paired.push({...s.trade,userId,source,broker:brokerName,quantity:s.remainingQty,status:'OPEN'});
  for(const slots of Object.values(sellPool)) for(const s of slots) if(s.remainingQty>0) paired.push({...s.trade,userId,source,broker:brokerName,quantity:s.remainingQty,status:'OPEN'});
  return paired;
}

function parseDateBoundary(value, boundary) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = boundary === 'end' ? '23:59:59.999' : '00:00:00.000';
    return new Date(`${value}T${time}+05:30`);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

router.get('/', async (req, res) => {
  try {
    const { status, symbol, underlying, from, to, optionType, page=1, limit=50 } = req.query;
    const where = { userId: req.user.id };
    if (status)     where.status     = status.toUpperCase();
    if (optionType) where.optionType = optionType;
    if (symbol)     where.symbol     = { [Op.iLike]: `%${symbol}%` };
    if (underlying) where.underlying = { [Op.iLike]: underlying };
    if (from || to) {
      where.entryDate = {};
      const fromDate = parseDateBoundary(from, 'start');
      const toDate = parseDateBoundary(to, 'end');
      if (fromDate) where.entryDate[Op.gte] = fromDate;
      if (toDate)   where.entryDate[Op.lte] = toDate;
    }
    const total  = await Trade.count({ where });
    const trades = await Trade.findAll({
      where,
      order: [['entryDate', 'DESC']],
      offset: (+page - 1) * +limit,
      limit: +limit
    });
    res.json({ trades, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch(err){res.status(500).json({message:err.message});}
});

router.get('/:id', async (req, res) => {
  try {
    const trade = await Trade.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!trade) return res.status(404).json({ message: 'Trade not found.' });
    res.json(trade);
  } catch(err){res.status(500).json({message:err.message});}
});

router.post('/', async (req, res) => {
  try {
    const body     = { ...req.body, userId: req.user.id, source: 'manual' };
    const exchange = body.exchange || 'NSE';

    if (parseInt(body.quantity) <= 0) return res.status(400).json({ message: 'Quantity must be greater than 0' });
    if (parseInt(body.lotSize) <= 0) return res.status(400).json({ message: 'Lot size must be greater than 0' });

    const today = new Date().toISOString().split('T')[0];
    const entryDateStr = new Date(body.entryDate).toISOString().split('T')[0];
    
    if (entryDateStr > today) {
      return res.status(400).json({ message: 'Entry date cannot be in the future' });
    }
    if (body.exitDate) {
      const exitDateStr = new Date(body.exitDate).toISOString().split('T')[0];
      if (exitDateStr < entryDateStr) {
        return res.status(400).json({ message: 'Exit date cannot be before entry date' });
      }
      if (exitDateStr > today) {
        return res.status(400).json({ message: 'Exit date cannot be in the future' });
      }
    }

    const isSettled = body.status === 'CLOSED' || body.status === 'EXPIRED';
    body.charges = calcCharges(
      body.entryPrice, 
      isSettled ? (body.exitPrice || 0) : 0, 
      body.lotSize, 
      body.quantity, 
      body.tradeType, 
      exchange, 
      body.status,
      body.instrumentType
    ).total;

    const trade = await Trade.create(body);
    res.status(201).json({ trade });
  } catch(err) { res.status(400).json({ message: err.message }); }
});

router.put('/:id/close', async (req, res) => {
  try {
    const trade = await Trade.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!trade) return res.status(404).json({ message: 'Trade not found.' });

    const exitPrice = parseFloat(req.body.exitPrice);
    const exitDate = req.body.exitDate ? new Date(req.body.exitDate) : new Date();

    if (!Number.isFinite(exitPrice)) {
      return res.status(400).json({ message: 'Valid exit price is required.' });
    }

    if (Number.isNaN(exitDate.getTime())) {
      return res.status(400).json({ message: 'Valid exit date is required.' });
    }

    if (exitDate < new Date(trade.entryDate)) {
      return res.status(400).json({ message: 'Exit date cannot be before entry date.' });
    }

    const exchange = trade.exchange || 'NSE';
    const charges = calcCharges(
      trade.entryPrice,
      exitPrice,
      trade.lotSize,
      trade.quantity,
      trade.tradeType,
      exchange,
      'CLOSED',
      trade.instrumentType
    ).total;

    await trade.update({
      exitPrice,
      exitDate,
      status: 'CLOSED',
      charges,
    });

    res.json({ trade });
  } catch(err){res.status(400).json({message:err.message});}
});

router.put('/:id', async (req, res) => {
  try {
    const trade = await Trade.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!trade) return res.status(404).json({ message: 'Trade not found.' });
    
    const body     = { ...req.body };
    const exchange = body.exchange || trade.exchange || 'NSE';
    const entry    = body.entryPrice  || trade.entryPrice;
    const exit     = body.exitPrice   || trade.exitPrice;
    const lotSize  = body.lotSize     || trade.lotSize;
    const qty      = body.quantity    || trade.quantity;
    const type     = body.tradeType   || trade.tradeType;
    const status   = body.status      || trade.status;
    const psych    = body.psychology  || trade.psychology;
    const instr    = body.instrumentType || trade.instrumentType;

    if (qty <= 0) return res.status(400).json({ message: 'Quantity must be greater than 0' });
    if (lotSize <= 0) return res.status(400).json({ message: 'Lot size must be greater than 0' });

    const entryDate = body.entryDate || trade.entryDate;
    const exitDate  = body.exitDate  || trade.exitDate;

    const today = new Date().toISOString().split('T')[0];
    const entryDateStr = new Date(entryDate).toISOString().split('T')[0];

    if (entryDateStr > today) {
      return res.status(400).json({ message: 'Entry date cannot be in the future' });
    }
    if (exitDate) {
      const exitDateStr = new Date(exitDate).toISOString().split('T')[0];
      if (exitDateStr < entryDateStr) {
        return res.status(400).json({ message: 'Exit date cannot be before entry date' });
      }
      if (exitDateStr > today) {
        return res.status(400).json({ message: 'Exit date cannot be in the future' });
      }
    }

    const isSettled = status === 'CLOSED' || status === 'EXPIRED';
    body.charges = calcCharges(
      entry, 
      isSettled ? (exit || 0) : 0, 
      lotSize, 
      qty, 
      type, 
      exchange, 
      status,
      instr
    ).total;

    body.psychology = psych;
    
    await trade.update(body);
    res.json({ trade });
  } catch(err){res.status(400).json({message:err.message});}
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Trade.destroy({ where: { id: req.params.id, userId: req.user.id } });
    if(!deleted) return res.status(404).json({message:'Trade not found.'});
    res.json({message:'Trade deleted.'});
  } catch(err){res.status(500).json({message:err.message});}
});

router.post('/:id/psychology', async (req, res) => {
  try {
    const {emotionBefore,emotionAfter,disciplineRating,followedPlan,mistakeTags,notes} = req.body;
    const trade = await Trade.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if(!trade) return res.status(404).json({message:'Trade not found.'});
    
    await trade.update({
      psychology: {
        emotionBefore: emotionBefore || '',
        emotionAfter: emotionAfter || '',
        disciplineRating: disciplineRating ? Number(disciplineRating) : undefined,
        followedPlan: followedPlan != null ? Boolean(followedPlan) : undefined,
        mistakeTags: Array.isArray(mistakeTags) ? mistakeTags : [],
        notes: notes || ''
      }
    });
    
    res.json({psychology:trade.psychology});
  } catch(err){res.status(400).json({message:err.message});}
});

router.get('/:id/psychology', async (req, res) => {
  try {
    const trade = await Trade.findOne({
      where: { id: req.params.id, userId: req.user.id },
      attributes: ['psychology', 'symbol', 'entryDate']
    });
    if(!trade) return res.status(404).json({message:'Trade not found.'});
    res.json({psychology:trade.psychology||{},symbol:trade.symbol,entryDate:trade.entryDate});
  } catch(err){res.status(500).json({message:err.message});}
});

// #11: Save chart screenshot (base64 data URL)
router.post('/:id/screenshot', async (req, res) => {
  try {
    const { screenshot } = req.body;
    if (!screenshot) return res.status(400).json({ message: 'No screenshot provided.' });
    // Basic validation — must be a data URL
    if (!screenshot.startsWith('data:image/')) {
      return res.status(400).json({ message: 'Invalid image format.' });
    }
    // Guard against excessively large images (>5MB base64 ≈ ~3.75MB decoded)
    if (screenshot.length > 6 * 1024 * 1024) {
      return res.status(400).json({ message: 'Screenshot exceeds 5MB limit.' });
    }
    const trade = await Trade.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!trade) return res.status(404).json({ message: 'Trade not found.' });
    await trade.update({ screenshot });
    res.json({ message: 'Screenshot saved.', tradeId: trade.id });
  } catch(err) { res.status(400).json({ message: err.message }); }
});

router.post('/import/csv', upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({message:'No file uploaded.'});
    const {broker,trades:rawTrades,skipped} = parseCSVBuffer(req.file.buffer,req.user.id);
    if(!rawTrades.length) return res.status(400).json({message:`No options trades found. Broker: ${broker}.`,broker,skipped:skipped.slice(0,10)});
    const paired = buildPositions(rawTrades,req.user.id,'csv',broker);

    const brokerIds = paired.filter(t => t.brokerId).map(t => t.brokerId);
    const existing = brokerIds.length > 0
      ? await Trade.findAll({
          where: { userId: req.user.id, brokerId: { [Op.in]: brokerIds } },
          attributes: ['brokerId']
        })
      : [];
    const existingIds = new Set(existing.map(t => t.brokerId));
    const deduplicated = paired.filter(t => !t.brokerId || !existingIds.has(t.brokerId));
    const duplicatesSkipped = paired.length - deduplicated.length;

    const inserted = await Trade.bulkCreate(deduplicated);
    res.status(201).json({
      message: `${inserted.length} trades imported. ${duplicatesSkipped > 0 ? `${duplicatesSkipped} duplicates skipped.` : ''}`,
      count: inserted.length,
      broker,
      closed: deduplicated.filter(t => t.status === 'CLOSED' || t.status === 'EXPIRED').length,
      open: deduplicated.filter(t => t.status === 'OPEN').length,
      skipped: skipped.length,
      duplicatesSkipped,
      tradeIds: inserted.map(t => ({ id: t.id, symbol: t.symbol, entryDate: t.entryDate }))
    });
  } catch(err){res.status(400).json({message:'CSV import failed: '+err.message});}
});

router.post('/import/broker', async (req, res) => {
  const { broker, clientId, accessToken, fromDate, toDate } = req.body;
  if (!accessToken) return res.status(400).json({ message: 'Access token is required.' });
  if (!clientId)    return res.status(400).json({ message: 'Client ID is required.' });

  const { default: axios } = await import('axios');
  let dhanRows = [];
  const today = new Date().toISOString().split('T')[0];
  const from  = fromDate || today;
  const to    = toDate   || today;
  const hdrs  = { 'access-token': accessToken.trim(), 'client-id': clientId.trim(), 'Content-Type': 'application/json', 'Accept': 'application/json' };

  try {
    if (from === today && to === today) {
      const r = await axios.get('https://api.dhan.co/v2/trades', { headers: hdrs, timeout: 15000 });
      dhanRows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    } else {
      let page = 0, hasMore = true;
      while (hasMore && page < 50) {
        const r = await axios.get(`https://api.dhan.co/v2/trades/${from}/${to}/${page}`, { headers: hdrs, timeout: 15000 });
        const rows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
        dhanRows.push(...rows); hasMore = rows.length >= 20; page++;
      }
    }
  } catch (dhanErr) {
    const status = dhanErr.response?.status;
    const d      = dhanErr.response?.data;
    let userMsg  = '';
    if (status === 401 || status === 403) userMsg = 'Invalid or expired access token. Regenerate from web.dhan.co → Profile → Access Token.';
    else if (status === 400) userMsg = `Dhan rejected the request: ${d?.errorMessage || d?.message || JSON.stringify(d)}`;
    else if (status === 429) userMsg = 'Dhan API rate limit hit. Wait a minute and try again.';
    else if (!status)        userMsg = `Cannot reach Dhan API. Check internet. (${dhanErr.message})`;
    else userMsg = `Dhan API error (HTTP ${status}): ${d?.errorMessage || d?.message || dhanErr.message}`;
    return res.status(400).json({ message: userMsg, details: d });
  }

  const allRows = dhanRows;
  if (!allRows.length) return res.status(400).json({ message: 'No trades found in this date range. Try a wider range.' });

  const rawTrades = allRows.map(t => {
    const sym        = (t.customSymbol || t.tradingSymbol || '').toUpperCase();
    let instrumentType = 'EQUITY';
    if (['NSE_FNO','BSE_FNO','NSE_FO','BSE_FO'].includes(t.exchangeSegment)) {
      instrumentType = (t.drvOptionType && t.drvOptionType !== 'NA' && t.drvOptionType !== '') ? 'OPTIONS' : 'FUTURES';
    } else if (sym.includes('CE') || sym.includes('PE')) {
      instrumentType = 'OPTIONS';
    } else if (sym.includes('FUT')) {
      instrumentType = 'FUTURES';
    }

    const optionType = instrumentType === 'OPTIONS' 
      ? (t.drvOptionType === 'CALL' ? 'CE' : t.drvOptionType === 'PUT' ? 'PE' : (sym.endsWith('PE') ? 'PE' : 'CE'))
      : 'XX';

    const underlying = sym.replace(/\d{2}[A-Z]{3}\d{2,4}(CE|PE)$/i,'').replace(/\d+.*$/,'').replace(/[-_]/g,'')||'UNKNOWN';
    const exchange   = (t.exchangeSegment||'').startsWith('BSE') ? 'BSE' : 'NSE';
    const tradeType  = t.transactionType==='BUY' ? 'BUY' : 'SELL';
    const entryPrice = parseFloat(t.tradedPrice) || 0;
    const quantity   = parseInt(t.tradedQuantity) || 1;
    const charges    = calcCharges(entryPrice, 0, 1, quantity, tradeType, exchange, 'OPEN', instrumentType).total;
    
    return { 
      symbol: sym, 
      underlying: underlying.toUpperCase(), 
      tradeType, 
      instrumentType,
      optionType, 
      exchange, 
      strikePrice: parseFloat(t.drvStrikePrice) || null, 
      expiryDate: t.drvExpiryDate && t.drvExpiryDate !== 'NA' ? new Date(t.drvExpiryDate) : (instrumentType === 'EQUITY' ? null : new Date()), 
      lotSize: 1, 
      quantity, 
      entryPrice, 
      entryDate: new Date(t.exchangeTime || t.createTime || Date.now()), 
      brokerId: t.exchangeTradeId || t.orderId || '', 
      charges 
    };
  });

  try {
    const paired   = buildPositions(rawTrades, req.user.id, 'broker_api', 'dhan');
    const inserted = await Trade.bulkCreate(paired);
    res.json({ message:`${inserted.length} trades synced from Dhan.`, count:inserted.length, closed:paired.filter(t=>t.status==='CLOSED'||t.status==='EXPIRED').length, open:paired.filter(t=>t.status==='OPEN').length, tradeIds:inserted.map(t=>({id:t.id,symbol:t.symbol,entryDate:t.entryDate})) });
  } catch(err) {
    res.status(500).json({ message: 'Failed to save trades: ' + err.message });
  }
});

router.post('/import/fyers', async (req, res) => {
  const { appId, accessToken, fromDate, toDate } = req.body;
  if (!accessToken) return res.status(400).json({ message: 'Access token is required.' });
  if (!appId)       return res.status(400).json({ message: 'App ID is required.' });

  const { default: axios } = await import('axios');
  const today = new Date().toISOString().split('T')[0];
  const from  = fromDate || today;
  const to    = toDate   || today;

  const authHeader = `${appId.trim()}:${accessToken.trim()}`;

  const hdrs = {
    'Authorization': authHeader,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };

  let fyersRows = [];
  let lastError = null;

  const endpoints = [
    'https://api-t1.fyers.in/api/v3/tradebook',
    'https://api-t2.fyers.in/api/v3/tradebook',
    'https://api.fyers.in/api/v3/tradebook',
  ];

  for (const url of endpoints) {
    try {
      const r    = await axios.get(url, { headers: hdrs, timeout: 15000 });
      const data = r.data;
      if (data?.s === 'error' || data?.s === 'Error') {
        const errMsg = data?.message || data?.errmsg || 'Fyers API returned error';
        if (errMsg.toLowerCase().includes('token') || errMsg.toLowerCase().includes('auth') ||
            errMsg.toLowerCase().includes('invalid') || errMsg.toLowerCase().includes('unauthorized')) {
          return res.status(401).json({
            message: `Invalid token: ${errMsg}. Re-generate your access token from myapi.fyers.in.`,
          });
        }
        throw new Error(errMsg);
      }
      fyersRows = Array.isArray(data?.tradeBook) ? data.tradeBook
                : Array.isArray(data?.data)       ? data.data
                : Array.isArray(data)              ? data
                : [];
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) break;
      if (status === 400) break;
    }
  }

  if (lastError) {
    const status = lastError.response?.status;
    const d      = lastError.response?.data;
    let msg;
    if (status === 401 || status === 403) {
      msg = 'Access token is invalid or expired. Go to myapi.fyers.in → Generate Token and paste the fresh token.';
    } else if (status === 400) {
      msg = `Bad request: ${d?.message || d?.errmsg || 'Check your App ID format (e.g. XY1234-100)'}`;
    } else if (status === 429) {
      msg = 'Fyers API rate limit hit. Wait 1 minute and try again.';
    } else if (status === 502 || status === 503 || status === 504) {
      msg = 'Fyers API servers are temporarily down (502/503). Try again in a few minutes, or use CSV export instead.';
    } else if (!status) {
      msg = `Cannot reach Fyers API. Check your internet connection. (${lastError.message})`;
    } else {
      msg = `Fyers API error (HTTP ${status}): ${d?.message || d?.errmsg || lastError.message}`;
    }
    return res.status(400).json({ message: msg });
  }

  if (from || to) {
    fyersRows = fyersRows.filter(t => {
      const d = (t.orderDateTime || t.tradeDate || t.order_date_time || '').slice(0,10);
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    });
  }

  const allRows = fyersRows;
  if (!allRows.length)
    return res.status(400).json({ message: 'No trades found in this date range. Try a wider range.' });

  const rawTrades = allRows.map(t => {
    const fullSym    = (t.symbol || t.tradingSymbol || '').toUpperCase();
    const sym        = fullSym.includes(':') ? fullSym.split(':')[1] : fullSym;
    const exchange   = fullSym.startsWith('BSE') ? 'BSE' : 'NSE';
    
    let instrumentType = 'EQUITY';
    if (sym.endsWith('CE') || sym.endsWith('PE')) instrumentType = 'OPTIONS';
    else if (sym.endsWith('FUT')) instrumentType = 'FUTURES';

    const optionType = instrumentType === 'OPTIONS' ? (sym.endsWith('CE') ? 'CE' : 'PE') : 'XX';
    const underlying = sym.replace(/\d{2}[A-Z]{3}\d{2,6}(CE|PE)$/i,'').replace(/\d+.*$/,'') || 'UNKNOWN';
    
    const strikeMatch = sym.match(/(\d+)(CE|PE)$/i);
    const strikePrice = instrumentType === 'OPTIONS' && strikeMatch ? parseFloat(strikeMatch[1]) : null;
    
    const expMatch = sym.match(/(\d{2})([A-Z]{3})(\d{2,4})/i);
    let expiryDate = null;
    if (instrumentType !== 'EQUITY') {
      if (expMatch) {
        const yr  = expMatch[3].length === 2 ? '20' + expMatch[3] : expMatch[3];
        expiryDate = new Date(`${expMatch[1]} ${expMatch[2]} ${yr}`);
      } else {
        expiryDate = new Date();
      }
    }

    const tradeType  = (t.side === 1 || t.side === 'BUY'  || t.transactionType === 'BUY')  ? 'BUY' : 'SELL';
    const entryPrice = parseFloat(t.tradePrice || t.tradedPrice || t.rate || 0);
    const quantity   = parseInt(t.tradedQty || t.qty || t.quantity || 1);
    const charges    = calcCharges(entryPrice, 0, 1, quantity, tradeType, exchange, 'OPEN', instrumentType).total;
    const entryDate  = new Date(t.orderDateTime || t.tradeDate || Date.now());

    return {
      symbol: sym, 
      underlying: underlying.toUpperCase(), 
      tradeType, 
      instrumentType,
      optionType, 
      exchange,
      strikePrice, 
      expiryDate, 
      lotSize: 1, 
      quantity, 
      entryPrice, 
      entryDate,
      brokerId: t.tradeId || t.orderId || '', 
      charges,
    };
  });

  try {
    const paired   = buildPositions(rawTrades, req.user.id, 'broker_api', 'fyers');
    const inserted = await Trade.bulkCreate(paired);
    res.json({
      message: `${inserted.length} trades synced from Fyers.`,
      count: inserted.length,
      closed: paired.filter(t => t.status === 'CLOSED' || t.status === 'EXPIRED').length,
      open:   paired.filter(t => t.status === 'OPEN').length,
      tradeIds: inserted.map(t => ({ id: t.id, symbol: t.symbol, entryDate: t.entryDate })),
    });
  } catch(err) {
    res.status(500).json({ message: 'Failed to save trades: ' + err.message });
  }
});

export default router;
