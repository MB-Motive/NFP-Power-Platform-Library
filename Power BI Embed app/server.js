/**
 * server.js
 * Main entry point.
 */
require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const SqliteStore  = require('better-sqlite3-session-store')(session);
const Database     = require('better-sqlite3');

const authRouter  = require('./routes/auth');
const apiRouter   = require('./routes/api');
const adminRouter = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Logging ───────────────────────────────────────────────────
// 'combined' format in production gives Apache-style logs Azure captures
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────
// Auth endpoints: 30 requests per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// API endpoints: 200 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/auth', authLimiter);
app.use('/api',  apiLimiter);

// ── Sessions — persisted to SQLite ───────────────────────────
// Sessions survive server restarts. connect-sqlite3 uses the same
// data.db file as the rest of the app for simplicity.
app.use(session({
  store: new SqliteStore({
    client: new Database(require('path').join(__dirname, 'data.db')),
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Set secure: true when behind HTTPS (Azure App Service handles this)
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8-hour sessions
  },
}));

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────
app.use('/auth',      authRouter);
app.use('/api',       apiRouter);
app.use('/api/admin', adminRouter);

// ── Root redirect ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/dashboard.html' : '/login.html');
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Power BI Insights Portal  →  http://localhost:${PORT}`);
  console.log(`    Sessions: SQLite (persistent)`);
  console.log(`    Logging:  ${process.env.NODE_ENV === 'production' ? 'combined' : 'dev'}`);
  console.log(`    Rate limiting: auth 30/15min · api 200/15min\n`);
});
