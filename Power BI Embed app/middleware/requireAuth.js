/**
 * middleware/requireAuth.js
 * Verifies the session is present and validates token binding.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login.html');
  }

  const user = req.session.user;

  // TID mismatch is a real security issue — reject and destroy.
  // Missing oid/tid just means a pre-token-binding session — allow it
  // through so existing sessions aren't broken. They'll get oid/tid
  // on next login.
  if (user.tid && process.env.TENANT_ID && user.tid !== process.env.TENANT_ID) {
    console.warn('Session TID mismatch — destroying session for user', user.id);
    req.session.destroy(() => {});
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login.html');
  }

  next();
}

module.exports = requireAuth;
