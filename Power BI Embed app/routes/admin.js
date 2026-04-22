const express = require('express');
const requireAuth  = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const v = require('../middleware/validate');
const db  = require('../db');
const pbi = require('../powerbi');
const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// Re-validate admin status from DB on every admin request.
// Prevents a demoted admin from retaining access for the rest of their session.
router.use((req, res, next) => {
  const user = db.getUserById(req.session.user.id);
  if (!user || !user.is_admin || user.is_blocked) {
    console.warn('Admin re-validation failed for user', req.session.user.id);
    req.session.destroy(() => res.status(403).json({ error: 'Access denied' }));
    return;
  }
  next();
});

// ── Audit helper ──────────────────────────────────────────────
function audit(req, event, target, detail) {
  const meta = { ip: req.ip, userAgent: req.get("User-Agent") };
  db.writeAuditLog(req.session.user.id, req.session.user.email, event, target, detail, meta);
}

// ── Graph user search ─────────────────────────────────────────
router.get('/graph/users', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try { res.json(await pbi.searchTenantUsers(q)); }
  catch (err) { res.status(500).json({ error: err.response?.data?.error?.message || err.message }); }
});

// ── Power BI browsing ─────────────────────────────────────────
router.get('/pbi/workspaces', async (req, res) => {
  try { res.json(await pbi.getWorkspaces()); }
  catch (err) { res.status(500).json({ error: err.response?.data?.error?.message || err.message }); }
});
router.get('/pbi/workspaces/:wsId/reports', async (req, res) => {
  try { res.json(await pbi.getReportsInWorkspace(req.params.wsId)); }
  catch (err) { res.status(500).json({ error: err.response?.data?.error?.message || err.message }); }
});

// ── Reports ───────────────────────────────────────────────────
router.get('/reports', (req, res) => res.json(db.getAllReports()));

router.post('/reports', v.validateReport, (req, res) => {
  const { workspaceId, workspaceName, reportId, reportName, embedUrl, datasetId, reportType } = req.body;
  const report = db.addReport(workspaceId, workspaceName, reportId, reportName, embedUrl, datasetId, reportType);
  audit(req, 'report_added', reportName, { workspaceId, reportId, reportType });
  res.status(201).json(report);
});

router.patch('/reports/:id', v.validateReportPatch, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid report ID' });
  const fields = {};
  for (const k of ['role_name','show_filters','show_page_nav','show_toolbar','mobile_layout','background']) {
    if (k in req.body) fields[k] = req.body[k];
  }
  db.updateReportSettings(id, fields);
  audit(req, 'report_settings_updated', String(id), fields);
  res.json({ ok: true });
});

router.delete('/reports/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid report ID' });
  const report = db.getReportById(id);
  db.removeReport(id);
  audit(req, 'report_removed', report?.report_name || String(id));
  res.json({ ok: true });
});

// ── Groups ────────────────────────────────────────────────────
router.get('/groups', (req, res) => res.json(db.getAllGroups()));

router.post('/groups', v.validateGroup, (req, res) => {
  const { name, description } = req.body;
  try {
    const group = db.createGroup(name, description);
    audit(req, 'group_created', name);
    res.status(201).json(group);
  } catch (_) { res.status(409).json({ error: 'A group with that name already exists' }); }
});

router.patch('/groups/:id', v.validateGroup, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid group ID' });
  const { name, description } = req.body;
  try {
    audit(req, 'group_updated', name, { id });
    res.json(db.updateGroup(id, name, description));
  } catch (_) { res.status(409).json({ error: 'A group with that name already exists' }); }
});

router.delete('/groups/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid group ID' });
  const group = db.getGroupById(id);
  db.deleteGroup(id);
  audit(req, 'group_deleted', group?.name || String(id));
  res.json({ ok: true });
});

router.get('/groups/:id/members', (req, res) => res.json(db.getGroupMembers(parseInt(req.params.id,10))));

