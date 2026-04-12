/**
 * middleware/requireAdmin.js
 * Returns 403 if the authenticated user is not an admin.
 * Always apply requireAuth before this middleware.
 */
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).json({ error: 'Admin access required' });
}

module.exports = requireAdmin;
