import express from 'express';

const router = express.Router();

// ── 6-hour in-memory cache ─────────────────────────────────────────────────
const CACHE_TTL = 6 * 60 * 60 * 1000;
let cache = { symbols: null, ts: 0 };
let lastFail = 0;
const FAIL_COOLDOWN = 30 * 60 * 1000; // only warn once per 30 min

// ── Static fallback (Jan 2025 NSE F&O lot sizes) ──────────────────────────
const STATIC_SYMBOLS = [
  { symbol: 'NIFTY',          lotSize: 65   },
  { symbol: 'BANKNIFTY',      lotSize: 30   },
  { symbol: 'FINNIFTY',       lotSize: 65   },
  { symbol: 'MIDCPNIFTY',     lotSize: 120  },
  { symbol: 'SENSEX',         lotSize: 20   },
  { symbol: 'BANKEX',         lotSize: 20   },
  { symbol: 'RELIANCE',       lotSize: 250  },
  { symbol: 'TCS',            lotSize: 175  },
  { symbol: 'INFY',           lotSize: 400  },
  { symbol: 'HDFCBANK',       lotSize: 550  },
  { symbol: 'ICICIBANK',      lotSize: 700  },
  { symbol: 'SBIN',           lotSize: 750  },
  { symbol: 'AXISBANK',       lotSize: 625  },
  { symbol: 'KOTAKBANK',      lotSize: 400  },
  { symbol: 'WIPRO',          lotSize: 1500 },
  { symbol: 'LT',             lotSize: 175  },
  { symbol: 'BAJFINANCE',     lotSize: 125  },
  { symbol: 'TATASTEEL',      lotSize: 1350 },
  { symbol: 'ADANIENT',       lotSize: 625  },
  { symbol: 'MARUTI',         lotSize: 100  },
  { symbol: 'HINDUNILVR',     lotSize: 300  },
  { symbol: 'HCLTECH',        lotSize: 350  },
  { symbol: 'SUNPHARMA',      lotSize: 350  },
  { symbol: 'TATAMOTORS',     lotSize: 900  },
  { symbol: 'ITC',            lotSize: 1600 },
  { symbol: 'ONGC',           lotSize: 1925 },
  { symbol: 'POWERGRID',      lotSize: 2900 },
  { symbol: 'NTPC',           lotSize: 2250 },
  { symbol: 'ADANIPORTS',     lotSize: 625  },
  { symbol: 'BAJAJFINSV',     lotSize: 125  },
  { symbol: 'ASIANPAINT',     lotSize: 200  },
  { symbol: 'ULTRACEMCO',     lotSize: 100  },
  { symbol: 'TITAN',          lotSize: 175  },
  { symbol: 'NESTLEIND',      lotSize: 40   },
  { symbol: 'TECHM',          lotSize: 600  },
  { symbol: 'DIVISLAB',       lotSize: 200  },
  { symbol: 'DRREDDY',        lotSize: 125  },
  { symbol: 'CIPLA',          lotSize: 650  },
  { symbol: 'APOLLOHOSP',     lotSize: 125  },
  { symbol: 'JSWSTEEL',       lotSize: 675  },
  { symbol: 'HINDALCO',       lotSize: 1400 },
  { symbol: 'COALINDIA',      lotSize: 2100 },
  { symbol: 'VEDL',           lotSize: 2000 },
  { symbol: 'SAIL',           lotSize: 5400 },
  { symbol: 'INDUSINDBK',     lotSize: 500  },
  { symbol: 'FEDERALBNK',     lotSize: 5000 },
  { symbol: 'IDFCFIRSTB',     lotSize: 7500 },
  { symbol: 'PNB',            lotSize: 8000 },
  { symbol: 'BANKBARODA',     lotSize: 3750 },
  { symbol: 'CANBK',          lotSize: 3000 },
  { symbol: 'UNIONBANK',      lotSize: 6500 },
  { symbol: 'ZOMATO',         lotSize: 2250 },
  { symbol: 'PAYTM',          lotSize: 2000 },
  { symbol: 'NYKAA',          lotSize: 1800 },
  { symbol: 'DELHIVERY',      lotSize: 2200 },
  { symbol: 'IRCTC',          lotSize: 875  },
  { symbol: 'HAL',            lotSize: 150  },
  { symbol: 'BEL',            lotSize: 3700 },
  { symbol: 'BHEL',           lotSize: 3450 },
  { symbol: 'SIEMENS',        lotSize: 125  },
  { symbol: 'ABB',            lotSize: 150  },
  { symbol: 'CHOLAFIN',       lotSize: 500  },
  { symbol: 'MUTHOOTFIN',     lotSize: 400  },
  { symbol: 'SBILIFE',        lotSize: 375  },
  { symbol: 'HDFCLIFE',       lotSize: 1100 },
  { symbol: 'ICICIlombard',   lotSize: 425  },
  { symbol: 'ICICIGI',        lotSize: 425  },
  { symbol: 'LICI',           lotSize: 700  },
  { symbol: 'GRASIM',         lotSize: 225  },
  { symbol: 'AMBUJACEM',      lotSize: 2000 },
  { symbol: 'ACC',            lotSize: 500  },
  { symbol: 'SHREECEM',       lotSize: 25   },
  { symbol: 'UPL',            lotSize: 1300 },
  { symbol: 'PIIND',          lotSize: 150  },
  { symbol: 'DIVI',           lotSize: 200  },
  { symbol: 'TORNTPHARM',     lotSize: 250  },
  { symbol: 'AUROPHARMA',     lotSize: 650  },
  { symbol: 'LUPIN',          lotSize: 400  },
  { symbol: 'BIOCON',         lotSize: 2600 },
  { symbol: 'INDUSTOWER',     lotSize: 2800 },
  { symbol: 'BHARTIARTL',     lotSize: 475  },
  { symbol: 'IDEA',           lotSize: 40000},
  { symbol: 'TATACOMM',       lotSize: 425  },
  { symbol: 'MPHASIS',        lotSize: 175  },
  { symbol: 'LTI',            lotSize: 150  },
  { symbol: 'LTIM',           lotSize: 150  },
  { symbol: 'COFORGE',        lotSize: 100  },
  { symbol: 'PERSISTENT',     lotSize: 125  },
  { symbol: 'OFSS',           lotSize: 100  },
  { symbol: 'KPIT',           lotSize: 500  },
  { symbol: 'TATAPOWER',      lotSize: 2700 },
  { symbol: 'ADANIGREEN',     lotSize: 500  },
  { symbol: 'ADANITRANS',     lotSize: 400  },
  { symbol: 'TORNTPOWER',     lotSize: 750  },
  { symbol: 'CESC',           lotSize: 2300 },
  { symbol: 'GAIL',           lotSize: 3825 },
  { symbol: 'IGL',            lotSize: 1375 },
  { symbol: 'MGL',            lotSize: 400  },
  { symbol: 'PETRONET',       lotSize: 3000 },
  { symbol: 'BPCL',           lotSize: 1800 },
  { symbol: 'IOC',            lotSize: 5000 },
  { symbol: 'HPCL',           lotSize: 2700 },
  { symbol: 'MRPL',           lotSize: 4900 },
  { symbol: 'INDIGOPNTS',     lotSize: 375  },
  { symbol: 'BERGEPAINT',     lotSize: 1100 },
  { symbol: 'PIDILITIND',     lotSize: 250  },
  { symbol: 'HAVELLS',        lotSize: 500  },
  { symbol: 'CROMPTON',       lotSize: 2200 },
  { symbol: 'VOLTAS',         lotSize: 500  },
  { symbol: 'WHIRLPOOL',      lotSize: 375  },
  { symbol: 'JUBLFOOD',       lotSize: 1250 },
  { symbol: 'TRENT',          lotSize: 275  },
  { symbol: 'DMART',          lotSize: 75   },
  { symbol: 'ABFRL',          lotSize: 2500 },
  { symbol: 'PAGEIND',        lotSize: 15   },
  { symbol: 'MCDOWELL',       lotSize: 250  },
  { symbol: 'UBL',            lotSize: 400  },
  { symbol: 'RADICO',         lotSize: 500  },
  { symbol: 'GODREJCP',       lotSize: 500  },
  { symbol: 'MARICO',         lotSize: 1200 },
  { symbol: 'DABUR',          lotSize: 1250 },
  { symbol: 'EMAMILTD',       lotSize: 600  },
  { symbol: 'COLPAL',         lotSize: 350  },
  { symbol: 'PEL',            lotSize: 125  },
  { symbol: 'IPCALAB',        lotSize: 375  },
  { symbol: 'ALKEM',          lotSize: 100  },
  { symbol: 'ABBOTT',         lotSize: 100  },
  { symbol: 'PFIZER',         lotSize: 250  },
  { symbol: 'EICHERMOT',      lotSize: 175  },
  { symbol: 'M&M',            lotSize: 350  },
  { symbol: 'ASHOKLEY',       lotSize: 4500 },
  { symbol: 'TVSMOTOR',       lotSize: 350  },
  { symbol: 'HEROMOTOCO',     lotSize: 150  },
  { symbol: 'BAJAJ-AUTO',     lotSize: 75   },
  { symbol: 'BALKRISIND',     lotSize: 300  },
  { symbol: 'APOLLOTYRE',     lotSize: 1950 },
  { symbol: 'MRF',            lotSize: 10   },
  { symbol: 'CEAT',           lotSize: 275  },
  { symbol: 'BOSCHLTD',       lotSize: 50   },
  { symbol: 'MOTHERSON',      lotSize: 4800 },
  { symbol: 'EXIDEIND',       lotSize: 2800 },
  { symbol: 'AMARAJABAT',     lotSize: 1000 },
  { symbol: 'SRF',            lotSize: 375  },
  { symbol: 'ATUL',           lotSize: 75   },
  { symbol: 'DEEPAKNTR',      lotSize: 250  },
  { symbol: 'AARTIIND',       lotSize: 750  },
  { symbol: 'INDHOTEL',       lotSize: 1800 },
  { symbol: 'LEMONTREE',      lotSize: 4400 },
  { symbol: 'MAXHEALTH',      lotSize: 700  },
  { symbol: 'METROPOLIS',     lotSize: 250  },
  { symbol: 'DRLAL',          lotSize: 250  },
  { symbol: 'CONCOR',         lotSize: 700  },
  { symbol: 'GMRINFRA',       lotSize: 11250},
  { symbol: 'IRB',            lotSize: 7500 },
  { symbol: 'SAREGAMA',       lotSize: 600  },
  { symbol: 'ZEEL',           lotSize: 2600 },
  { symbol: 'SUNTV',          lotSize: 750  },
  { symbol: 'PVRINOX',        lotSize: 400  },
  { symbol: 'NAUKRI',         lotSize: 100  },
  { symbol: 'INDIAMART',      lotSize: 75   },
  { symbol: 'JUSTDIAL',       lotSize: 350  },
  { symbol: 'POLICYBZR',      lotSize: 1100 },
  { symbol: 'CARTRADE',       lotSize: 600  },
];

