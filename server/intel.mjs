// Project compliance intelligence: loads real data, scores it (health.mjs), stores daily snapshots, keeps recommendations
// without duplicates, and adds an AI narrative that is validated against the data before anything is shown or saved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld, Core } from './generate.mjs';
import { loadDeps, ctxForScope } from './gate.mjs';
import { computeHealth, buildRecommendations, aiFacts, mergeSettings, LEVELS } from './health.mjs';
import { notify } from './notify.mjs';
import { askJson } from './chat.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(appDir, f), 'utf8')); } catch { return fallback; } };
const sha = (s, n = 16) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const todayISO = () => new Date().toISOString().slice(0, 10);
const recId = (dedupe) => 'rec_' + sha(dedupe);
const PRI = { P1: 1, P2: 2, P3: 3, P4: 4 };
export const CATEGORIES = ['Immediate Compliance Actions', 'Upcoming Deadline Actions', 'Document Collection', 'Dependency Recommendations', 'Stage Readiness', 'Project Coordination', 'Compliance Process Improvement'];

/** Everything needed to score any company or project, read once. */
export async function loadShared(db) {
  const w = await loadWorld(db);
  const [trackDocs, docs, risk, stageOv, settingsDoc] = await Promise.all([
    db.collection('tracking').find().toArray(), db.collection('documents').find().toArray(), db.collection('risk_overrides').find().toArray(),
    db.collection('stage_overrides').find().toArray(), db.collection('settings').findOne({ _id: 'health' }),
  ]);
  const docsByKey = {};
  for (const d of docs) (docsByKey[d.key] = docsByKey[d.key] || []).push({ ...d, id: String(d._id) });
  return {
    w, tracking: Object.fromEntries(trackDocs.map((t) => [String(t._id), t])), docsByKey,
    riskOverrides: Object.fromEntries(risk.map((r) => [String(r._id), r])), stageOverrides: Object.fromEntries(stageOv.map((s) => [String(s._id), s.stage_id])),
    settings: mergeSettings(settingsDoc || {}), deps: loadDeps(), stages: readJson('stages.json', []), proposals: (readJson('risk-proposals.json', {}).proposals) || {}, today: todayISO(),
  };
}

export function scopeInfo(shared, id) {
  const w = shared.w;
  if (w.projects[id]) {
    const p = w.projects[id];
    return { type: 'project', id, name: p.name, companyId: p.company_id || null, companyName: (w.companies[p.company_id] || {}).name || null, location: p.location || null,
      projectType: p.project_type || null, category: Core.categoryOf(p), constructionStage: p.current_stage || null, projectManager: p.project_manager || null, complianceManager: p.compliance_manager || null,
      phases: Object.values(w.phases).filter((x) => x.project_id === id).map((x) => x.name), buildings: Object.values(w.buildings).filter((x) => x.project_id === id).length };
  }
  if (w.companies[id]) return { type: 'company', id, name: `Company-wide · ${w.companies[id].name}`, companyId: id, companyName: w.companies[id].name };
  return null;
}

export function healthOf(shared, id) {
  const scope = scopeInfo(shared, id);
  if (!scope) return null;
  const ctx = scope.type === 'project' ? { projectId: id } : { companyId: id };
  const insts = Core.enumerate(shared.w, ctx);
  const h = computeHealth({ insts, decisions: shared.w.decisions, tracking: shared.tracking, docsByKey: shared.docsByKey, deps: shared.deps, stages: shared.stages, stageOverrides: shared.stageOverrides,
    riskOverrides: shared.riskOverrides, proposals: shared.proposals, settings: shared.settings, today: shared.today, scope, itemById: shared.w.itemById });
  return h;
}
export const publicHealth = (h) => { const { _rows, ...rest } = h; return rest; };

