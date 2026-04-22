/**
 * middleware/validate.js
 * Lightweight input validation for admin endpoints.
 * Validates types, lengths, and allowed values without external libraries.
 */

const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z]{2,})+$/;

function str(val, max = 255) {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (trimmed.length > max) return false;
  return trimmed;
}

function validEmail(val) {
  const s = str(val, 320);
  return s && EMAIL_RE.test(s) ? s : false;
}

function validDomain(val) {
  const s = str(val, 253);
  return s && DOMAIN_RE.test(s) ? s : false;
}

function validColour(val) {
  const s = str(val, 7);
  return s && COLOUR_RE.test(s) ? s : false;
}

function fail(res, message) {
  return res.status(400).json({ error: message });
}

// ── Route-specific validators ────────────────────────────────

function validateReport(req, res, next) {
  const { workspaceId, workspaceName, reportId, reportName, embedUrl, datasetId, reportType } = req.body;
  if (!str(workspaceId, 36))  return fail(res, 'workspaceId must be a valid string');
  if (!str(reportId, 36))     return fail(res, 'reportId must be a valid string');
  if (!str(reportName, 255))  return fail(res, 'reportName must be a non-empty string under 255 chars');
  if (workspaceName && !str(workspaceName, 255)) return fail(res, 'workspaceName too long');
  if (embedUrl && !str(embedUrl, 2048))          return fail(res, 'embedUrl too long');
  if (datasetId && !str(datasetId, 36))          return fail(res, 'datasetId must be a valid string');
  if (reportType && !['PowerBIReport','PaginatedReport'].includes(reportType))
    return fail(res, 'reportType must be PowerBIReport or PaginatedReport');
  next();
}

function validateReportPatch(req, res, next) {
  const { role_name, show_filters, show_page_nav, mobile_layout, background } = req.body;
  if (role_name !== undefined && str(role_name, 1024) === false)
    return fail(res, 'role_name must be a string under 1024 chars');
  for (const flag of [show_filters, show_page_nav, mobile_layout]) {
    if (flag !== undefined && ![0, 1, true, false].includes(flag))
      return fail(res, 'Display setting flags must be 0 or 1');
  }
  if (background !== undefined && !['default','transparent'].includes(background))
    return fail(res, 'background must be "default" or "transparent"');
  next();
}

function validateGroup(req, res, next) {
  const name = str(req.body.name, 100);
  if (!name) return fail(res, 'name must be a non-empty string under 100 chars');
  if (req.body.description && str(req.body.description, 500) === false)
    return fail(res, 'description must be under 500 chars');
  next();
}

function validateGroupReport(req, res, next) {
  const reportId = parseInt(req.body.reportId, 10);
  if (!reportId || isNaN(reportId)) return fail(res, 'reportId must be a valid integer');
  if (req.body.roleName && str(req.body.roleName, 1024) === false)
    return fail(res, 'roleName must be a string under 1024 chars');
  next();
}

function validateUserCreate(req, res, next) {
  const email = validEmail(req.body.email);
  if (!email) return fail(res, 'email must be a valid email address');
  if (req.body.displayName && str(req.body.displayName, 255) === false)
    return fail(res, 'displayName must be under 255 chars');
  next();
}

function validateUserPatch(req, res, next) {
  if (req.body.isAdmin !== undefined && typeof req.body.isAdmin !== 'boolean')
    return fail(res, 'isAdmin must be a boolean');
  if (req.body.isBlocked !== undefined && typeof req.body.isBlocked !== 'boolean')
    return fail(res, 'isBlocked must be a boolean');
  next();
}

function validateOverride(req, res, next) {
  const reportId = parseInt(req.body.reportId, 10);
  if (!reportId || isNaN(reportId)) return fail(res, 'reportId must be a valid integer');
  if (typeof req.body.granted !== 'boolean') return fail(res, 'granted must be a boolean');
  if (req.body.roleName && str(req.body.roleName, 1024) === false)
    return fail(res, 'roleName must be a string under 1024 chars');
  next();
}

function validateAccessRule(req, res, next) {
  const valid = ['allow_domain','block_domain','allow_email','block_email'];
  if (!valid.includes(req.body.type)) return fail(res, 'type must be a valid rule type');
  const { type, value } = req.body;
  if (type.includes('email')) {
    if (!validEmail(value)) return fail(res, 'value must be a valid email address');
  } else {
    if (!validDomain(value)) return fail(res, 'value must be a valid domain (e.g. contoso.com)');
  }
  next();
}

function validateSettings(req, res, next) {
  const colourFields = ['primary_colour','secondary_colour','text_primary','text_secondary'];
  for (const field of colourFields) {
    if (req.body[field] !== undefined && req.body[field] !== '' && !validColour(req.body[field]))
      return fail(res, `${field} must be a valid hex colour (e.g. #00b4a6)`);
  }
  const textFields = ['org_name','portal_title','portal_tagline','footer_left'];
  for (const field of textFields) {
    if (req.body[field] !== undefined && str(req.body[field], 255) === false)
      return fail(res, `${field} must be under 255 chars`);
  }
  if (req.body.contact_email && req.body.contact_email !== '' && !validEmail(req.body.contact_email))
    return fail(res, 'contact_email must be a valid email address');
  if (req.body.logo_url && str(req.body.logo_url, 2048) === false)
    return fail(res, 'logo_url must be under 2048 chars');
  if (req.body.favicon_url && str(req.body.favicon_url, 2048) === false)
    return fail(res, 'logo_url must be under 2048 chars');
  if (req.body.allow_new_signins !== undefined && !['0','1'].includes(req.body.allow_new_signins))
    return fail(res, 'allow_new_signins must be "0" or "1"');
  next();
}

module.exports = {
  validateReport, validateReportPatch, validateGroup, validateGroupReport,
  validateUserCreate, validateUserPatch, validateOverride,
  validateAccessRule, validateSettings,
};