// ── GET /api/nse/fno-symbols ──────────────────────────────────────────────────
router.get('/fno-symbols', async (req, res) => {
  // Serve from cache if fresh
  if (cache.symbols && Date.now() - cache.ts < CACHE_TTL) {
    return res.json({ symbols: cache.symbols, source: 'cache', count: cache.symbols.length });
  }

  // Skip live fetch if NSE recently failed (30 min cooldown to avoid log spam)
  const shouldTry = Date.now() - lastFail > FAIL_COOLDOWN;

  if (shouldTry) {
    try {
      const { default: axios } = await import('axios');

      // Step 1: establish session cookie via homepage
      const homeRes = await axios.get('https://www.nseindia.com', {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      const cookies = homeRes.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

      // Step 2: visit derivatives page
      await axios.get('https://www.nseindia.com/market-data/equity-derivatives-watch', {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies, 'Referer': 'https://www.nseindia.com' },
      });

      // Step 3: fetch F&O master CSV
      const csvRes = await axios.get('https://www.nseindia.com/api/master-quote', {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/market-data/equity-derivatives-watch', 'Accept': 'application/json' },
      });

      const items = Array.isArray(csvRes.data) ? csvRes.data : (csvRes.data?.data || []);
      if (items.length > 0) {
        const symbols = items.map(item => ({
          symbol:  (item.symbol || item.underlying || '').toUpperCase(),
          lotSize: parseInt(item.marketLot || item.lotSize || item.lot_size || 1),
        })).filter(s => s.symbol);

        cache = { symbols, ts: Date.now() };
        return res.json({ symbols, source: 'nse_live', count: symbols.length });
      }
    } catch (err) {
      lastFail = Date.now();
      console.warn(`[NSE] Live fetch failed — using static fallback. (${err.message})`);
    }
  }

  // Return static fallback
  res.json({ symbols: STATIC_SYMBOLS, source: 'static_fallback', count: STATIC_SYMBOLS.length });
});

// ── GET /api/nse/market-snapshot ──────────────────────────────────────────────
// Returns current NIFTY 50 level and India VIX
const snapCache = { data: null, ts: 0 };
const SNAP_TTL  = 3 * 60 * 1000; // 3-minute cache (live during market hours)

router.get('/market-snapshot', async (req, res) => {
  // Serve from cache if fresh
  if (snapCache.data && Date.now() - snapCache.ts < SNAP_TTL) {
    return res.json({ ...snapCache.data, source: 'cache' });
  }

  try {
    const { default: axios } = await import('axios');

    // Establish NSE session cookie first
    const homeRes = await axios.get('https://www.nseindia.com', {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const cookies = homeRes.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

    const NSE_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com',
      'Cookie': cookies,
    };

    // Fetch NIFTY 50 and India VIX in parallel
    const [niftyRes, vixRes] = await Promise.all([
      axios.get('https://www.nseindia.com/api/quote-equity?symbol=NIFTY%2050&series=["EQ"]', {
        timeout: 6000, headers: NSE_HEADERS,
      }).catch(() => null),
      axios.get('https://www.nseindia.com/api/quote-equity?symbol=INDIA%20VIX&series=["EQ"]', {
        timeout: 6000, headers: NSE_HEADERS,
      }).catch(() => null),
    ]);

    // Parse NIFTY — try multiple response shapes NSE uses
    let nifty = null;
    if (niftyRes?.data) {
      const d = niftyRes.data;
      nifty = d.priceInfo?.lastPrice
           || d.data?.[0]?.lastPrice
           || d.lastPrice
           || null;
    }

    // Parse VIX
    let vix = null;
    if (vixRes?.data) {
      const d = vixRes.data;
      vix = d.priceInfo?.lastPrice
         || d.data?.[0]?.lastPrice
         || d.lastPrice
         || null;
    }

    // Fallback: try indices API if quote API didn't work
    if (!nifty || !vix) {
      const idxRes = await axios.get('https://www.nseindia.com/api/allIndices', {
        timeout: 6000, headers: NSE_HEADERS,
      }).catch(() => null);

      if (idxRes?.data?.data) {
        const indices = idxRes.data.data;
        if (!nifty) {
          const n = indices.find(i => i.index === 'NIFTY 50' || i.indexSymbol === 'NIFTY 50');
          if (n) nifty = n.last || n.lastPrice;
        }
        if (!vix) {
          const v = indices.find(i => i.index === 'INDIA VIX' || i.indexSymbol === 'INDIA VIX');
          if (v) vix = v.last || v.lastPrice;
        }
      }
    }

    if (!nifty && !vix) throw new Error('Could not parse NSE response');

    const snapshot = {
      nifty:     nifty  ? parseFloat(parseFloat(nifty).toFixed(2))  : null,
      vix:       vix    ? parseFloat(parseFloat(vix).toFixed(2))    : null,
      timestamp: new Date().toISOString(),
      marketStatus: isMarketOpen() ? 'open' : 'closed',
    };

    snapCache.data = snapshot;
    snapCache.ts   = Date.now();

    res.json({ ...snapshot, source: 'live' });
  } catch (err) {
    // Return last known values if available, else error
    if (snapCache.data) {
      return res.json({ ...snapCache.data, source: 'stale_cache', staleSince: new Date(snapCache.ts).toISOString() });
    }
    res.status(503).json({ message: 'Market data unavailable', error: err.message });
  }
});

function isMarketOpen() {
  const now = new Date();
  // IST = UTC + 5:30
  const istMins = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  const day     = new Date(now.getTime() + 330 * 60000).getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false; // weekend
  return istMins >= 555 && istMins <= 930;  // 9:15 AM to 3:30 PM IST
}

export default router;