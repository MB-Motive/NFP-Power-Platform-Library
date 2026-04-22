/**
 * powerbi.js
 * Power BI REST API helpers using Service Principal (App Owns Data).
 * Uses the V2 GenerateToken endpoint — supports PowerBIReport and PaginatedReport.
 */
const axios = require('axios');

// ── Token cache ───────────────────────────────────────────────
// getPBIToken and getGraphToken share the same factory function.
// Each scope gets its own cache entry.
const tokenCache = {};

async function getToken(scope) {
  const entry = tokenCache[scope];
  if (entry && Date.now() < entry.expiry) return entry.token;

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    scope,
  });
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokenCache[scope] = {
    token:  r.data.access_token,
    expiry: Date.now() + (r.data.expires_in - 300) * 1000,
  };
  return tokenCache[scope].token;
}

const getPBIToken   = () => getToken('https://analysis.windows.net/powerbi/api/.default');
const getGraphToken = () => getToken('https://graph.microsoft.com/.default');

// ── Workspace / report browsing ───────────────────────────────
async function getWorkspaces() {
  const token = await getPBIToken();
  const r = await axios.get('https://api.powerbi.com/v1.0/myorg/groups',
    { headers: { Authorization: `Bearer ${token}` } });
  return r.data.value;
}

async function getReportsInWorkspace(workspaceId) {
  const token = await getPBIToken();
  const r = await axios.get(
    `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports`,
    { headers: { Authorization: `Bearer ${token}` } });
  return r.data.value;
}

// ── Graph user search ─────────────────────────────────────────
async function searchTenantUsers(query) {
  const token = await getGraphToken();
  const r = await axios.get(
    `https://graph.microsoft.com/v1.0/users` +
    `?$search="displayName:${query}" OR "mail:${query}" OR "userPrincipalName:${query}"` +
    `&$select=id,displayName,mail,userPrincipalName,userType&$top=20`,
    { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } }
  );
  return r.data.value.map(u => ({
    id:          u.id,
    displayName: u.displayName,
    email:       u.mail || u.userPrincipalName,
    userType:    u.userType === 'Guest' ? 'guest' : 'member',
  }));
}

// ── Paginated report dataset ID ───────────────────────────────
// The reports list endpoint doesn't expose datasetId for paginated reports.
// We fetch it from the datasources endpoint and parse the SSAS database string.
async function getPaginatedReportDatasetId(workspaceId, reportId) {
  try {
    const token = await getPBIToken();
    const r = await axios.get(
      `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports/${reportId}/datasources`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const src = r.data.value.find(d => d.datasourceType === 'AnalysisServices');
    const match = src?.connectionDetails?.database?.match(/sobe_wowvirtualserver-([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  } catch (err) {
    console.warn('Could not fetch paginated report datasource:', err.message);
    return null;
  }
}

// ── V2 Embed token ────────────────────────────────────────────
async function getEmbedConfig(workspaceId, pbiReportId, datasetId, reportType, userOid, roleName, userEmail) {
  const token = await getPBIToken();

  // Fetch report metadata for embedUrl
  const reportRes = await axios.get(
    `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports/${pbiReportId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const report = reportRes.data;

  let effectiveDatasetId = datasetId || report.datasetId || null;

  // For paginated reports, dataset ID isn't in the report metadata
  if (!effectiveDatasetId && reportType === 'PaginatedReport') {
    effectiveDatasetId = await getPaginatedReportDatasetId(workspaceId, pbiReportId);
  }

  const tokenBody = { reports: [{ id: report.id, allowEdit: false }] };

  if (effectiveDatasetId) {
    tokenBody.datasets = [{ id: effectiveDatasetId, xmlaPermissions: 'ReadOnly' }];
  }

  // RLS: OID as username (stable Entra identity), email as customData for USERPRINCIPALNAME() DAX
  if (roleName && userOid && effectiveDatasetId) {
    const roles = roleName.split(',').map(r => r.trim()).filter(Boolean);
    if (roles.length > 0) {
      const identity = { username: userOid, roles, datasets: [effectiveDatasetId] };
      if (userEmail) identity.customData = userEmail;
      tokenBody.identities = [identity];
    }
  }

  const tokenRes = await axios.post(
    'https://api.powerbi.com/v1.0/myorg/GenerateToken',
    tokenBody,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return {
    embedUrl:    report.embedUrl,
    embedToken:  tokenRes.data.token,
    reportId:    report.id,
    reportType:  reportType || 'PowerBIReport',
    tokenExpiry: tokenRes.data.expiration,
  };
}

module.exports = { getWorkspaces, getReportsInWorkspace, searchTenantUsers, getEmbedConfig, getGraphToken };