router.post('/groups/:id/members', (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.userId, 10);
  if (isNaN(gid) || isNaN(uid)) return res.status(400).json({ error: 'Invalid ID' });
  db.addUserToGroup(uid, gid);
  const user = db.getUserById(uid), group = db.getGroupById(gid);
  audit(req, 'group_member_added', group?.name, { userEmail: user?.email });
  res.json({ ok: true });
});

router.delete('/groups/:id/members/:userId', (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.userId, 10);
  if (isNaN(gid) || isNaN(uid)) return res.status(400).json({ error: 'Invalid ID' });
  const user = db.getUserById(uid), group = db.getGroupById(gid);
  db.removeUserFromGroup(uid, gid);
  audit(req, 'group_member_removed', group?.name, { userEmail: user?.email });
  res.json({ ok: true });
});

router.get('/groups/:id/reports', (req, res) => res.json(db.getGroupReports(parseInt(req.params.id,10))));

router.post('/groups/:id/reports', v.validateGroupReport, (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const rid = parseInt(req.body.reportId, 10);
  if (isNaN(gid)) return res.status(400).json({ error: 'Invalid group ID' });
  db.addReportToGroup(gid, rid, req.body.roleName||null);
  const report = db.getReportById(rid), group = db.getGroupById(gid);
  audit(req, 'group_report_added', group?.name, { report: report?.report_name, role: req.body.roleName||null });
  res.json({ ok: true });
});

router.patch('/groups/:id/reports/:reportId', (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const rid = parseInt(req.params.reportId, 10);
  if (isNaN(gid) || isNaN(rid)) return res.status(400).json({ error: 'Invalid ID' });
  db.updateGroupReportRole(gid, rid, req.body.roleName||null);
  res.json({ ok: true });
});

router.delete('/groups/:id/reports/:reportId', (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const rid = parseInt(req.params.reportId, 10);
  if (isNaN(gid) || isNaN(rid)) return res.status(400).json({ error: 'Invalid ID' });
  const report = db.getReportById(rid), group = db.getGroupById(gid);
  db.removeReportFromGroup(gid, rid);
  audit(req, 'group_report_removed', group?.name, { report: report?.report_name });
  res.json({ ok: true });
});

// ── Users ─────────────────────────────────────────────────────
router.get('/users', (req, res) => res.json(db.getAllUsers()));

router.post('/users', v.validateUserCreate, (req, res) => {
  const { email, displayName } = req.body;
  const user = db.createPendingUser(email, displayName);
  if (!user) return res.status(409).json({ error: 'A user with that email already exists' });
  audit(req, 'user_created_pending', email);
  res.status(201).json(user);
});

router.patch('/users/:id', v.validateUserPatch, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });
  if (userId === req.session.user.id && req.body.isAdmin === false)
    return res.status(400).json({ error: 'You cannot remove your own admin status' });
  if (userId === req.session.user.id && req.body.isBlocked === true)
    return res.status(400).json({ error: 'You cannot block your own account' });
  const user = db.getUserById(userId);
  if (typeof req.body.isAdmin === 'boolean') {
    db.setAdmin(userId, req.body.isAdmin);
    if (userId === req.session.user.id) req.session.user.isAdmin = req.body.isAdmin;
    audit(req, req.body.isAdmin ? 'user_admin_granted' : 'user_admin_revoked', user?.email);
  }
  if (typeof req.body.isBlocked === 'boolean') {
    db.setBlocked(userId, req.body.isBlocked);
    audit(req, req.body.isBlocked ? 'user_blocked' : 'user_unblocked', user?.email);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });
  if (userId === req.session.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const user = db.getUserById(userId);
  db.deleteUser(userId);
  audit(req, 'user_deleted', user?.email);
  res.json({ ok: true });
});

router.get('/users/:id/groups',    (req, res) => res.json(db.getUserGroups(parseInt(req.params.id,10))));
router.get('/users/:id/overrides', (req, res) => res.json(db.getUserOverrides(parseInt(req.params.id,10))));

