/**
 * db-AzureSQL.js
 * Azure SQL implementation of the data layer.
 *
 * Drop-in replacement for db.js. All public functions have identical
 * signatures but are async (return Promises).
 *
 * Setup:
 *   1. npm install mssql connect-mssql-v2
 *   2. Set AZURE_SQL_CONNECTION_STRING in environment / App Service settings
 *   3. Rename this file to db.js (keep the SQLite version as db-sqlite.js)
 *   4. Update server.js session store (see comments in server.js)
 *
 * Recommended connection string for Azure App Service with managed identity:
 *   Server=yourserver.database.windows.net;Database=yourdb;Authentication=Active Directory Default
 *
 * For local dev with SQL Server / Azure SQL:
 *   Server=localhost;Database=pbi_portal;User Id=sa;Password=yourpassword;TrustServerCertificate=true
 */

const sql  = require('mssql');
const { isAdminEmail } = require('./utils');

// ── Connection pool ───────────────────────────────────────────
const pool = new sql.ConnectionPool(process.env.AZURE_SQL_CONNECTION_STRING);
const poolConnect = pool.connect();

pool.on('error', err => console.error('SQL pool error:', err));

// Ensure pool is ready before any query runs
async function getPool() {
  await poolConnect;
  return pool;
}

// ── Query helpers ─────────────────────────────────────────────
// Shorthand for a parameterised query.
// params is an object: { name: { type: sql.NVarChar, value: 'foo' } }
async function query(text, params = {}) {
  const p = (await getPool()).request();
  for (const [name, { type, value }] of Object.entries(params)) {
    p.input(name, type, value ?? null);
  }
  return p.query(text);
}

// Returns first row or undefined
async function queryOne(text, params = {}) {
  const r = await query(text, params);
  return r.recordset[0];
}

// Returns all rows
async function queryAll(text, params = {}) {
  const r = await query(text, params);
  return r.recordset;
}

