import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { protect, generateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

// ── GET /api/profile ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    res.json({
      name:           user.name,
      email:          user.email,
      profile:        user.profile  || {},
      riskManagement: user.riskManagement || {},
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/profile ──────────────────────────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    const { name, profile } = req.body;
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    
    if (name?.trim()) user.name = name.trim();
    if (profile)      user.profile = { ...user.profile, ...profile };
    
    await user.save();
    res.json({ name: user.name, email: user.email, profile: user.profile });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── PUT /api/profile/password ─────────────────────────────────────────────────
router.put('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: 'Current and new password are required.' });
    if (newPassword.length < 6)
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });

    const user = await User.findByPk(req.user.id);
    if (!user.password)
      return res.status(400).json({ message: 'Cannot change password for social login accounts.' });

    const match = await user.comparePassword(currentPassword);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect.' });

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password changed successfully.' });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── GET /api/profile/risk ─────────────────────────────────────────────────────
router.get('/risk', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    res.json({ riskManagement: user.riskManagement || {} });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/profile/risk ─────────────────────────────────────────────────────
router.put('/risk', async (req, res) => {
  try {
    const { totalCapital, availableMargin, riskPerTrade, maxDailyLoss } = req.body;
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const rm = { ...user.riskManagement };
    if (totalCapital    != null) rm.totalCapital    = Number(totalCapital);
    if (availableMargin != null) rm.availableMargin = Number(availableMargin);
    if (riskPerTrade    != null) rm.riskPerTrade    = Number(riskPerTrade);
    if (maxDailyLoss    != null) rm.maxDailyLoss    = Number(maxDailyLoss);
    
    user.riskManagement = rm;
    await user.save();
    res.json({ riskManagement: user.riskManagement });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ── GET /api/profile/sessions ─────────────────────────────────────────────────
router.get('/sessions', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    const sessions = (user.sessions || []).map(s => ({
      id:        s.id || s._id,
      device:    s.device,
      ip:        s.ip,
      createdAt: s.createdAt,
      lastUsed:  s.lastUsed,
    }));
    res.json({ sessions });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/profile/sessions/all ─────────────────────────────────────────
router.delete('/sessions/all', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (user) {
      user.sessions = [];
      await user.save();
    }
    res.json({ message: 'All sessions cleared. Please log in again.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/profile/account ───────────────────────────────────────────────
router.delete('/account', async (req, res) => {
  try {
    const { password } = req.body;
    const user = await User.findByPk(req.user.id);
    if (user.password) {
      if (!password) return res.status(400).json({ message: 'Password is required to delete account.' });
      const match = await user.comparePassword(password);
      if (!match) return res.status(400).json({ message: 'Incorrect password.' });
    }
    // Delete all trades too
    const Trade = (await import('../models/Trade.js')).default;
    await Trade.destroy({ where: { userId: req.user.id } });
    await user.destroy();
    res.json({ message: 'Account deleted.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
