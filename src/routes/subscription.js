import express from 'express';
import User from '../models/User.js';
import Coupon from '../models/Coupon.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

const PLAN_PRICES = { starter: 199, pro: 699 };

// ── POST /api/subscription/validate-coupon ────────────────────────────────────
router.post('/validate-coupon', async (req, res) => {
  try {
    const { code, plan } = req.body;
    if (!code || !plan) return res.status(400).json({ message: 'Code and plan required' });

    const coupon = await Coupon.findOne({ where: { code: code.toUpperCase(), active: true } });
    
    if (!coupon) return res.status(404).json({ valid: false, message: 'Invalid or inactive coupon' });
    
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      return res.status(400).json({ valid: false, message: 'Coupon expired' });
    }

    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
      return res.status(400).json({ valid: false, message: 'Coupon usage limit reached' });
    }

    if (!coupon.validPlans.includes(plan)) {
      return res.status(400).json({ valid: false, message: 'Coupon not valid for this plan' });
    }

    const basePrice = PLAN_PRICES[plan] || 0;
    const discount = Math.round(basePrice * (coupon.discountPct / 100));
    const finalPrice = basePrice - discount;

    res.json({
      valid: true,
      discountPct: coupon.discountPct,
      finalPrice
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/subscription/activate ──────────────────────────────────────────
// Simulates payment success
router.post('/activate', async (req, res) => {
  try {
    const { plan, paymentMethod, transactionId, couponCode, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (paymentMethod === 'razorpay' || razorpay_payment_id) {
      if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        return res.status(400).json({ message: 'Payment verification details missing.' });
      }
      const generated_signature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');
        
      if (generated_signature !== razorpay_signature) {
        return res.status(400).json({ message: 'Payment verification failed. Invalid signature.' });
      }
    }

    if (!['starter','pro'].includes(plan))
      return res.status(400).json({ message: 'Invalid plan.' });

    let discountPct = 0;
    if (couponCode) {
      const coupon = await Coupon.findOne({ where: { code: couponCode.toUpperCase(), active: true } });
      if (coupon && 
          (!coupon.expiresAt || new Date(coupon.expiresAt) > new Date()) && 
          (!coupon.maxUses || coupon.usedCount < coupon.maxUses) &&
          coupon.validPlans.includes(plan)) {
        discountPct = coupon.discountPct;
        await coupon.increment('usedCount');
      }
    }

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
        discountPct: discountPct,
        couponCode: couponCode || null
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
