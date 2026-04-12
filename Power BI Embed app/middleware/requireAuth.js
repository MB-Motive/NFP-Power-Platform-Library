/**
 * middleware/requireAuth.js
 * Redirects unauthenticated requests to the login page.
 * For API routes, returns 401 JSON instead of a redirect.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login.html');
}

module.exports = requireAuth;
