import Settings from '../models/Settings.js';

let flagCache = null;
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const DEFAULT_FLAGS = {
  starter: { tradeLimit: -1, csvImport: true, analytics: true, brokerSync: false, aiInsights: false, export: true, psychology: true },
  pro: { tradeLimit: -1, csvImport: true, analytics: true, brokerSync: true, aiInsights: true, export: true, psychology: true }
};

async function getFeatureFlags() {
  const now = Date.now();
  if (flagCache && (now - lastFetch < CACHE_TTL)) {
    return flagCache;
  }

  try {
    const doc = await Settings.findByPk('feature_flags');
    flagCache = doc ? doc.value : DEFAULT_FLAGS;
    lastFetch = now;
    return flagCache;
  } catch (err) {
    console.error('Failed to fetch feature flags:', err.message);
    return flagCache || DEFAULT_FLAGS;
  }
}

export function planGate(feature) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ message: 'Unauthorized' });

      const sub = user.subscription || {};
      if (sub.status !== 'active') {
        return res.status(403).json({ message: 'Active subscription required.' });
      }

      const plan = sub.plan || 'none';
      if (plan === 'none') {
        return res.status(403).json({ message: 'Active subscription required.' });
      }

      const flags = await getFeatureFlags();
      const planFlags = flags[plan];

      if (!planFlags) {
        return res.status(403).json({ message: 'Active subscription required.' });
      }

      // Feature specific checks
      if (feature === 'tradeLimit') {
        // This is handled in the route itself but we can pass flags to req
        req.planFlags = planFlags;
        return next();
      }

      if (!planFlags[feature]) {
        return res.status(403).json({ message: 'Upgrade your plan to access this feature.' });
      }

      next();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  };
}
