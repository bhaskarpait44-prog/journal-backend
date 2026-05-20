import express    from 'express';
import cors       from 'cors';
import sequelize  from './lib/sequelize.js';
import dotenv     from 'dotenv';

dotenv.config();

// ── Startup validation ───────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('❌  FATAL: JWT_SECRET is not defined in .env');
  process.exit(1);
}

// ── Routes ────────────────────────────────────────────────────────────────────
import authRoutes         from './routes/auth.js';
import tradeRoutes        from './routes/trades.js';
import analyticsRoutes    from './routes/analytics.js';
import profileRoutes      from './routes/profile.js';
import subscriptionRoutes  from './routes/subscription.js';
import nseRoutes          from './routes/nse.js';
import adminRoutes        from './routes/admin.js';
import exportRoutes       from './routes/export.js';
import fyersRoutes        from './routes/fyers.js';

const app  = express();
const PORT = process.env.PORT || 5000;

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://tradelog-journal.vercel.app',
  'https://trade-log.io'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/trades',    tradeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/subscription',  subscriptionRoutes);
app.use('/api/nse',           nseRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/export',        exportRoutes);
app.use('/api/fyers',         fyersRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'OK', database: 'connected' }));

// ── PostgreSQL / Sequelize ────────────────────────────────────────────────────
sequelize.authenticate().then(() => {
  console.log('✅  PostgreSQL connected via Sequelize');
  const syncOptions = process.env.NODE_ENV === 'production' 
    ? { alter: false }
    : { alter: true };
  if (process.env.NODE_ENV === 'production') {
    console.log('✅ Using existing DB schema (no alter). Run migrations manually for schema changes.');
  }
  return sequelize.sync(syncOptions);
}).then(() => {
  console.log('✅  Database models synced');
  app.listen(PORT, () => console.log(`🚀  Backend on http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌  Database connection failed:', err.message);
  process.exit(1);
});
