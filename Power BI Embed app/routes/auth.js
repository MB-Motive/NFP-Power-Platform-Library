const express = require('express');
const crypto  = require('crypto');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios   = require('axios');
const { getGraphToken } = require('../powerbi');
const db = require('../db');
const { isAdminEmail, maskEmail } = require('../utils');
const router = express.Router();

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId:     process.env.CLIENT_ID,
    authority:    `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
    clientSecret: process.env.CLIENT_SECRET,
  },
});

// MSAL Node handles nonce internally as part of the auth code flow.
const SCOPES       = ['openid', 'profile', 'email'];
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

// ── GET /auth/login ───────────────────────────────────────────
router.get('/login', async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.authState = state;
    const authUrl = await msalClient.getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI, state });
    res.redirect(authUrl);
  } catch (err) {
    console.error('Login initiation error:', err.message);
    res.redirect('/login.html?error=login_failed');
  }
});

// ── GET /auth/callback ────────────────────────────────────────
router.get('/callback', async (req, res) => {
  try {
    // Validate code presence and shape
    if (!req.query.code || Array.isArray(req.query.code)) {
      console.warn('Callback: missing or malformed code parameter');
      return res.redirect('/login.html?error=invalid_state');
    }
    if (req.query.state !== req.session.authState) {
      console.warn('Callback: state mismatch (possible CSRF)');
      return res.redirect('/login.html?error=invalid_state');
    }
    delete req.session.authState;

    if (req.query.error) {
      console.warn('Callback: auth error from Microsoft:', req.query.error);
      return res.redirect('/login.html?error=auth_denied');
    }

    const tokenResponse = await msalClient.acquireTokenByCode({
      code: req.query.code, scopes: SCOPES, redirectUri: REDIRECT_URI,
    });
    const claims = tokenResponse.idTokenClaims;

    // ── Token claim validation ────────────────────────────────
    if (claims.aud !== process.env.CLIENT_ID) {
      console.warn('Token rejected: audience mismatch');
      return res.redirect('/login.html?error=auth_denied');
    }
    const expectedIssuer = `https://login.microsoftonline.com/${process.env.TENANT_ID}/v2.0`;
    if (claims.iss !== expectedIssuer) {
      console.warn('Token rejected: issuer mismatch', claims.iss);
      return res.redirect('/login.html?error=auth_denied');
    }
    if (claims.exp * 1000 < Date.now()) {
      console.warn('Token rejected: token expired');
      return res.redirect('/login.html?error=auth_denied');
    }
    if (claims.tid !== process.env.TENANT_ID) {
      console.warn('Token rejected: tid mismatch');
      return res.redirect('/login.html?error=auth_denied');
    }

    const entraOid    = claims.oid;
    const email       = claims.preferred_username || claims.email || tokenResponse.account.username;
    const displayName = claims.name || email;

    // ── Determine user type via Graph ─────────────────────────
    let userType = 'member';
    let graphSucceeded = false;
    try {
      const gToken = await getGraphToken();
      const gUser  = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${entraOid}?$select=userType`,
        { headers: { Authorization: `Bearer ${gToken}` } }
      );
      userType = gUser.data.userType === 'Guest' ? 'guest' : 'member';
      graphSucceeded = true;
    } catch (err) {
      console.warn('Graph userType lookup failed:', err.message);
    }

    if (!graphSucceeded) {
      const existingUser = db.getUserByOid(entraOid);
      if (!existingUser) {
        // New user, Graph failed — deny login
        db.writeAuditLog(null, email, 'login_denied', email, { reason: 'graph_unavailable_new_user' }, { ip: req.ip, userAgent: req.get('User-Agent') });
        console.warn('Login denied: Graph unavailable for new user', maskEmail(email));
        return res.redirect('/login.html?error=callback_failed');
      }
      userType = existingUser.user_type || 'member';
      console.warn('Graph unavailable, using stored userType:', userType);
    }

    console.log('Login:', maskEmail(email), '| userType:', userType);

    // ── Access rules check ────────────────────────────────────
    const access = db.checkLoginAccess(email, entraOid);
    if (!access.allowed) {
      db.writeAuditLog(null, email, 'login_denied', email, { reason: access.reason }, { ip: req.ip, userAgent: req.get('User-Agent') });
      console.warn('Login denied for', maskEmail(email), ':', access.reason);
      return res.redirect('/access-denied.html');
    }

    // ── Create or update user record ──────────────────────────
    // Admin determined by ADMIN_EMAIL env var, not first-login heuristic
    const user = db.findOrCreateUser(entraOid, email, displayName, userType);

    // Promote to admin if matches ADMIN_EMAIL and not already admin
    if (isAdminEmail(email) && !user.is_admin) {
      db.setAdmin(user.id, true);
      user.is_admin = 1;
    }

    // ── Session regeneration (prevents session fixation) ──────
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.redirect('/login.html?error=callback_failed');
      }
      req.session.user = {
        id:          user.id,
        oid:         entraOid,
        tid:         claims.tid,
        email:       user.email,
        displayName: user.display_name,
        isAdmin:     user.is_admin === 1,
        userType:    user.user_type,
      };
      db.writeAuditLog(user.id, user.email, 'user_login', null, { userType: user.user_type }, { ip: req.ip, userAgent: req.get('User-Agent') });
      res.redirect('/dashboard.html');
    });

  } catch (err) {
    console.error('Callback error:', err.message);
    res.redirect('/login.html?error=callback_failed');
  }
});

// ── GET /auth/logout ──────────────────────────────────────────
router.get('/logout', (req, res) => {
  const tid = req.session.user?.tid || process.env.TENANT_ID;
  const userId = req.session.user?.id;
  const userEmail = req.session.user?.email;
  req.session.destroy(() => {
    res.clearCookie('pbi.sid');
    if (userId) db.writeAuditLog(userId, userEmail, 'user_logout', null, null, { ip: req.ip, userAgent: req.get('User-Agent') });
    const postLogoutUri = encodeURIComponent(`${req.protocol}://${req.get('host')}/login.html`);
    res.redirect(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutUri}`);
  });
});

module.exports = router;
