/**
 * utils.js
 * Shared utility functions used across multiple modules.
 * Keeps common logic in one place to avoid duplication.
 */

/**
 * Returns true if the given email matches the configured ADMIN_EMAIL env var.
 * Case-insensitive. Returns false if ADMIN_EMAIL is not set.
 */
function isAdminEmail(email) {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!(adminEmail && email && email.toLowerCase() === adminEmail);
}

/**
 * Masks an email address for safe logging: matt@example.com → m***@example.com
 */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '[unknown]';
  const [local, domain] = email.split('@');
  return local[0] + '***@' + domain;
}

module.exports = { isAdminEmail, maskEmail };
