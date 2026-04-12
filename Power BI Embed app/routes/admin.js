const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const db = require('../db');
const pbi = require('../powerbi');
const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// ── Graph user search ─────────────────────────────────────────
router.get('/graph/users', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const users = await pbi.searchTenantUsers(q);
    res.json(users);
  } catch (err) {
    console.error('Graph search error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
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

router.post('/reports', (req, res) => {
  const { workspaceId, workspaceName, reportId, reportName, embedUrl, datasetId, reportType } = req.body;
  if (!workspaceId || !reportId || !reportName)
    return res.status(400).json({ error: 'workspaceId, reportId and reportName are required' });
  res.status(201).json(db.addReport(workspaceId, workspaceName, reportId, reportName, embedUrl, datasetId, reportType));
});

router.patch('/reports/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = {};
  for (const k of ['role_name','show_filters','show_page_nav','show_toolbar','mobile_layout','background']) {
    if (k in req.body) fields[k] = req.body[k];
  }
  db.updateReportSettings(id, fields);
  res.json({ ok: true });
});

router.delete('/reports/:id', (req, res) => { db.removeReport(parseInt(req.params.id,10)); res.json({ok:true}); });

// ── Groups ────────────────────────────────────────────────────
router.get('/groups', (req, res) => res.json(db.getAllGroups()));

router.post('/groups', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try { res.status(201).json(db.createGroup(name, description)); }
  catch (_) { res.status(409).json({ error: 'A group with that name already exists' }); }
});

router.patch('/groups/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try { res.json(db.updateGroup(id, name, description)); }
  catch (_) { res.status(409).json({ error: 'A group with that name already exists' }); }
});

router.delete('/groups/:id', (req, res) => { db.deleteGroup(parseInt(req.params.id,10)); res.json({ok:true}); });
router.get('/groups/:id/members', (req, res) => res.json(db.getGroupMembers(parseInt(req.params.id,10))));
router.post('/groups/:id/members', (req, res) => { const {userId}=req.body; if(!userId)return res.status(400).json({error:'userId required'}); db.addUserToGroup(parseInt(userId,10),parseInt(req.params.id,10)); res.json({ok:true}); });
router.delete('/groups/:id/members/:userId', (req, res) => { db.removeUserFromGroup(parseInt(req.params.userId,10),parseInt(req.params.id,10)); res.json({ok:true}); });
router.get('/groups/:id/reports', (req, res) => res.json(db.getGroupReports(parseInt(req.params.id,10))));
router.post('/groups/:id/reports', (req, res) => { const {reportId,roleName}=req.body; if(!reportId)return res.status(400).json({error:'reportId required'}); db.addReportToGroup(parseInt(req.params.id,10),parseInt(reportId,10),roleName||null); res.json({ok:true}); });
router.patch('/groups/:id/reports/:reportId', (req, res) => { db.updateGroupReportRole(parseInt(req.params.id,10),parseInt(req.params.reportId,10),req.body.roleName||null); res.json({ok:true}); });
router.delete('/groups/:id/reports/:reportId', (req, res) => { db.removeReportFromGroup(parseInt(req.params.id,10),parseInt(req.params.reportId,10)); res.json({ok:true}); });

// ── Users ─────────────────────────────────────────────────────
router.get('/users', (req, res) => res.json(db.getAllUsers()));

router.post('/users', (req, res) => {
  const { email, displayName } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const user = db.createPendingUser(email, displayName);
  if (!user) return res.status(409).json({ error: 'A user with that email already exists' });
  res.status(201).json(user);
});

router.patch('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (userId === req.session.user.id && req.body.isAdmin === false)
    return res.status(400).json({ error: 'You cannot remove your own admin status' });
  if (typeof req.body.isAdmin === 'boolean') {
    db.setAdmin(userId, req.body.isAdmin);
    if (userId === req.session.user.id) req.session.user.isAdmin = req.body.isAdmin;
  }
  if (typeof req.body.isBlocked === 'boolean') db.setBlocked(userId, req.body.isBlocked);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (userId === req.session.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  db.deleteUser(userId);
  res.json({ ok: true });
});

router.get('/users/:id/groups', (req, res) => res.json(db.getUserGroups(parseInt(req.params.id,10))));
router.get('/users/:id/overrides', (req, res) => res.json(db.getUserOverrides(parseInt(req.params.id,10))));
router.post('/users/:id/overrides', (req, res) => { const {reportId,granted,roleName}=req.body; if(reportId===undefined||granted===undefined)return res.status(400).json({error:'reportId and granted required'}); db.setUserOverride(parseInt(req.params.id,10),parseInt(reportId,10),granted,roleName||null); res.json({ok:true}); });
router.delete('/users/:id/overrides/:reportId', (req, res) => { db.removeUserOverride(parseInt(req.params.id,10),parseInt(req.params.reportId,10)); res.json({ok:true}); });

// ── Settings ──────────────────────────────────────────────────
router.get('/settings', (req, res) => res.json(db.getAllSettings()));

router.post('/settings', (req, res) => {
  const allowed = ['org_name','portal_title','portal_tagline','primary_colour','secondary_colour','text_primary','text_secondary','logo_url','contact_email','footer_left','allow_new_signins','tenant_name'];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) db.setSetting(key, value);
  }
  res.json({ ok: true });
});

// ── Access rules ──────────────────────────────────────────────
router.get('/access-rules', (req, res) => res.json(db.getAllAccessRules()));
router.post('/access-rules', (req, res) => {
  const { type, value } = req.body;
  const valid = ['allow_domain','block_domain','allow_email','block_email'];
  if (!type || !value || !valid.includes(type)) return res.status(400).json({ error: 'Valid type and value required' });
  db.addAccessRule(type, value);
  res.status(201).json({ ok: true });
});
router.delete('/access-rules/:id', (req, res) => { db.removeAccessRule(parseInt(req.params.id,10)); res.json({ok:true}); });

module.exports = router;
