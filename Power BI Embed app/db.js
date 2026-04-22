const Database = require('better-sqlite3');
const path     = require('path');
const { isAdminEmail } = require('./utils');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -8000'); // 8MB cache

// ── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entra_oid TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE, display_name TEXT, is_admin INTEGER DEFAULT 0,
    is_blocked INTEGER DEFAULT 0, is_pending INTEGER DEFAULT 0,
    user_type TEXT DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME
  );
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
    description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER NOT NULL, group_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, group_id),
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
    workspace_name TEXT, report_id TEXT NOT NULL, report_name TEXT NOT NULL,
    embed_url TEXT, dataset_id TEXT, report_type TEXT DEFAULT 'PowerBIReport',
    role_name TEXT,
    show_filters INTEGER DEFAULT 0, show_page_nav INTEGER DEFAULT 1,
    show_toolbar INTEGER DEFAULT 0, mobile_layout INTEGER DEFAULT 0,
    background TEXT DEFAULT 'default',
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, report_id)
  );
  CREATE TABLE IF NOT EXISTS group_reports (
    group_id INTEGER NOT NULL, report_id INTEGER NOT NULL, role_name TEXT,
    PRIMARY KEY (group_id, report_id),
    FOREIGN KEY (group_id)  REFERENCES groups(id)  ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_report_overrides (
    user_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
    granted INTEGER DEFAULT 1, role_name TEXT,
    PRIMARY KEY (user_id, report_id),
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor_id    INTEGER,
    actor_email TEXT,
    event       TEXT NOT NULL,
    target      TEXT,
    detail      TEXT
  );
  CREATE TABLE IF NOT EXISTS user_favourites (
    user_id   INTEGER NOT NULL, report_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, report_id),
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS access_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('allow_domain','block_domain','allow_email','block_email')),
    value TEXT NOT NULL COLLATE NOCASE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, value)
  );
`);

// ── Indexes ───────────────────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user_groups_user     ON user_groups(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_groups_group    ON user_groups(group_id);
  CREATE INDEX IF NOT EXISTS idx_group_reports_group  ON group_reports(group_id);
  CREATE INDEX IF NOT EXISTS idx_group_reports_report ON group_reports(report_id);
  CREATE INDEX IF NOT EXISTS idx_overrides_user       ON user_report_overrides(user_id);
  CREATE INDEX IF NOT EXISTS idx_overrides_report     ON user_report_overrides(report_id);
  CREATE INDEX IF NOT EXISTS idx_users_oid            ON users(entra_oid);
  CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
  CREATE INDEX IF NOT EXISTS idx_audit_log_ts         ON audit_log(timestamp);
`);

// ── Migrations ────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const migrations = [
  { id: 'create_user_favourites', sql: `CREATE TABLE IF NOT EXISTS user_favourites (
    user_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, report_id),
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  )` },
  // One-time heuristic fix: mark #EXT# UPN accounts as guests
  // for any users who signed in before Graph-based detection was added.
  { id: 'fix_guest_user_type', sql: `UPDATE users SET user_type='guest' WHERE email LIKE '%#EXT#%' AND user_type='member'` },
];

const applied = new Set(db.prepare('SELECT id FROM migrations').all().map(r => r.id));
for (const { id, sql } of migrations) {
  if (applied.has(id)) continue;
  try {
    db.exec(sql);
    db.prepare('INSERT INTO migrations (id) VALUES (?)').run(id);
    console.log(`Migration applied: ${id}`);
  } catch (err) {
    console.error(`Migration failed [${id}]:`, err.message);
    throw err;
  }
}

// ── Settings defaults ─────────────────────────────────────────
const defaults = {
  org_name: 'Organisation', portal_title: 'Insights Portal',
  portal_tagline: 'Insights Portal',
  primary_colour: '#00b4a6', secondary_colour: '#0f1e36',
  text_primary: '#0f1e36', text_secondary: '#8a9ab5',
  logo_url: '', contact_email: '', footer_left: '',
  allow_new_signins: '0', audit_log_retention_days: '90',
  tenant_name: '', favicon_url: '',
};
const insDefault = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaults)) insDefault.run(k, v);

// ── Pre-prepared hot-path statements ──────────────────────────
// Prepared once at module load — avoids repeated parse+compile on every call.
const stmts = {
  getUserById:    db.prepare('SELECT * FROM users WHERE id=?'),
  getUserByOid:   db.prepare('SELECT * FROM users WHERE entra_oid=?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE AND entra_oid IS NULL'),
  getUserByEmailAny: db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE'),
  updateUserLogin: db.prepare('UPDATE users SET last_login=CURRENT_TIMESTAMP,display_name=?,email=?,entra_oid=?,is_pending=0,user_type=? WHERE id=?'),
  insertUser:     db.prepare('INSERT INTO users (entra_oid,email,display_name,is_admin,last_login,user_type) VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)'),
  getReportById:  db.prepare('SELECT * FROM reports WHERE id=?'),
  userHasAccess:  db.prepare(`
    SELECT 1 FROM reports r
    WHERE r.id = ?
    AND r.id IN (
      SELECT gr.report_id FROM group_reports gr
      JOIN user_groups ug ON gr.group_id = ug.group_id
      WHERE ug.user_id = ?
      UNION
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id = ? AND uro.granted = 1
    )
    AND r.id NOT IN (
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id = ? AND uro.granted = 0
    )
  `),
};

