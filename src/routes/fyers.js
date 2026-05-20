import express       from 'express';
import crypto        from 'crypto';
import { protect as authMiddleware } from '../middleware/auth.js';
import { planGate } from '../middleware/planGate.js';

const router = express.Router();
router.use(planGate('brokerSync'));

// ── In-memory session store (per-process, fine for single server) ────────────
// Maps sessionId → { appId, secretId, userId, accessToken, status, error }
const sessions = new Map();
const CLEANUP_MS = 10 * 60 * 1000; // 10 min TTL

function cleanupSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > CLEANUP_MS) sessions.delete(k);
  }
}

// ── POST /api/fyers/auth-start ────────────────────────────────────────────────
// Frontend sends { appId, secretId }
// Returns { authUrl, sessionId }
router.post('/auth-start', authMiddleware, async (req, res) => {
  cleanupSessions();
  const { appId, secretId } = req.body;
  if (!appId)    return res.status(400).json({ message: 'App ID is required' });
  if (!secretId) return res.status(400).json({ message: 'Secret ID is required' });

  const sessionId   = crypto.randomBytes(16).toString('hex');
  const backendBase = process.env.BACKEND_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
  const redirectUri = `${backendBase}/api/fyers/callback`;

  sessions.set(sessionId, {
    appId, secretId,
    userId:    req.user.id.toString(),
    createdAt: Date.now(),
    status:    'pending',
    accessToken: null,
    error:     null,
  });

  const authUrl = `https://api-t1.fyers.in/api/v3/generate-authcode`
    + `?client_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&response_type=code`
    + `&state=${sessionId}`;

  res.json({ authUrl, sessionId, redirectUri });
});

// ── GET /api/fyers/callback ───────────────────────────────────────────────────
// Fyers redirects here with ?auth_code=xxx&state=sessionId
// We exchange auth_code for access_token server-side, store it, close popup
router.get('/callback', async (req, res) => {
  const { auth_code, code, state: sessionId, error } = req.query;
  const authCode = auth_code || code;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.send(closePopupHTML('Session expired or invalid. Please try again.', null));
  }

  const session = sessions.get(sessionId);

  if (error) {
    session.status = 'error';
    session.error  = `Fyers returned error: ${error}`;
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    return res.send(closePopupHTML(session.error, null));
  }

  if (!authCode) {
    session.status = 'error';
    session.error  = 'No auth code received from Fyers';
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    return res.send(closePopupHTML(session.error, null));
  }

  // Exchange auth_code for access_token
  try {
    const { default: axios } = await import('axios');

    // Fyers API v3: appIdHash = SHA256(appId:secretId)
    // appId here is the full client_id e.g. "XY1234-100"
    const hashInput = `${session.appId}:${session.secretId}`;
    const appIdHash = crypto
      .createHash('sha256')
      .update(hashInput)
      .digest('hex');

    console.log('[Fyers] Exchanging auth_code for token...');
    console.log('[Fyers] appId:', session.appId);
    console.log('[Fyers] hashInput:', hashInput);
    console.log('[Fyers] appIdHash:', appIdHash);

    const r = await axios.post('https://api-t1.fyers.in/api/v3/token', {
      grant_type:  'authorization_code',
      appIdHash,
      code:        authCode,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept':        'application/json',
      },
      timeout: 15000,
    });

    // Also try validate-authcode if token returns error
    let data = r.data;
    if ((data?.s === 'error' || data?.code === 403) && !data?.access_token) {
      console.log('[Fyers] /token failed, trying /validate-authcode...');
      const r2 = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
        grant_type: 'authorization_code',
        appIdHash,
        code: authCode,
      }, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 15000,
      });
      data = r2.data;
    }
    console.log('[Fyers] Token exchange response:', JSON.stringify(data));

    if (data?.s === 'error' || data?.s === 'Error') {
      throw new Error(data?.message || data?.errmsg || 'Token exchange failed');
    }

    const accessToken = data?.access_token || data?.data?.access_token;
    if (!accessToken) throw new Error('No access_token in Fyers response: ' + JSON.stringify(data));

    session.status      = 'success';
    session.accessToken = accessToken;

    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    return res.send(closePopupHTML(null, accessToken, session.appId, sessionId));

  } catch (err) {
    const errData = err.response?.data;
    const msg     = errData?.message || errData?.errmsg || err.message || 'Token exchange failed';
    console.error('[Fyers] Token exchange error:', err.response?.status, JSON.stringify(errData));
    session.status = 'error';
    session.error  = `${msg} (HTTP ${err.response?.status || 'network'})`;
    return res.send(closePopupHTML(msg, null));
  }
});

// ── GET /api/fyers/poll-token ─────────────────────────────────────────────────
// Frontend polls this to get the token after popup closes
router.get('/poll-token', authMiddleware, async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ status: 'expired' });
  }
  const s = sessions.get(sessionId);
  // Security: only the user who started the session can poll
  if (s.userId !== req.user.id.toString()) {
    return res.status(403).json({ status: 'forbidden' });
  }
  res.json({
    status:      s.status,
    accessToken: s.accessToken,
    appId:       s.appId,
    error:       s.error,
  });
});

// ── HTML page that closes the popup and posts result to opener ────────────────
function closePopupHTML(error, accessToken, appId, sessionId) {
  if (error) {
    return `<!DOCTYPE html><html><head><title>Fyers Auth</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#060a12;color:#ef4444;text-align:center;}</style>
    </head><body>
    <div>
      <div style="font-size:2rem;margin-bottom:1rem">❌</div>
      <div style="font-size:1rem;font-weight:600;margin-bottom:0.5rem">Authorization Failed</div>
      <div style="font-size:0.8rem;color:#7a90b0;margin-bottom:1.5rem">${error}</div>
      <div style="font-size:0.75rem;color:#3a4f6a">This window will close in 3 seconds…</div>
    </div>
    <script>setTimeout(() => window.close(), 3000);</script>
    </body></html>`;
  }

  return `<!DOCTYPE html><html><head><title>Fyers Auth</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#060a12;color:#22c55e;text-align:center;}</style>
  </head><body>
  <div>
    <div style="font-size:2rem;margin-bottom:1rem">✅</div>
    <div style="font-size:1rem;font-weight:600;color:#e8eeff;margin-bottom:0.5rem">Connected to Fyers!</div>
    <div style="font-size:0.75rem;color:#3a4f6a">Closing window…</div>
  </div>
  <script>setTimeout(() => window.close(), 1000);</script>
  </body></html>`;
}

export default router;