// ── Schema ────────────────────────────────────────────────────
// Run once on startup to ensure tables exist.
// Idempotent — safe to call on every startup.
async function initSchema() {
  const p = (await getPool()).request();
  await p.batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'users')
    CREATE TABLE users (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      entra_oid     NVARCHAR(64) UNIQUE,
      email         NVARCHAR(320) NOT NULL UNIQUE,
      display_name  NVARCHAR(255),
      is_admin      BIT DEFAULT 0,
      is_blocked    BIT DEFAULT 0,
      is_pending    BIT DEFAULT 0,
      user_type     NVARCHAR(20) DEFAULT 'member',
      created_at    DATETIME2 DEFAULT GETUTCDATE(),
      last_login    DATETIME2
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'groups')
    CREATE TABLE groups (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      name        NVARCHAR(100) NOT NULL UNIQUE,
      description NVARCHAR(500),
      created_at  DATETIME2 DEFAULT GETUTCDATE()
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'user_groups')
    CREATE TABLE user_groups (
      user_id  INT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      group_id INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'reports')
    CREATE TABLE reports (
      id             INT IDENTITY(1,1) PRIMARY KEY,
      workspace_id   NVARCHAR(64)  NOT NULL,
      workspace_name NVARCHAR(255),
      report_id      NVARCHAR(64)  NOT NULL,
      report_name    NVARCHAR(255) NOT NULL,
      embed_url      NVARCHAR(2048),
      dataset_id     NVARCHAR(64),
      report_type    NVARCHAR(50)  DEFAULT 'PowerBIReport',
      role_name      NVARCHAR(1024),
      show_filters   BIT DEFAULT 0,
      show_page_nav  BIT DEFAULT 1,
      show_toolbar   BIT DEFAULT 0,
      mobile_layout  BIT DEFAULT 0,
      background     NVARCHAR(20) DEFAULT 'default',
      added_at       DATETIME2 DEFAULT GETUTCDATE(),
      UNIQUE (workspace_id, report_id)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'group_reports')
    CREATE TABLE group_reports (
      group_id  INT NOT NULL REFERENCES groups(id)  ON DELETE CASCADE,
      report_id INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      role_name NVARCHAR(1024),
      PRIMARY KEY (group_id, report_id)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'user_report_overrides')
    CREATE TABLE user_report_overrides (
      user_id   INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      report_id INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      granted   BIT DEFAULT 1,
      role_name NVARCHAR(1024),
      PRIMARY KEY (user_id, report_id)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'user_favourites')
    CREATE TABLE user_favourites (
      user_id    INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      report_id  INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      created_at DATETIME2 DEFAULT GETUTCDATE(),
      PRIMARY KEY (user_id, report_id)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'settings')
    CREATE TABLE settings (
      [key]   NVARCHAR(100) PRIMARY KEY,
      value   NVARCHAR(MAX)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'audit_log')
    CREATE TABLE audit_log (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      timestamp   DATETIME2 DEFAULT GETUTCDATE(),
      actor_id    INT,
      actor_email NVARCHAR(320),
      event       NVARCHAR(100) NOT NULL,
      target      NVARCHAR(500),
      detail      NVARCHAR(MAX)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'access_rules')
    CREATE TABLE access_rules (
      id         INT IDENTITY(1,1) PRIMARY KEY,
      type       NVARCHAR(20) NOT NULL
                   CHECK (type IN ('allow_domain','block_domain','allow_email','block_email')),
      value      NVARCHAR(320) NOT NULL,
      created_at DATETIME2 DEFAULT GETUTCDATE(),
      UNIQUE (type, value)
    );

    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'migrations')
    CREATE TABLE migrations (
      id         NVARCHAR(100) PRIMARY KEY,
      applied_at DATETIME2 DEFAULT GETUTCDATE()
    );
  `);

  // Indexes
  await p.batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_user_groups_user')
      CREATE INDEX idx_user_groups_user     ON user_groups(user_id);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_user_groups_group')
      CREATE INDEX idx_user_groups_group    ON user_groups(group_id);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_group_reports_group')
      CREATE INDEX idx_group_reports_group  ON group_reports(group_id);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_group_reports_report')
      CREATE INDEX idx_group_reports_report ON group_reports(report_id);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_overrides_user')
      CREATE INDEX idx_overrides_user       ON user_report_overrides(user_id);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_overrides_report')
      CREATE INDEX idx_overrides_report     ON user_report_overrides(report_id);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_users_oid')
      CREATE INDEX idx_users_oid            ON users(entra_oid);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_users_email')
      CREATE INDEX idx_users_email          ON users(email);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_log_ts')
      CREATE INDEX idx_audit_log_ts         ON audit_log(timestamp);
  `);

  // Seed default settings
  const defaults = {
    org_name: 'Organisation', portal_title: 'Insights Portal',
    portal_tagline: 'Insights Portal',
    primary_colour: '#00b4a6', secondary_colour: '#0f1e36',
    text_primary: '#0f1e36', text_secondary: '#8a9ab5',
    logo_url: '', contact_email: '', footer_left: '',
    allow_new_signins: '0', audit_log_retention_days: '90',
    tenant_name: '', favicon_url: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await query(`
      IF NOT EXISTS (SELECT 1 FROM settings WHERE [key] = @k)
        INSERT INTO settings ([key], value) VALUES (@k, @v)
    `, { k: { type: sql.NVarChar(100), value: k }, v: { type: sql.NVarChar(sql.MAX), value: v } });
  }

  // One-time heuristic: mark #EXT# accounts as guests
  await query(`
    UPDATE users SET user_type = 'guest'
    WHERE email LIKE '%#EXT#%' AND user_type = 'member'
  `);

  console.log('Azure SQL schema initialised');
}

// Kick off schema init — awaited inside each exported function via getPool()
const schemaReady = initSchema().catch(err => {
  console.error('Schema init failed:', err.message);
  process.exit(1);
});

async function ready() { await schemaReady; }

