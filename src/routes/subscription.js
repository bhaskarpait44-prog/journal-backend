import express from 'express';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

// ── GET /api/subscription/status ──────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    const sub  = user.subscription || {};

    // Auto-expire if past expiry
    if (sub.status === 'active' && sub.expiry && new Date() > new Date(sub.expiry)) {
      user.subscription = { ...sub, status: 'expired' };
      await user.save();
      return res.json({ plan: sub.plan, status: 'expired', expiry: sub.expiry });
    }

    res.json({
      plan:      sub.plan   || 'none',
      status:    sub.status || 'none',
      expiry:    sub.expiry || null,
      startedAt: sub.startedAt || null,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/subscription/activate ──────────────────────────────────────────
// Simulates payment success — in production this would be a webhook from Razorpay/Stripe
router.post('/activate', async (req, res) => {
  try {
    const { plan, paymentMethod, transactionId } = req.body;
    if (!['starter','pro'].includes(plan))
      return res.status(400).json({ message: 'Invalid plan.' });

    const durationDays = 30;
    const now    = new Date();
    const expiry = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    await user.update({
      subscription: {
        plan:      plan,
        status:    'active',
        expiry:    expiry,
        startedAt: now,
      }
    });

    res.json({
      message: `${plan} plan activated successfully!`,
      plan,
      status:  'active',
      expiry,
      user:    user.toJSON(),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/subscription/cancel ─────────────────────────────────────────────
router.post('/cancel', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (user) {
      user.subscription = { ...user.subscription, status: 'cancelled' };
      await user.save();
    }
    res.json({ message: 'Subscription cancelled.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