/* ----------------------------- snapshots / trend ----------------------------- */
export async function saveSnapshot(db, h) {
  if (h.score == null) return null;
  const doc = { scope_id: h.scope.id, scope_type: h.scope.type, scope_name: h.scope.name, date: h.today, at: new Date().toISOString(), score: h.score, category: h.category, risk_pct: h.riskPct,
    deduction_total: h.deductionTotal, counts: h.counts, buckets: h.buckets, documents: { required: h.documents.required, verified: h.documents.verified, missing: h.documents.missing, expired: h.documents.expired, rejected: h.documents.rejected },
    stages: h.stages.map((s) => ({ id: s.id, status: s.status, pct: s.readinessPct })), data_version: h.dataVersion, calc_version: 1 };
  await db.collection('health_snapshots').updateOne({ _id: `${h.scope.id}:${h.today}` }, { $set: doc }, { upsert: true });
  return doc;
}
export async function previousSnapshot(db, id, today) {
  return db.collection('health_snapshots').find({ scope_id: id, date: { $lt: today } }).sort({ date: -1 }).limit(1).next();
}
export async function trend(db, id, days, from, to) {
  const end = to || todayISO();
  const start = from || new Date(Date.now() - (days || 30) * 86400000).toISOString().slice(0, 10);
  const rows = await db.collection('health_snapshots').find({ scope_id: id, date: { $gte: start, $lte: end } }).sort({ date: 1 }).toArray();
  return rows.map(({ _id, ...r }) => r);
}

/* ----------------------------- recommendations ----------------------------- */
/** Keep the rule-based recommendations in step with the data. Updates by dedupe key; never creates a second one for the same issue. */
export async function syncRecs(db, h, recs) {
  const col = db.collection('ai_recommendations');
  const now = new Date().toISOString(), today = h.today;
  const existing = await col.find({ scope_id: h.scope.id, source: 'rules' }).toArray();
  const map = Object.fromEntries(existing.map((e) => [String(e._id), e]));
  const seen = new Set(), ops = [], newP1 = [];
  const res = { created: 0, updated: 0, reopened: 0, resolved: 0 };
  for (const r of recs) {
    const id = recId(r.dedupe_key); seen.add(id);
    const fields = { ...r, updated_at: now, last_seen_at: now, data_version: h.dataVersion, project_name: h.scope.type === 'project' ? h.scope.name : null, company_name: h.scope.companyName || null };
    const ex = map[id];
    if (!ex) {
      ops.push({ insertOne: { document: { _id: id, ...fields, status: 'open', created_at: now, history: [{ at: now, by: 'system', to: 'open', note: 'Detected' }] } } });
      res.created++; if (r.priority === 'P1') newP1.push({ id, r });
      continue;
    }
    const set = { ...fields }; let status = ex.status;
    const push = [];
    if (status === 'snoozed' && ex.snooze_until && ex.snooze_until <= today) { status = 'open'; push.push({ at: now, by: 'system', from: 'snoozed', to: 'open', note: 'Snooze ended' }); }
    if (status === 'completed') { status = 'open'; res.reopened++; set.reopened_at = now; push.push({ at: now, by: 'system', from: 'completed', to: 'open', note: 'The issue is still detected, so it was reopened.' }); }
    if (status === 'resolved') { status = 'open'; res.reopened++; push.push({ at: now, by: 'system', from: 'resolved', to: 'open', note: 'The issue came back.' }); }
    if (status === 'rejected' && (PRI[r.priority] || 9) < (PRI[ex.rejected_priority] || 9)) { status = 'open'; push.push({ at: now, by: 'system', from: 'rejected', to: 'open', note: `Priority rose to ${r.priority}.` }); }
    set.status = status;
    if (ex.title !== r.title || ex.priority !== r.priority || ex.due_date !== r.due_date || ex.recommended_action !== r.recommended_action) res.updated++;
    ops.push({ updateOne: { filter: { _id: id }, update: { $set: set, ...(push.length ? { $push: { history: { $each: push } } } : {}) } } });
  }
  for (const ex of existing) {
    if (seen.has(String(ex._id)) || !['open', 'accepted', 'snoozed', 'review_requested'].includes(ex.status)) continue;
    res.resolved++;
    ops.push({ updateOne: { filter: { _id: ex._id }, update: { $set: { status: 'resolved', resolved_at: now, resolution: 'The issue is no longer detected.', updated_at: now }, $push: { history: { at: now, by: 'system', from: ex.status, to: 'resolved', note: 'The issue is no longer detected.' } } } } });
    if (ex.compliance_key) ops.push({ _clear: ex }); // handled below
  }
  const real = ops.filter((o) => !o._clear);
  if (real.length) await col.bulkWrite(real, { ordered: false });
  for (const o of ops.filter((x) => x._clear)) await db.collection('tracking').updateOne({ _id: o._clear.compliance_key, 'open_action.recommendation_id': String(o._clear._id) }, { $unset: { open_action: '' } });
  for (const { id, r } of newP1) await notify(db, { id: `rec:${id}`, type: 'ai_p1', level: 'bad', cap: 'manage_actions', key: r.compliance_key || null, compliance_id: r.compliance_id || null, project_id: r.project_id || null,
    title: `P1 action: ${r.title}`, message: r.reason || r.recommended_action });
  return res;
}

