const express = require('express');
const crypto = require('crypto');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const { getGraphToken } = require('../powerbi');
const db = require('../db');
const router = express.Router();

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
    clientSecret: process.env.CLIENT_SECRET,
  },
});

const SCOPES = ['openid', 'profile', 'email'];
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

router.get('/login', async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.authState = state;
    const authUrl = await msalClient.getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI, state });
    res.redirect(authUrl);
  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login.html?error=login_failed');
  }
});

router.get('/callback', async (req, res) => {
  try {
    if (req.query.state !== req.session.authState) return res.redirect('/login.html?error=invalid_state');
    delete req.session.authState;
    if (req.query.error) { console.error('Auth error:', req.query.error_description); return res.redirect('/login.html?error=auth_denied'); }

    const tokenResponse = await msalClient.acquireTokenByCode({ code: req.query.code, scopes: SCOPES, redirectUri: REDIRECT_URI });
    const claims = tokenResponse.idTokenClaims;
    const entraOid    = claims.oid;
    const email       = claims.preferred_username || claims.email || tokenResponse.account.username;
    const displayName = claims.name || email;

    // Look up the user's type via Graph API — this is the definitive source.
    // B2B guests authenticate within the host tenant so tid-based detection fails.
    let userType = 'member';
    try {
      const gToken = await getGraphToken();
      const gUser = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${entraOid}?$select=userType`,
        { headers: { Authorization: `Bearer ${gToken}` } }
      );
      userType = gUser.data.userType === 'Guest' ? 'guest' : 'member';
    } catch (err) {
      // Fallback: use UPN heuristics if Graph call fails
      console.warn('Graph userType lookup failed, using heuristic:', err.message);
      userType = (claims.idtyp === 'guest' || (email && email.includes('#EXT#'))) ? 'guest' : 'member';
    }
    console.log('Login:', email, '| userType:', userType);

    const access = db.checkLoginAccess(email);
    if (!access.allowed) {
      console.warn(`Login denied for ${email}: ${access.reason}`);
      return res.redirect('/access-denied.html');
    }

    const user = db.findOrCreateUser(entraOid, email, displayName, userType);

    req.session.user = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin === 1,
      userType: user.user_type,
    };
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('/login.html?error=callback_failed');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

module.exports = router;
