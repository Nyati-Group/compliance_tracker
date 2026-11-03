import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, decide, loadWorld, Core } from './generate.mjs';
import { CAPS, ROLE_INFO, ROLES, capsOf, hasCap, isRestricted, scopeOfKey, allowedScopes, canSee, canWriteScope } from './access.mjs';
import { completionGate, gateMessage, newlyReady } from './gate.mjs';
import { carryForward, carryAllExisting, mirrorStatus } from './docflow.mjs';
import { notify, runReminders, getSettings, DEFAULT_SETTINGS } from './notify.mjs';
import { loadShared, healthOf, publicHealth, saveSnapshot, previousSnapshot, trend as snapshotTrend, syncRecs, actOnRec, analyse, touchScopes, scopesForKey, runAll, autoAnalyse } from './intel.mjs';
import { buildRecommendations, DEFAULT_HEALTH, mergeSettings as mergeHealthSettings } from './health.mjs';
import { registerRegulatory, ensureIndexes as ensureRegulatoryIndexes } from './regulatory-routes.mjs';
import { registerDocStudio } from './docstudio-routes.mjs';
import { startScheduler as startRegulatoryScheduler, runMonitoring as runRegulatoryMonitoring } from './regulatory.mjs';
import { initKnowledge, retrieve, trackingContext, buildContext, extractSources, askModel, askGemini, rewriteQueries } from './chat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');
const imagesDir = path.join(here, '..', 'images');
const knowledgeDir = path.join(here, '..', 'knowledge');
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const {
  MONGODB_URI, MONGODB_DB = 'compliance_tracker', PORT = 8000,
  NODE_ENV, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, TRUST_PROXY,
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL = 'claude-sonnet-5-5',
  GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.5-flash', GEMINI_SEARCH_MODEL = 'gemini-3.5-flash-lite', GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite'
} = process.env;
// Ask AI uses Gemini when GEMINI_API_KEY is set, otherwise Claude when ANTHROPIC_API_KEY is set.
const CHAT_PROVIDER = GEMINI_API_KEY ? 'gemini' : ANTHROPIC_API_KEY ? 'anthropic' : null;
const CHAT_MODEL = CHAT_PROVIDER === 'gemini' ? GEMINI_MODEL : ANTHROPIC_MODEL;
const PROD = NODE_ENV === 'production';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is missing. Copy server/.env.example to server/.env and fill it in.');
  process.exit(1);
}
if (PROD && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  console.error('SESSION_SECRET (at least 32 characters) is required when NODE_ENV=production.');
  process.exit(1);
}
const SECRET = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!SESSION_SECRET) console.warn('SESSION_SECRET not set: using a random one, so everyone is signed out on each restart.');

// The capability needed to write each collection (null = read-only through /api). Everyone signed in may read what their project access allows.
const WRITE_CAPS = {
  tracking: 'edit_tracking',
  projects: 'manage_setup',
  audit: 'edit_tracking',
  stage_overrides: 'manage_company',
  companies: 'manage_company',
  phases: 'manage_setup',
  buildings: 'manage_setup',
  settings: 'manage_settings',
  risk_overrides: 'decide_applicability',   // a person's risk level for a compliance record (the register carries none)
  documents: null,     // rows are created, verified and deleted only by the /files routes
  applicability: null  // written only by the engine and POST /api/applicability
};
const MAX_UPLOAD = 15 * 1024 * 1024;
const UPLOAD_EXT = new Set(['.pdf', '.doc', '.docx']);
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;

/* ----------------------------- database ----------------------------- */
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const users = db.collection('users');
await db.collection('audit').createIndex({ key: 1, at: -1 });
await db.collection('documents').createIndex({ key: 1, uploaded_at: -1 });
await db.collection('notifications').createIndex({ at: -1 });
await db.collection('ai_recommendations').createIndex({ scope_id: 1, status: 1 });
await db.collection('health_snapshots').createIndex({ scope_id: 1, date: -1 });
await db.collection('ai_analyses').createIndex({ project_id: 1, analysed_at: -1 });
const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
console.log(`Connected to MongoDB database "${MONGODB_DB}"`);

/* ----------------------------- passwords & sessions ----------------------------- */
const scrypt = promisify(crypto.scrypt);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const hash = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const expected = Buffer.from(h, 'base64');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}
const DUMMY_HASH = await hashPassword(crypto.randomBytes(8).toString('hex'));

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
function makeToken(user) {
  const p = Buffer.from(JSON.stringify({ e: user._id, v: user.tv || 0, x: Date.now() + SESSION_MS })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function readToken(token) {
  if (typeof token !== 'string') return null;
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  const expected = sign(p);
  if (expected.length !== s.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.x > Date.now() ? d : null;
  } catch { return null; }
}
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: SESSION_MS, path: '/' };

/* First run: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD when there are no users. */
if ((await users.countDocuments()) === 0) {
  if (ADMIN_EMAIL && ADMIN_PASSWORD && ADMIN_PASSWORD.length >= MIN_PASSWORD) {
    await users.insertOne({
      _id: ADMIN_EMAIL.trim().toLowerCase(), name: 'Administrator', role: 'admin', active: true,
      passwordHash: await hashPassword(ADMIN_PASSWORD), tv: 0, created_at: new Date().toISOString()
    });
    console.log(`Created first admin user ${ADMIN_EMAIL}. You can now remove ADMIN_PASSWORD from the environment.`);
  } else {
    console.warn(`No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (min ${MIN_PASSWORD} chars) and restart to create the first admin.`);
  }
}

/* ----------------------------- helpers ----------------------------- */
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Reject Mongo operator keys ($...) anywhere in a payload, and absurd nesting.
function clean(v, depth = 0) {
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.every((x) => clean(x, depth + 1));
  if (isObj(v)) return Object.entries(v).every(([k, x]) => !k.startsWith('$') && clean(x, depth + 1));
  return true;
}
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\0$\/\\]/.test(id) && !id.startsWith('$');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (u) => ({
  email: u._id, name: u.name, role: u.role, role_label: (ROLE_INFO[u.role] || ROLE_INFO.readonly).label, caps: capsOf(u.role),
  active: u.active !== false, project_ids: Array.isArray(u.project_ids) ? u.project_ids : null
});

/* ----------------------------- app ----------------------------- */
const app = express();
export default app;
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"]
    }
  },
  hsts: PROD ? undefined : false
}));