/** Accept, reject, snooze, complete, assign, reopen, or ask for review. Accepting links the action to the compliance record (no separate task list). */
export async function actOnRec(db, id, body, user) {
  const col = db.collection('ai_recommendations');
  const rec = await col.findOne({ _id: id });
  if (!rec) throw Object.assign(new Error('Recommendation not found.'), { status: 404 });
  const now = new Date().toISOString();
  const action = String(body.action || '');
  const note = String(body.note || '').trim().slice(0, 500);
  const set = { updated_at: now }; let to = null;
  const link = async (owner, due) => {
    if (!rec.compliance_key) return null;                       // aggregate recommendations have no single record to attach to
    const tr = await db.collection('tracking').findOne({ _id: rec.compliance_key });
    if (tr && tr.open_action && tr.open_action.recommendation_id !== id && ['accepted'].includes((await col.findOne({ _id: tr.open_action.recommendation_id }) || {}).status)) {
      throw Object.assign(new Error(`This record already has an open action: “${tr.open_action.title}”. Complete or reject that one first.`), { status: 409 });
    }
    const oa = { recommendation_id: id, title: rec.title, owner: owner || rec.suggested_owner || null, due_date: due || rec.due_date || null, priority: rec.priority, created_at: (tr && tr.open_action && tr.open_action.created_at) || now, created_by: user.name };
    await db.collection('tracking').updateOne({ _id: rec.compliance_key }, { $set: { open_action: oa } }, { upsert: true });
    return oa;
  };
  if (action === 'accept' || action === 'create_task') {
    if (rec.status === 'accepted' && rec.task) return { rec, task: rec.task, already: true };
    const owner = String(body.owner || '').trim().slice(0, 120) || null, due = /^\d{4}-\d{2}-\d{2}$/.test(body.due_date || '') ? body.due_date : null;
    const task = await link(owner, due);
    to = 'accepted'; Object.assign(set, { status: 'accepted', accepted_at: now, accepted_by: user.name, assigned_owner: owner || rec.suggested_owner || null, assigned_due: due || rec.due_date || null, task: task ? { type: 'tracking', key: rec.compliance_key, linked_at: now } : null });
  } else if (action === 'assign') {
    const owner = String(body.owner || '').trim().slice(0, 120); if (!owner) throw Object.assign(new Error('Enter who it is assigned to.'), { status: 400 });
    Object.assign(set, { assigned_owner: owner, ...(/^\d{4}-\d{2}-\d{2}$/.test(body.due_date || '') ? { assigned_due: body.due_date } : {}) });
    if (rec.status === 'accepted' && rec.compliance_key) await db.collection('tracking').updateOne({ _id: rec.compliance_key }, { $set: { 'open_action.owner': owner } });
    to = rec.status;
  } else if (action === 'reject') {
    if (!note) throw Object.assign(new Error('Say why you are rejecting it.'), { status: 400 });
    to = 'rejected'; Object.assign(set, { status: 'rejected', rejected_at: now, rejected_by: user.name, rejected_priority: rec.priority, reject_reason: note });
    if (rec.compliance_key) await db.collection('tracking').updateOne({ _id: rec.compliance_key, 'open_action.recommendation_id': id }, { $unset: { open_action: '' } });
  } else if (action === 'snooze') {
    const days = Math.max(1, Math.min(90, parseInt(body.days, 10) || 7));
    const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    to = 'snoozed'; Object.assign(set, { status: 'snoozed', snooze_until: until, snoozed_by: user.name });
  } else if (action === 'complete') {
    to = 'completed'; Object.assign(set, { status: 'completed', completed_at: now, completed_by: user.name });
    if (rec.compliance_key) await db.collection('tracking').updateOne({ _id: rec.compliance_key, 'open_action.recommendation_id': id }, { $unset: { open_action: '' } });
  } else if (action === 'request_review') {
    to = 'review_requested'; Object.assign(set, { status: 'review_requested', review_requested_by: user.name, review_requested_at: now });
    await notify(db, { id: `review:${id}:${now.slice(0, 10)}`, type: 'review_requested', level: 'info', cap: 'manage_actions', key: rec.compliance_key || null, compliance_id: rec.compliance_id || null, project_id: rec.project_id || null,
      title: `Review requested: ${rec.title}`, message: `${user.name} asked for a review.${note ? ' ' + note : ''}` });
  } else if (action === 'reopen') {
    to = 'open'; Object.assign(set, { status: 'open' });
  } else throw Object.assign(new Error('Unknown action.'), { status: 400 });
  await col.updateOne({ _id: id }, { $set: set, $push: { history: { at: now, by: user.name, from: rec.status, to: to || rec.status, note: note || action } } });
  return { rec: { ...(await col.findOne({ _id: id })) }, task: set.task || rec.task || null };
}