// ── Users ─────────────────────────────────────────────────────
async function findOrCreateUser(oid, email, name, userType) {
  await ready();
  const type = userType || 'member';

  // OID lookup first, then pending email-only match
  let user = await queryOne(
    'SELECT * FROM users WHERE entra_oid = @oid',
    { oid: { type: sql.NVarChar(64), value: oid } }
  );
  if (!user) {
    user = await queryOne(
      'SELECT * FROM users WHERE email = @email AND entra_oid IS NULL',
      { email: { type: sql.NVarChar(320), value: email } }
    );
  }

  if (user) {
    await query(`
      UPDATE users SET
        last_login   = GETUTCDATE(),
        display_name = @name,
        email        = @email,
        entra_oid    = @oid,
        is_pending   = 0,
        user_type    = @type
      WHERE id = @id
    `, {
      name:  { type: sql.NVarChar(255), value: name },
      email: { type: sql.NVarChar(320), value: email },
      oid:   { type: sql.NVarChar(64),  value: oid },
      type:  { type: sql.NVarChar(20),  value: type },
      id:    { type: sql.Int,           value: user.id },
    });
    return { ...user, display_name: name, email, entra_oid: oid, is_pending: false, user_type: type };
  }

  const result = await query(`
    INSERT INTO users (entra_oid, email, display_name, is_admin, last_login, user_type)
    OUTPUT INSERTED.id
    VALUES (@oid, @email, @name, 0, GETUTCDATE(), @type)
  `, {
    oid:   { type: sql.NVarChar(64),  value: oid },
    email: { type: sql.NVarChar(320), value: email },
    name:  { type: sql.NVarChar(255), value: name },
    type:  { type: sql.NVarChar(20),  value: type },
  });
  return getUserById(result.recordset[0].id);
}

async function createPendingUser(email, displayName, userType) {
  await ready();
  try {
    const result = await query(`
      INSERT INTO users (email, display_name, is_pending, user_type)
      OUTPUT INSERTED.id
      VALUES (@email, @name, 1, @type)
    `, {
      email: { type: sql.NVarChar(320), value: email.toLowerCase().trim() },
      name:  { type: sql.NVarChar(255), value: displayName || email },
      type:  { type: sql.NVarChar(20),  value: userType || 'member' },
    });
    return getUserById(result.recordset[0].id);
  } catch (_) { return null; }
}

async function getAllUsers() {
  await ready();
  return queryAll(`
    SELECT u.*,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.user_id = u.id) AS group_count,
      (SELECT COUNT(DISTINCT r.id) FROM reports r
       WHERE r.id IN (
         SELECT gr.report_id FROM group_reports gr
         JOIN user_groups ug2 ON gr.group_id = ug2.group_id WHERE ug2.user_id = u.id
         UNION
         SELECT uro.report_id FROM user_report_overrides uro
         WHERE uro.user_id = u.id AND uro.granted = 1
       ) AND r.id NOT IN (
         SELECT uro.report_id FROM user_report_overrides uro
         WHERE uro.user_id = u.id AND uro.granted = 0
       )) AS report_count
    FROM users u
    ORDER BY u.is_pending ASC, u.created_at ASC
  `);
}

async function getUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = @id',
    { id: { type: sql.Int, value: id } });
}

async function getUserByOid(oid) {
  return queryOne('SELECT * FROM users WHERE entra_oid = @oid',
    { oid: { type: sql.NVarChar(64), value: oid } });
}

async function setAdmin(id, v) {
  await query('UPDATE users SET is_admin = @v WHERE id = @id',
    { v: { type: sql.Bit, value: v ? 1 : 0 }, id: { type: sql.Int, value: id } });
}

async function setBlocked(id, v) {
  await query('UPDATE users SET is_blocked = @v WHERE id = @id',
    { v: { type: sql.Bit, value: v ? 1 : 0 }, id: { type: sql.Int, value: id } });
}

async function deleteUser(id) {
  await query('DELETE FROM users WHERE id = @id',
    { id: { type: sql.Int, value: id } });
}

// ── Groups ────────────────────────────────────────────────────
async function getAllGroups() {
  return queryAll(`
    SELECT g.*,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM group_reports gr WHERE gr.group_id = g.id) AS report_count
    FROM groups g ORDER BY g.name ASC
  `);
}