// ── Users ─────────────────────────────────────────────────────
function findOrCreateUser(oid, email, name, userType) {
  // Try OID first, then email-only match for pending users
  let user = stmts.getUserByOid.get(oid)
          || stmts.getUserByEmail.get(email);

  if (user) {
    stmts.updateUserLogin.run(name, email, oid, userType || 'member', user.id);
    // Return updated fields without an extra SELECT
    return { ...user, display_name: name, email, entra_oid: oid,
             is_pending: 0, user_type: userType || 'member',
             last_login: new Date().toISOString() };
  }

  const r = stmts.insertUser.run(oid, email, name, 0, userType || 'member');
  return stmts.getUserById.get(r.lastInsertRowid);
}

function createPendingUser(email, displayName, userType) {
  try {
    const r = db.prepare('INSERT INTO users (email,display_name,is_pending,user_type) VALUES (?,?,1,?)')
                .run(email.toLowerCase().trim(), displayName || email, userType || 'member');
    return stmts.getUserById.get(r.lastInsertRowid);
  } catch (_) { return null; }
}

function getAllUsers() {
  return db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.user_id=u.id) AS group_count,
      (SELECT COUNT(DISTINCT r.id) FROM reports r
       WHERE r.id IN (
         SELECT gr.report_id FROM group_reports gr
         JOIN user_groups ug2 ON gr.group_id=ug2.group_id WHERE ug2.user_id=u.id
         UNION
         SELECT uro.report_id FROM user_report_overrides uro
         WHERE uro.user_id=u.id AND uro.granted=1
       ) AND r.id NOT IN (
         SELECT uro.report_id FROM user_report_overrides uro
         WHERE uro.user_id=u.id AND uro.granted=0
       )) AS report_count
    FROM users u ORDER BY u.is_pending ASC, u.created_at ASC
  `).all();
}

function getUserById(id)    { return stmts.getUserById.get(id); }
function getUserByOid(oid)  { return stmts.getUserByOid.get(oid); }
function setAdmin(id, v)    { db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(v ? 1 : 0, id); }
function setBlocked(id, v)  { db.prepare('UPDATE users SET is_blocked=? WHERE id=?').run(v ? 1 : 0, id); }
function deleteUser(id)     { db.prepare('DELETE FROM users WHERE id=?').run(id); }

// ── Groups ────────────────────────────────────────────────────
function getAllGroups() {
  return db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id=g.id) AS member_count,
      (SELECT COUNT(*) FROM group_reports gr WHERE gr.group_id=g.id) AS report_count
    FROM groups g ORDER BY g.name ASC
  `).all();
}
function getGroupById(id)            { return db.prepare('SELECT * FROM groups WHERE id=?').get(id); }
function createGroup(name, desc)     { const r = db.prepare('INSERT INTO groups (name,description) VALUES (?,?)').run(name, desc || null); return getGroupById(r.lastInsertRowid); }
function updateGroup(id, name, desc) { db.prepare('UPDATE groups SET name=?,description=? WHERE id=?').run(name, desc || null, id); return getGroupById(id); }
function deleteGroup(id)             { db.prepare('DELETE FROM groups WHERE id=?').run(id); }
function getGroupMembers(gid)        { return db.prepare('SELECT u.* FROM users u JOIN user_groups ug ON u.id=ug.user_id WHERE ug.group_id=? ORDER BY u.display_name ASC').all(gid); }
function addUserToGroup(uid, gid)    { db.prepare('INSERT OR IGNORE INTO user_groups (user_id,group_id) VALUES (?,?)').run(uid, gid); }
function removeUserFromGroup(uid, gid) { db.prepare('DELETE FROM user_groups WHERE user_id=? AND group_id=?').run(uid, gid); }
function getUserGroups(uid)          { return db.prepare('SELECT g.* FROM groups g JOIN user_groups ug ON g.id=ug.group_id WHERE ug.user_id=? ORDER BY g.name ASC').all(uid); }
function getGroupReports(gid)        { return db.prepare('SELECT r.*,gr.role_name AS assigned_role FROM reports r JOIN group_reports gr ON r.id=gr.report_id WHERE gr.group_id=? ORDER BY r.report_name ASC').all(gid); }
function addReportToGroup(gid, rid, roleName)    { db.prepare('INSERT OR IGNORE INTO group_reports (group_id,report_id,role_name) VALUES (?,?,?)').run(gid, rid, roleName || null); }
function updateGroupReportRole(gid, rid, roleName) { db.prepare('UPDATE group_reports SET role_name=? WHERE group_id=? AND report_id=?').run(roleName || null, gid, rid); }
function removeReportFromGroup(gid, rid)         { db.prepare('DELETE FROM group_reports WHERE group_id=? AND report_id=?').run(gid, rid); }

