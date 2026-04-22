const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db  = require('../db');
const { getEmbedConfig } = require('../powerbi');
const telemetry = require('../telemetry');
const router = express.Router();

// ── Public endpoint ───────────────────────────────────────────
// Intentionally unauthenticated — needed by login.html and access-denied.html
// before a session exists. Contains only visual/branding settings, nothing sensitive.
router.get('/branding', (req, res) => res.json(db.getAllSettings()));

router.use(requireAuth);

// ── /api/me ───────────────────────────────────────────────────
router.get('/me', (req, res) => res.json(req.session.user));

// ── /api/my-reports ───────────────────────────────────────────
// Returns only fields needed by the frontend — no embed URLs, dataset IDs,
// workspace IDs or role names are exposed here.
router.get('/my-reports', (req, res) => {
  try {
    const reports = db.getUserReports(req.session.user.id);
    const safe = reports.map(r => ({
      id:             r.id,
      report_name:    r.report_name,
      workspace_name: r.workspace_name,
      report_type:    r.report_type,
      is_favourite:   r.is_favourite === 1,
    }));
    res.json(safe);
  } catch (err) {
    console.error('my-reports error:', err.message);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// ── /api/embed-config/:id ─────────────────────────────────────
router.get('/embed-config/:id', async (req, res) => {
  try {
    // 2.1 — Validate ID is a proper integer before any DB or API call
    const reportDbId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reportDbId) || reportDbId <= 0) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    // Access check before any token generation — correct ordering
    if (!db.userHasAccess(req.session.user.id, reportDbId)) {
      return res.status(403).json({ error: 'Access denied to this report' });
    }

    const report = db.getReportById(reportDbId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Log report view to audit log and Application Insights
    db.writeAuditLog(
      req.session.user.id, req.session.user.email,
      'report_viewed', report.report_name,
      { reportId: reportDbId, workspaceName: report.workspace_name }
    );
    telemetry.trackEvent('ReportViewed', {
      userId:        String(req.session.user.id),
      reportId:      String(reportDbId),
      reportName:    report.report_name,
      workspaceName: report.workspace_name || '',
      reportType:    report.report_type || 'PowerBIReport',
    });

    // RLS role — priority: user override → group → report-level → none
    const effectiveRole = db.getEffectiveRole(req.session.user.id, reportDbId);
    const isPaginated   = report.report_type === 'PaginatedReport';

    // 1.1 — Use OID as the primary RLS identity (immutable, stable Entra identifier)
    // OID is passed as `username` so Power BI RLS can use USERNAME() to match it.
    // Email is passed as `customData` for datasets that use USERPRINCIPALNAME()
    // or custom DAX — the dataset author can use whichever suits their RLS model.
    const config = await getEmbedConfig(
      report.workspace_id,
      report.report_id,
      report.dataset_id,
      report.report_type,
      req.session.user.oid,       // OID as primary identity
      effectiveRole,
      req.session.user.email      // email as customData fallback
    );

    // 2.2 — Explicit whitelist of response fields — never spread config blindly
    res.json({
      embedUrl:    config.embedUrl,
      embedToken:  config.embedToken,
      reportId:    config.reportId,
      reportType:  config.reportType,
      tokenExpiry: config.tokenExpiry,
      displaySettings: {
        showFilters:  !isPaginated && !!report.show_filters,
        showPageNav:  !isPaginated && report.show_page_nav !== 0,
        showToolbar:  !!report.show_toolbar,
        mobileLayout: !isPaginated && !!report.mobile_layout,
        background:   report.background || 'default',
        isPaginated,
      }
    });
  } catch (err) {
    // 3.3 — Log full error internally, return generic message externally
    // Power BI API errors can expose workspace IDs, dataset names, internal structure
    console.error('embed-config error:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to generate embed configuration' });
  }
});

// ── Favourites ────────────────────────────────────────────────
router.post('/favourites/:id', (req, res) => {
  const rid = parseInt(req.params.id, 10);
  if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'Invalid report ID' });
  if (!db.userHasAccess(req.session.user.id, rid)) return res.status(403).json({ error: 'Access denied' });
  db.addFavourite(req.session.user.id, rid);
  res.json({ ok: true });
});

router.delete('/favourites/:id', (req, res) => {
  const rid = parseInt(req.params.id, 10);
  if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'Invalid report ID' });
  db.removeFavourite(req.session.user.id, rid);
  res.json({ ok: true });
});

module.exports = router;