async function getGroupById(id) {
  return queryOne('SELECT * FROM groups WHERE id = @id',
    { id: { type: sql.Int, value: id } });
}

async function createGroup(name, desc) {
  const r = await query(
    'INSERT INTO groups (name, description) OUTPUT INSERTED.id VALUES (@name, @desc)',
    { name: { type: sql.NVarChar(100), value: name }, desc: { type: sql.NVarChar(500), value: desc || null } }
  );
  return getGroupById(r.recordset[0].id);
}

async function updateGroup(id, name, desc) {
  await query('UPDATE groups SET name = @name, description = @desc WHERE id = @id',
    { name: { type: sql.NVarChar(100), value: name }, desc: { type: sql.NVarChar(500), value: desc || null }, id: { type: sql.Int, value: id } });
  return getGroupById(id);
}

async function deleteGroup(id) {
  await query('DELETE FROM groups WHERE id = @id', { id: { type: sql.Int, value: id } });
}

async function getGroupMembers(gid) {
  return queryAll(
    'SELECT u.* FROM users u JOIN user_groups ug ON u.id = ug.user_id WHERE ug.group_id = @gid ORDER BY u.display_name ASC',
    { gid: { type: sql.Int, value: gid } }
  );
}

async function addUserToGroup(uid, gid) {
  await query(`
    IF NOT EXISTS (SELECT 1 FROM user_groups WHERE user_id = @uid AND group_id = @gid)
      INSERT INTO user_groups (user_id, group_id) VALUES (@uid, @gid)
  `, { uid: { type: sql.Int, value: uid }, gid: { type: sql.Int, value: gid } });
}

async function removeUserFromGroup(uid, gid) {
  await query('DELETE FROM user_groups WHERE user_id = @uid AND group_id = @gid',
    { uid: { type: sql.Int, value: uid }, gid: { type: sql.Int, value: gid } });
}

async function getUserGroups(uid) {
  return queryAll(
    'SELECT g.* FROM groups g JOIN user_groups ug ON g.id = ug.group_id WHERE ug.user_id = @uid ORDER BY g.name ASC',
    { uid: { type: sql.Int, value: uid } }
  );
}

async function getGroupReports(gid) {
  return queryAll(
    'SELECT r.*, gr.role_name AS assigned_role FROM reports r JOIN group_reports gr ON r.id = gr.report_id WHERE gr.group_id = @gid ORDER BY r.report_name ASC',
    { gid: { type: sql.Int, value: gid } }
  );
}

async function addReportToGroup(gid, rid, roleName) {
  await query(`
    IF NOT EXISTS (SELECT 1 FROM group_reports WHERE group_id = @gid AND report_id = @rid)
      INSERT INTO group_reports (group_id, report_id, role_name) VALUES (@gid, @rid, @role)
  `, {
    gid:  { type: sql.Int,          value: gid },
    rid:  { type: sql.Int,          value: rid },
    role: { type: sql.NVarChar(1024), value: roleName || null },
  });
}

async function updateGroupReportRole(gid, rid, roleName) {
  await query('UPDATE group_reports SET role_name = @role WHERE group_id = @gid AND report_id = @rid',
    { role: { type: sql.NVarChar(1024), value: roleName || null }, gid: { type: sql.Int, value: gid }, rid: { type: sql.Int, value: rid } });
}

async function removeReportFromGroup(gid, rid) {
  await query('DELETE FROM group_reports WHERE group_id = @gid AND report_id = @rid',
    { gid: { type: sql.Int, value: gid }, rid: { type: sql.Int, value: rid } });
}

// ── Reports ───────────────────────────────────────────────────
async function getAllReports() {
  return queryAll('SELECT * FROM reports ORDER BY workspace_name ASC, report_name ASC');
}

async function getReportById(id) {
  return queryOne('SELECT * FROM reports WHERE id = @id',
    { id: { type: sql.Int, value: id } });
}