router.post('/users/:id/overrides', v.validateOverride, (req, res) => {
  const uid = parseInt(req.params.id, 10);
  if (isNaN(uid)) return res.status(400).json({ error: 'Invalid user ID' });
  const { reportId, granted, roleName } = req.body;
  db.setUserOverride(uid, parseInt(reportId,10), granted, roleName||null);
  const user = db.getUserById(uid), report = db.getReportById(parseInt(reportId,10));
  audit(req, granted ? 'override_granted' : 'override_revoked', user?.email, { report: report?.report_name, role: roleName||null });
  res.json({ ok: true });
});

router.delete('/users/:id/overrides/:reportId', (req, res) => {
  const uid = parseInt(req.params.id, 10);
  const rid = parseInt(req.params.reportId, 10);
  if (isNaN(uid) || isNaN(rid)) return res.status(400).json({ error: 'Invalid ID' });
  const user = db.getUserById(uid), report = db.getReportById(rid);
  db.removeUserOverride(uid, rid);
  audit(req, 'override_removed', user?.email, { report: report?.report_name });
  res.json({ ok: true });
});

// ── Add all users of a type from Graph ───────────────────────
router.post('/users/add-all-type', async (req, res) => {
  const { userType } = req.body;
  if (!['member','guest'].includes(userType)) return res.status(400).json({ error: 'userType must be member or guest' });
  try {
    // Search Graph using common letters to get a broad list, filter by userType
    const { searchTenantUsers } = require('../powerbi');
    const existing = db.getAllUsers().map(u => u.email.toLowerCase());
    const seen = new Set();
    let added = 0, skipped = 0;
    // Multiple searches to maximise coverage
    for (const q of ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','r','s','t','u','v','w']) {
      try {
        const users = await searchTenantUsers(q);
        for (const u of users) {
          if (u.userType !== userType) continue;
          if (!u.email) continue;
          const em = u.email.toLowerCase();
          if (seen.has(em)) continue;
          seen.add(em);
          if (existing.includes(em)) { skipped++; continue; }
          try {
            db.createPendingUser(u.email, u.displayName, u.userType);
            added++;
          } catch(_) { skipped++; }
        }
      } catch(_) {}
    }
    res.json({ added, skipped });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk user operations ─────────────────────────────────────
router.post('/users/bulk', (req, res) => {
  const { userIds, action, groupId } = req.body;
  if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds required' });
  const ids = userIds.slice(0, 200).map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
  if (!ids.length) return res.status(400).json({ error: 'No valid user IDs' });
  if (userIds.length > 200) console.warn('Bulk op: capped at 200, received', userIds.length);

  // Pre-fetch group/report once — avoids repeated DB lookups inside the loop
  const bulkGroupId  = groupId ? parseInt(groupId, 10) : null;
  const bulkReportId = req.body.reportId ? parseInt(req.body.reportId, 10) : null;
  const bulkGroup    = bulkGroupId  ? db.getGroupById(bulkGroupId)   : null;
  const bulkReport   = bulkReportId ? db.getReportById(bulkReportId) : null;

  const results = { ok: [], failed: [] };
  for (const uid of ids) {
    try {
      const user = db.getUserById(uid);
      if (!user) { results.failed.push(uid); continue; }

      if (action === 'block')   { db.setBlocked(uid, true);  audit(req, 'user_blocked',   user.email); }
      if (action === 'unblock') { db.setBlocked(uid, false); audit(req, 'user_unblocked', user.email); }
      if (action === 'delete') {
        if (uid === req.session.user.id) { results.failed.push(uid); continue; }
        db.deleteUser(uid);
        audit(req, 'user_deleted', user.email);
      }
      if (action === 'add_to_group' && bulkGroup) {
        db.addUserToGroup(uid, bulkGroupId);
        audit(req, 'group_member_added', bulkGroup.name, { userEmail: user.email });
      }
      if (action === 'remove_from_group' && bulkGroup) {
        db.removeUserFromGroup(uid, bulkGroupId);
        audit(req, 'group_member_removed', bulkGroup.name, { userEmail: user.email });
      }
      if (action === 'add_report' && bulkReport) {
        db.setUserOverride(uid, bulkReportId, true, req.body.roleName || null);
        audit(req, 'override_granted', user.email, { report: bulkReport.report_name });
      }
      if (action === 'remove_report' && bulkReport) {
        db.setUserOverride(uid, bulkReportId, false, null);
        audit(req, 'override_revoked', user.email, { report: bulkReport.report_name });
      }
      results.ok.push(uid);
    } catch(err) {
      console.warn('Bulk op failed for user', uid, ':', err.message);
      results.failed.push(uid);
    }
  }
  res.json(results);
});

// ── Settings ──────────────────────────────────────────────────
router.get('/settings', (req, res) => res.json(db.getAllSettings()));

router.post('/settings', v.validateSettings, (req, res) => {
  const allowed = ['org_name','portal_title','portal_tagline','primary_colour','secondary_colour',
                   'text_primary','text_secondary','logo_url','favicon_url','contact_email','footer_left',
                   'allow_new_signins','tenant_name'];
  const changed = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      db.setSetting(key, value);
      changed[key] = value;
      // Log signin setting change as its own event type for clarity
      if (key === 'allow_new_signins') {
        audit(req, 'signin_setting_updated', null, { allow_new_signins: value === '1' ? 'enabled' : 'disabled' });
      }
    }
  }
  audit(req, 'settings_updated', null, changed);
  res.json({ ok: true });
});

// ── Access rules ──────────────────────────────────────────────
router.get('/access-rules', (req, res) => res.json(db.getAllAccessRules()));

router.post('/access-rules', v.validateAccessRule, (req, res) => {
  db.addAccessRule(req.body.type, req.body.value);
  audit(req, 'access_rule_added', `${req.body.type}:${req.body.value}`);
  res.status(201).json({ ok: true });
});

router.delete('/access-rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid rule ID' });
  const rules = db.getAllAccessRules();
  const rule = rules.find(r => r.id === id);
  db.removeAccessRule(id);
  audit(req, 'access_rule_deleted', rule ? `${rule.type}:${rule.value}` : String(id));
  res.json({ ok: true });
});