app.get('/healthz', async (req, res) => {
  try { await db.command({ ping: 1 }); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(express.json({ limit: '100kb' }));

// CSRF defence in depth (cookie is SameSite=Strict): writes must be JSON and same-origin.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) return res.status(403).json({ error: 'cross-origin request blocked' });
  }
  // File upload/delete routes carry binary bodies; a custom header (which cross-site forms can't send) stands in for the JSON check.
  if (req.path.startsWith('/files')) {
    if (req.headers['x-requested-with'] !== 'fetch') return res.status(415).json({ error: 'bad request' });
    return next();
  }
  if (req.body === undefined || !req.is('json')) return res.status(415).json({ error: 'JSON body required' });
  next();
});

/* ----------------------------- auth ----------------------------- */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' }
});

app.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = email ? await users.findOne({ _id: email }) : null;
    // Always run a hash so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok || user.active === false) return res.status(401).json({ error: 'Invalid email or password.' });
    res.cookie('sid', makeToken(user), cookieOpts);
    res.json(publicUser(user));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('sid', { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});

// Load the signed-in user on every request so role changes and disabling take effect immediately.
app.use(async (req, res, next) => {
  try {
    const t = readToken(getCookie(req, 'sid'));
    if (t) {
      const u = await users.findOne({ _id: t.e });
      if (u && u.active !== false && (u.tv || 0) === t.v) req.user = u;
    }
    next();
  } catch (e) { next(e); }
});

// Public: login page and logo only.
app.use('/images', express.static(imagesDir, {
  setHeaders: (res, p) => { if (p.endsWith('.avif')) res.setHeader('Content-Type', 'image/avif'); }
}));
app.get('/login.html', (req, res) => res.sendFile(path.join(appDir, 'login.html')));

// Public, but guarded by a shared secret instead of a session: the daily reminder/health/regulatory
// run, for a scheduler with no session of its own (e.g. Vercel Cron — see vercel.json). `cronDailyDeps.run`
// is filled in further down, once everything it needs exists; the route itself only runs on a real request,
// by which time module setup has finished, so the forward reference is safe.
const cronDailyDeps = {};
app.all('/api/cron/daily', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(404).json({ error: 'not found' });
  try { await cronDailyDeps.run(); res.json({ ok: true }); }
  catch (e) { console.error('Cron run failed:', e); res.status(500).json({ error: 'cron run failed' }); }
});

// Everything below needs a signed-in user.
app.use((req, res, next) => {
  if (req.user) return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.method !== 'GET') {
    return res.status(401).json({ error: 'not signed in' });
  }
  res.redirect('/login.html');
});

const requireCap = (cap) => (req, res, next) =>
  hasCap(req.user, cap) ? next() : res.status(403).json({ error: 'not allowed for your role' });
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'not allowed for your role' });
// Loads the user's project access once per request.
const withScopes = async (req, res, next) => { try { req.allowed = await allowedScopes(db, req.user); next(); } catch (e) { next(e); } };

app.get('/auth/me', (req, res) => res.json(publicUser(req.user)));
app.get('/auth/roles', (req, res) => res.json({
  roles: ROLES.map((r) => ({ key: r, label: ROLE_INFO[r].label, description: ROLE_INFO[r].description, caps: ROLE_INFO[r].caps })),
  caps: CAPS
}));

