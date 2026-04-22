# Power BI Insights Portal

A white-label Power BI embedded portal using the App Owns Data pattern. Built for NFP and for-purpose organisations on the [NFP Power Platform Library](https://github.com/MB-Motive/NFP-Power-Platform-Library).

## What it does

- Authenticates users via Microsoft Entra ID (single-tenant)
- Serves Power BI reports (standard and paginated) to authorised users
- Manages access via groups, individual overrides, and domain/email allow/block rules
- Provides a full admin panel for managing users, groups, reports, and branding
- Supports row-level security (RLS) with OID-based identity

## Stack

- **Backend:** Node.js, Express
- **Auth:** MSAL Node (Entra ID OAuth 2.0)
- **Database:** SQLite (better-sqlite3)
- **Sessions:** better-sqlite3-session-store (persistent across restarts)
- **Frontend:** Vanilla HTML/CSS/JS, Power BI JavaScript SDK

---

## Prerequisites

- Node.js 18+
- A Microsoft 365 tenant
- A Power BI workspace with at least one report
- An Azure App Registration with the following configured:

### App Registration setup

1. Go to **Entra ID > App registrations > New registration**
2. Set the redirect URI to `http://localhost:3000/auth/callback` (for local dev)
3. Under **Certificates & secrets**, create a client secret
4. Under **API permissions**, add:
   - `Power BI Service > Report.Read.All` (Application)
   - `Power BI Service > Dataset.Read.All` (Application)
   - `Microsoft Graph > User.Read.All` (Application)
   - Grant admin consent for all
5. Note your **Tenant ID**, **Client ID**, and **Client Secret**

### Power BI workspace setup

For each workspace containing reports you want to embed:
1. Go to the workspace in Power BI service
2. **Manage access** → add your app registration as **Member** or **Contributor**

---

## Local setup

```bash
# 1. Clone and install
git clone <repo>
cd powerbi-embed-demo-v2
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Tenant ID, Client ID, Client Secret, and a random SESSION_SECRET

# 3. Start
npm start
```

Navigate to `http://localhost:3000`. The first **member** (non-guest) to sign in becomes the admin automatically.

---

## First-time admin setup

1. Sign in with a member account from your tenant
2. Go to `/admin.html`
3. **Reports tab** → Sync workspaces → Add the reports you want to make available
4. **Groups tab** → Create a group, assign reports to it
5. **Users tab** → Add users (via tenant search), assign them to the group
6. Users can now sign in and see their reports at `/dashboard.html`

---

## Row-level security (RLS)

RLS is supported for both standard and paginated reports backed by Power BI datasets.

### Identity passed to Power BI

| DAX function | Value |
|---|---|
| `USERNAME()` | User's Entra Object ID (OID) — stable, immutable |
| `CUSTOMDATA()` | User's email address — for UPN-based RLS |

### Recommended approach

In Power BI Desktop, define your RLS role filter using OID:
```
[UserOID] = USERNAME()
```

Or using email (if your data contains email addresses):
```
[Email] = CUSTOMDATA()
```

### Configuring RLS in the portal

1. In **Reports tab**, set the role name(s) on the report — use **↓ Fetch roles** to pull names directly from the dataset
2. In **Groups tab** or **Users tab**, you can override the role per group or per user
3. Role priority: user override → group role → report-level role → no RLS

---

## Access control

### How access works

A user can see a report if:
- They are in a **group** that has been assigned the report, **AND**
- They do not have an individual **revocation override** for that report

Individual **grant overrides** give access regardless of group membership.

### Access rules

Rules on the **Access Rules tab** control who can log in:
- **Block rules** always take priority
- **Allow rules** act as an allowlist — if any allow rule exists, all other users are denied
- ⚠️ Adding the first allow rule immediately restricts access to only listed users/domains

---

## RLS misconfiguration risk

Row-level security in this portal depends on the **role name in the portal matching exactly** the role name defined in Power BI Desktop.

If an admin enters a role name that doesn't exist in the dataset (e.g. a typo, wrong case, or stale name after a dataset change), Power BI will **silently issue the embed token without RLS applied**. The user will see all data in the dataset with no filtering.

**How to avoid this:**
- Role names are case-sensitive and must match exactly what is defined under Modelling → Manage roles in Power BI Desktop
- After publishing a dataset update that changes role names, update the role name in the portal's Reports tab immediately
- Test RLS by signing in as a non-admin user and verifying they see filtered data
- The effective role applied to each user can be traced in the Audit log (look for `override_granted` and `group_report_added` events)

**Scope of the risk:**
- Only affects reports where a role name is configured in the portal but doesn't match the dataset
- Reports with no role name configured are unaffected (they simply have no RLS)
- RLS defined in Power BI Desktop still governs what roles exist — the portal cannot grant access to roles that don't exist in the dataset

---

## Security features

- Single-tenant Entra ID auth (rejects tokens from other tenants)
- Token claim validation: `aud`, `iss` (exact match), `exp`, `tid`
- Session regeneration after login (prevents session fixation)
- OID stored in session — email is display-only
- Graph API for definitive guest/member classification on every login
- Persistent SQLite sessions (survive server restarts)
- Helmet security headers (CSP, HSTS, X-Content-Type-Options, referrer-policy)
- CSP tuned for Power BI embedding
- Rate limiting: auth (30/15min), API (200/15min), embed tokens (20/min per user)
- V2 embed token scoped to specific report and dataset only
- `xmlaPermissions: ReadOnly` for paginated reports
- Input validation on all admin endpoints
- Audit log with actor, event, target, IP, and browser for all admin actions

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TENANT_ID` | Yes | Azure AD tenant ID |
| `CLIENT_ID` | Yes | App registration client ID |
| `CLIENT_SECRET` | Yes | App registration client secret |
| `REDIRECT_URI` | Yes | OAuth callback URL (must match app registration) |
| `SESSION_SECRET` | Yes | Random string for signing session cookies |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to `production` for secure cookies and combined logging |

---

## Health check

`GET /health` — returns `200 OK` with uptime. Used by Azure App Service and load balancers. No authentication required.

---

## Deployment to Azure App Service

1. Set `NODE_ENV=production` in Application Settings
2. Update `REDIRECT_URI` to your production domain
3. Update the redirect URI in your app registration to match
4. Set all `.env` variables as Application Settings (never commit `.env` to source control)
5. Consider Azure Key Vault for `CLIENT_SECRET` and `SESSION_SECRET` in production

---

## Project structure

```
├── server.js              Express entry, security headers, rate limiting, sessions
├── db.js                  SQLite schema, all DB operations, audit log
├── powerbi.js             Power BI REST API, Graph API, V2 embed token
├── .env.example           Environment variable template
├── middleware/
│   ├── requireAuth.js     Session auth check
│   ├── requireAdmin.js    Admin flag check
│   └── validate.js        Input validation for admin routes
├── routes/
│   ├── auth.js            Entra ID OAuth2, token validation, session management
│   ├── api.js             /api/me, /api/my-reports, /api/embed-config/:id
│   └── admin.js           All /api/admin/* with audit logging
└── public/
    ├── style.css          Design tokens, component styles
    ├── branding.js        Loads /api/branding, applies CSS vars and favicon
    ├── login.html
    ├── dashboard.html     Report grid with search and workspace filter
    ├── report.html        Sidebar, in-place embed, token refresh
    ├── admin.html         6-tab admin panel
    └── access-denied.html
```

---

## Production setup

This section covers everything required to run the portal in a production environment on Azure. Local development does not require any of these steps.

### 1. Azure App Service

**Recommended tier:** S1 Standard or P1v3 Premium.
- S1 is the minimum for deployment slots (zero-downtime deploys)
- P1v3 offers better RAM per dollar and is preferred for larger user counts

**Required Application Settings (set in App Service → Configuration, not in .env):**

| Setting | Value |
|---|---|
| `TENANT_ID` | Your Azure AD tenant ID |
| `CLIENT_ID` | App registration client ID |
| `CLIENT_SECRET` | From Azure Key Vault reference (see below) |
| `REDIRECT_URI` | `https://your-domain.azurewebsites.net/auth/callback` |
| `SESSION_SECRET` | From Azure Key Vault reference (see below) |
| `ADMIN_EMAIL` | Email of the initial admin user |
| `NODE_ENV` | `production` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | From Application Insights resource |

Set `NODE_ENV=production` to enable:
- Secure (HTTPS-only) session cookies
- Combined (Apache-style) HTTP logging that Azure captures
- HSTS headers

**Never commit `.env` to source control.** Use Application Settings in production.

---

### 2. Azure Key Vault

Store `CLIENT_SECRET` and `SESSION_SECRET` in Key Vault rather than as plain Application Settings.

1. Create a Key Vault in the same resource group as your App Service
2. Add the secrets: `PbiClientSecret` and `PbiSessionSecret`
3. Enable the App Service managed identity: App Service → Identity → System assigned → On
4. Grant the managed identity `Key Vault Secrets User` on the Key Vault
5. In Application Settings, use Key Vault references:
   ```
   CLIENT_SECRET  = @Microsoft.KeyVault(SecretUri=https://your-kv.vault.azure.net/secrets/PbiClientSecret/)
   SESSION_SECRET = @Microsoft.KeyVault(SecretUri=https://your-kv.vault.azure.net/secrets/PbiSessionSecret/)
   ```

---

### 3. HTTPS and custom domain

Azure App Service provides HTTPS on the `.azurewebsites.net` domain automatically.

For a custom domain:
1. App Service → Custom domains → Add custom domain
2. App Service → TLS/SSL → Add a managed certificate (free)
3. Update `REDIRECT_URI` in Application Settings and in your app registration

---

### 4. Application Insights

1. Create an Application Insights resource in the Azure portal
2. Copy the **Connection String** (not the instrumentation key)
3. Add it as `APPLICATIONINSIGHTS_CONNECTION_STRING` in Application Settings
4. The portal will automatically begin collecting:
   - HTTP request traces and response times
   - Unhandled exceptions
   - Custom events: `ReportViewed`, `ReportError`
   - Console logs

Run `npm install` after adding `applicationinsights` to activate the SDK locally for testing.

---

### 5. CI/CD with GitHub Actions

A workflow file is included at `.github/workflows/deploy.yml`. It:
- Runs `npm ci` (clean install from lockfile)
- Runs `npm audit --audit-level=high` — **fails the build on high or critical vulnerabilities**
- Deploys to Azure App Service on push to `main`

**Setup:**
1. In Azure portal, go to App Service → Get publish profile → download the file
2. In GitHub, go to Settings → Secrets → Actions → New secret
   - Name: `AZURE_WEBAPP_PUBLISH_PROFILE`
   - Value: paste the entire contents of the publish profile file
3. In GitHub Settings → Variables → Actions → New variable
   - Name: `AZURE_WEBAPP_NAME`
   - Value: your App Service name (e.g. `my-pbi-portal`)
4. Push to `main` — the pipeline runs automatically

**Zero-downtime deploys:** use App Service deployment slots. Create a `staging` slot, deploy there first, then swap. The workflow can be extended to do this automatically.

---

### 6. SQLite in production

SQLite works for a single App Service instance with moderate load. For production:

**Backups:** App Service does not back up files in `/home` automatically for SQLite.
Set up a daily backup using Azure Logic Apps or a scheduled WebJob that copies `data.db` to an Azure Storage account blob container.

Example Logic App schedule:
```
Trigger: Recurrence (daily at 02:00)
Action: Run command on App Service → cp /home/site/wwwroot/data.db /mnt/backup/data-$(date +%Y%m%d).db
Action: Upload to Azure Blob Storage
```

**Scaling:** SQLite cannot support multiple App Service instances simultaneously (no distributed locking). If you need to scale out, migrate to Azure SQL:
1. Export data: `sqlite3 data.db .dump > export.sql`
2. Adapt schema for T-SQL (minor type changes)
3. Replace `better-sqlite3` with `mssql` or `tedious`
4. Update connection string in Application Settings

---

### 7. CLIENT_SECRET rotation

Rotate the app registration client secret every 90 days:
1. Entra ID → App registrations → your app → Certificates & secrets
2. Add a new secret (note the value)
3. Update the value in Key Vault
4. App Service picks up the new value automatically via Key Vault reference
5. Delete the old secret from the app registration

Set a calendar reminder or use Entra ID secret expiry notifications.

---

### 8. Health probe

The `/health` endpoint is already built. Wire it to App Service:
1. App Service → Health check
2. Path: `/health`
3. Azure will restart unhealthy instances automatically

---

### 9. npm audit

The CI pipeline enforces `npm audit --audit-level=high`. To run locally:
```bash
npm audit
npm audit --audit-level=high  # exit code 1 if high/critical issues found
npm audit fix                  # auto-fix where possible
```

Keep dependencies updated regularly. Consider Dependabot (GitHub) or Renovate for automated PR creation on dependency updates.

---

### 10. Capacity pause schedule (cost saving)

For NFPs with business-hours-only usage, Fabric/Power BI Embedded capacity can be paused outside hours to halve the monthly cost.

Use Azure Automation or Logic Apps:
- **Pause:** weekdays at 18:00, weekends all day
- **Resume:** weekdays at 07:45 (allow 5–10 min warm-up before users arrive)

The portal handles the capacity being paused gracefully — users will see the Power BI error page with the "try again" option. Consider adding a maintenance message to `access-denied.html` for out-of-hours access.

