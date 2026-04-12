# Power BI Embed app demo

A Node.js web app demonstrating the **App Owns Data** Power BI embedding pattern, with Microsoft Entra ID authentication, group-based access control, and an admin panel for managing reports and users.

---

## Architecture

```
Browser
  │
  ├─ /auth/login  ──→ Microsoft Entra ID (OAuth2 auth code flow)
  │                         └─ /auth/callback → session created
  │
  ├─ /dashboard.html  ──→ GET /api/my-reports  (filtered by access)
  │
  ├─ /report.html     ──→ GET /api/embed-config/:id
  │                         └─ Service Principal → Power BI REST API → Embed token
  │
  └─ /admin.html      ──→ /api/admin/* (admin-only)
                            └─ Manage reports, groups, users, access and branding
```

---

## Prerequisites

- Node.js 18+
- An Azure tenant (Microsoft 365 / Entra ID)
- A Power BI workspace on Fabric capacity (F SKU), Power BI Premium (P SKU) or Fabric Trial
- A Power BI report published to that workspace

---

## Part 1 – Azure App Registration

This single app registration handles both:
- **User login** (Entra ID auth code flow)
- **Power BI API access** (service principal client credentials)

### 1.1 Create the app registration

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID → App registrations → New registration**
2. Fill in:
   - **Name**: `Power BI Insights Portal`
   - **Supported account types**: *Accounts in this organisational directory only* (single tenant)
   - **Redirect URI**: Select **Web** and enter `http://localhost:3000/auth/callback`
3. Click **Register**

> Note your **Application (client) ID** → `CLIENT_ID`
> Note your **Directory (tenant) ID** → `TENANT_ID`

### 1.2 Create a client secret

1. **Certificates & secrets → Client secrets → New client secret**
2. Set a description and expiry, click **Add**
3. Copy the secret **Value** immediately

> This is your `CLIENT_SECRET`

### 1.3 Add Microsoft Graph permission (for user login)

1. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**
2. Add: `User.Read`
3. Click **Add permissions**

> This permission allows the app to read the signed-in user's profile (name, email). Users can consent to this themselves — no admin consent required.

**Note on Power BI API permissions:** No API permissions need to be added for Power BI. Access is controlled by:
- The Power BI admin setting (Part 2 below)
- Adding the service principal to the workspace (Part 3 below)

---

## Part 2 – Power BI Tenant Settings

1. Go to the [Power BI Admin Portal](https://app.powerbi.com/admin-portal/tenantSettings)
2. Find **Developer settings → Service principals can call Fabric public APIs**
3. Enable it (for all users, or for a specific security group containing your app registration)

---

## Part 3 – Power BI Workspace Access

1. Open your workspace in Power BI
2. **Workspace settings → Access**
3. Search for your app registration by name and add it as **Member** or **Contributor**

### 3.1 Find your Workspace ID

Open the workspace. The URL will be:
```
https://app.powerbi.com/groups/{WORKSPACE_ID}/list
```

> You no longer need to put IDs in `.env` — reports are managed via the admin panel.

---

## Part 4 – Project Setup

### 4.1 Install dependencies

```bash
npm install
```

### 4.2 Create your `.env` file

```bash
copy .env.example .env
```

Fill in:

```env
TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CLIENT_ID=yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy
CLIENT_SECRET=your-secret-value-here

REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=generate-a-long-random-string

PORT=3000
```

To generate a SESSION_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4.3 Run the app

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000)

---

## First-run workflow

1. **Sign in** — the first user to log in automatically becomes the admin
2. **Admin → Reports tab** — click "Sync workspaces" to browse your Power BI content, then click **+ Add** on the reports you want available
3. **Admin → Groups tab** — create groups (e.g. "Finance Team"), assign reports to each group
4. **Admin → Users tab** — as other users sign in, assign them to groups, or grant individual report access
5. **Dashboard** — users see only the reports they have been given access to

---

## Access control logic

A user can see a report if:
- They are in a **group** that has the report assigned

OR

- They have an **individual grant** on the report

AND NOT

- They have an **individual revocation** (this overrides group access)

---

## Project structure

```
powerbi-embed-demo/
├── server.js              ← Express entry point
├── db.js                  ← SQLite schema and all DB operations
├── powerbi.js             ← Power BI REST API helpers
├── middleware/
│   ├── requireAuth.js     ← Redirects unauthenticated users
│   └── requireAdmin.js    ← Returns 403 for non-admins
├── routes/
│   ├── auth.js            ← /auth/login, /auth/callback, /auth/logout
│   ├── api.js             ← /api/me, /api/my-reports, /api/embed-config/:id
│   └── admin.js           ← All /api/admin/* endpoints
├── public/
│   ├── style.css          ← Shared styles
│   ├── login.html         ← Sign-in page
│   ├── dashboard.html     ← Report cards for the logged-in user
│   ├── report.html        ← Embedded report view
│   └── admin.html         ← Admin panel (reports, groups, users)
├── data.db                ← SQLite database (auto-created on first run)
├── .env                   ← Your secrets (never commit this)
├── .env.example
└── package.json
```

---

## Common errors

| Error | Likely cause |
|---|---|
| Redirect to login loops | `REDIRECT_URI` in `.env` doesn't match what's registered in Azure |
| `AADSTS700016` | Wrong `CLIENT_ID` or tenant |
| `AADSTS7000215` | Wrong or expired `CLIENT_SECRET` |
| 401 from Power BI API | Service principal API setting not enabled in Power BI admin |
| 403 from Power BI API | Service principal not added to the workspace |
| "No workspaces found" in admin | Service principal hasn't been added to any workspace |

---

## What to demo

**For non-technical stakeholders:**
Sign in, show the dashboard, click a report. Explain: *"Each user sees only the reports assigned to them. No Power BI licence required for your staff."*

**For technical stakeholders:**
Walk through `server.js`, `db.js`, and `routes/auth.js`. The Entra ID auth is ~60 lines. The Power BI embed is ~30 lines. The access control SQL in `db.js` is the centrepiece.
