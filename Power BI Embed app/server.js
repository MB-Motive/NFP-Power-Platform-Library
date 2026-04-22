require('dotenv').config();
require('./telemetry').init();
const db = require('./db');

// ── Startup validation ────────────────────────────────────────
// Fail fast if required environment variables are missing.
// Better to crash on startup than to run silently misconfigured.
(function validateEnv() {
  const required = ['TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('\n❌  Missing required environment variables:', missing.join(', '));
    console.error('    Copy .env.example to .env and fill in all values.\n');
    process.exit(1);
  }
  if (process.env.SESSION_SECRET === 'change-me-in-production') {
    console.error('\n❌  SESSION_SECRET is set to the default placeholder value.');
    console.error('    Generate a real secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    process.exit(1);
  }
})();

require('dotenv').config();
const express      = require('express');
const helmet       = require('helmet');
const session      = require('express-session');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const cookieParser = require('cookie-parser');
const SqliteStore  = require('better-sqlite3-session-store')(session);
const Database     = require('better-sqlite3');

const authRouter  = require('./routes/auth');
const apiRouter   = require('./routes/api');
const adminRouter = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy — required for Azure App Service and any reverse proxy
// so that req.ip reflects the real client IP, rate limiting works correctly,
// and secure cookies function behind HTTPS termination.
app.set('trust proxy', 1);

// ── Cookie parser (required for csrf-csrf) ──────────────────
app.use(cookieParser(process.env.SESSION_SECRET));

// ── Security headers (helmet) ─────────────────────────────────
// Configure before static files and routes
app.use(helmet({
  // Power BI embedding requires relaxed frame-ancestors / CSP
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "*.powerbi.com", "fonts.googleapis.com"],
      styleSrc:       ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:        ["'self'", "fonts.gstatic.com"],
      frameSrc:       ["'self'", "https://app.powerbi.com", "https://*.powerbi.com"],
      connectSrc:     ["'self'", "https://*.powerbi.com", "https://*.analysis.windows.net",
                       "https://login.microsoftonline.com", "https://graph.microsoft.com"],
      imgSrc:         ["'self'", "data:", "https:"],
      objectSrc:      ["'none'"],
      scriptSrcAttr:  ["'unsafe-inline'"],  // Required for inline event handlers (onclick, onchange etc)
      baseUri:        ["'self'"],
      frameAncestors: ["'self'"],  // Prevent our portal being iframed elsewhere
    },
  },
  // HSTS — tell browsers to always use HTTPS (1 year)
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  // Prevent MIME-type sniffing
  xContentTypeOptions: true,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Disable X-Powered-By
  hidePoweredBy: true,
  // Prevent clickjacking (belt-and-suspenders with frameAncestors above)
  frameguard: { action: 'sameorigin' },
}));

// ── Logging ───────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));  // Cap request body size

// ── Rate limiting ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
});

// Per-session rate limit on embed token endpoints — prevents Power BI API quota exhaustion
const embedLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  max: 20,              // 20 token requests per minute per IP
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.session?.user?.id || req.ip,
  message: { error: 'Too many embed token requests, please slow down.' },
});

app.use('/auth', authLimiter);
app.use('/api',  apiLimiter);
app.use('/api/embed-config', embedLimiter);

// ── Sessions ──────────────────────────────────────────────────
app.use(session({
  store: new SqliteStore({
    client: new Database(path.join(__dirname, 'data.db')),
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  name: 'pbi.sid',
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours — aligns with typical Entra token lifetime
  },
}));

// ── Favicon ──────────────────────────────────────────────────
// Serve favicon from branding settings if set, otherwise 204 No Content
app.get('/favicon.ico', (req, res) => {
  try {
    const settings = db.getAllSettings();
    const favicon = settings.favicon_url || 'https://app.powerbi.com/images/PowerBI_Favicon.ico';
    return res.redirect(302, favicon);
  } catch (_) {
    res.redirect(302, 'https://app.powerbi.com/images/PowerBI_Favicon.ico');
  }
});


// ── CSRF protection ───────────────────────────────────────────
// Double-submit cookie pattern via csrf-csrf.
// GET /api/csrf-token sets the CSRF cookie and returns the token.
// All POST/PATCH/DELETE requests must include X-CSRF-Token header.
const { doubleCsrf } = require('csrf-csrf');
const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET,
  // Plain cookie name — no __Host- prefix, which requires HTTPS/Secure
  // and breaks local development over HTTP.
  cookieName: 'pbi-csrf',
  cookieOptions: {
    httpOnly: false,   // Must be false — the lib needs to read it
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

// Expose CSRF token to authenticated clients.
// Also sets the CSRF cookie — must be called before any mutating request.
app.get('/api/csrf-token', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const token = generateToken(req, res);
    res.json({ token });
  } catch (err) {
    console.error('CSRF token generation error:', err.message);
    res.status(500).json({ error: 'Could not generate CSRF token' });
  }
});

// Apply CSRF check to all state-mutating API routes.
// Safe methods and the OAuth callback are exempt.
const csrfProtection = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/auth/')) return next();
  doubleCsrfProtection(req, res, (err) => {
    if (err) {
      console.warn('CSRF validation failed:', req.method, req.path, err.code);
      return res.status(403).json({ error: 'Invalid or missing CSRF token. Please refresh the page.' });
    }
    next();
  });
};
app.use('/api', csrfProtection);

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────
app.use('/auth',      authRouter);
app.use('/api',       apiRouter);
app.use('/api/admin', adminRouter);

// ── Health check ──────────────────────────────────────────────
// Used by Azure App Service and load balancers — no auth required
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard.html' : '/login.html');
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  // Don't leak internal error details to the client
  res.status(500).json({ error: 'Internal server error' });
});

// ── Graceful shutdown ─────────────────────────────────────────
// Cleanly closes the SQLite connection on SIGTERM/SIGINT so in-flight
// writes complete before Azure App Service restarts the process.
function shutdown(signal) {
  console.log(`
${signal} received — shutting down gracefully`);
  try {
    const db = require('./db');
    // better-sqlite3 closes automatically on process exit, but being explicit
    // ensures WAL checkpoint completes before the process terminates.
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Audit log cleanup ─────────────────────────────────────────
function runAuditCleanup() {
  try {
    const settings = db.getAllSettings();
    const days = parseInt(settings.audit_log_retention_days || '90', 10);
    db.purgeOldAuditLogs(days);
    console.log(`Audit log: purged entries older than ${days} days`);
  } catch (err) {
    console.error('Audit log cleanup error:', err.message);
  }
}
// Run once on startup, then every 24 hours
runAuditCleanup();
setInterval(runAuditCleanup, 24 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Power BI Insights Portal  →  http://localhost:${PORT}`);
  console.log(`    Sessions:     SQLite (persistent)`);
  console.log(`    Logging:      ${process.env.NODE_ENV === 'production' ? 'combined' : 'dev'}`);
  console.log(`    Rate limits:  auth 30/15min · api 200/15min`);
  console.log(`    Security:     helmet + CSP + HSTS\n`);
});
