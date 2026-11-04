# Compliance Tracker & Calendar — Nyati

A React app (built with Vite, in `client/`) and a plain Node server (`server/`, on `node:http`
with a small router in `server/http.mjs` — no Express) that stores all tracking data in MongoDB
Atlas. Users sign in with email and password; roles are enforced on the server.

## Run locally

```
npm install                # in the repo root: React, Vite and the server's packages
copy server\.env.example server\.env     # then fill in the values (see below)
npm run dev                # API on :8000 (restarts on change) + Vite on http://localhost:5173 (hot reload)
```

Open the Vite address; it forwards `/api`, `/auth`, `/files`, `/data` and `/images` to the API server.
To run it the way production does instead: `npm run build` (writes `client/dist`), then `npm start`
(http://localhost:8000 serves both the API and the built app). `npm test` runs the server tests.

Required `.env` values: `MONGODB_URI`, and for the first run `ADMIN_EMAIL` +
`ADMIN_PASSWORD` (creates the first admin when there are no users) and
`SESSION_SECRET`. Remove `ADMIN_PASSWORD` once you have signed in; sign in, then
change the password from **Settings** in the left menu.

In Atlas, add your IP address under **Network Access**, otherwise the server cannot
connect (the error looks like a TLS / "internal error" failure).

## Demo data

`server/migrate/demo-data.mjs` fills an **empty** database with a demo: one company, five projects (real estate,
a redevelopment and two EPC sites at different stages), one user per role, statuses, documents (verified, pending,
rejected, expiring, expired, older versions), risk levels, notifications, four weeks of score history, four fictional
regulatory updates and a saved document. It refuses to run against a database that already has projects, tracking or
users, so it cannot mix into real data. Use a separate database:

```
cd server
set MONGODB_DB=compliance_demo
set DEMO_PASSWORD=choose-a-password
node migrate/demo-data.mjs            # dry run: shows the target
node migrate/demo-data.mjs --apply
```

Then start the server with the same `MONGODB_DB` and sign in as `admin@demo.test` (or `manager@`, `owner@`, `approver@`,
`depthead@`, `companyadmin@`, `pm@` — limited to one project — or `auditor@` — read-only — all `@demo.test`).

## Roles (enforced by the server)

| Role | Update status / projects | Change item stage | Manage users |
|---|---|---|---|
| Admin | yes | yes | yes |
| Compliance Head, Owner, Approver | yes | no | no |
| Read-only | no | no | no |

Admins add users, change roles, disable accounts and reset passwords on the
**Users** tab. Who made each change is recorded by the server from the signed-in
user, not from anything the browser sends.

## Deploy

Any host that runs Node or Docker works (Render, Railway, Fly.io, Azure, a VPS).
A `Dockerfile` is included at the repo root.

1. Create the service from this repo (Docker, or Node from the repo root: build
   `npm ci && npm run build`, start `npm start`).
2. Set these environment variables on the host (never commit them):
   - `NODE_ENV=production`
   - `MONGODB_URI`, `MONGODB_DB`
   - `SESSION_SECRET` — 32+ random characters
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — for the first start only
   - `TRUST_PROXY=1`
3. In Atlas **Network Access**, allow the host's outbound IP (or `0.0.0.0/0` with a
   strong database password if the host has no fixed IP). Use a database user that
   only has access to this one database.
4. Use the host's HTTPS URL. Cookies are marked secure in production, so sign-in
   only works over HTTPS.
5. Health check path: `/healthz`.
6. Turn on Atlas backups.

### Deploying to Vercel instead

The app also runs on Vercel: `npm run build` produces the React app in `client/dist`, which Vercel
serves from its CDN, and every other request goes to a single serverless function
(`api/index.mjs`, routed to by `vercel.json`) instead of the long-running `node server.js` process
above. Everything in `server/`, `shared/`, `images/` and `knowledge/` is bundled into that function.

1. Import the repo in Vercel. `vercel.json` sets the build command and output folder; the root
   `package.json` holds the client's packages plus the same server dependencies as `server/package.json`.
2. Set the same environment variables as above, plus `CRON_SECRET` (any long random string) —
   it guards the `/api/cron/daily` route that Vercel Cron calls instead of the in-process timers.