/* ----------------------------- AI narrative ----------------------------- */
const SYSTEM = `You are the compliance-intelligence analyst for a real estate and EPC company in India. You are given structured facts about ONE company or project, taken from its own compliance records.
Rules:
- Use only the facts provided. Never invent compliance IDs, dates, deadlines, penalties, laws, approvals, authorities or project status.
- If something needed is missing, say "Insufficient information for reliable analysis." If a legal interpretation would be needed, say "Legal validation required."
- Never say a project is legally compliant or non-compliant. The score is an operational indicator.
- A risk whose level is "pending" has no validated classification: do not call it critical or high.
- Refer to records only by complianceId values present in the input.
- Be specific to this project and short. Plain English.
Return ONLY one JSON object with exactly these keys:
{"projectSummary": string (3-5 sentences: current condition, major risks, biggest blocker, stage needing attention, next action),
 "healthExplanation": string (why the score is what it is, in 2-3 sentences, using the numbers given),
 "criticalRisks": [{"complianceId": string|null, "title": string, "reason": string}],
 "highRisks": [{"complianceId": string|null, "title": string, "reason": string}],
 "recommendations": [{"title": string, "category": one of ${JSON.stringify(CATEGORIES)}, "priority": "P1"|"P2"|"P3"|"P4", "riskLevel": "critical"|"high"|"medium"|"low", "complianceId": string, "projectId": string, "stage": string|null, "reason": string, "recommendedAction": string, "responsibleDepartment": string, "suggestedOwner": string, "dueDate": "YYYY-MM-DD"|null, "requiredDocuments": [string], "expectedOutcome": string, "sourceReferences": [string]}],
 "stageReadiness": [{"stage": string, "status": string, "comment": string}],
 "documentIssues": [{"complianceId": string|null, "issue": string}],
 "deadlineRisks": [{"complianceId": string|null, "issue": string}],
 "dataLimitations": [string]}
Give at most 6 recommendations and only for records that appear in the input risks. Do not repeat recommendations that are already listed under "recommendations" in the input; add new insight only.`;

const parseJson = (t) => { const s = String(t).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(); return JSON.parse(s); };
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const arr = (v) => (Array.isArray(v) ? v : []);