// ── Access export ─────────────────────────────────────────────
router.get('/reports/access-export', (req, res) => {
  // One row per user-report combination showing how access is granted
  const rows = db.getAllUsers().filter(u => !u.is_pending).flatMap(user => {
    const reports = db.getUserReports(user.id);
    return reports.map(report => {
      const role = db.getEffectiveRole(user.id, report.id);
      // Determine how access was granted
      const overrides = db.getUserOverrides(user.id);
      const override = overrides.find(o => o.report_id === report.id && o.granted);
      const groups = db.getUserGroups(user.id);
      const gReports = groups.flatMap(g => db.getGroupReports(g.id));
      const viaGroup = gReports.find(gr => gr.id === report.id);
      const source = override ? 'Individual override' : viaGroup ? `Group: ${groups.find(g => db.getGroupReports(g.id).some(gr => gr.id === report.id))?.name || 'Unknown'}` : 'Unknown';
      return {
        user_email:      user.email,
        user_name:       user.display_name || user.email,
        user_type:       user.user_type,
        is_admin:        user.is_admin ? 'Yes' : 'No',
        report_name:     report.report_name,
        workspace:       report.workspace_name || '',
        report_type:     report.report_type,
        access_via:      source,
        rls_role:        role || 'None (no RLS)',
      };
    });
  });

  const header = 'User Email,User Name,User Type,Admin,Report,Workspace,Report Type,Access Via,RLS Role';
  const csv = v => '"' + String(v || '').replace(/"/g, '""') + '"';
  const lines = rows.map(r =>
    [r.user_email, r.user_name, r.user_type, r.is_admin, r.report_name,
     r.workspace, r.report_type, r.access_via, r.rls_role].map(csv).join(',')
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="access-report.csv"');
  res.send([header, ...lines].join('\n'));
});

// ── Audit log ─────────────────────────────────────────────────
router.get('/audit-log', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 500);
  const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);
  const from   = req.query.from || null;
  const to     = req.query.to   || null;
  const rows   = db.getAuditLog({ from, to, limit, offset });
  const total  = db.countAuditLog({ from, to });
  res.json({ rows, total, limit, offset });
});