app.post('/auth/password', async (req, res) => {
  try {
    const { current, next: nextPw } = req.body || {};
    if (!(await verifyPassword(String(current || ''), req.user.passwordHash))) return res.status(400).json({ error: 'Current password is incorrect.' });
    if (typeof nextPw !== 'string' || nextPw.length < MIN_PASSWORD) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
    const tv = (req.user.tv || 0) + 1; // signs out every other session
    await users.updateOne({ _id: req.user._id }, { $set: { passwordHash: await hashPassword(nextPw), tv } });
    res.cookie('sid', makeToken({ ...req.user, tv }), cookieOpts);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* ----------------------------- user management (admin) ----------------------------- */
app.get('/auth/users', requireCap('manage_users'), async (req, res) => {
  res.json((await users.find().sort({ _id: 1 }).toArray()).map(publicUser));
});

// null = every project; otherwise a list of existing project ids.
async function cleanProjectIds(v) {
  if (v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !validId(x))) throw Object.assign(new Error('Project access must be "all" or a list of projects.'), { status: 400 });
  const found = new Set((await db.collection('projects').find({ _id: { $in: v } }, { projection: { _id: 1 } }).toArray()).map((p) => String(p._id)));
  if (v.some((x) => !found.has(x))) throw Object.assign(new Error('One of the chosen projects does not exist.'), { status: 400 });
  return [...new Set(v)];
}

app.post('/auth/users', requireCap('manage_users'), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim().slice(0, 100);
    const { role, password } = req.body || {};
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    if (await users.findOne({ _id: email })) return res.status(409).json({ error: 'A user with that email already exists.' });
    const project_ids = req.body?.project_ids === undefined ? null : await cleanProjectIds(req.body.project_ids);
    await users.insertOne({ _id: email, name, role, active: true, project_ids, passwordHash: await hashPassword(password), tv: 0, created_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.put('/auth/users/:email', requireCap('manage_users'), async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const target = await users.findOne({ _id: email });
    if (!target) return res.status(404).json({ error: 'No such user.' });
    const { name, role, active, password } = req.body || {};
    const set = {};
    let revoke = false;
    if (req.body && req.body.project_ids !== undefined) { set.project_ids = await cleanProjectIds(req.body.project_ids); revoke = true; }
    if (name !== undefined) { set.name = String(name).trim().slice(0, 100); if (!set.name) return res.status(400).json({ error: 'Enter a name.' }); }
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
      if (email === req.user._id && role !== target.role) return res.status(400).json({ error: "You can't change your own role." });
      if (role !== target.role) { set.role = role; revoke = true; }
    }
    if (active !== undefined) {
      if (email === req.user._id && active === false) return res.status(400).json({ error: "You can't disable your own account." });
      set.active = active !== false;
      if (!set.active) revoke = true;
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
      set.passwordHash = await hashPassword(password);
      revoke = true;
    }
    const update = { $set: set };
    if (revoke) update.$inc = { tv: 1 };
    if (Object.keys(set).length) await users.updateOne({ _id: email }, update);
    res.json({ ok: true });
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* ----------------------------- Ask AI chatbot ----------------------------- */
const chatPrompt = fs.readFileSync(path.join(here, 'chat-prompt.txt'), 'utf8');
const chatLogs = db.collection('chat_logs');
await chatLogs.createIndex({ at: -1 });
initKnowledge(appDir, knowledgeDir, () => aiConfig()).catch((e) => console.error('Ask AI knowledge load failed:', e));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { error: 'Too many questions in a minute. Please wait a moment.' }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    if (!CHAT_PROVIDER) return res.status(503).json({ error: 'Ask AI is not set up yet: the server needs a GEMINI_API_KEY (or ANTHROPIC_API_KEY).' });
    const raw = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
    const msgs = raw
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Ask a question first.' });
    const question = msgs.pop().content;
    const today = new Date().toISOString().slice(0, 10);

    // Retrieve using the question plus the previous user turn, so short follow-ups ("and its penalty?") still match.
    const prevUser = [...msgs].reverse().find((m) => m.role === 'user');
    const searches = CHAT_PROVIDER === 'gemini' ? await rewriteQueries({ apiKey: GEMINI_API_KEY, model: GEMINI_SEARCH_MODEL, question, history: msgs }) : [];
    const hits = retrieve(prevUser ? `${prevUser.content} ${question}` : question, searches);
    const tracking = await trackingContext(db, hits.items, today);
    const ask = CHAT_PROVIDER === 'gemini' ? askGemini : askModel;
    const ctx = buildContext(hits, tracking, today);
    const args = { apiKey: CHAT_PROVIDER === 'gemini' ? GEMINI_API_KEY : ANTHROPIC_API_KEY, model: CHAT_MODEL, system: chatPrompt, history: msgs, question, context: ctx.text };
    let reply, usedFallback = false;
    try { reply = await ask(args); }
    catch (e) {
      // Free-tier Gemini keys have a small daily quota per model; fall back to the lighter model rather than failing.
      if (CHAT_PROVIDER === 'gemini' && (e.status === 429 || e.status === 503) && GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== CHAT_MODEL) {
        console.warn(`chat: ${CHAT_MODEL} unavailable (${e.status}); using ${GEMINI_FALLBACK_MODEL}`);
        reply = await ask({ ...args, model: GEMINI_FALLBACK_MODEL });
        usedFallback = true;
      } else throw e;
    }
    // Footer shows only what the model says it used (document + start page, or register ID), not everything retrieved.
    const extracted = extractSources(reply, ctx.refs);
    const sources = extracted.sources;
    // Which model answered is an internal detail: logged, never shown to the user (or fed back to the model through the chat history).
    const answer = extracted.body;
    if (usedFallback) console.warn('chat: answered by the backup model');
    const log = await chatLogs.insertOne({
      email: req.user._id, name: req.user.name, question: question.slice(0, 4000), answer, sources, model: CHAT_MODEL,
      at: new Date().toISOString(), feedback: null
    });
    res.json({ answer, sources, id: String(log.insertedId) });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(502).json({ error: 'The assistant could not answer right now. Please try again.' });
  }
});

/* ----------------------------- applicability engine routes ----------------------------- */
// Re-evaluate applicability after setup answers change. Body: {projectId} or {companyId}.
app.post('/api/generate', requireCap('manage_setup'), withScopes, async (req, res) => {
  try {
    const { projectId, companyId } = req.body || {};
    if (!(validId(projectId || '') && projectId) && !(validId(companyId || '') && companyId)) return res.status(400).json({ error: 'projectId or companyId required' });
    if (projectId ? !canWriteScope(req.allowed, projectId) : !req.allowed.all) return res.status(403).json({ error: 'You do not have access to that.' });
    const summary = await generate(db, projectId ? { projectId } : { companyId }, req.user.name);
    touchScopes(db, [projectId || companyId]);
    res.json({ ok: true, summary });
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not generate the register' }); }
});

// A person's applicability decision for one record on one company/project/phase/building.
app.post('/api/applicability', requireCap('decide_applicability'), withScopes, async (req, res) => {
  try {
    const { key, status, reason } = req.body || {};
    if (typeof key !== 'string' || !validId(key) || typeof status !== 'string') return res.status(400).json({ error: 'bad request' });
    if (!canWriteScope(req.allowed, scopeOfKey(key))) return res.status(403).json({ error: 'You do not have access to that.' });
    const out = await decide(db, { key, status, reason }, req.user);
    touchKeysSoon([key]);
    res.json(out);
  } catch (e) {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'server error' });
  }
});

// Remove a phase or building that has nothing recorded against it (no tracking, uploads, or manual decisions).
app.delete('/api/:col/:id', withScopes, async (req, res, next) => {
  const { col, id } = req.params;
  if (col !== 'phases' && col !== 'buildings') return next();
  try {
    if (!hasCap(req.user, 'manage_setup')) return res.status(403).json({ error: 'not allowed for your role' });
    if (!validId(id)) return res.status(400).json({ error: 'bad id' });
    const doc = await db.collection(col).findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!canWriteScope(req.allowed, doc.project_id)) return res.status(403).json({ error: 'You do not have access to that.' });
    const suffix = new RegExp(`__${id.replace(/[^\w-]/g, '\\$&')}$`);
    const used = (await db.collection('tracking').countDocuments({ _id: suffix })) +
      (await db.collection('documents').countDocuments({ key: suffix })) +
      (await db.collection('applicability').countDocuments({ _id: suffix, source: 'manual' }));
    if (used) return res.status(409).json({ error: 'Something has already been recorded against this (status, documents or a manual decision), so it cannot be removed.' });
    if (col === 'phases') {
      if (await db.collection('buildings').countDocuments({ phase_id: id })) return res.status(409).json({ error: 'Move or remove this phase\'s buildings first.' });
      if ((await db.collection('phases').countDocuments({ project_id: doc.project_id })) <= 1) return res.status(409).json({ error: 'A project needs at least one phase.' });
    }
    await db.collection(col).deleteOne({ _id: id });
    await db.collection('applicability').deleteMany({ _id: suffix, source: 'auto' });
    await generate(db, { projectId: doc.project_id }, req.user.name);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.post('/api/chat/feedback', async (req, res) => {
  try {
    const { id, value } = req.body || {};
    if (!ObjectId.isValid(id) || !['up', 'down'].includes(value)) return res.status(400).json({ error: 'bad feedback' });
    await chatLogs.updateOne({ _id: new ObjectId(id), email: req.user._id }, { $set: { feedback: value } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* ----------------------------- project compliance intelligence ----------------------------- */
const itemIds = new Set(JSON.parse(fs.readFileSync(path.join(appDir, 'items.json'), 'utf8')).map((i) => i.compliance_id));
const aiConfig = () => (CHAT_PROVIDER ? { provider: CHAT_PROVIDER, apiKey: CHAT_PROVIDER === 'gemini' ? GEMINI_API_KEY : ANTHROPIC_API_KEY, model: CHAT_MODEL, fallbackModel: CHAT_PROVIDER === 'gemini' ? GEMINI_FALLBACK_MODEL : null } : null);

// A tracking/document key ends in a company, project, phase or building id; find the project or company view it belongs to.
async function resolveScope(sid) {
  if (!sid) return null;
  if (await db.collection('projects').findOne({ _id: sid }, { projection: { _id: 1 } })) return sid;
  if (await db.collection('companies').findOne({ _id: sid }, { projection: { _id: 1 } })) return sid;
  for (const c of ['phases', 'buildings']) { const d = await db.collection(c).findOne({ _id: sid }, { projection: { project_id: 1 } }); if (d) return d.project_id; }
  return null;
}
/** Refresh score, snapshot and rule-based recommendations shortly after data changes. Never calls the AI. */
function touchKeysSoon(keys) {
  (async () => { try { const ids = []; for (const k of keys) ids.push(await resolveScope(scopeOfKey(k))); touchScopes(db, ids); } catch (e) { console.error('touch failed', e.message); } })();
}
let allTimer = null;
function touchAllSoon() { clearTimeout(allTimer); allTimer = setTimeout(() => runAll(db).catch((e) => console.error('refresh all failed', e.message)), 5000); allTimer.unref?.(); }

const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
/** Returns an error message, or null after keeping only the known setting keys. */
function validateHealthSettings(d) {
  const D = DEFAULT_HEALTH, clean = {};
  const group = (k, lo, hi, label) => {
    const src = d[k] || {};
    clean[k] = {};
    for (const key of Object.keys(D[k])) { const v = src[key] === undefined ? D[k][key] : src[key]; if (!num(v, lo, hi)) return `${label} “${key.replace(/_/g, ' ')}” must be a number from ${lo} to ${hi}.`; clean[k][key] = v; }
    return null;
  };
  let e = group('weights', 0, 100, 'Risk weight') || group('factors', 0, 1, 'Outstanding-risk factor') || group('deductions', 0, 50, 'Deduction') || group('deduction_caps', 0, 100, 'Deduction cap');
  if (e) return e;
  const b = { ...D.bands, ...(d.bands || {}) };
  if (!['healthy', 'good', 'attention', 'at_risk'].every((k) => num(b[k], 0, 100)) || !(b.healthy > b.good && b.good > b.attention && b.attention > b.at_risk)) return 'Score bands must be numbers from 0 to 100, each lower than the one before.';
  clean.bands = { healthy: b.healthy, good: b.good, attention: b.attention, at_risk: b.at_risk };
  clean.due_soon_days = d.due_soon_days === undefined ? D.due_soon_days : d.due_soon_days; if (!Number.isInteger(clean.due_soon_days) || clean.due_soon_days < 1 || clean.due_soon_days > 365) return '“Due soon” must be a whole number of days from 1 to 365.';
  clean.unclassified_level = d.unclassified_level === undefined ? D.unclassified_level : d.unclassified_level; if (!['critical', 'high', 'medium', 'low'].includes(clean.unclassified_level)) return 'Choose a level for unclassified records.';
  clean.ai_auto_refresh = !!d.ai_auto_refresh; clean.ai_refresh_hours = d.ai_refresh_hours === undefined ? D.ai_refresh_hours : d.ai_refresh_hours; if (!Number.isInteger(clean.ai_refresh_hours) || clean.ai_refresh_hours < 1 || clean.ai_refresh_hours > 168) return 'AI refresh hours must be 1 to 168.';
  for (const k of Object.keys(d)) delete d[k]; Object.assign(d, clean);
  return null;
}

const scopeGuard = (req, res, next) => (validId(req.params.id) && canSee(req.allowed, req.params.id) ? next() : res.status(403).json({ error: 'You do not have access to that project.' }));
const recRow = ({ _id, ...r }) => ({ id: String(_id), ...r });

// Everything the dashboard needs about one company-wide or project view, calculated fresh from the records.
app.get('/api/projects/:id/compliance-health', withScopes, scopeGuard, async (req, res) => {
  try {
    const id = req.params.id, shared = await loadShared(db), h = healthOf(shared, id);
    if (!h) return res.status(404).json({ error: 'Unknown project.' });
    // Keep stored recommendations and today's snapshot in step with the data the user is looking at.
    if (!(await db.collection('ai_recommendations').findOne({ scope_id: id, source: 'rules', data_version: h.dataVersion }, { projection: { _id: 1 } }))) await syncRecs(db, h, buildRecommendations(h, {}));
    const snap = await db.collection('health_snapshots').findOne({ _id: `${id}:${h.today}` }, { projection: { data_version: 1 } });
    if (!snap || snap.data_version !== h.dataVersion) await saveSnapshot(db, h);
    const prev = await previousSnapshot(db, id, h.today);
    const attempt = await db.collection('ai_analyses').find({ project_id: id }).sort({ analysed_at: -1 }).limit(1).next();
    const ok = await db.collection('ai_analyses').find({ project_id: id, status: 'ok' }).sort({ analysed_at: -1 }).limit(1).next();
    res.json({
      health: publicHealth(h), calculatedAt: new Date().toISOString(),
      previous: prev ? { score: prev.score, date: prev.date, category: prev.category } : null, change: prev && h.score != null ? h.score - prev.score : null,
      analysis: { aiConfigured: !!aiConfig(), lastAttempt: attempt ? { status: attempt.status, at: attempt.analysed_at, error: attempt.error || null } : null, lastOk: ok ? { at: ok.analysed_at, fresh: ok.data_version === h.dataVersion } : null }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not calculate the compliance health.' }); }
});

app.get('/api/projects/:id/compliance-health/trend', withScopes, scopeGuard, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const points = await snapshotTrend(db, req.params.id, days, iso(req.query.from), iso(req.query.to));
    res.json({ points, days, note: points.length < 2 ? 'Historical compliance health data is not available yet. Daily score snapshots are being collected from now on.' : null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load the trend.' }); }
});

app.get('/api/projects/:id/ai-analysis', withScopes, scopeGuard, async (req, res) => {
  try {
    const col = db.collection('ai_analyses'), id = req.params.id;
    const attempt = await col.find({ project_id: id }).sort({ analysed_at: -1 }).limit(1).next();
    const ok = await col.find({ project_id: id, status: 'ok' }).sort({ analysed_at: -1 }).limit(1).next();
    const strip = (a) => a && (({ _id, ...r }) => r)(a);
    res.json({ aiConfigured: !!aiConfig(), latest: strip(ok), lastAttempt: attempt ? { status: attempt.status, at: attempt.analysed_at, error: attempt.error || null } : null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.post('/api/projects/:id/ai-analysis/refresh', requireCap('edit_tracking'), withScopes, scopeGuard, async (req, res) => {
  try {
    const out = await analyse(db, req.params.id, req.user, aiConfig(), { force: !!req.body?.force });
    const { health, analysis, ...rest } = out; const { _id, ...a } = analysis || {};
    res.json({ ok: true, ...rest, analysis: a, health: publicHealth(health) });
  } catch (e) {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'The analysis could not be completed.' });
  }
});

app.get('/api/projects/:id/ai-recommendations', withScopes, scopeGuard, async (req, res) => {
  try {
    const q = { scope_id: req.params.id };
    const st = String(req.query.status || '');
    if (st && st !== 'all') q.status = { $in: st.split(',').slice(0, 8) }; else if (!st) q.status = { $ne: 'resolved' };
    const rows = await db.collection('ai_recommendations').find(q).limit(400).toArray();
    rows.sort((a, b) => (a.priority || 'P9').localeCompare(b.priority || 'P9') || (b.priority_points || 0) - (a.priority_points || 0));
    res.json(rows.map(recRow));
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

const recAction = (cap) => async (req, res) => {
  try {
    const id = req.params.id; if (!validId(id)) return res.status(400).json({ error: 'bad id' });
    const rec = await db.collection('ai_recommendations').findOne({ _id: id });
    if (!rec || !canSee(req.allowed, rec.scope_id)) return res.status(404).json({ error: 'Recommendation not found.' });
    const action = cap === 'create_task' ? 'create_task' : String(req.body?.action || '');
    const need = action === 'request_review' ? 'edit_tracking' : 'manage_actions';
    if (!hasCap(req.user, need)) return res.status(403).json({ error: 'not allowed for your role' });
    if (!canWriteScope(req.allowed, rec.scope_id)) return res.status(403).json({ error: 'You do not have access to that project.' });
    const out = await actOnRec(db, id, { ...req.body, action }, req.user);
    const { _id, ...r } = out.rec;
    res.json({ ok: true, recommendation: { id: String(_id), ...r }, task: out.task || null, already: !!out.already });
  } catch (e) {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'server error' });
  }
};
app.patch('/api/ai-recommendations/:id', withScopes, recAction('patch'));
app.post('/api/ai-recommendations/:id/create-task', withScopes, recAction('create_task'));

app.get('/api/projects/:id/stage-readiness', withScopes, scopeGuard, async (req, res) => {
  try { const h = healthOf(await loadShared(db), req.params.id); if (!h) return res.status(404).json({ error: 'Unknown project.' }); res.json({ current: h.currentStage, next: h.nextStage, stages: h.stages }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/projects/:id/document-health', withScopes, scopeGuard, async (req, res) => {
  try { const h = healthOf(await loadShared(db), req.params.id); if (!h) return res.status(404).json({ error: 'Unknown project.' }); res.json(h.documents); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// All projects the user may see, one row each, plus the company-wide view. Used by the portfolio dashboard.
app.get('/api/intel/portfolio', withScopes, async (req, res) => {
  try {
    const shared = await loadShared(db);
    const ids = [...Object.keys(shared.w.projects), ...Object.keys(shared.w.companies)].filter((id) => canSee(req.allowed, id));
    const recCounts = {};
    for (const r of await db.collection('ai_recommendations').aggregate([{ $match: { status: { $in: ['open', 'accepted', 'review_requested'] } } }, { $group: { _id: { s: '$scope_id', p: '$priority' }, n: { $sum: 1 } } }]).toArray()) (recCounts[r._id.s] = recCounts[r._id.s] || {})[r._id.p] = r.n;
    const rows = ids.map((id) => {
      const h = healthOf(shared, id), s = h.scope;
      const top = h.cards[0];
      return { id, type: s.type, name: s.name, companyName: s.companyName, location: s.location || null, projectType: s.projectType || null, category: s.category || null,
        score: h.score, band: h.category, counts: h.counts, currentStage: h.currentStage ? { id: h.currentStage.id, name: h.currentStage.name, status: h.currentStage.status } : null,
        topIssue: top ? { complianceId: top.complianceId, level: top.level, reason: top.reason } : null, openActions: recCounts[id] || {} };
    });
    const scored = rows.filter((r) => r.score != null);
    const bands = {}; scored.forEach((r) => { bands[r.band] = (bands[r.band] || 0) + 1; });
    res.json({ rows, summary: { projects: rows.filter((r) => r.type === 'project').length, scored: scored.length, average: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null, bands,
      overdue: rows.reduce((a, r) => a + r.counts.overdue, 0), critical: rows.reduce((a, r) => a + r.counts.critical, 0), blocked: rows.reduce((a, r) => a + r.counts.blocked, 0) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not build the portfolio view.' }); }
});

// Accept the register-derived suggestions as real classifications (only for records nobody has classified yet).
app.post('/api/risk/accept-suggestions', requireCap('decide_applicability'), withScopes, async (req, res) => {
  try {
    if (!req.allowed.all) return res.status(403).json({ error: 'Only an unrestricted account can classify risk for the whole register.' });
    const proposals = (JSON.parse(fs.readFileSync(path.join(appDir, 'risk-proposals.json'), 'utf8')).proposals) || {};
    const have = new Set((await db.collection('risk_overrides').find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
    const now = new Date().toISOString(), ops = [];
    for (const [cid, p] of Object.entries(proposals)) if (!have.has(cid) && itemIds.has(cid)) ops.push({ insertOne: { document: { _id: cid, level: p.level, source: 'suggested', reason: p.basis, set_by: req.user.name, at: now } } });
    if (ops.length) await db.collection('risk_overrides').bulkWrite(ops, { ordered: false });
    touchAllSoon();
    res.json({ ok: true, applied: ops.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* ----------------------------- notifications ----------------------------- */
async function visibleNotes(req) {
  const caps = capsOf(req.user.role);
  // People who can't act on anything (auditors) still see every notice; everyone else sees notices addressed to a capability they hold.
  const rows = await db.collection('notifications').find(caps.length ? { cap: { $in: caps } } : {}).sort({ at: -1 }).limit(400).toArray();
  const me = req.user._id;
  return rows.filter((n) => {
    if (n.to && n.to !== me) return false;                              // addressed to one person (assignments)
    if ((n.dismissed_by || []).includes(me)) return false;
    if (Array.isArray(n.project_ids)) return req.allowed.all || n.project_ids.length === 0 || n.project_ids.some((p) => canSee(req.allowed, p));
    const sc = n.key ? scopeOfKey(n.key) : n.project_id; return sc == null || canSee(req.allowed, sc);
  }).slice(0, 100);
}
app.get('/api/notifications', withScopes, async (req, res) => {
  try {
    const me = req.user._id;
    res.json((await visibleNotes(req)).map(({ _id, read_by, ...rest }) => ({ id: String(_id), data: { ...rest, read: (read_by || []).includes(me) } })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});
app.post('/api/notifications/read', withScopes, async (req, res) => {
  try {
    const ids = req.body?.all ? (await visibleNotes(req)).map((n) => n._id) : (Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 200) : []);
    if (ids.length) await db.collection('notifications').updateMany({ _id: { $in: ids } }, { $addToSet: { read_by: req.user._id } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});
app.post('/api/notifications/dismiss', withScopes, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 50) : [];
    const visible = new Set((await visibleNotes(req)).map((n) => n._id));
    const mine = ids.filter((i) => visible.has(i));
    if (mine.length) await db.collection('notifications').updateMany({ _id: { $in: mine } }, { $addToSet: { dismissed_by: req.user._id, read_by: req.user._id } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});
app.post('/api/notifications/run', requireCap('manage_settings'), async (req, res) => {
  try { res.json({ ok: true, ...(await runReminders(db)) }); } catch (e) { console.error(e); res.status(500).json({ error: 'could not run the reminder check' }); }
});

/* ----------------------------- regulatory updates ----------------------------- */
const itemsList = JSON.parse(fs.readFileSync(path.join(appDir, 'items.json'), 'utf8'));
const regulatory = registerRegulatory(app, { db, bucket, requireCap, withScopes, aiConfig, items: itemsList, appDir });
const docStudio = registerDocStudio(app, { db, bucket, requireCap, withScopes, aiConfig, attach: (...a) => attachPrepared(...a) });

/* ----------------------------- data API ----------------------------- */
const guard = (req, res, next) =>
  Object.hasOwn(WRITE_CAPS, req.params.col) ? next() : res.status(404).json({ error: 'unknown collection' });
const canWrite = (req, res, next) => {
  const cap = WRITE_CAPS[req.params.col];
  return cap && hasCap(req.user, cap) ? next() : res.status(403).json({ error: 'not allowed for your role' });
};

const toDoc = ({ _id, ...rest }) => ({ id: String(_id), data: rest });

// Which company/project/phase/building a stored document belongs to (undefined = shared by everyone).
function docScope(col, d) {
  switch (col) {
    case 'projects': return String(d._id);
    case 'phases': case 'buildings': return d.project_id;
    case 'tracking': case 'applicability': return scopeOfKey(d._id);
    case 'audit': case 'documents': return scopeOfKey(d.key);
    default: return undefined;
  }
}
function writeScope(col, id, data) {
  switch (col) {
    case 'projects': return id;
    case 'phases': case 'buildings': return data.project_id;
    case 'tracking': return scopeOfKey(id);
    case 'audit': return scopeOfKey(data.key);
    default: return undefined;
  }
}

// The server, not the browser, decides who made a change and when.
function stamp(col, data, user) {
  const now = new Date().toISOString();
  if (col === 'tracking') { data.last_updated_by = user.name; data.updated_at = now; }
  if (col === 'stage_overrides') { data.set_by = user.name; data.at = now; }
  if (col === 'projects' || col === 'companies' || col === 'phases' || col === 'buildings') { data.updated_by = user.name; data.updated_at = now; }
  if (col === 'audit') { data.who = user.name; data.at = now; }
  if (col === 'settings') { data.updated_by = user.name; data.updated_at = now; }
  return data;
}

// List documents. Optional: ?key=...&orderBy=at&dir=desc&limit=25
app.get('/api/:col', guard, withScopes, async (req, res) => {
  try {
    const { key, orderBy, dir, limit } = req.query;
    const filter = typeof key === 'string' ? { key } : {};
    let cur = db.collection(req.params.col).find(filter);
    if (typeof orderBy === 'string' && /^[a-z_]{1,40}$/.test(orderBy)) cur = cur.sort({ [orderBy]: dir === 'desc' ? -1 : 1 });
    if (typeof limit === 'string') cur = cur.limit(Math.min(parseInt(limit, 10) || 0, 1000));
    const rows = await cur.toArray();
    res.json(rows.filter((d) => { const s = docScope(req.params.col, d); return s === undefined || canSee(req.allowed, s); }).map(toDoc));
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

const okDays = (a, lo, hi) => Array.isArray(a) && a.length <= 12 && a.every((n) => Number.isInteger(n) && n >= lo && n <= hi);

// Create or replace a document by id.
app.put('/api/:col/:id', guard, canWrite, withScopes, async (req, res) => {
  try {
    const col = req.params.col, id = req.params.id;
    if (!validId(id)) return res.status(400).json({ error: 'bad id' });
    if (!isObj(req.body) || !clean(req.body)) return res.status(400).json({ error: 'bad document' });
    const { _id, ...data } = req.body;
    const sc = writeScope(col, id, data);
    if (sc !== undefined && !canWriteScope(req.allowed, sc)) return res.status(403).json({ error: 'You do not have access to that.' });
    if (col === 'settings') {
      if (id === 'health') { const bad = validateHealthSettings(data); if (bad) return res.status(400).json({ error: bad }); }
      else if (id !== 'reminders') return res.status(400).json({ error: 'unknown setting' });
      else if (!okDays(data.days, 0, 365) || !okDays(data.overdue_days, 1, 365) || typeof data.enabled !== 'boolean') return res.status(400).json({ error: 'Reminder days must be whole numbers (0-365), at most 12 of them.' });
    }
    if (col === 'risk_overrides') {
      if (!itemIds.has(id)) return res.status(400).json({ error: 'Unknown compliance record.' });
      if (!['critical', 'high', 'medium', 'low'].includes(data.level)) return res.status(400).json({ error: 'Choose Critical, High, Medium or Low.' });
      data.reason = String(data.reason || '').slice(0, 300); data.source = 'manual'; data.set_by = req.user.name; data.at = new Date().toISOString();
    }
    let overridden = null, prev = null;
    if (col === 'tracking') {
      prev = await db.collection('tracking').findOne({ _id: id });
      const reason = String(data.override_reason || '').trim().slice(0, 500);
      delete data.override_reason; delete data.completion_override; delete data.open_action;      // never trust these from the browser
      if (prev && prev.open_action) data.open_action = prev.open_action;                          // an accepted AI action stays attached to the record
      if (data.status === 'Compliant / Completed') {
        if (!prev || prev.status !== 'Compliant / Completed') {
          const g = await completionGate(db, id);
          if (!g.ok) {
            const may = hasCap(req.user, 'override_completion');
            if (!(may && reason)) return res.status(409).json({ error: gateMessage(g), gate: g, can_override: may });
            overridden = { by: req.user.name, reason, at: new Date().toISOString(), gate: { issues: g.issues, blockers: g.blockers.map((b) => b.id) } };
          }
        } else if (prev.completion_override) data.completion_override = prev.completion_override;
      }
      if (overridden) data.completion_override = overridden;
    }
    if (col === 'tracking' && data.status === 'Compliant / Completed' && data.open_action) {
      await db.collection('ai_recommendations').updateOne({ _id: data.open_action.recommendation_id, status: 'accepted' }, { $set: { status: 'completed', completed_at: new Date().toISOString(), completed_by: req.user.name }, $push: { history: { at: new Date().toISOString(), by: req.user.name, from: 'accepted', to: 'completed', note: 'The compliance record was completed.' } } });
      delete data.open_action;
    }
    await db.collection(col).replaceOne({ _id: id }, stamp(col, data, req.user), { upsert: true });
    if (col === 'tracking') touchKeysSoon([id]);
    if (col === 'risk_overrides' || (col === 'settings' && id === 'health')) touchAllSoon();
    if (col === 'tracking') {
      const pk = Core.parseKey(id);
      if (overridden) {
        await db.collection('audit').insertOne({ key: id, compliance_id: pk && pk.compliance_id, project_id: null, old_status: (prev && prev.status) || 'Not Started', new_status: 'Compliant / Completed',
          who: req.user.name, remark: `OVERRIDE of completion checks: ${overridden.reason}`, at: overridden.at });
      }
      if (data.status === 'Compliant / Completed' && (!prev || prev.status !== 'Compliant / Completed')) {
        for (const r of await newlyReady(db, id)) {
          await notify(db, { id: `ready:${r.key}:${id}`, type: 'dependency_done', level: 'info', cap: 'edit_tracking', key: r.key, compliance_id: r.id, project_id: r.projectId,
            title: `${r.id} is ready to start`, message: `${pk.compliance_id} was completed, so ${r.id} (${(r.text || '').slice(0, 80)}) is no longer blocked.` });
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

// Append a document with a generated id.
app.post('/api/:col', guard, canWrite, withScopes, async (req, res) => {
  try {
    if (!isObj(req.body) || !clean(req.body)) return res.status(400).json({ error: 'bad document' });
    const { _id, ...data } = req.body;
    const sc = writeScope(req.params.col, '', data);
    if (sc !== undefined && !canWriteScope(req.allowed, sc)) return res.status(403).json({ error: 'You do not have access to that.' });
    const r = await db.collection(req.params.col).insertOne(stamp(req.params.col, data, req.user));
    res.json({ ok: true, id: String(r.insertedId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db error' }); }
});

/* ----------------------------- document files (GridFS + "documents" collection) ----------------------------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v)) ? v : null);

// Store a file against a record as the next version of that named document, tell the verifiers, and pass it on to later records that need it.
async function saveDocument(meta, buffer, user, { issue = null, expiry = null, extra = {} } = {}) {
  const docs = db.collection('documents');
  const name_lc = meta.doc_name.toLowerCase();
  const latest = await docs.find({ key: meta.key, doc_name_lc: name_lc }).sort({ version: -1 }).limit(1).next();
  const up = bucket.openUploadStream(meta.file_name, { metadata: { key: meta.key } });
  await new Promise((ok, fail) => { up.on('finish', ok).on('error', fail); up.end(buffer); });
  const doc = {
    ...meta, doc_name_lc: name_lc, file_id: String(up.id), size: buffer.length, version: latest ? (latest.version || 1) + 1 : 1, superseded: false,
    status: 'Pending Verification', issue_date: issue, expiry_date: expiry,
    uploaded_by: user.name, uploaded_by_email: user._id, uploaded_at: new Date().toISOString(), ...extra
  };
  const r = await docs.insertOne(doc);
  await docs.updateMany({ key: meta.key, doc_name_lc: name_lc, _id: { $ne: r.insertedId } }, { $set: { superseded: true } });
  touchKeysSoon([meta.key]);
  await notify(db, { id: `approval:${r.insertedId}`, type: 'approval_request', level: 'info', cap: 'verify_docs', key: meta.key, compliance_id: meta.compliance_id, project_id: meta.project_id,
    title: `${meta.compliance_id}: document waiting for verification`, message: `${meta.doc_name} (version ${doc.version}) was ${extra.generated_id ? 'prepared' : 'uploaded'} by ${user.name}.` });
  let carried = [];
  try { carried = await carryForward(db, bucket, { ...doc, _id: r.insertedId }); if (carried.length) touchKeysSoon(carried); } catch (e) { console.error('carry-forward failed:', e.message); }
  return { id: String(r.insertedId), version: doc.version, carried: carried.length };
}

// A document the company writes itself (from a saved format) is attached to the record it was prepared for.
async function attachPrepared(req, a, buffer, fileName, generatedId) {
  const key = typeof a.key === 'string' ? a.key.slice(0, 200) : '', pk = Core.parseKey(key), item = pk && itemsList.find((i) => i.compliance_id === pk.compliance_id);
  const name = typeof a.doc_name === 'string' ? a.doc_name.trim().slice(0, 150) : '';
  if (!validId(key) || !item) throw Object.assign(new Error('Unknown compliance record.'), { status: 400 });
  if (!canWriteScope(req.allowed, scopeOfKey(key))) throw Object.assign(new Error('You do not have access to that.'), { status: 403 });
  const listed = Core.requiredDocs(item).find((n) => n.toLowerCase() === name.toLowerCase());
  if (!listed) throw Object.assign(new Error('That record does not list this document.'), { status: 400 });
  if (Core.docOrigin(listed) !== 'prepared') throw Object.assign(new Error('This document is issued by an authority or another party, so upload it instead of preparing it.'), { status: 400 });
  const projectId = typeof a.project_id === 'string' && validId(a.project_id) ? a.project_id : null;
  return saveDocument({ key, compliance_id: item.compliance_id, project_id: projectId, doc_name: listed, file_name: fileName }, buffer, req.user, { extra: { generated_id: generatedId } });
}

// Uploading the same document name again creates a new version; older versions stay on record.
app.post('/files', requireCap('upload_docs'), withScopes, express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  try {
    const { key, compliance_id, project_id, doc_name, file_name, issue_date, expiry_date } = req.query;
    const meta = {
      key: str(key, 200), compliance_id: str(compliance_id, 100), project_id: str(project_id, 100) || null,
      doc_name: str(doc_name, 150), file_name: path.basename(str(file_name, 200).replace(/\\/g, '/'))
    };
    if (!validId(meta.key) || !validId(meta.compliance_id) || !meta.doc_name || !meta.file_name) return res.status(400).json({ error: 'Missing document details.' });
    if (!canWriteScope(req.allowed, scopeOfKey(meta.key))) return res.status(403).json({ error: 'You do not have access to that.' });
    if (!UPLOAD_EXT.has(path.extname(meta.file_name).toLowerCase())) return res.status(400).json({ error: 'This file type is not allowed.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'The file is empty.' });
    const issue = isoDate(issue_date), expiry = isoDate(expiry_date);
    if ((issue_date && !issue) || (expiry_date && !expiry)) return res.status(400).json({ error: 'Dates must be valid.' });
    if (issue && expiry && expiry < issue) return res.status(400).json({ error: 'The expiry date is before the issue date.' });
    const saved = await saveDocument(meta, req.body, req.user, { issue, expiry });
    res.json({ ok: true, id: saved.id, version: saved.version, carried: saved.carried });
  } catch (e) {
    if (e.type === 'entity.too.large') return res.status(413).json({ error: 'File is larger than 15 MB.' });
    console.error(e); res.status(500).json({ error: 'upload failed' });
  }
});

app.get('/files/:fileId', withScopes, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.fileId)) return res.status(404).json({ error: 'not found' });
    const doc = await db.collection('documents').findOne({ file_id: req.params.fileId });
    if (!doc || !canSee(req.allowed, scopeOfKey(doc.key))) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    bucket.openDownloadStream(new ObjectId(doc.file_id)).on('error', () => res.destroy()).pipe(res);
  } catch (e) { console.error(e); res.status(500).json({ error: 'download failed' }); }
});

// Verify or reject the current version of a document. A different person from the uploader must do it (admins excepted).
app.post('/files/:id/verify', requireCap('verify_docs'), withScopes, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { status } = req.body || {};
    const note = str(req.body?.note, 500);
    if (!['Verified', 'Rejected'].includes(status)) return res.status(400).json({ error: 'Choose Verified or Rejected.' });
    if (status === 'Rejected' && !note) return res.status(400).json({ error: 'Say why the document is rejected.' });
    const docs = db.collection('documents');
    const doc = await docs.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc || !canWriteScope(req.allowed, scopeOfKey(doc.key))) return res.status(404).json({ error: 'not found' });
    if (doc.superseded) return res.status(409).json({ error: 'A newer version exists, so this one can no longer be verified.' });
    if (doc.uploaded_by_email === req.user._id && req.user.role !== 'admin') return res.status(403).json({ error: 'A different person must verify a document you uploaded.' });
    const now = new Date().toISOString();
    await docs.updateOne({ _id: doc._id }, { $set: { status, verified_by: req.user.name, verified_by_email: req.user._id, verified_at: now, verification_note: note } });
    const mirrored = await mirrorStatus(db, { ...doc, status, verified_by: req.user.name, verified_by_email: req.user._id, verified_at: now, verification_note: note });
    touchKeysSoon([doc.key, ...mirrored]);
    if (status === 'Rejected') {
      await notify(db, { id: `rejected:${doc._id}`, type: 'doc_rejected', level: 'bad', cap: 'upload_docs', key: doc.key, compliance_id: doc.compliance_id, project_id: doc.project_id,
        title: `${doc.compliance_id}: document rejected`, message: `${doc.doc_name} (version ${doc.version || 1}) was rejected by ${req.user.name}: ${note}` });
    }
    res.json({ ok: true, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// :id here is the "documents" row id. Verified documents are kept (upload a new version instead) unless a company admin removes them.
app.delete('/files/:id', requireCap('upload_docs'), withScopes, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const docs = db.collection('documents');
    const doc = await docs.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc || !canWriteScope(req.allowed, scopeOfKey(doc.key))) return res.status(404).json({ error: 'not found' });
    if (doc.status === 'Verified' && !hasCap(req.user, 'manage_company')) return res.status(403).json({ error: 'A verified document is part of the record. Upload a new version instead.' });
    await docs.deleteOne({ _id: doc._id });
    await bucket.delete(new ObjectId(doc.file_id)).catch(() => {});
    // If the current version went, the newest remaining one becomes current again.
    const newest = await docs.find({ key: doc.key, doc_name_lc: doc.doc_name_lc }).sort({ version: -1 }).limit(1).next();
    if (newest && newest.superseded) await docs.updateOne({ _id: newest._id }, { $set: { superseded: false } });
    touchKeysSoon([doc.key]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'delete failed' }); }
});

// Deadline reminders and document-expiry notices, plus health scores and the regulatory feed.
// On a traditional host this runs itself on a timer; on serverless (no long-lived process) it
// only runs when something calls it, so Vercel Cron hits /api/cron/daily instead (see vercel.json
// and the public route registered above, before the signed-in gate).
const runReminderCheck = () => runReminders(db)
  .then((r) => { if (!r.skipped) console.log(`Reminders checked ${r.checked} records; new notices: ${JSON.stringify(r.made)}`); })
  .then(() => runAll(db)).then((r) => console.log(`Health scores and snapshots refreshed for ${r.scopes} project/company views.`))
  .then(() => autoAnalyse(db, aiConfig())).then((n) => { if (n) console.log(`AI analysis refreshed automatically for ${n} project(s).`); })
  .catch((e) => console.error('Reminder / health refresh failed:', e.message));

ensureRegulatoryIndexes(db).catch((e) => console.error('Regulatory indexes:', e.message));
docStudio.ensureIndexes().catch((e) => console.error('Document indexes:', e.message));

// Documents already on file are passed on to the later records that need them (copies already made are skipped).
const runCarryForward = () => carryAllExisting(db, bucket)
  .then((n) => { if (n) { console.log(`Documents carried forward to later records: ${n}.`); touchAllSoon(); } })
  .catch((e) => console.error('Carry-forward failed:', e.message));
cronDailyDeps.run = async () => {
  await runReminderCheck();
  if (process.env.REGULATORY_MONITORING !== 'off') {
    const r = await runRegulatoryMonitoring(db, regulatory.deps(), { trigger: 'scheduled' });
    if (!r.skipped) console.log(`Regulatory monitoring finished: ${r.run.totals.new} new, ${r.run.totals.modified} changed, ${r.run.totals.failed} source problem(s).`);
  }
};

/* ----------------------------- static app (signed-in only) ----------------------------- */
app.use(express.static(appDir, {
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); }
  }
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'server error' });
});

if (process.env.VERCEL) {
  // Serverless: no persistent process to run deferred/interval work, so do the one-time setup now.
  await runCarryForward();
} else {
  const server = app.listen(PORT, () => console.log(`Compliance Tracker running on port ${PORT}${PROD ? ' (production)' : ''}`));

  setTimeout(runReminderCheck, 20_000).unref();
  setInterval(runReminderCheck, 6 * 60 * 60 * 1000).unref();
  setTimeout(runCarryForward, 30_000).unref();
  // Regulatory monitoring: every day at 08:00 IST, in the backend, with the dashboard closed. Admins can also run it from Settings.
  if (process.env.REGULATORY_MONITORING !== 'off') startRegulatoryScheduler(db, regulatory.deps());

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(async () => { await client.close(); process.exit(0); }));
  }
}