/** Check the model's output against the real data. Anything referring to a record or project that does not exist is dropped. */
export function validateAi(raw, h, recs) {
  const notes = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, notes: ['The AI response was not a JSON object.'] };
  const ids = new Set(h._rows.map((r) => r.cid)), stageIds = new Set(h.stages.map((s) => s.id));
  const ruleCids = new Set(recs.map((r) => r.compliance_id).filter(Boolean));
  const riskList = (v, label) => arr(v).slice(0, 8).map((x) => {
    if (typeof x === 'string') return { complianceId: null, title: str(x, 160), reason: '' };
    const cid = x && typeof x.complianceId === 'string' ? x.complianceId : null;
    if (cid && !ids.has(cid)) { notes.push(`Dropped a ${label} that named an unknown record (${str(cid, 20)}).`); return null; }
    return { complianceId: cid, title: str(x.title, 160), reason: str(x.reason, 400) };
  }).filter((x) => x && x.title);
  // the AI cannot call something critical/high unless the engine did
  const engineLevel = Object.fromEntries(h.cards.map((c) => [c.complianceId, c.level]));
  const critical = riskList(raw.criticalRisks, 'critical risk').filter((x) => !x.complianceId || engineLevel[x.complianceId] === 'critical' || (notes.push(`Moved ${x.complianceId} out of critical risks: it is not classified critical.`), false));
  const high = riskList(raw.highRisks, 'high risk').filter((x) => !x.complianceId || ['critical', 'high'].includes(engineLevel[x.complianceId]) || (notes.push(`Moved ${x.complianceId} out of high risks: it is not classified high.`), false));
  const recsOut = [];
  for (const x of arr(raw.recommendations).slice(0, 10)) {
    if (!x || typeof x !== 'object') continue;
    const cid = str(x.complianceId, 40);
    if (!ids.has(cid)) { notes.push(`Dropped a recommendation for an unknown record (${cid || 'none'}).`); continue; }
    if (x.projectId && x.projectId !== h.scope.id) { notes.push(`Dropped a recommendation for a different project (${str(x.projectId, 40)}).`); continue; }
    if (ruleCids.has(cid)) { notes.push(`Skipped an AI recommendation for ${cid}: a rule-based one already exists.`); continue; }
    if (!PRI[x.priority] || !LEVELS.includes(x.riskLevel) || !CATEGORIES.includes(x.category)) { notes.push(`Dropped a recommendation for ${cid} with an invalid priority, risk level or category.`); continue; }
    if (x.riskLevel === 'critical' && engineLevel[cid] !== 'critical') x.riskLevel = engineLevel[cid] && engineLevel[cid] !== 'pending' ? engineLevel[cid] : 'medium';
    recsOut.push({ title: str(x.title, 200), category: x.category, priority: x.priority, riskLevel: x.riskLevel, complianceId: cid, projectId: h.scope.id, stage: stageIds.has(x.stage) ? x.stage : null,
      reason: str(x.reason, 500), recommendedAction: str(x.recommendedAction, 600), responsibleDepartment: str(x.responsibleDepartment, 120), suggestedOwner: str(x.suggestedOwner, 120),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(x.dueDate || '') ? x.dueDate : null, requiredDocuments: arr(x.requiredDocuments).slice(0, 8).map((d) => str(d, 120)).filter(Boolean),
      expectedOutcome: str(x.expectedOutcome, 300), sourceReferences: arr(x.sourceReferences).slice(0, 8).map((d) => str(d, 120)).filter(Boolean) });
  }
  const simple = (v) => arr(v).slice(0, 10).map((x) => (typeof x === 'string' ? { issue: str(x, 300), complianceId: null } : { complianceId: x && ids.has(x.complianceId) ? x.complianceId : null, issue: str(x && (x.issue || x.comment || x.title), 300), stage: str(x && x.stage, 80), status: str(x && x.status, 60), comment: str(x && x.comment, 300) })).filter((x) => x.issue || x.comment);
  const result = { projectSummary: str(raw.projectSummary, 1800), healthExplanation: str(raw.healthExplanation, 1000), criticalRisks: critical, highRisks: high, recommendations: recsOut,
    stageReadiness: simple(raw.stageReadiness), documentIssues: simple(raw.documentIssues), deadlineRisks: simple(raw.deadlineRisks), dataLimitations: arr(raw.dataLimitations).slice(0, 8).map((d) => str(d, 300)).filter(Boolean) };
  if (!result.projectSummary) return { ok: false, notes: [...notes, 'The AI response had no project summary.'] };
  return { ok: true, result, notes };
}