async function addReport(wsId, wsName, rId, rName, eUrl, datasetId, reportType) {
  await query(`
    IF NOT EXISTS (SELECT 1 FROM reports WHERE workspace_id = @wsId AND report_id = @rId)
      INSERT INTO reports (workspace_id, workspace_name, report_id, report_name, embed_url, dataset_id, report_type)
      VALUES (@wsId, @wsName, @rId, @rName, @eUrl, @dsId, @rType)
  `, {
    wsId:  { type: sql.NVarChar(64),   value: wsId },
    wsName:{ type: sql.NVarChar(255),  value: wsName },
    rId:   { type: sql.NVarChar(64),   value: rId },
    rName: { type: sql.NVarChar(255),  value: rName },
    eUrl:  { type: sql.NVarChar(2048), value: eUrl || null },
    dsId:  { type: sql.NVarChar(64),   value: datasetId || null },
    rType: { type: sql.NVarChar(50),   value: reportType || 'PowerBIReport' },
  });
  return queryOne('SELECT * FROM reports WHERE workspace_id = @wsId AND report_id = @rId',
    { wsId: { type: sql.NVarChar(64), value: wsId }, rId: { type: sql.NVarChar(64), value: rId } });
}

async function removeReport(id) {
  await query('DELETE FROM reports WHERE id = @id', { id: { type: sql.Int, value: id } });
}

