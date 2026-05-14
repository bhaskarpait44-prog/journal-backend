import express  from 'express';
import crypto   from 'crypto';
import User     from '../models/User.js';
import { generateToken, protect } from '../middleware/auth.js';
import { Op } from 'sequelize';

const router = express.Router();

// ── Helper: send email via nodemailer ─────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const { default: nodemailer } = await import('nodemailer');

  // Use SMTP config from .env, fall back to Ethereal for dev
  let transporter;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } else {
    // Dev mode — create Ethereal test account and log preview URL
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log('[Email] No SMTP configured — using Ethereal test account:', testAccount.user);
  }

  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"TradeLog" <no-reply@tradelog.in>',
    to, subject, html,
  });

  if (!process.env.SMTP_HOST) {
    console.log('[Email] Preview URL:', nodemailer.getTestMessageUrl(info));
  }
  return info;
}

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !name.trim())
      return res.status(400).json({ success: false, message: 'Name is required.' });
    if (!email || !email.trim())
      return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!password || password.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    const normalEmail = email.toLowerCase().trim();
    const existing    = await User.findOne({ where: { email: normalEmail } });

    if (existing)
      return res.status(400).json({
        success:  false,
        message:  'Email already exists. Please sign in.',
        redirect: 'login',   // hint for frontend to redirect
      });

    const user  = await User.create({ name: name.trim(), email: normalEmail, password, authProvider: 'local' });
    const token = generateToken(user.id);

    res.status(201).json({ success: true, token, user: user.toJSON() });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ success: false, message: err.message || 'Signup failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email and password are required.' });

    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.password)
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    res.json({ success: true, token: generateToken(user.id), user: user.toJSON() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: err.message || 'Login failed. Please try again.' });
  }
});

// ── POST /api/auth/google ─────────────────────────────────────────────────────
router.post('/google', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID)
      return res.status(501).json({ success: false, message: 'Google Sign-In is not configured. Set GOOGLE_CLIENT_ID in .env.' });

    const { credential } = req.body;
    if (!credential)
      return res.status(400).json({ success: false, message: 'Google credential token is required.' });

    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const { sub: googleId, email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ 
      where: { 
        [Op.or]: [{ googleId }, { email }] 
      } 
    });
    if (user) {
      if (!user.googleId) { 
        user.googleId = googleId; 
        user.authProvider = 'google'; 
        await user.save(); 
      }
    } else {
      user = await User.create({ name, email, googleId, avatar: picture, authProvider: 'google' });
    }

    res.json({ success: true, token: generateToken(user.id), user: user.toJSON() });
  } catch (err) {
    console.error('Google auth error:', err);
    const msg = err.message?.includes('Token used too late') ? 'Google token expired. Please try again.'
              : err.message?.includes('Invalid token')      ? 'Invalid Google token. Please try again.'
              : err.message || 'Google sign-in failed.';
    res.status(401).json({ success: false, message: msg });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.trim())
      return res.status(400).json({ success: false, message: 'Email is required.' });

    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });

    // Always return 200 to prevent email enumeration — only send email if found
    if (!user) {
      return res.json({ success: false, message: 'No account found with this email.' });
    }

    if (user.authProvider === 'google' && !user.password) {
      return res.json({ success: false, message: 'This account uses Google Sign-In. Please log in with Google.' });
    }

    // Generate secure reset token
    const resetToken   = crypto.randomBytes(32).toString('hex');
    const resetExpiry  = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.passwordResetToken  = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.passwordResetExpiry = resetExpiry;
    await user.save();

    const clientUrl  = process.env.CLIENT_URL || 'http://localhost:5173';
    const resetUrl   = `${clientUrl}/#reset-password?token=${resetToken}&email=${encodeURIComponent(user.email)}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:Inter,sans-serif;background:#060a12;color:#e8eeff;margin:0;padding:0">
        <div style="max-width:480px;margin:2rem auto;background:#0d1524;border:1px solid #1e2d45;border-radius:16px;overflow:hidden">
          <div style="padding:1.5rem;background:#080e1a;border-bottom:1px solid #1e2d45;display:flex;align-items:center;gap:0.5rem">
            <div style="width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center">
              <span style="color:white;font-size:14px">↗</span>
            </div>
            <strong style="color:#fff;font-size:0.95rem">TradeLog</strong>
          </div>
          <div style="padding:2rem">
            <h2 style="margin:0 0 0.5rem;color:#fff;font-size:1.2rem">Reset Your Password</h2>
            <p style="color:#7a90b0;font-size:0.875rem;margin:0 0 1.5rem">Hi ${user.name}, click the button below to reset your TradeLog password. This link expires in <strong style="color:#c0cce0">1 hour</strong>.</p>
            <a href="${resetUrl}"
               style="display:inline-block;padding:0.75rem 2rem;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;text-decoration:none;border-radius:9px;font-weight:600;font-size:0.9rem">
              Reset Password →
            </a>
            <p style="color:#3a4f6a;font-size:0.72rem;margin:1.5rem 0 0;line-height:1.6">
              If you didn't request this, you can safely ignore this email. Your password won't change.<br>
              Link expires at: ${resetExpiry.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </p>
            <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #1e2d45;font-size:0.7rem;color:#2a3f5a">
              If the button doesn't work, copy this link:<br>
              <span style="color:#3a4f6a;word-break:break-all">${resetUrl}</span>
            </div>
          </div>
        </div>
      </body>
      </html>`;

    await sendEmail({ to: user.email, subject: 'Reset your TradeLog password', html });

    res.json({ success: true, message: 'Password reset link sent to your email.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: 'Failed to send reset email. Please try again.' });
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, email, password } = req.body;

    if (!token || !email || !password)
      return res.status(400).json({ success: false, message: 'Token, email and new password are required.' });
    if (password.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    // Hash the incoming token and compare
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      where: {
        email:                email.toLowerCase().trim(),
        passwordResetToken:   hashedToken,
        passwordResetExpiry:  { [Op.gt]: new Date() },   // not expired
      }
    });

    if (!user)
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired. Please request a new one.' });

    // Set new password and clear reset fields
    user.password            = password;
    user.passwordResetToken  = null;
    user.passwordResetExpiry = null;
    await user.save();

    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Password reset failed. Please try again.' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', protect, (req, res) => res.json({ success: true, user: req.user }));

// ── POST /api/auth/subscribe ──────────────────────────────────────────────────
router.post('/subscribe', protect, async (req, res) => {
  try {
    const { plan, status, expiry } = req.body;
    if (!plan || !status) return res.status(400).json({ success: false, message: 'Plan and status are required.' });
    
    await req.user.update({
      subscription: {
        ...req.user.subscription,
        plan,
        status,
        expiry
      }
    });
    
    res.json({ success: true, user: req.user.toJSON(), subscription: req.user.subscription });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

export default router;
