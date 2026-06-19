import express from 'express';
import axios from 'axios';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Simple in-memory cache: { "SYMBOL-DATE-INTERVAL-RANGE": { data, expiry } }
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const VALID_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const VALID_INTERVALS = new Set(['1m', '2m', '3m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

const TICKER_MAP = {
  'NIFTY': '^NSEI',
  'BANKNIFTY': '^NSEBANK',
  'FINNIFTY': 'NIFTY_FIN_SERVICE.NS',
  'MIDCPNIFTY': '^NSEMDCP50',
  'NIFTYNXT50': '^NSENX50',
  'SENSEX': '^BSESN',
  'BANKEX': '^BSEBK',
};

function aggregateCandles(candles, minutes) {
  const bucketSize = minutes * 60;
  const buckets = new Map();

  candles.forEach((candle) => {
    const bucketTime = Math.floor(candle.time / bucketSize) * bucketSize;
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, { ...candle, time: bucketTime });
      return;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
  });

  return Array.from(buckets.values()).map((candle) => ({
    ...candle,
    open: Number(candle.open.toFixed(2)),
    high: Number(candle.high.toFixed(2)),
    low: Number(candle.low.toFixed(2)),
    close: Number(candle.close.toFixed(2)),
  }));
}

router.get('/', protect, async (req, res) => {
  try {
    const { symbol, date, range, interval = range ? '1d' : '5m' } = req.query;

    if (!symbol || (!date && !range)) {
      return res.status(400).json({ message: 'Symbol and either date or range are required' });
    }

    if (!VALID_INTERVALS.has(interval)) {
      return res.status(400).json({ message: 'Unsupported candle interval' });
    }

    if (range && !VALID_RANGES.has(range)) {
      return res.status(400).json({ message: 'Unsupported candle range' });
    }

    const cacheKey = `${symbol}-${date || 'history'}-${interval}-${range || 'session'}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return res.json(cached.data);
    }

    // Map to Yahoo Ticker
    let ticker = TICKER_MAP[symbol] || symbol;
    if (!ticker.includes('^') && !ticker.includes('.')) {
      ticker += '.NS';
    }

    const yahooInterval = interval === '3m' ? '1m' : interval;
    let url;
    if (range) {
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${yahooInterval}&range=${range}`;
    } else {
      // Calculate timestamps for the requested date (IST 9:15 AM to 3:30 PM)
      // Yahoo Finance uses UTC. IST is UTC+5:30.
      const dateObj = new Date(date);

      if (Number.isNaN(dateObj.getTime())) {
        return res.status(400).json({ message: 'Invalid candle date' });
      }

      // Market Start: 9:15 AM IST = 3:45 AM UTC
      const start = new Date(dateObj);
      start.setUTCHours(3, 45, 0, 0);

      // Market End: 3:30 PM IST = 10:00 AM UTC
      const end = new Date(dateObj);
      end.setUTCHours(10, 0, 0, 0);

      const period1 = Math.floor(start.getTime() / 1000);
      const period2 = Math.floor(end.getTime() / 1000);

      url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${yahooInterval}&period1=${period1}&period2=${period2}`;
    }
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const result = response.data.chart.result?.[0];
    if (!result || !result.timestamp) {
      return res.status(404).json({ message: 'No candle data found for this date/symbol' });
    }

    const { timestamp, indicators } = result;
    const { quote } = indicators;
    const { open, high, low, close } = quote[0];

    const rawCandles = timestamp.map((t, i) => ({
      time: t, // lightweight-charts accepts Unix timestamps
      open: Number(open[i]?.toFixed(2)),
      high: Number(high[i]?.toFixed(2)),
      low: Number(low[i]?.toFixed(2)),
      close: Number(close[i]?.toFixed(2)),
    })).filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite));

    const candles = interval === '3m' ? aggregateCandles(rawCandles, 3) : rawCandles;

    const responseData = { candles, symbol: ticker, date, range, interval };
    
    cache.set(cacheKey, {
      data: responseData,
      expiry: Date.now() + CACHE_TTL
    });

    res.json(responseData);
  } catch (err) {
    console.error('Candle Fetch Error:', err.message);
    res.status(500).json({ message: 'Failed to fetch market data: ' + err.message });
  }
});

export default router;