router.get('/audit-log/csv', (req, res) => {
  const from = req.query.from || null;
  const to   = req.query.to   || null;
  // Fetch all rows in range for CSV (no pagination)
  const rows = db.getAuditLog({ from, to, limit: 10000, offset: 0 });
  const header = 'Time (UTC),Local Time,Actor,Event,Target,Detail,IP,Browser';
  const csvRows = rows.map(e => {
    const d = new Date(e.timestamp + 'Z');
    const utc   = d.toISOString().replace('T',' ').substring(0,19);
    const local = d.toLocaleString();
    let detail = '', ip = '', browser = '';
    try {
      const p = JSON.parse(e.detail || 'null');
      if (p) {
        ip = p.ip || '';
        const ua = p.ua || '';
        browser = ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') && !ua.includes('Chrome') ? 'Safari' : ua ? 'Other' : '';
        detail = Object.entries(p).filter(([k,v]) => v !== null && v !== '' && k !== 'ip' && k !== 'ua').map(([k,v]) => k+': '+v).join('; ');
      }
    } catch(_) {}
    const csv = v => '"' + String(v||'').replace(/"/g,'""') + '"';
    return [utc, local, e.actor_email||'system', e.event, e.target||'', detail, ip, browser].map(csv).join(',');
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send([header, ...csvRows].join('\n'));
});

// Audit log retention setting
router.post('/audit-log/retention', (req, res) => {
  const days = Math.max(7, parseInt(req.body.days || '90', 10));
  db.setSetting('audit_log_retention_days', String(days));
  db.purgeOldAuditLogs(days);
  audit(req, 'audit_retention_updated', null, { days });
  res.json({ ok: true, days });
});

// ── Usage data ─────────────────────────────────────────────────
router.get('/usage', (req, res) => {
  const days  = Math.min(parseInt(req.query.days || '30', 10), 180);
  const from  = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  // Logins per day
  const loginRows = db.getAuditLog({ from, limit: 10000, offset: 0 })
    .filter(e => e.event === 'user_login');

  // Report views per report and per user
  const viewRows = db.getAuditLog({ from, limit: 10000, offset: 0 })
    .filter(e => e.event === 'report_viewed');

  // Aggregate logins by day
  const loginsByDay = {};
  loginRows.forEach(e => {
    const day = (e.timestamp + 'Z').substring(0, 10);
    loginsByDay[day] = (loginsByDay[day] || 0) + 1;
  });

  // Aggregate views by report
  const viewsByReport = {};
  viewRows.forEach(e => {
    const name = e.target || 'Unknown';
    viewsByReport[name] = (viewsByReport[name] || 0) + 1;
  });

  // Aggregate views by user
  const viewsByUser = {};
  viewRows.forEach(e => {
    const email = e.actor_email || 'Unknown';
    viewsByUser[email] = (viewsByUser[email] || 0) + 1;
  });

  // Logins by user
  const loginsByUser = {};
  loginRows.forEach(e => {
    const email = e.actor_email || 'Unknown';
    loginsByUser[email] = (loginsByUser[email] || 0) + 1;
  });

  res.json({ loginsByDay, viewsByReport, viewsByUser, loginsByUser, days });
});

module.exports = router;