// ── Reports ───────────────────────────────────────────────────
function getAllReports() { return db.prepare('SELECT * FROM reports ORDER BY workspace_name ASC, report_name ASC').all(); }
function getReportById(id) { return stmts.getReportById.get(id); }
function addReport(wsId, wsName, rId, rName, eUrl, datasetId, reportType) {
  db.prepare('INSERT OR IGNORE INTO reports (workspace_id,workspace_name,report_id,report_name,embed_url,dataset_id,report_type) VALUES (?,?,?,?,?,?,?)')
    .run(wsId, wsName, rId, rName, eUrl, datasetId || null, reportType || 'PowerBIReport');
  return db.prepare('SELECT * FROM reports WHERE workspace_id=? AND report_id=?').get(wsId, rId);
}
function removeReport(id) { db.prepare('DELETE FROM reports WHERE id=?').run(id); }
function updateReportSettings(id, fields) {
  const allowed = ['role_name','show_filters','show_page_nav','show_toolbar','mobile_layout','background'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  db.prepare('UPDATE reports SET ' + keys.map(k => k + '=?').join(',') + ' WHERE id=?')
    .run(...keys.map(k => fields[k]), id);
}

// ── Access control ────────────────────────────────────────────
function getUserReports(uid) {
  return db.prepare(`
    SELECT DISTINCT r.*,
      CASE WHEN f.report_id IS NOT NULL THEN 1 ELSE 0 END AS is_favourite
    FROM reports r
    LEFT JOIN user_favourites f ON f.report_id = r.id AND f.user_id = ?
    WHERE r.id IN (
      SELECT gr.report_id FROM group_reports gr
      JOIN user_groups ug ON gr.group_id=ug.group_id WHERE ug.user_id=?
      UNION
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id=? AND uro.granted=1
    )
    AND r.id NOT IN (
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id=? AND uro.granted=0
    )
    ORDER BY r.workspace_name ASC, r.report_name ASC
  `).all(uid, uid, uid, uid);
}

function userHasAccess(uid, rid) {
  return !!stmts.userHasAccess.get(rid, uid, uid, uid);
}

function getEffectiveRole(userId, reportDbId) {
  const override = db.prepare(
    'SELECT role_name FROM user_report_overrides WHERE user_id=? AND report_id=? AND granted=1'
  ).get(userId, reportDbId);
  if (override?.role_name) return override.role_name;

  // ORDER BY group_id ASC for deterministic result when user is in multiple groups
  const groupRole = db.prepare(`
    SELECT gr.role_name FROM group_reports gr
    JOIN user_groups ug ON gr.group_id=ug.group_id
    WHERE ug.user_id=? AND gr.report_id=? AND gr.role_name IS NOT NULL
    ORDER BY ug.group_id ASC LIMIT 1
  `).get(userId, reportDbId);
  if (groupRole?.role_name) return groupRole.role_name;

  return stmts.getReportById.get(reportDbId)?.role_name || null;
}

function getUserOverrides(uid) {
  return db.prepare(`
    SELECT uro.*, r.report_name, r.workspace_name
    FROM user_report_overrides uro
    JOIN reports r ON uro.report_id=r.id
    WHERE uro.user_id=?
  `).all(uid);
}
function setUserOverride(uid, rid, granted, roleName) {
  db.prepare(`
    INSERT INTO user_report_overrides (user_id,report_id,granted,role_name) VALUES (?,?,?,?)
    ON CONFLICT(user_id,report_id) DO UPDATE SET granted=excluded.granted, role_name=excluded.role_name
  `).run(uid, rid, granted ? 1 : 0, roleName || null);
}
function removeUserOverride(uid, rid) {
  db.prepare('DELETE FROM user_report_overrides WHERE user_id=? AND report_id=?').run(uid, rid);
}

// ── Settings ──────────────────────────────────────────────────
function getAllSettings() {
  return Object.fromEntries(
    db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value])
  );
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

// ── Access rules ──────────────────────────────────────────────
function getAllAccessRules() {
  return db.prepare('SELECT * FROM access_rules ORDER BY type ASC, value ASC').all();
}
function addAccessRule(type, value) {
  db.prepare('INSERT OR IGNORE INTO access_rules (type,value) VALUES (?,?)').run(type, value.toLowerCase().trim());
}
function removeAccessRule(id) {
  db.prepare('DELETE FROM access_rules WHERE id=?').run(id);
}