const running = new Map();
/**
 * Recompute everything for one company/project, then ask the AI for the narrative.
 * The score, risks and rule-based recommendations are saved even if the AI is down.
 */
export async function analyse(db, id, user, ai, { force = false } = {}) {
  if (running.has(id)) throw Object.assign(new Error('An analysis for this project is already running.'), { status: 409 });
  const run = (async () => {
    const shared = await loadShared(db);
    const h = healthOf(shared, id);
    if (!h) throw Object.assign(new Error('Unknown project or company.'), { status: 404 });
    const recs = buildRecommendations(h, {});
    const sync = await syncRecs(db, h, recs);
    await saveSnapshot(db, h);
    const last = await db.collection('ai_analyses').find({ project_id: id, status: 'ok' }).sort({ analysed_at: -1 }).limit(1).next();
    const ageMin = last ? (Date.now() - new Date(last.analysed_at)) / 60000 : null;
    if (last && last.data_version === h.dataVersion && ageMin < 10 && !force) return { cached: true, message: 'Nothing has changed since the last analysis a few minutes ago.', analysis: last, sync, health: h };
    const rec = { project_id: id, scope_type: h.scope.type, analysed_at: new Date().toISOString(), requested_by: user ? user.name : 'system', data_version: h.dataVersion, score: h.score, category: h.category, counts: h.counts, limitations: h.limitations };
    if (!ai || !ai.provider) { const a = { ...rec, status: 'ai_unavailable', error: 'The AI is not set up (no API key on the server). The score and rule-based recommendations are still up to date.' }; const r = await db.collection('ai_analyses').insertOne(a); return { analysis: { ...a, _id: r.insertedId }, sync, health: h, aiError: a.error }; }
    let text, model;
    try {
      const out = await askJson({ provider: ai.provider, apiKey: ai.apiKey, model: ai.model, fallbackModel: ai.fallbackModel, system: SYSTEM, prompt: `FACTS (JSON):\n${JSON.stringify(aiFacts(h, recs))}` });
      text = out.text; model = out.model;
    } catch (e) {
      const msg = e.status === 429 ? 'The AI is out of quota right now. Try again later.' : e.name === 'TimeoutError' ? 'The AI took too long to answer.' : 'The AI could not be reached.';
      console.error('intel: AI call failed:', e.status || '', String(e.message).slice(0, 200));
      const a = { ...rec, status: 'ai_unavailable', error: `${msg} The score and rule-based recommendations are still up to date.`, model: ai.model }; const r = await db.collection('ai_analyses').insertOne(a);
      return { analysis: { ...a, _id: r.insertedId }, sync, health: h, aiError: a.error };
    }
    let parsed; try { parsed = parseJson(text); } catch { parsed = null; }
    const v = parsed ? validateAi(parsed, h, recs) : { ok: false, notes: ['The AI did not return valid JSON.'] };
    if (!v.ok) { const a = { ...rec, status: 'ai_invalid', model, error: 'The AI answer could not be used, so it was discarded. ' + v.notes.join(' '), validation_notes: v.notes }; const r = await db.collection('ai_analyses').insertOne(a); return { analysis: { ...a, _id: r.insertedId }, sync, health: h, aiError: a.error }; }
    // store validated AI-suggested extras as recommendations (source "ai"), without touching rule-based ones
    const now = new Date().toISOString(), col = db.collection('ai_recommendations'); let aiCount = 0;
    const keep = new Set();
    for (const x of v.result.recommendations) {
      const row = h._rows.find((r) => r.cid === x.complianceId); const dedupe = `${id}|ai|${x.complianceId}|${sha(x.title.toLowerCase())}`; const rid = recId(dedupe); keep.add(rid);
      const doc = { scope_type: h.scope.type, scope_id: id, scope_name: h.scope.name, project_id: h.scope.type === 'project' ? id : null, company_id: h.scope.companyId || null, project_name: h.scope.name, source: 'ai', dedupe_key: dedupe, category: x.category,
        title: x.title, explanation: x.reason, reason: x.reason, priority: x.priority, priority_reason: 'Suggested by the AI from the project data; check it before acting.', risk_level: x.riskLevel, risk_classified: !!(row && row.classified),
        compliance_key: row ? row.key : null, compliance_id: x.complianceId, stage: x.stage, stage_name: x.stage, recommended_action: x.recommendedAction, responsible_department: x.responsibleDepartment || (row && row.department) || null,
        suggested_owner: x.suggestedOwner || (row && row.owner) || null, due_date: x.dueDate || (row && row.due) || null, required_documents: x.requiredDocuments, expected_outcome: x.expectedOutcome,
        source_refs: [{ type: 'compliance', id: x.complianceId, key: row ? row.key : null }, ...x.sourceReferences.map((s) => ({ type: 'text', text: s }))], evidence: [], updated_at: now, last_seen_at: now };
      const ex = await col.findOne({ _id: rid });
      if (!ex) await col.insertOne({ _id: rid, ...doc, status: 'open', created_at: now, history: [{ at: now, by: 'AI', to: 'open', note: 'Suggested by the AI' }] }); else await col.updateOne({ _id: rid }, { $set: doc });
      aiCount++;
    }
    await col.updateMany({ scope_id: id, source: 'ai', status: 'open', _id: { $nin: [...keep] } }, { $set: { status: 'resolved', resolved_at: now, resolution: 'The latest AI analysis no longer suggests it.' } });
    const a = { ...rec, status: 'ok', model, result: v.result, validation_notes: v.notes, ai_recommendations: aiCount };
    const r = await db.collection('ai_analyses').insertOne(a);
    return { analysis: { ...a, _id: r.insertedId }, sync, health: h, validation: v.notes };
  })();
  running.set(id, run);
  try { return await run; } finally { running.delete(id); }
}

