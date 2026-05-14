import express  from 'express';
import { Op } from 'sequelize';
import User     from '../models/User.js';
import Trade    from '../models/Trade.js';
import Settings from '../models/Settings.js';
import sequelize from '../lib/sequelize.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// ── Admin guard middleware ────────────────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admins only.' });
  }
  next();
};

const guard = [protect, adminOnly];

// ── GET /api/admin/dashboard ──────────────────────────────────────────────────
router.get('/dashboard', guard, async (req, res) => {
  try {
    const now   = new Date();
    const month = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers, activeSubscribers, freeUsers,
      monthlyNewUsers, totalTrades, monthTrades,
      recentUsers, planBreakdown,
    ] = await Promise.all([
      User.count(),
      User.count({ where: { 'subscription.status': 'active' } }),
      User.count({
        where: {
          [Op.or]: [
            { 'subscription.plan': 'none' },
            { 'subscription.status': { [Op.ne]: 'active' } }
          ]
        }
      }),
      User.count({ where: { createdAt: { [Op.gte]: month } } }),
      Trade.count(),
      Trade.count({ where: { createdAt: { [Op.gte]: month } } }),
      User.findAll({
        attributes: ['id', 'name', 'email', 'subscription', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit: 5
      }),
      User.findAll({
        attributes: [
          [sequelize.literal("subscription->>'plan'"), '_id'],
          [sequelize.fn('count', sequelize.col('id')), 'count']
        ],
        group: [sequelize.literal("subscription->>'plan'")],
        raw: true
      }),
    ]);

    // Revenue calc (starter=199, pro=699)
    const starterCount = parseInt(planBreakdown.find(p => p._id === 'starter')?.count || 0);
    const proCount     = parseInt(planBreakdown.find(p => p._id === 'pro')?.count || 0);
    const totalRevenue = (starterCount * 199) + (proCount * 699);

    // User growth last 12 months
    const userGrowthRaw = await User.findAll({
      where: { createdAt: { [Op.gte]: new Date(now.getFullYear() - 1, now.getMonth(), 1) } },
      attributes: [
        [sequelize.fn('EXTRACT', sequelize.literal('YEAR FROM "createdAt"')), 'year'],
        [sequelize.fn('EXTRACT', sequelize.literal('MONTH FROM "createdAt"')), 'month'],
        [sequelize.fn('count', sequelize.col('id')), 'count']
      ],
      group: [
        sequelize.fn('EXTRACT', sequelize.literal('YEAR FROM "createdAt"')),
        sequelize.fn('EXTRACT', sequelize.literal('MONTH FROM "createdAt"'))
      ],
      order: [
        [sequelize.fn('EXTRACT', sequelize.literal('YEAR FROM "createdAt"')), 'ASC'],
        [sequelize.fn('EXTRACT', sequelize.literal('MONTH FROM "createdAt"')), 'ASC']
      ],
      raw: true
    });
    const userGrowth = userGrowthRaw.map(g => ({
      _id: { year: parseInt(g.year), month: parseInt(g.month) },
      count: parseInt(g.count)
    }));

    // Daily trades last 30 days
    const thirtyDays = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const dailyTradesRaw = await Trade.findAll({
      where: { createdAt: { [Op.gte]: thirtyDays } },
      attributes: [
        [sequelize.fn('date_trunc', 'day', sequelize.col('createdAt')), 'day'],
        [sequelize.fn('count', sequelize.col('id')), 'count']
      ],
      group: [sequelize.fn('date_trunc', 'day', sequelize.col('createdAt'))],
      order: [[sequelize.fn('date_trunc', 'day', sequelize.col('createdAt')), 'ASC']],
      raw: true
    });
    const dailyTrades = dailyTradesRaw.map(g => ({
      _id: new Date(g.day).toISOString().split('T')[0],
      count: parseInt(g.count)
    }));

    res.json({
      stats: { totalUsers, activeSubscribers, freeUsers, monthlyNewUsers, totalTrades, monthTrades,
               totalRevenue, monthlyRevenue: (starterCount * 199) + (proCount * 699) },
      planBreakdown: planBreakdown.map(p => ({ ...p, count: parseInt(p.count) })), 
      recentUsers, userGrowth, dailyTrades,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', guard, async (req, res) => {
  try {
    const { search = '', plan = '', status = '', page = 1, limit = 20 } = req.query;
    const where = {};
    if (search) where[Op.or] = [
      { name:  { [Op.iLike]: `%${search}%` } },
      { email: { [Op.iLike]: `%${search}%` } },
    ];
    if (plan)   where['subscription.plan']   = plan;
    if (status) where['subscription.status'] = status;

    const [users, total] = await Promise.all([
      User.findAll({
        where,
        attributes: { exclude: ['password', 'sessions'] },
        order: [['createdAt', 'DESC']],
        offset: (parseInt(page) - 1) * parseInt(limit),
        limit: parseInt(limit)
      }),
      User.count({ where }),
    ]);
    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
router.get('/users/:id', guard, async (req, res) => {
  try {
    const user   = await User.findByPk(req.params.id, {
      attributes: { exclude: ['password', 'sessions'] }
    });
    if (!user) return res.status(404).json({ message: 'User not found' });
    const trades = await Trade.findAll({
      where: { userId: req.params.id },
      order: [['createdAt', 'DESC']],
      limit: 10
    });
    const stats = await Trade.findAll({
      where: { userId: req.params.id },
      attributes: [
        [sequelize.fn('count', sequelize.col('id')), 'total'],
        [sequelize.fn('sum', sequelize.col('netPnl')), 'totalPnl'],
        [sequelize.fn('sum', sequelize.literal('CASE WHEN "netPnl" > 0 THEN 1 ELSE 0 END')), 'wins']
      ],
      raw: true
    });
    const s = stats[0] || { total: 0, totalPnl: 0, wins: 0 };
    res.json({
      user,
      trades,
      stats: {
        total: parseInt(s.total || 0),
        totalPnl: parseFloat(s.totalPnl || 0),
        wins: parseInt(s.wins || 0)
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/admin/users/:id ──────────────────────────────────────────────────
router.put('/users/:id', guard, async (req, res) => {
  try {
    const { name, email, role, plan, subStatus } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const update = {};
    if (name)  update.name  = name;
    if (email) update.email = email;
    if (role)  update.role  = role;
    
    if (plan || subStatus) {
      const sub = { ...user.subscription };
      if (plan)      sub.plan   = plan;
      if (subStatus) sub.status = subStatus;
      update.subscription = sub;
    }

    await user.update(update);
    res.json({ user: user.toJSON() });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete('/users/:id', guard, async (req, res) => {
  try {
    await Trade.destroy({ where: { userId: req.params.id } });
    await User.destroy({ where: { id: req.params.id } });
    res.json({ message: 'User and all their trades deleted.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/trades ─────────────────────────────────────────────────────
router.get('/trades', guard, async (req, res) => {
  try {
    const { search = '', strategy = '', page = 1, limit = 25 } = req.query;
    const where = {};
    if (search)   where.symbol   = { [Op.iLike]: `%${search}%` };
    if (strategy) where.strategy = { [Op.iLike]: `%${strategy}%` };

    const [trades, total] = await Promise.all([
      Trade.findAll({
        where,
        include: [{ model: User, as: 'user', attributes: ['name', 'email'] }],
        order: [['createdAt', 'DESC']],
        offset: (parseInt(page) - 1) * parseInt(limit),
        limit: parseInt(limit)
      }),
      Trade.count({ where }),
    ]);
    res.json({ trades, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/analytics ──────────────────────────────────────────────────
router.get('/analytics', guard, async (req, res) => {
  try {
    const [
      topStrategiesRaw, topSymbolsRaw, pnlRatioRaw, activeTradersRaw,
    ] = await Promise.all([
      Trade.findAll({
        where: { strategy: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } },
        attributes: [
          ['strategy', '_id'],
          [sequelize.fn('count', sequelize.col('id')), 'count'],
          [sequelize.fn('sum', sequelize.col('netPnl')), 'totalPnl']
        ],
        group: ['strategy'],
        order: [[sequelize.literal('count'), 'DESC']],
        limit: 8,
        raw: true
      }),
      Trade.findAll({
        attributes: [
          ['underlying', '_id'],
          [sequelize.fn('count', sequelize.col('id')), 'count'],
          [sequelize.fn('sum', sequelize.col('netPnl')), 'totalPnl']
        ],
        group: ['underlying'],
        order: [[sequelize.literal('count'), 'DESC']],
        limit: 10,
        raw: true
      }),
      Trade.findAll({
        attributes: [
          [sequelize.fn('sum', sequelize.literal('CASE WHEN "netPnl" > 0 THEN 1 ELSE 0 END')), 'winners'],
          [sequelize.fn('sum', sequelize.literal('CASE WHEN "netPnl" < 0 THEN 1 ELSE 0 END')), 'losers'],
          [sequelize.fn('sum', sequelize.col('netPnl')), 'totalPnl'],
          [sequelize.fn('count', sequelize.col('id')), 'total']
        ],
        raw: true
      }),
      Trade.findAll({
        where: { createdAt: { [Op.gte]: new Date(Date.now() - 30*24*60*60*1000) } },
        attributes: [
          [sequelize.fn('date_trunc', 'day', sequelize.col('createdAt')), 'day'],
          [sequelize.fn('count', sequelize.fn('DISTINCT', sequelize.col('userId'))), 'activeUsers']
        ],
        group: [sequelize.fn('date_trunc', 'day', sequelize.col('createdAt'))],
        order: [[sequelize.fn('date_trunc', 'day', sequelize.col('createdAt')), 'ASC']],
        raw: true
      }),
    ]);
    res.json({
      topStrategies: topStrategiesRaw.map(s => ({ ...s, count: parseInt(s.count), totalPnl: parseFloat(s.totalPnl) })),
      topSymbols: topSymbolsRaw.map(s => ({ ...s, count: parseInt(s.count), totalPnl: parseFloat(s.totalPnl) })),
      pnlRatio: pnlRatioRaw[0] ? {
        winners: parseInt(pnlRatioRaw[0].winners),
        losers: parseInt(pnlRatioRaw[0].losers),
        totalPnl: parseFloat(pnlRatioRaw[0].totalPnl),
        total: parseInt(pnlRatioRaw[0].total)
      } : {},
      activeTraders: activeTradersRaw.map(t => ({
        _id: new Date(t.day).toISOString().split('T')[0],
        activeUsers: parseInt(t.activeUsers)
      }))
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/payments (simulated from subscriptions) ────────────────────
router.get('/payments', guard, async (req, res) => {
  try {
    const { status = '', page = 1, limit = 20 } = req.query;
    const where = { 'subscription.status': { [Op.ne]: 'none' } };
    if (status) where['subscription.status'] = status;

    const [users, total] = await Promise.all([
      User.findAll({
        where,
        attributes: ['id', 'name', 'email', 'subscription', 'createdAt'],
        order: [[sequelize.literal("subscription->>'startedAt'"), 'DESC']],
        offset: (parseInt(page) - 1) * parseInt(limit),
        limit: parseInt(limit)
      }),
      User.count({ where }),
    ]);

    const payments = users.map(u => ({
      id:     u.id,
      user:   { name: u.name, email: u.email },
      plan:   u.subscription.plan,
      amount: u.subscription.plan === 'pro' ? 699 : 199,
      status: u.subscription.status,
      date:   u.subscription.startedAt || u.createdAt,
      paymentId: `TL${u.id.toString().slice(-8).toUpperCase()}`,
    }));

    res.json({ payments, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

const DEFAULT_SETTINGS = {
  // ── Platform ──────────────────────────────────────────────────────────────
  platformName:     'TradeLog',
  supportEmail:     'support@tradelog.in',
  starterPrice:     199,
  proPrice:         699,
  trialDays:        14,
  maintenanceMode:  false,
  allowSignups:     true,
  maxTradesPerUser: 10000,
  announcement:     '',

  // ── Landing — Hero ────────────────────────────────────────────────────────
  heroTagline:      'Built for NIFTY, BANKNIFTY & F&O Traders',
  heroTitle:        'Become a Consistently Profitable Options Trader',
  heroSubtext:      'Track trades, analyse strategies, control risk, and master your trading psychology — all in one powerful journal built for Indian options markets.',
  heroCtaPrimary:   'Get Started',
  heroCtaSecondary: 'View Pricing',
  heroStat1Value:   '10,000+',  heroStat1Label: 'Active traders',
  heroStat2Value:   '₹50Cr+',   heroStat2Label: 'P&L tracked',
  heroStat3Value:   '4.9★',     heroStat3Label: 'User rating',

  // ── Landing — Features ────────────────────────────────────────────────────
  featuresTitle:    'Everything you need to trade like a professional',
  featuresSub:      'Designed specifically for Indian options traders — not generic tools repurposed for F&O.',
  features: [
    { icon:'📒', title:'Trade Book',          desc:'Log every NIFTY, BANKNIFTY & F&O trade. Auto-calculate P&L, charges, and net returns per trade.' },
    { icon:'📊', title:'Strategy Analytics',  desc:'See which strategies — Iron Condor, Straddle, Scalp — actually make you money and which drain your capital.' },
    { icon:'🧠', title:'Psychology Tracking', desc:'Track emotions before and after each trade. Detect revenge trading, FOMO entries, and overtrading patterns.' },
    { icon:'🛡️', title:'Risk Management',     desc:'Set capital limits, daily loss caps, and position sizing rules. Get alerted before you break your own rules.' },
    { icon:'🔍', title:'Mistake Detection',   desc:'Auto-tag common mistakes: no stop loss, late entry, oversized position. Learn from patterns across hundreds of trades.' },
    { icon:'🔗', title:'Broker Sync',         desc:'Sync trades directly from Dhan API. No manual entry for broker trades — just connect and analyse.' },
    { icon:'📈', title:'Performance Dashboard',desc:'Daily P&L, equity curve, win rate, streak tracking, and drawdown analysis — your entire trading career in one view.' },
    { icon:'🎯', title:'Option Strategy Tracker',desc:'Track strategies like Straddle, Strangle, Iron Condor, Bull Call Spread — with legs, Greeks, and P&L attribution.' },
  ],

  // ── Landing — Pricing ─────────────────────────────────────────────────────
  pricingTitle:     'Simple, transparent pricing',
  pricingSub:       'Start free, upgrade when you\'re ready. Cancel anytime.',
  starterPlanName:  'Starter',
  starterPlanPer:   'Billed monthly · No setup fee',
  starterFeatures:  ['Trade journal (unlimited)','Basic analytics dashboard','Psychology tracking','Risk management tools','CSV import (all brokers)','Email support'],
  proPlanName:      'Pro Trader',
  proPlanPer:       'Billed monthly · 14-day free trial',
  proFeatures:      ['Everything in Starter','Advanced strategy analytics','Strategy performance tracking','Dhan broker auto sync','AI trade insights & patterns','Priority support + Discord'],
  proPlanBadge:     'MOST POPULAR',

  // ── Landing — Testimonials ────────────────────────────────────────────────
  testimonialsTitle: 'Trusted by Indian options traders',
  testimonials: [
    { name:'Arjun M.',  role:'Options Scalper, Mumbai',      initials:'AM', gradient:'linear-gradient(135deg,#3b82f6,#1d4ed8)', quote:'I was profitable some days and losing on others with no idea why. TradeLog showed me I had a 74% win rate on ORB trades but was destroying profits with FOMO entries after 2PM. Game changer.' },
    { name:'Priya S.',  role:'Swing Trader, Bangalore',      initials:'PS', gradient:'linear-gradient(135deg,#a855f7,#7c3aed)', quote:'The psychology tracking is unreal. I discovered I trade completely differently when I\'m overconfident — win rate drops from 65% to 31%. Now I size down automatically on those days.' },
    { name:'Rahul K.',  role:'BankNifty Trader, Hyderabad',  initials:'RK', gradient:'linear-gradient(135deg,#22c55e,#16a34a)', quote:'Dhan broker sync means my trades just appear. No manual entry. The strategy analytics showed Iron Condor is my best setup — I had no idea. Up ₹3.2L since switching focus.' },
  ],

  // ── Landing — FAQ ─────────────────────────────────────────────────────────
  faqTitle: 'Questions answered',
  faq: [
    { q:'Is TradeLog connected to brokers directly?',       a:'Yes — the Pro plan includes Dhan API sync that automatically imports your F&O trades. We only read trade data; we cannot place orders or access your funds.' },
    { q:'Can beginners use this?',                          a:'Absolutely. The Starter plan is perfect for new traders who want to understand their patterns. Just log trades manually or upload your broker CSV — no API setup needed.' },
    { q:'Is my trade data secure?',                        a:'Your data is encrypted in transit and at rest. We never share your data with third parties. You can export or delete all your data at any time from the profile page.' },
    { q:'Which brokers are supported for CSV import?',     a:'Zerodha, Dhan, Upstox, Angel One, Fyers, Groww, 5Paisa, ICICI Direct, HDFC Securities, Kotak, AliceBlue, Sharekhan, and more. Most CSVs are auto-detected.' },
    { q:'What is the 14-day free trial?',                  a:'The Pro plan comes with a full 14-day free trial. No credit card required to start. You\'ll only be charged after the trial ends if you choose to continue.' },
    { q:'Can I cancel anytime?',                           a:'Yes. No lock-in. Cancel from your profile page and you\'ll keep access until the end of your billing period. No questions asked.' },
  ],

  // ── Landing — Final CTA ───────────────────────────────────────────────────
  finalCtaTitle:  'Stop Guessing. Start Trading with Data.',
  finalCtaSub:    'Join 10,000+ Indian options traders who journal with TradeLog.',
  finalCtaBtn:    'Get Started →',
  finalCtaNote:   'No credit card required · Cancel anytime',
};

// ── GET /api/admin/settings ───────────────────────────────────────────────────
router.get('/settings', guard, async (req, res) => {
  try {
    const doc = await Settings.findByPk('platform');
    res.json({ settings: doc?.value || DEFAULT_SETTINGS });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/admin/settings ───────────────────────────────────────────────────
router.put('/settings', guard, async (req, res) => {
  try {
    const allowed = [
      'platformName','supportEmail','starterPrice','proPrice','trialDays',
      'maintenanceMode','allowSignups','maxTradesPerUser','announcement',
      // landing
      'heroTagline','heroTitle','heroSubtext','heroCtaPrimary','heroCtaSecondary',
      'heroStat1Value','heroStat1Label','heroStat2Value','heroStat2Label','heroStat3Value','heroStat3Label',
      'featuresTitle','featuresSub','features',
      'pricingTitle','pricingSub','starterPlanName','starterPlanPer','starterFeatures',
      'proPlanName','proPlanPer','proFeatures','proPlanBadge',
      'testimonialsTitle','testimonials',
      'faqTitle','faq',
      'finalCtaTitle','finalCtaSub','finalCtaBtn','finalCtaNote',
    ];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const current = await Settings.findByPk('platform');
    const merged  = { ...DEFAULT_SETTINGS, ...(current?.value || {}), ...update };

    const [doc] = await Settings.upsert({
      key: 'platform',
      value: merged
    });
    res.json({ success: true, settings: doc.value });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/public-settings  (no auth — used by landing page) ─────────
router.get('/public-settings', async (req, res) => {
  try {
    const doc = await Settings.findByPk('platform');
    const s   = { ...DEFAULT_SETTINGS, ...(doc?.value || {}) };
    // strip sensitive / server-only fields
    const { maintenanceMode, allowSignups, maxTradesPerUser, announcement, supportEmail, ...pub } = s;
    res.json({ settings: pub });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/users/:id/make-admin ──────────────────────────────────────
router.post('/users/:id/make-admin', guard, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    await user.update({ role: 'admin' });
    res.json({ success: true, message: `${user.email} is now an admin`, user: user.toJSON() });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/users/:id/revoke-admin ────────────────────────────────────
router.post('/users/:id/revoke-admin', guard, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    await user.update({ role: 'user' });
    res.json({ success: true, message: `Admin access revoked for ${user.email}`, user: user.toJSON() });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/users/:id/extend-subscription ────────────────────────────
router.post('/users/:id/extend-subscription', guard, async (req, res) => {
  try {
    const { days = 30, plan } = req.body;
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const currentExpiry = user.subscription?.expiry && new Date(user.subscription.expiry) > new Date()
      ? new Date(user.subscription.expiry)
      : new Date();
    const newExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);

    const sub = { ...user.subscription, expiry: newExpiry, status: 'active' };
    if (plan) sub.plan = plan;

    await user.update({ subscription: sub });
    res.json({ success: true, message: `Subscription extended by ${days} days`, newExpiry });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/broadcast ─────────────────────────────────────────────────
router.post('/broadcast', guard, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message required' });
    // Store announcement in settings
    const current = await Settings.findByPk('platform');
    const value = { ...(current?.value || DEFAULT_SETTINGS), announcement: message };
    await Settings.upsert({ key: 'platform', value });
    res.json({ success: true, message: 'Announcement updated for all users' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
