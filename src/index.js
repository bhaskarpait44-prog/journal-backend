import express    from 'express';
import cors       from 'cors';
import sequelize  from './lib/sequelize.js';
import dotenv     from 'dotenv';

dotenv.config();

// ── Startup validation ────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your_jwt_secret_here') {
  console.error('❌  JWT_SECRET is not set or is still the placeholder. Edit backend/.env');
  process.exit(1);
}

import authRoutes     from './routes/auth.js';
import tradeRoutes    from './routes/trades.js';
import analyticsRoutes from './routes/analytics.js';
import profileRoutes       from './routes/profile.js';
import subscriptionRoutes  from './routes/subscription.js';
import nseRoutes      from './routes/nse.js';
import adminRoutes    from './routes/admin.js';
import exportRoutes   from './routes/export.js';
import fyersRoutes    from './routes/fyers.js';

const app  = express();
const PORT = process.env.PORT || 5000;

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://trading-journal-frontend-mu.vercel.app',
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    callback(new Error(`CORS blocked: ${origin}`));
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
app.use('/api/nse',       nseRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/export',    exportRoutes);
app.use('/api/fyers',     fyersRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'OK', database: 'connected' }));

// ── PostgreSQL / Sequelize ────────────────────────────────────────────────────
sequelize.authenticate().then(() => {
  console.log('✅  PostgreSQL connected via Sequelize');
  return sequelize.sync({ alter: true }); // Sync models to database
}).then(() => {
  console.log('✅  Database models synced');
  app.listen(PORT, () => console.log(`🚀  Backend on http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌  Database connection failed:', err.message);
  process.exit(1);
});