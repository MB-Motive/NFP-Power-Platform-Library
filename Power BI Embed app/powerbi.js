/**
 * powerbi.js
 * Power BI REST API helpers using Service Principal (App Owns Data).
 * Uses the V2 GenerateToken endpoint — supports PowerBIReport and PaginatedReport.
 */
const axios = require('axios');

// ── Token cache ───────────────────────────────────────────────
let pbiToken = null, pbiExpiry = null;
let graphToken = null, graphExpiry = null;

async function getPBIToken() {
  if (pbiToken && pbiExpiry && Date.now() < pbiExpiry) return pbiToken;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    scope: 'https://analysis.windows.net/powerbi/api/.default',
  });
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
    params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  pbiToken = r.data.access_token;
  pbiExpiry = Date.now() + (r.data.expires_in - 300) * 1000;
  return pbiToken;
}

async function getGraphToken() {
  if (graphToken && graphExpiry && Date.now() < graphExpiry) return graphToken;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
    params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  graphToken = r.data.access_token;
  graphExpiry = Date.now() + (r.data.expires_in - 300) * 1000;
  return graphToken;
}

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

// ── Graph user search (contains-style via $search) ────────────
async function searchTenantUsers(query) {
  const token = await getGraphToken();
  const r = await axios.get(
    `https://graph.microsoft.com/v1.0/users?$search="displayName:${query}" OR "mail:${query}" OR "userPrincipalName:${query}"&$select=id,displayName,mail,userPrincipalName,userType&$top=20`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual',
      }
    }
  );
  return r.data.value.map(u => ({
    id: u.id,
    displayName: u.displayName,
    email: u.mail || u.userPrincipalName,
    userType: u.userType === 'Guest' ? 'guest' : 'member',
  }));
}

// ── Paginated report dataset ID lookup ────────────────────────
// Paginated reports don't expose datasetId in the reports list endpoint.
// It must be fetched from the datasources endpoint and extracted from
// the AnalysisServices connectionDetails.database field.
async function getPaginatedReportDatasetId(workspaceId, reportId) {
  try {
    const token = await getPBIToken();
    const r = await axios.get(
      `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports/${reportId}/datasources`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const asSrc = r.data.value.find(d => d.datasourceType === 'AnalysisServices');
    if (!asSrc?.connectionDetails?.database) return null;
    // Format: "sobe_wowvirtualserver-{datasetId}"
    const match = asSrc.connectionDetails.database.match(/sobe_wowvirtualserver-([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  } catch (err) {
    console.warn('Could not fetch paginated report datasource:', err.message);
    return null;
  }
}

// ── V2 Embed token ────────────────────────────────────────────
async function getEmbedConfig(workspaceId, pbiReportId, datasetId, reportType, userEmail, roleName) {
  const token = await getPBIToken();

  // Fetch report metadata for embedUrl
  const reportRes = await axios.get(
    `https://api.powerbi.com/v1.0/myorg/groups/${workspaceId}/reports/${pbiReportId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const report = reportRes.data;

  let effectiveDatasetId = datasetId || report.datasetId || null;

  // For paginated reports, dataset ID isn't in the report metadata —
  // fetch it from the datasources endpoint
  if (!effectiveDatasetId && reportType === 'PaginatedReport') {
    effectiveDatasetId = await getPaginatedReportDatasetId(workspaceId, pbiReportId);
  }

  // Build V2 token request
  const tokenBody = {
    reports: [{ id: report.id, allowEdit: false }],
    targetWorkspaces: [{ id: workspaceId }],
  };

  if (effectiveDatasetId) {
    tokenBody.datasets = [{ id: effectiveDatasetId, xmlaPermissions: 'ReadOnly' }];
  }

  // RLS identity (only for reports with a dataset)
  if (roleName && userEmail && effectiveDatasetId) {
    const roles = roleName.split(',').map(r => r.trim()).filter(Boolean);
    if (roles.length > 0) {
      tokenBody.identities = [{
        username: userEmail,
        roles,
        datasets: [effectiveDatasetId],
      }];
    }
  }

  const tokenRes = await axios.post(
    'https://api.powerbi.com/v1.0/myorg/GenerateToken',
    tokenBody,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return {
    embedUrl: report.embedUrl,
    embedToken: tokenRes.data.token,
    reportId: report.id,
    reportType: reportType || 'PowerBIReport',
    tokenExpiry: tokenRes.data.expiration,
  };
}

module.exports = { getWorkspaces, getReportsInWorkspace, searchTenantUsers, getEmbedConfig, getGraphToken };