3. `vercel.json` schedules that cron for 02:30 UTC (08:00 IST) daily. **On the Hobby plan, Vercel
   allows at most daily cron runs**, so reminder/health checks move from every 6 hours to once a
   day; add more entries to `crons` (Pro plan) for the original cadence.
4. **Document uploads are capped at ~4.5 MB on Vercel**, regardless of the app's own 15 MB limit
   (`server/server.js`'s `MAX_UPLOAD`) — this is a hard platform limit on serverless function
   request bodies, not something `vercel.json` can raise. Uploads between 4.5–15 MB will fail
   with a 413 until this is addressed (e.g. a smaller limit, or a direct-to-storage upload flow).
5. Default function timeout is 60s (`maxDuration` in `vercel.json`); raise it (Pro plan, up to
   300s) if AI chat or document analysis calls are timing out.
6. Vercel's filesystem is read-only/ephemeral, but this app already stores uploads in MongoDB
   GridFS and has no other writes to local disk at request time, so this isn't a concern.

## Contents

- `client/` — the React app. `src/views/` has one component per screen (dashboard, stages,
  calendar, register, documents, vault, regulatory updates, projects, data quality, users,
  settings), `src/components/` the record drawer, notifications and Ask AI, `src/state/store.jsx`
  the shared data (collections are re-read every 5 seconds), `src/lib/records.js` the record logic.
  `login.html` / `src/login.jsx` is the sign-in page.
- `shared/items.json` — all compliance items from the master sheet, with
  normalized fields and a draft stage assignment.
- `shared/stages.json` — the draft stages ("Proposed — needs compliance head
  approval") plus "Unmapped to Stage".
- `server/server.js` — API, authentication, role checks, static hosting.
- `server/http.mjs` — the HTTP layer: routing, bodies, cookies, static files, rate limits,
  security headers.
- `data-prep/` — scripts that build `items.json` from the master Excel file.

## Re-running the data prep

If the company sends an updated master sheet, update the `path` variable at the
top of `build_data.py` and re-run the three scripts in order:

```
python3 build_data.py
python3 normalize.py
python3 stage_map.py
cp items_final.json ../shared/items.json
```

Compare the new `items_final.json` against the old one before redeploying (the
acceptance checks — item counts by department and type — are printed by
`build_data.py`).

## Open items

1. Stage mapping for the 236 non-Sanctioning items needs the compliance head's
   sign-off on a stage list.
2. Email digest reminders are not implemented (no scheduler).
3. Re-import/diff of a newer master sheet is a manual script re-run.
4. Compliance Head, Owner and Approver currently have identical permissions.


## Data model and migrations

The master register (306 records) lives in `shared/items.json`; MongoDB holds everything a team enters:
`companies`, `projects`, `phases`, `buildings`, `applicability` (one decision per record per company/project/phase/building),
`tracking`, `documents`, `audit`, `stage_overrides`, `users`.

Each migration is a dry run unless given `--apply`, takes a full backup into `server/backups/` first, and is safe to re-run.
Run from the `server` folder, in this order on a fresh setup:

```
node migrate/stages-v2.mjs --apply          # stage framework S0-S8 + per-record stage/level/deadline metadata
node migrate/applicability-v1.mjs --apply   # writes shared/applicability.json (the set-up questions)
node migrate/setup-v1.mjs --apply           # default company, a "Phase 1" per project, first applicability decisions
node migrate/backup.mjs                     # a backup on its own, any time
```

`shared/core.js` is shared by the browser and the server: it decides which record is tracked against which company, project,
phase or building, and how applicability is worked out from the set-up answers.

More migrations and tools (all dry-run unless `--apply`, all take a backup first):

```
node migrate/projects-v1.mjs --apply        # adds the client's 14 real estate + 13 EPC projects to the single company
node migrate/coverage-review.mjs --apply    # checks the register against laws typical for real estate / EPC; writes shared/coverage-gaps.json
```

Roles (`server/access.mjs`): Master Admin, Company Admin, Compliance Manager, Department Head, Compliance Owner, Approver,
Project Manager, Auditor. A user can also be limited to chosen projects (Users tab); the server filters every read and write.

Other data files in `shared/`: `profiles.json` (what EPC vs real estate projects track), `applicability.json` (the set-up questions),
`dependencies.json` (proposed prerequisites between records; none are legally validated yet), `coverage-gaps.json`.
Reminder rules are edited in Settings; a check runs 20 seconds after start and every 6 hours, and notices appear in the bell.
## Real Estate Compliance checklist (CHK-001 to CHK-209)

The consolidated CSV (`data-prep/Maharashtra_RealEstate_Compliance_Consolidated.csv`) holds the 306 register records plus 209 checklist records: 95 for a new project and 114 for a redevelopment. They are added by `server/migrate/real-estate-checklist-v1.mjs` (dry run by default, `--apply` to write; it backs up first, never changes the original 306 records, and can be re-run safely). Stage placement, setup questions and links to existing records are in `server/migrate/checklist-rules.mjs`; the import report is `data-prep/real-estate-checklist-report.md`. After applying, run `node migrate/applicability-v1.mjs --apply` and restart the server.

Each project answers one new setup question, "Is this a redevelopment project?". New-project records apply when it is No, redevelopment records when it is Yes, and redevelopment records tagged society / MHADA / SRA / tenanted / cluster also need that track.

## Project compliance intelligence (dashboard)

The Dashboard now opens with a health score, an AI analysis, risks, stage readiness, an action centre, document health and a trend, for the
selected project, the company-wide view, or all projects. Code: `server/health.mjs` (the score; pure, no AI), `server/intel.mjs`
(snapshots, recommendations, AI analysis and validation), routes in `server/server.js`, screens in `client/src/views/Dashboard.jsx`.

```
node migrate/risk-proposals-v1.mjs --apply   # suggested risk levels read from the register's penalty wording (never used until accepted)
node migrate/health-v1.mjs --apply           # indexes, default score settings, first snapshots and recommendations
node tests/health.test.mjs                   # runs the score tests (no database needed)
```

Collections added: `risk_overrides`, `health_snapshots`, `ai_recommendations`, `ai_analyses`; settings document `settings/health`.
The AI uses the same keys as Ask AI (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`); it is optional, the score works without it.
## Regulatory Updates

A **Regulatory Updates** page (left menu) lists circulars, notifications and orders found on official sources, with an AI summary, the projects they may affect, and a review workflow. It is built into the existing app: same login and roles, same MongoDB, same notification bell.

**What runs, and when.** The server (not the browser) checks every enabled source **every day at 08:00 IST**, even when nobody is signed in. If the server was off at 08:00 it catches up shortly after it starts. Administrators can also press *Check sources now*, *Check all now* or *Retry failed* (Settings → Regulatory sources); these run in the background.

**Per document:** fetch → read the text (PDF or web page) → hash it → skip if already known (same URL, same content hash, or same authority + circular number) → keep a copy of PDFs → AI analysis → match against projects → one notification. A changed document is detected by its hash, analysed again, flagged *Changed — review again*, and keeps earlier decisions.

**Sources** (Settings → Regulatory sources, administrators only). Seeded, after being opened and checked on 2026-10-28:

| Source | How |
|---|---|
| PCMC circulars, MPCB circulars | monitored daily (PCMC circular PDFs are scanned images, so they are stored with the official link and marked *needs manual reading*) |
| MahaRERA orders & circulars | **off**: its robots.txt answers HTTP 403, so automated reading is not assumed to be allowed. An admin may switch it on after confirming permission (tick the permission box when editing the source) |
| MoEFCC circulars | **off**: the list is built by script and could not be read reliably |
| CPCB | manual only: robots.txt disallows automated access |
| MoHUA, Directorate of Town Planning, Maharashtra Fire Services, Maharashtra GR portal, Maharashtra e-Gazette, PMC, India Code | manual only: no readable listing, or the site was unreachable when checked |

For anything that cannot be monitored, an administrator uses **Add official document** (link to the official document + pasted text or an uploaded PDF). The server never bypasses a CAPTCHA, login or robots.txt, refuses private-network addresses, limits download size (15 MB) and reads sites slowly (about one page every 1.2 s). A source that fails shows its error and counts failures; *Retry failed* tries again.

**AI.** Uses the same provider as Ask AI (`GEMINI_API_KEY` first, else `ANTHROPIC_API_KEY`). The document text is sent as *untrusted data* with instructions not to follow anything inside it. **No company or project data is sent to the AI**; matching to projects is rule-based on the server (location, planning authority, project category, stage). The AI's answer is validated: circular numbers, deadlines and quotes must appear in the document text or are dropped; priority is capped (Critical needs a binding obligation with a verified deadline; informational items are Low and never mandatory); unknown fields are ignored. Everything is labelled *AI summary — unverified* until a reviewer marks it checked. If no AI is available the document is stored as *analysis pending* and retried on later runs. Each run sends at most `REGULATORY_AI_PER_RUN` (default 15) documents to the AI.

**Review workflow:** New Update → AI Analysed → Compliance Review → Applicable / Not Applicable / Legal Review → Action Assigned → Implemented → Closed. A reviewer (Master Admin, Company Admin, Compliance Manager: capability `review_regulatory`) confirms or rejects applicability per project (with a reason), assigns a person, creates tasks, links existing compliance records, comments and closes. **Nothing is automatic:** no compliance record is created, no compliance status is changed, nothing is marked implemented by the system. Tasks are to-dos stored on the update. Project-restricted users only see updates that could affect their projects.

**MongoDB.** New collections `regulatory_sources`, `regulatory_updates` (analysis, hash, stored-copy reference, per-project impacts, tasks, comments, review history) and `regulatory_runs` (monitoring history). Notifications reuse the existing `notifications` collection (extra fields `reg_id`, `project_ids`, `to`, `dismissed_by`). Nothing existing was changed or removed.

**Set-up on an existing database:** `node migrate/regulatory-v1.mjs` (dry run), then `node migrate/regulatory-v1.mjs --apply` (backs up first, creates indexes, adds the sources above; existing sources are never overwritten). Optional env: `REGULATORY_AI_PER_RUN`, `REGULATORY_MONITORING=off`. Tests: `node --test tests/regulatory.test.mjs`.

**Limits.** Scanned PDFs have no text layer and are not OCR'd. Sites that block or hide automated access need manual entry. AI summaries can be wrong: always read the official document; none of this is legal advice.

## Documents (create, upload a format, review)

A **Documents** page in the sidebar has three tabs.

- **Create a document** - ready-made formats (authorisation letter, declaration and undertaking, NOC request, application cover letter, intimation of commencement, reply to notice, board resolution, extension request). Pick one, choose a project (company, project name, RERA number, location and date are filled in automatically), fill the rest and save. Empty required fields are allowed: the document is saved as a *Draft* and shows `[Field name]` until filled.
- **Upload your own format** - a Word (`.docx`, best), PDF or text file. Blanks and placeholders (`____`, `.....`, `[Project name]`, `<Name>`, `{{name}}`) are found automatically, labelled from the words before them, given a type (date, number, email...) and an auto-fill source where the label is clear. The person uploading checks them, can rename or remove fields, and can add one the detector missed by typing the exact words in the document. Word formats keep all their formatting; scanned PDFs are read with OCR.
- **My documents** - every saved document, with its values, version history (the last 10 versions are kept), preview, and download as Word or text. A document tied to a project follows that project's access; a document without a project is private to its author and administrators.
- **Review a document** - upload any application, declaration, letter or agreement (or pick a saved one) and it is checked against the regulations in `knowledge/` and the compliance register. You get what the document is, readiness (Ready to submit / Needs changes / Major gaps), checks with the rule each is based on, suggested wording to paste, missing information, and a downloadable Word report. Quotes shown as evidence are verified to exist in the document; rule references are limited to passages that were actually supplied. If the AI is unavailable, basic checks (blanks left, no date, no signature block) still run and the review can be retried.

Needs `upload_docs` to create, upload or review; everyone signed in can read what they have access to. Files are stored in the same GridFS bucket as other documents. Collections: `doc_templates`, `doc_generated`, `doc_analyses`. Tests: `node --test tests/docx.test.mjs tests/docstudio.test.mjs`.

**Chatbot knowledge:** PDFs in `knowledge/` are indexed when the server starts. Identical copies are indexed once; pages that are scans or have unreadable (legacy-font) Marathi/Hindi text are read with OCR and translated to English, and the result is cached in `knowledge/.ocr-cache/`.
