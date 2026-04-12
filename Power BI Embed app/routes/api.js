const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db');
const { getEmbedConfig } = require('../powerbi');
const router = express.Router();

router.get('/branding', (req, res) => res.json(db.getAllSettings()));

router.use(requireAuth);

router.get('/me', (req, res) => res.json(req.session.user));

router.get('/my-reports', (req, res) => {
  try { res.json(db.getUserReports(req.session.user.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load reports' }); }
});

router.get('/embed-config/:id', async (req, res) => {
  try {
    const reportDbId = parseInt(req.params.id, 10);
    if (!db.userHasAccess(req.session.user.id, reportDbId))
      return res.status(403).json({ error: 'Access denied to this report' });

    const report = db.getReportById(reportDbId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const effectiveRole = db.getEffectiveRole(req.session.user.id, reportDbId);
    const isPaginated = report.report_type === 'PaginatedReport';

    const config = await getEmbedConfig(
      report.workspace_id, report.report_id,
      report.dataset_id, report.report_type,
      req.session.user.email, effectiveRole
    );

    res.json({
      ...config,
      displaySettings: {
        // Paginated reports ignore filter/nav/mobile settings — auto-skipped
        showFilters:   !isPaginated && !!report.show_filters,
        showPageNav:   !isPaginated && report.show_page_nav !== 0,
        showToolbar:   !!report.show_toolbar,
        mobileLayout:  !isPaginated && !!report.mobile_layout,
        background:    report.background || 'default',
        isPaginated,
      }
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    console.error('embed-config error:', status, message);
    res.status(status).json({ error: message });
  }
});

// Token refresh endpoint — called by client before embed token expires
// Checks access again and returns a fresh token for the same report
router.get('/refresh-token/:id', async (req, res) => {
  try {
    const reportDbId = parseInt(req.params.id, 10);
    if (!db.userHasAccess(req.session.user.id, reportDbId))
      return res.status(403).json({ error: 'Access denied' });

    const report = db.getReportById(reportDbId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const effectiveRole = db.getEffectiveRole(req.session.user.id, reportDbId);
    const config = await getEmbedConfig(
      report.workspace_id, report.report_id,
      report.dataset_id, report.report_type,
      req.session.user.email, effectiveRole
    );

    // Return only what the client needs to refresh the token
    res.json({
      embedToken: config.embedToken,
      tokenExpiry: config.tokenExpiry,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    console.error('refresh-token error:', status, message);
    res.status(status).json({ error: message });
  }
});

module.exports = router;