async function updateReportSettings(id, fields) {
  const allowed = ['role_name','show_filters','show_page_nav','show_toolbar','mobile_layout','background'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  const p = (await getPool()).request();
  p.input('id', sql.Int, id);
  for (const k of keys) {
    if (['show_filters','show_page_nav','show_toolbar','mobile_layout'].includes(k)) {
      p.input(k, sql.Bit, fields[k] ? 1 : 0);
    } else {
      p.input(k, sql.NVarChar(sql.MAX), fields[k]);
    }
  }
  await p.query(`UPDATE reports SET ${sets} WHERE id = @id`);
}

// ── Access control ────────────────────────────────────────────
async function getUserReports(uid) {
  return queryAll(`
    SELECT DISTINCT r.*,
      CASE WHEN f.report_id IS NOT NULL THEN 1 ELSE 0 END AS is_favourite
    FROM reports r
    LEFT JOIN user_favourites f ON f.report_id = r.id AND f.user_id = @uid
    WHERE r.id IN (
      SELECT gr.report_id FROM group_reports gr
      JOIN user_groups ug ON gr.group_id = ug.group_id WHERE ug.user_id = @uid
      UNION
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id = @uid AND uro.granted = 1
    )
    AND r.id NOT IN (
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id = @uid AND uro.granted = 0
    )
    ORDER BY r.workspace_name ASC, r.report_name ASC
  `, { uid: { type: sql.Int, value: uid } });
}

async function userHasAccess(uid, rid) {
  const row = await queryOne(`
    SELECT 1 AS ok FROM reports r
    WHERE r.id = @rid
    AND r.id IN (
      SELECT gr.report_id FROM group_reports gr
      JOIN user_groups ug ON gr.group_id = ug.group_id WHERE ug.user_id = @uid
      UNION
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id = @uid AND uro.granted = 1
    )
    AND r.id NOT IN (
      SELECT uro.report_id FROM user_report_overrides uro
      WHERE uro.user_id = @uid AND uro.granted = 0
    )
  `, { rid: { type: sql.Int, value: rid }, uid: { type: sql.Int, value: uid } });
  return !!row;
}

async function getEffectiveRole(userId, reportDbId) {
  const override = await queryOne(
    'SELECT role_name FROM user_report_overrides WHERE user_id = @uid AND report_id = @rid AND granted = 1',
    { uid: { type: sql.Int, value: userId }, rid: { type: sql.Int, value: reportDbId } }
  );
  if (override?.role_name) return override.role_name;

  const groupRole = await queryOne(`
    SELECT TOP 1 gr.role_name
    FROM group_reports gr
    JOIN user_groups ug ON gr.group_id = ug.group_id
    WHERE ug.user_id = @uid AND gr.report_id = @rid AND gr.role_name IS NOT NULL
    ORDER BY ug.group_id ASC
  `, { uid: { type: sql.Int, value: userId }, rid: { type: sql.Int, value: reportDbId } });
  if (groupRole?.role_name) return groupRole.role_name;

  return (await getReportById(reportDbId))?.role_name || null;
}

async function getUserOverrides(uid) {
  return queryAll(`
    SELECT uro.*, r.report_name, r.workspace_name
    FROM user_report_overrides uro
    JOIN reports r ON uro.report_id = r.id
    WHERE uro.user_id = @uid
  `, { uid: { type: sql.Int, value: uid } });
}

async function setUserOverride(uid, rid, granted, roleName) {
  await query(`
    MERGE user_report_overrides AS target
    USING (VALUES (@uid, @rid, @granted, @role)) AS src (user_id, report_id, granted, role_name)
    ON target.user_id = src.user_id AND target.report_id = src.report_id
    WHEN MATCHED THEN UPDATE SET granted = src.granted, role_name = src.role_name
    WHEN NOT MATCHED THEN INSERT (user_id, report_id, granted, role_name)
      VALUES (src.user_id, src.report_id, src.granted, src.role_name);
  `, {
    uid:     { type: sql.Int,          value: uid },
    rid:     { type: sql.Int,          value: rid },
    granted: { type: sql.Bit,          value: granted ? 1 : 0 },
    role:    { type: sql.NVarChar(1024), value: roleName || null },
  });
}

async function removeUserOverride(uid, rid) {
  await query('DELETE FROM user_report_overrides WHERE user_id = @uid AND report_id = @rid',
    { uid: { type: sql.Int, value: uid }, rid: { type: sql.Int, value: rid } });
}

// ── Settings ──────────────────────────────────────────────────
async function getAllSettings() {
  const rows = await queryAll('SELECT [key], value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function setSetting(key, value) {
  await query(`
    MERGE settings AS target
    USING (VALUES (@key, @value)) AS src ([key], value)
    ON target.[key] = src.[key]
    WHEN MATCHED THEN UPDATE SET value = src.value
    WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (src.[key], src.value);
  `, {
    key:   { type: sql.NVarChar(100),    value: key },
    value: { type: sql.NVarChar(sql.MAX), value: value },
  });
}

// ── Access rules ──────────────────────────────────────────────
async function getAllAccessRules() {
  return queryAll('SELECT * FROM access_rules ORDER BY type ASC, value ASC');
}

async function addAccessRule(type, value) {
  await query(`
    IF NOT EXISTS (SELECT 1 FROM access_rules WHERE type = @type AND value = @value)
      INSERT INTO access_rules (type, value) VALUES (@type, @value)
  `, {
    type:  { type: sql.NVarChar(20),  value: type },
    value: { type: sql.NVarChar(320), value: value.toLowerCase().trim() },
  });
}

async function removeAccessRule(id) {
  await query('DELETE FROM access_rules WHERE id = @id', { id: { type: sql.Int, value: id } });
}

async function checkLoginAccess(email, oid) {
  const lower  = email.toLowerCase();
  const domain = lower.split('@')[1] || '';

  if (isAdminEmail(email)) return { allowed: true };

  const settings = await getAllSettings();
  const allowNew = settings.allow_new_signins !== '0';

  let existingUser = oid
    ? (await queryOne('SELECT * FROM users WHERE entra_oid = @oid',
        { oid: { type: sql.NVarChar(64), value: oid } })
       || await queryOne('SELECT * FROM users WHERE email = @email AND entra_oid IS NULL',
            { email: { type: sql.NVarChar(320), value: email } }))
    : await queryOne('SELECT * FROM users WHERE email = @email',
        { email: { type: sql.NVarChar(320), value: email } });

  if (existingUser?.is_blocked) return { allowed: false, reason: 'user_blocked' };
  if (!allowNew && !existingUser) return { allowed: false, reason: 'new_signins_disabled' };

  const rules = await getAllAccessRules();
  const be = rules.filter(r => r.type === 'block_email').map(r => r.value);
  const bd = rules.filter(r => r.type === 'block_domain').map(r => r.value);
  const ae = rules.filter(r => r.type === 'allow_email').map(r => r.value);
  const ad = rules.filter(r => r.type === 'allow_domain').map(r => r.value);

  if (be.includes(lower))  return { allowed: false, reason: 'email_blocked' };
  if (bd.includes(domain)) return { allowed: false, reason: 'domain_blocked' };
  if (ae.length || ad.length) {
    if (ae.includes(lower) || ad.includes(domain)) return { allowed: true };
    return { allowed: false, reason: 'not_in_allowlist' };
  }
  return { allowed: true };
}

// ── Favourites ────────────────────────────────────────────────
async function getFavourites(uid) {
  const rows = await queryAll('SELECT report_id FROM user_favourites WHERE user_id = @uid',
    { uid: { type: sql.Int, value: uid } });
  return rows.map(r => r.report_id);
}

async function addFavourite(uid, rid) {
  await query(`
    IF NOT EXISTS (SELECT 1 FROM user_favourites WHERE user_id = @uid AND report_id = @rid)
      INSERT INTO user_favourites (user_id, report_id) VALUES (@uid, @rid)
  `, { uid: { type: sql.Int, value: uid }, rid: { type: sql.Int, value: rid } });
}

async function removeFavourite(uid, rid) {
  await query('DELETE FROM user_favourites WHERE user_id = @uid AND report_id = @rid',
    { uid: { type: sql.Int, value: uid }, rid: { type: sql.Int, value: rid } });
}

// ── Audit log ─────────────────────────────────────────────────
async function writeAuditLog(actorId, actorEmail, event, target, detail, meta) {
  const detailJson = JSON.stringify({ ...detail || {}, ip: meta?.ip, ua: meta?.userAgent });
  try {
    await query(`
      INSERT INTO audit_log (actor_id, actor_email, event, target, detail)
      VALUES (@actorId, @actorEmail, @event, @target, @detail)
    `, {
      actorId:    { type: sql.Int,            value: actorId || null },
      actorEmail: { type: sql.NVarChar(320),  value: actorEmail || null },
      event:      { type: sql.NVarChar(100),  value: event },
      target:     { type: sql.NVarChar(500),  value: target || null },
      detail:     { type: sql.NVarChar(sql.MAX), value: detailJson },
    });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
  console.log(JSON.stringify({
    audit: true, timestamp: new Date().toISOString(),
    actorId, actorEmail, event, target: target || null,
    detail: detail || null, ip: meta?.ip || null,
  }));
}

function buildAuditWhere(from, to, p) {
  let sql_str = 'WHERE 1=1';
  if (from) { sql_str += ' AND timestamp >= @from'; p.input('from', sql.DateTime2, new Date(from)); }
  if (to)   { sql_str += ' AND timestamp <= @to';   p.input('to',   sql.DateTime2, new Date(to + 'T23:59:59')); }
  return sql_str;
}

async function getAuditLog({ from, to, limit = 50, offset = 0 } = {}) {
  const p = (await getPool()).request();
  p.input('limit',  sql.Int, limit);
  p.input('offset', sql.Int, offset);
  const where = buildAuditWhere(from, to, p);
  // SQL Server uses OFFSET/FETCH for pagination
  const r = await p.query(`
    SELECT * FROM audit_log ${where}
    ORDER BY id DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);
  return r.recordset;
}

async function countAuditLog({ from, to } = {}) {
  const p = (await getPool()).request();
  const where = buildAuditWhere(from, to, p);
  const r = await p.query(`SELECT COUNT(*) AS c FROM audit_log ${where}`);
  return r.recordset[0].c;
}

async function purgeOldAuditLogs(retentionDays) {
  const days = Math.max(7, parseInt(retentionDays) || 90);
  await query(
    'DELETE FROM audit_log WHERE timestamp < DATEADD(day, @days, GETUTCDATE())',
    { days: { type: sql.Int, value: -days } }
  );
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