function checkLoginAccess(email, oid) {
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1] || '';

  // Admin email always bypasses all restrictions
  if (isAdminEmail(email)) return { allowed: true };

  // Fetch settings and rules in a single transaction to avoid two separate queries
  const settings = getAllSettings();
  const allowNew = settings.allow_new_signins !== '0';

  // OID-primary lookup; email fallback only for pending users (no OID yet)
  const existingUser = oid
    ? (stmts.getUserByOid.get(oid) || stmts.getUserByEmail.get(email))
    : stmts.getUserByEmailAny.get(email);

  if (existingUser?.is_blocked) return { allowed: false, reason: 'user_blocked' };
  if (!allowNew && !existingUser) return { allowed: false, reason: 'new_signins_disabled' };

  const rules = getAllAccessRules();
  const be = rules.filter(r => r.type === 'block_email').map(r => r.value);
  const bd = rules.filter(r => r.type === 'block_domain').map(r => r.value);
  const ae = rules.filter(r => r.type === 'allow_email').map(r => r.value);
  const ad = rules.filter(r => r.type === 'allow_domain').map(r => r.value);

  if (be.includes(lower))   return { allowed: false, reason: 'email_blocked' };
  if (bd.includes(domain))  return { allowed: false, reason: 'domain_blocked' };
  if (ae.length || ad.length) {
    if (ae.includes(lower) || ad.includes(domain)) return { allowed: true };
    return { allowed: false, reason: 'not_in_allowlist' };
  }
  return { allowed: true };
}

// ── Favourites ────────────────────────────────────────────────
function getFavourites(uid) {
  return db.prepare('SELECT report_id FROM user_favourites WHERE user_id=?').all(uid).map(r => r.report_id);
}
function addFavourite(uid, rid) {
  db.prepare('INSERT OR IGNORE INTO user_favourites (user_id,report_id) VALUES (?,?)').run(uid, rid);
}
function removeFavourite(uid, rid) {
  db.prepare('DELETE FROM user_favourites WHERE user_id=? AND report_id=?').run(uid, rid);
}

// ── Audit log ─────────────────────────────────────────────────
function writeAuditLog(actorId, actorEmail, event, target, detail, meta) {
  const record = {
    audit: true, timestamp: new Date().toISOString(),
    actorId, actorEmail, event,
    target: target || null, detail: detail || null,
    ip: meta?.ip || null, userAgent: meta?.userAgent || null,
  };
  try {
    db.prepare('INSERT INTO audit_log (actor_id,actor_email,event,target,detail) VALUES (?,?,?,?,?)')
      .run(actorId || null, actorEmail || null, event, target || null,
           JSON.stringify({ ...detail || {}, ip: meta?.ip, ua: meta?.userAgent }));
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
  console.log(JSON.stringify(record));
}

// Shared WHERE-clause builder used by both getAuditLog and countAuditLog
function buildAuditWhere(from, to) {
  let sql = 'WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND timestamp >= ?'; params.push(from); }
  if (to)   { sql += ' AND timestamp <= ?'; params.push(to + 'T23:59:59'); }
  return { sql, params };
}

function getAuditLog({ from, to, limit = 50, offset = 0 } = {}) {
  const { sql, params } = buildAuditWhere(from, to);
  return db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
           .all(...params, limit, offset);
}

function countAuditLog({ from, to } = {}) {
  const { sql, params } = buildAuditWhere(from, to);
  return db.prepare(`SELECT COUNT(*) as c FROM audit_log ${sql}`).get(...params).c;
}

function purgeOldAuditLogs(retentionDays) {
  const days = Math.max(7, parseInt(retentionDays) || 90);
  db.prepare("DELETE FROM audit_log WHERE timestamp < datetime('now', ? || ' days')").run('-' + days);
}

module.exports = {
  findOrCreateUser, createPendingUser, getAllUsers, getUserById, getUserByOid,
  setAdmin, setBlocked, deleteUser,
  getAllGroups, getGroupById, createGroup, updateGroup, deleteGroup,
  getGroupMembers, addUserToGroup, removeUserFromGroup, getUserGroups,
  getGroupReports, addReportToGroup, updateGroupReportRole, removeReportFromGroup,
  getAllReports, getReportById, addReport, removeReport, updateReportSettings,
  getUserReports, userHasAccess, getEffectiveRole,
  getUserOverrides, setUserOverride, removeUserOverride,
  getFavourites, addFavourite, removeFavourite,
  getAllSettings, setSetting,
  getAllAccessRules, addAccessRule, removeAccessRule, checkLoginAccess,
  getAuditLog, countAuditLog, purgeOldAuditLogs,
  writeAuditLog,
};