/* ----------------------------- event-driven refresh ----------------------------- */
const timers = new Map();
/** Recompute the score, snapshot and rule-based recommendations a few seconds after something changes. No AI call. */
export function touchScopes(db, ids) {
  for (const id of new Set(ids.filter(Boolean))) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(async () => {
      timers.delete(id);
      try { const shared = await loadShared(db); const h = healthOf(shared, id); if (!h) return; await saveSnapshot(db, h); await syncRecs(db, h, buildRecommendations(h, {})); }
      catch (e) { console.error('intel refresh failed:', e.message); }
    }, 4000)); timers.get(id).unref?.();
  }
}
/** Which company/project views does a tracking/document/applicability key affect? */
export function scopesForKey(shared, key) {
  const pk = Core.parseKey(key); if (!pk) return [];
  const ctx = ctxForScope(shared.w, pk.scopeId);
  return ctx ? [ctx.projectId || ctx.companyId] : [];
}

/**
 * Optional (Settings → off by default): refresh the AI analysis on its own for projects whose data changed and that actually need
 * attention, at most a few per run so the AI quota is not burned. Never runs for a project with nothing wrong.
 */
export async function autoAnalyse(db, ai, max = 3) {
  if (!ai) return 0;
  const shared = await loadShared(db);
  if (!shared.settings.ai_auto_refresh) return 0;
  const hours = shared.settings.ai_refresh_hours; let n = 0;
  for (const id of Object.keys(shared.w.projects)) {
    if (n >= max) break;
    const h = healthOf(shared, id); if (!h || h.score == null) continue;
    const last = await db.collection('ai_analyses').find({ project_id: id, status: 'ok' }).sort({ analysed_at: -1 }).limit(1).next();
    const changed = !last || (last.data_version !== h.dataVersion && (Date.now() - new Date(last.analysed_at)) > hours * 3600e3);
    const needsAttention = h.counts.critical + h.counts.high + h.counts.overdue > 0;
    if (changed && needsAttention) { try { await analyse(db, id, null, ai); n++; } catch (e) { console.error('auto analysis skipped:', e.message); } }
  }
  return n;
}

export async function runAll(db) {
  const shared = await loadShared(db); let n = 0;
  const ids = [...Object.keys(shared.w.projects), ...Object.keys(shared.w.companies)];
  for (const id of ids) { const h = healthOf(shared, id); if (!h) continue; await saveSnapshot(db, h); await syncRecs(db, h, buildRecommendations(h, {})); n++; }
  return { scopes: n };
}
