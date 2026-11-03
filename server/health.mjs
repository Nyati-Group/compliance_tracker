// Project compliance health: a pure, deterministic engine (no database, no AI). Everything the dashboard shows as a number comes from here,
// and every number can be explained. The AI layer only reads this output and writes narrative and extra suggestions.
import crypto from 'node:crypto';
import { Core } from './generate.mjs';

export const LEVELS = ['critical', 'high', 'medium', 'low'];
export const LEVEL_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', pending: 'Risk classification pending validation' };

/** Suggested starting values. Every one is editable in Settings; none is a legal classification. */
export const DEFAULT_HEALTH = {
  weights: { critical: 10, high: 7, medium: 4, low: 1 },
  unclassified_level: 'medium',                       // weight used for a record nobody has classified yet (it is flagged as pending validation)
  factors: { completed_verified: 0, completed_unverified: 0.5, in_progress: 0.5, submitted: 0.5, not_started: 1, overdue: 1, blocked: 1, on_hold: 1 },
  deductions: { critical_overdue: 3, expired_document: 2, missing_documents: 1.5, blocked_statutory: 1.5 },
  deduction_caps: { critical_overdue: 15, expired_document: 10, missing_documents: 10, blocked_statutory: 10 },
  bands: { healthy: 90, good: 75, attention: 60, at_risk: 40 },
  due_soon_days: 30,
  ai_auto_refresh: false, ai_refresh_hours: 24,
};
export function mergeSettings(s) {
  const d = DEFAULT_HEALTH, o = s || {};
  const m = (k) => ({ ...d[k], ...(o[k] || {}) });
  return { ...d, ...o, weights: m('weights'), factors: m('factors'), deductions: m('deductions'), deduction_caps: m('deduction_caps'), bands: m('bands') };
}
export function bandOf(score, bands) {
  if (score == null) return 'Not enough information';
  if (score >= bands.healthy) return 'Healthy';
  if (score >= bands.good) return 'Good';
  if (score >= bands.attention) return 'Attention Required';
  if (score >= bands.at_risk) return 'At Risk';
  return 'Critical Risk';
}

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const dayDiff = (to, from) => Core.daysBetween(from, to);
const short = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const named = (v) => { const s = String(v || '').trim(); return s && !/^unassigned$/i.test(s) ? s : ''; };
const down = { critical: 'high', high: 'medium', medium: 'low', low: 'low', pending: 'pending' };

const KIND_ORDER = ['expired_doc', 'overdue', 'blocked', 'rejected_doc', 'missing_docs', 'deadline_soon', 'awaiting_verification'];

/**
 * input: { insts, decisions, tracking, docsByKey, deps, stages, stageOverrides, riskOverrides, proposals, settings, today, scope:{type,id,name}, itemById }
 * insts are the enumerated compliance instances for ONE company or project (Core.enumerate).
 */
export function computeHealth(input) {
  const { insts, decisions = {}, tracking = {}, docsByKey = {}, deps = { edges: [] }, stages = [], stageOverrides = {}, riskOverrides = {}, proposals = {}, today } = input;
  const S = mergeSettings(input.settings);
  const rows = [], excluded = [];

  for (const inst of insts) {
    const item = inst.item, cid = item.compliance_id;
    const dec = decisions[inst.key];
    const appStatus = dec ? dec.status : 'Pending Review';
    const state = Core.stateOf(appStatus);
    const tr = tracking[inst.key] || {};
    if (state === 'na' || tr.status === 'Not Applicable') { excluded.push({ key: inst.key, cid, title: short(item.brief_description, 70), scope: inst.scopeShort || inst.scopeLabel, reason: 'Not applicable', detail: (dec && dec.reason) || 'Marked not applicable.' }); continue; }
    if (state === 'review') { excluded.push({ key: inst.key, cid, title: short(item.brief_description, 70), scope: inst.scopeShort || inst.scopeLabel, reason: 'Applicability pending review', detail: (dec && dec.reason) || 'Not evaluated yet.' }); continue; }
    const due = tr.next_due_date || (item.due_date_parse_type === 'fixed_date' ? item.due_date_parse_value : null) || null;
    const rawStatus = tr.status || 'Not Started';
    const status = Core.effectiveStatus({ status: rawStatus, next_due_date: due }, today);
    const completed = rawStatus === 'Compliant / Completed';
    const docs = docsByKey[inst.key] || [];
    const issues = Core.docIssues(item, docs, today);
    const cur = [...Core.currentDocs(docs).values()];
    const level = (riskOverrides[cid] && riskOverrides[cid].level) || null;
    rows.push({
      inst, key: inst.key, cid, item, scopeLabel: inst.scopeLabel, scopeShort: inst.scopeShort || null, rawStatus, status, completed, due,
      daysLeft: due ? dayDiff(due, today) : null, issues, docs: cur, requiredDocs: Core.requiredDocs(item),
      level, classified: !!level, suggestion: (proposals[cid] && proposals[cid].level) || null,
      owner: named(item.owner), approver: named(item.approver), department: item.department,
      stageId: stageOverrides[cid] || item.stage_id,
    });
  }

  // prerequisites among the applicable records
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const blocks = Core.computeBlocks(rows.map((r) => r.inst), deps, { state: () => 'active', status: (i) => (byKey.get(i.key) || {}).rawStatus === 'Compliant / Completed' ? 'Compliant / Completed' : (byKey.get(i.key) || {}).status });
  for (const r of rows) {
    r.blockedBy = r.completed ? [] : (blocks.blockedBy[r.key] || []);
    r.blocked = r.blockedBy.length > 0;
    // A record that has not started and has no near deadline is just waiting its turn; that is not a problem to flag.
    r.blockedMatters = r.blocked && (r.rawStatus !== 'Not Started' || r.status === 'Overdue' || (r.daysLeft != null && r.daysLeft <= S.due_soon_days));
    r.dependents = (blocks.unblocks[r.key] || []).filter((k) => byKey.has(k) && !byKey.get(k).completed).length;
  }

  // ---- weighted outstanding risk ----
  let totalRisk = 0, outstanding = 0;
  for (const r of rows) {
    r.weight = S.weights[r.level || S.unclassified_level];
    if (r.completed) r.factor = r.issues.ok ? S.factors.completed_verified : S.factors.completed_unverified;
    else if (r.blocked) r.factor = S.factors.blocked;
    else if (r.status === 'Overdue') r.factor = S.factors.overdue;
    else if (r.rawStatus === 'On Hold') r.factor = S.factors.on_hold;
    else if (r.rawStatus === 'In Progress') r.factor = S.factors.in_progress;
    else if (r.rawStatus === 'Submitted / Under Review') r.factor = S.factors.submitted;
    else r.factor = S.factors.not_started;
    r.outstanding = r.weight * r.factor;
    totalRisk += r.weight; outstanding += r.outstanding;
  }
  const riskPct = totalRisk > 0 ? (outstanding / totalRisk) * 100 : null;
  const base = riskPct == null ? null : 100 - riskPct;

  // ---- extra deductions: each record can cause at most one, the largest that applies ----
  const kinds = { critical_overdue: [], expired_document: [], missing_documents: [], blocked_statutory: [] };
  for (const r of rows) {
    const c = [];
    if (r.level === 'critical' && r.status === 'Overdue' && !r.completed) c.push(['critical_overdue', `A critical obligation is ${Math.abs(r.daysLeft)} days overdue.`]);
    if (r.issues.expired.length) c.push(['expired_document', `Expired required document: ${r.issues.expired.join(', ')}.`]);
    if (!r.completed && (r.status === 'Overdue' || (r.daysLeft != null && r.daysLeft <= S.due_soon_days)) && r.issues.missing.length) c.push(['missing_documents', `Required document(s) not uploaded while due within ${S.due_soon_days} days or overdue: ${r.issues.missing.join(', ')}.`]);
    if (r.blockedMatters && (r.level === 'critical' || r.level === 'high')) c.push(['blocked_statutory', `A ${r.level} obligation is blocked by ${r.blockedBy.map((b) => b.id).join(', ')}.`]);
    if (!c.length) continue;
    c.sort((a, b) => S.deductions[b[0]] - S.deductions[a[0]]);
    kinds[c[0][0]].push({ key: r.key, cid: r.cid, points: S.deductions[c[0][0]], reason: c[0][1], also: c.slice(1).map((x) => x[0]) });
  }
  const deductions = []; let dedTotal = 0;
  for (const [k, list] of Object.entries(kinds)) {
    if (!list.length) continue;
    const sum = list.reduce((a, x) => a + x.points, 0), cap = S.deduction_caps[k];
    const applied = Math.min(sum, cap); dedTotal += applied;
    deductions.push({ kind: k, count: list.length, points_before_cap: sum, cap, points: applied, capped: sum > cap, items: list.slice(0, 40) });
  }
  const score = base == null ? null : Math.round(clamp(base - dedTotal, 0, 100));

  // ---- risk cards (one per record: its most serious issue) ----
  const cards = [];
  for (const r of rows) {
    const found = [];
    if (r.issues.expired.length) found.push('expired_doc');
    if (!r.completed) {
      if (r.status === 'Overdue') found.push('overdue');
      if (r.blockedMatters) found.push('blocked');
      if (r.issues.rejected.length) found.push('rejected_doc');
      const urgent = r.status === 'Overdue' || (r.daysLeft != null && r.daysLeft <= S.due_soon_days);
      if (r.issues.missing.length && (urgent || r.rawStatus === 'In Progress' || r.rawStatus === 'Submitted / Under Review')) found.push('missing_docs');
      if (r.daysLeft != null && r.daysLeft >= 0 && r.daysLeft <= S.due_soon_days) found.push('deadline_soon');
      if (r.issues.unverified.length) found.push('awaiting_verification');
    }
    if (!found.length) continue;
    found.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
    const kind = found[0];
    r.kind = kind; r.allKinds = found;
    const base0 = r.level || 'pending';
    const severe = ['expired_doc', 'overdue', 'blocked', 'rejected_doc'].includes(kind) || (kind === 'missing_docs' && (r.status === 'Overdue' || (r.daysLeft != null && r.daysLeft <= 7)));
    r.riskLevel = severe ? base0 : down[base0];
    const ev = [`Status: ${r.status}`];
    if (r.due) ev.push(`Due ${r.due}${r.daysLeft != null ? (r.daysLeft < 0 ? ` (${-r.daysLeft} days overdue)` : ` (in ${r.daysLeft} days)`) : ''}`);
    if (r.issues.missing.length) ev.push(`Not uploaded: ${r.issues.missing.join(', ')}`);
    if (r.issues.unverified.length) ev.push(`Awaiting verification: ${r.issues.unverified.join(', ')}`);
    if (r.issues.rejected.length) ev.push(`Rejected: ${r.issues.rejected.join(', ')}`);
    if (r.issues.expired.length) ev.push(`Expired: ${r.issues.expired.join(', ')}`);
    if (r.blocked) ev.push(`Waiting for: ${r.blockedBy.map((b) => b.id + (b.scopeShort ? ' (' + b.scopeShort + ')' : '')).join(', ')}`);
    const reason = {
      overdue: `Due ${r.due}; ${r.daysLeft == null ? '' : -r.daysLeft + ' days overdue'}.`,
      expired_doc: `Required document expired: ${r.issues.expired.join(', ')}.`,
      rejected_doc: `A required document was rejected: ${r.issues.rejected.join(', ')}.`,
      blocked: `Cannot proceed until ${r.blockedBy.map((b) => b.id).join(', ')} ${r.blockedBy.length > 1 ? 'are' : 'is'} completed.`,
      missing_docs: `Required documents are not uploaded: ${r.issues.missing.join(', ')}.`,
      deadline_soon: `Due in ${r.daysLeft} days.`,
      awaiting_verification: `Uploaded documents are waiting for verification: ${r.issues.unverified.join(', ')}.`,
    }[kind];
    cards.push({
      id: `risk:${r.key}`, key: r.key, complianceId: r.cid, title: short(r.item.brief_description, 110), scope: r.scopeLabel, scopeShort: r.scopeShort,
      stage: r.stageId, level: r.riskLevel, levelLabel: LEVEL_LABEL[r.riskLevel], recordLevel: r.level, classified: r.classified, kind, issues: found, reason,
      dueDate: r.due, daysLeft: r.daysLeft, owner: r.owner || null, department: r.department, evidence: ev,
    });
  }
  const levelRank = { critical: 0, high: 1, medium: 2, low: 3, pending: 4 };
  cards.sort((a, b) => levelRank[a.level] - levelRank[b.level] || (a.daysLeft ?? 9e3) - (b.daysLeft ?? 9e3));

  // ---- stage readiness ----
  const stageList = stages.filter((s) => s.id !== 'UNMAPPED' || rows.some((r) => r.stageId === 'UNMAPPED')).sort((a, b) => a.order - b.order);
  const stageRows = {};
  for (const s of stageList) stageRows[s.id] = rows.filter((r) => r.stageId === s.id);
  const naByStage = {}; for (const e of excluded) { const it = input.itemById[e.cid]; const sid = stageOverrides[e.cid] || (it && it.stage_id); naByStage[sid] = (naByStage[sid] || 0) + (e.reason === 'Not applicable' ? 1 : 0); }
  const stageOut = [];
  const done = {};
  for (const s of stageList) {
    const rs = stageRows[s.id];
    const mandatory = rs.filter((r) => r.level !== 'low');
    const mDone = mandatory.filter((r) => r.completed).length;
    const overdue = mandatory.filter((r) => r.status === 'Overdue' && !r.completed).length;
    const blocked = mandatory.filter((r) => r.blockedMatters).length;
    // a document is only "missing" in a way that matters once work has started or a deadline is near
    const docsMatter = (r) => !r.completed && r.issues.missing.length && (r.rawStatus !== 'Not Started' || r.status === 'Overdue' || (r.daysLeft != null && r.daysLeft <= S.due_soon_days));
    const docMissing = mandatory.filter(docsMatter).length;
    const docOther = mandatory.filter((r) => r.issues.expired.length || r.issues.rejected.length).length;
    const started = rs.some((r) => r.rawStatus !== 'Not Started');
    const complete = mandatory.length > 0 && mDone === mandatory.length;
    const noMandatory = mandatory.length === 0;
    done[s.id] = complete || noMandatory || s.id === 'S0';
    stageOut.push({ id: s.id, name: s.name, order: s.order, prerequisites: s.prerequisites || [],
      applicable: rs.length, mandatory: mandatory.length, optional: rs.length - mandatory.length, completed: mDone, pending: mandatory.length - mDone - overdue, overdue, blocked,
      notApplicable: naByStage[s.id] || 0, docsMissing: docMissing, docsOther: docOther,
      readinessPct: mandatory.length ? Math.round((mDone / mandatory.length) * 100) : null, started, _complete: complete, _none: noMandatory });
  }
  for (const st of stageOut) {
    const prereqDone = st.prerequisites.every((p) => done[p] !== false);
    st.prerequisitesDone = prereqDone;
    if (st._none) st.status = 'Not Applicable';
    else if (st._complete) st.status = 'Completed';
    else if (st.blocked > 0) st.status = 'Blocked';
    else if (st.started) st.status = 'In Progress';
    else if (!prereqDone) st.status = 'Not Started';
    else st.status = (st.overdue || st.docsMissing || st.docsOther) ? 'Ready with Attention' : 'Ready';
    const sev = (r) => (r.blockedMatters ? 0 : r.status === 'Overdue' ? 1 : r.issues.rejected.length || r.issues.expired.length ? 2 : 3);
    st.blockers = stageRows[st.id].filter((r) => !r.completed && r.level !== 'low' && (r.blockedMatters || r.status === 'Overdue' || r.issues.rejected.length || r.issues.expired.length ||
        (r.issues.missing.length && (r.rawStatus !== 'Not Started' || (r.daysLeft != null && r.daysLeft <= S.due_soon_days))))).sort((a, b) => sev(a) - sev(b)).slice(0, 12)
      .map((r) => ({ key: r.key, complianceId: r.cid, title: short(r.item.brief_description, 80), owner: r.owner || null, why: r.blocked ? `waiting for ${r.blockedBy.map((b) => b.id).join(', ')}` : r.status === 'Overdue' ? 'overdue' : r.issues.rejected.length ? 'document rejected' : r.issues.expired.length ? 'document expired' : 'documents not uploaded' }));
    delete st._complete; delete st._none;
  }
  const progression = stageOut.filter((s) => s.order >= 1 && s.id !== 'S8' && s.id !== 'UNMAPPED' && s.status !== 'Not Applicable');
  const current = progression.find((s) => s.status !== 'Completed') || null;
  const next = current ? progression.find((s) => s.order > current.order && s.status !== 'Completed') || null : null;

  // ---- documents ----
  const docHealth = { required: 0, uploaded: 0, verified: 0, missing: 0, pending: 0, rejected: 0, expired: 0, expiring: 0, issues: [] };
  for (const r of rows) {
    for (const name of r.requiredDocs) {
      docHealth.required++;
      const d = r.docs.find((x) => String(x.doc_name).toLowerCase() === name.toLowerCase());
      const base1 = { key: r.key, complianceId: r.cid, scope: r.scopeShort || r.scopeLabel, document: name };
      if (!d) { docHealth.missing++; if (!r.completed) docHealth.issues.push({ ...base1, issue: 'Not uploaded', docId: null }); continue; }
      docHealth.uploaded++;
      const exp = d.expiry_date && d.expiry_date < today;
      if (d.status === 'Rejected') { docHealth.rejected++; docHealth.issues.push({ ...base1, issue: 'Rejected', docId: d.id, note: d.verification_note || '' }); }
      else if (exp) { docHealth.expired++; docHealth.issues.push({ ...base1, issue: 'Expired', docId: d.id, date: d.expiry_date }); }
      else if (d.status === 'Verified') docHealth.verified++;
      else { docHealth.pending++; docHealth.issues.push({ ...base1, issue: 'Awaiting verification', docId: d.id }); }
      if (!exp && d.expiry_date && dayDiff(d.expiry_date, today) <= 30) { docHealth.expiring++; docHealth.issues.push({ ...base1, issue: 'Expiring soon', docId: d.id, date: d.expiry_date }); }
    }
  }

  // ---- deadlines and totals ----
  const open = rows.filter((r) => !r.completed);
  const buckets = { overdue: open.filter((r) => r.status === 'Overdue').length };
  for (const n of [1, 3, 7, 15, 30]) buckets['d' + n] = open.filter((r) => r.daysLeft != null && r.daysLeft >= 0 && r.daysLeft <= n).length;
  const counts = {
    applicable: rows.length, completed: rows.filter((r) => r.completed).length, pending: open.filter((r) => r.status !== 'Overdue').length, overdue: buckets.overdue,
    blocked: open.filter((r) => r.blocked).length, notApplicable: excluded.filter((e) => e.reason === 'Not applicable').length, pendingReview: excluded.filter((e) => e.reason !== 'Not applicable').length,
    critical: cards.filter((c) => c.level === 'critical').length, high: cards.filter((c) => c.level === 'high').length, medium: cards.filter((c) => c.level === 'medium').length,
    low: cards.filter((c) => c.level === 'low').length, unclassifiedRisk: cards.filter((c) => c.level === 'pending').length,
  };

  // ---- what we do not know ----
  const limitations = [];
  const unclassified = rows.filter((r) => !r.classified).length;
  if (unclassified) limitations.push(`Risk classification pending validation for ${unclassified} of ${rows.length} applicable records. They are scored at the "${S.unclassified_level}" weight until classified, and they are not counted as critical or high risks.`);
  if (counts.pendingReview) limitations.push(`${counts.pendingReview} record(s) are waiting for an applicability decision and are not in the score.`);
  const noDue = open.filter((r) => !r.due).length;
  if (noDue) limitations.push(`${noDue} open record(s) have no due date, so deadline risk cannot be assessed for them.`);
  const noOwner = open.filter((r) => !r.owner).length;
  if (noOwner) limitations.push(`${noOwner} open record(s) have no named owner.`);
  if (!rows.length) limitations.push('No applicable compliance records are available for this view yet, so no score can be calculated.');
  let scoreNote = null;
  if (score != null && score < 60 && counts.overdue === 0 && !deductions.length) scoreNote = `No deadline has been missed and there are no document or prerequisite problems. The score is low because ${counts.applicable - counts.completed} of ${counts.applicable} applicable obligations have not been completed yet.`;
  limitations.push('Failed statutory inspections are not recorded in this system, so they are not part of the score.');
  limitations.push('This is an operational indicator. It is not a legal finding that the project is or is not compliant.');

  const health = {
    scope: input.scope, today, settingsUsed: { weights: S.weights, factors: S.factors, deductions: S.deductions, deduction_caps: S.deduction_caps, bands: S.bands, unclassified_level: S.unclassified_level },
    score, category: bandOf(score, S.bands), riskPct: riskPct == null ? null : Math.round(riskPct * 10) / 10, base: base == null ? null : Math.round(base * 10) / 10,
    totalRisk, outstandingRisk: Math.round(outstanding * 10) / 10, deductions, deductionTotal: Math.round(dedTotal * 10) / 10,
    counts, buckets, cards, stages: stageOut, currentStage: current, nextStage: next, documents: docHealth,
    included: rows.map((r) => ({ key: r.key, cid: r.cid, title: short(r.item.brief_description, 70), scope: r.scopeShort || r.scopeLabel, level: r.level, classified: r.classified, suggestion: r.suggestion, weight: r.weight, status: r.status, factor: r.factor, outstanding: r.outstanding })),
    excluded, limitations, scoreNote,
    _rows: rows,
  };
  health.dataVersion = crypto.createHash('sha1').update(JSON.stringify([rows.map((r) => [r.key, r.status, r.due, r.level, r.blocked, r.issues.missing.length, r.issues.unverified.length, r.issues.rejected.length, r.issues.expired.length]), excluded.length, S.weights, S.factors])).digest('hex').slice(0, 16);
  return health;
}

/* ============================= recommendations ============================= */
const LEVEL_POINTS = { critical: 40, high: 28, medium: 16, low: 6, pending: 12 };
const STAGE_NAME = (h, id) => (h.stages.find((s) => s.id === id) || {}).name || id;

/** Priority from stated factors, so every priority can be explained. Not every overdue record is P1. */
function prioritise(r, h) {
  const f = []; let pts = LEVEL_POINTS[r.level || 'pending'];
  f.push(`${r.level ? LEVEL_LABEL[r.level] + ' risk' : 'risk classification pending'} (+${pts})`);
  if (r.status === 'Overdue' && r.daysLeft != null) { const a = Math.min(-r.daysLeft, 30) * 0.5; pts += a; f.push(`${-r.daysLeft} days overdue (+${a})`); }
  else if (r.daysLeft != null && r.daysLeft >= 0) { const a = r.daysLeft <= 1 ? 25 : r.daysLeft <= 3 ? 20 : r.daysLeft <= 7 ? 14 : r.daysLeft <= 15 ? 8 : r.daysLeft <= 30 ? 4 : 0; if (a) { pts += a; f.push(`due in ${r.daysLeft} days (+${a})`); } }
  if (r.dependents) { const a = Math.min(r.dependents * 6, 18); pts += a; f.push(`${r.dependents} other record(s) wait on it (+${a})`); }
  const dp = r.issues.expired.length ? 14 : r.issues.rejected.length ? 10 : r.issues.missing.length && r.status === 'Overdue' ? 8 : r.issues.unverified.length ? 5 : 0;
  if (dp) { pts += dp; f.push(`document problem (+${dp})`); }
  if (h.currentStage && h.currentStage.id === r.stageId) { pts += 6; f.push('belongs to the current stage (+6)'); }
  let p = pts >= 70 ? 'P1' : pts >= 50 ? 'P2' : pts >= 28 ? 'P3' : 'P4';
  if (r.level === 'critical' && !r.completed && (r.status === 'Overdue' || (r.daysLeft != null && r.daysLeft <= 3))) { p = 'P1'; f.push('critical obligation overdue or due within 3 days → P1'); }
  return { priority: p, points: Math.round(pts * 10) / 10, why: f.join('; ') };
}

export function buildRecommendations(h, ctx) {
  const out = [];
  const { scope } = h;
  const today = h.today;
  const rows = h._rows;
  const push = (o) => out.push({ scope_type: scope.type, scope_id: scope.id, scope_name: scope.name, project_id: scope.type === 'project' ? scope.id : null, company_id: scope.companyId || null, source: 'rules', ...o });

  for (const r of rows) {
    if (!r.kind) continue;
    const pr = prioritise(r, h);
    const k = r.kind;
    const cat = ['overdue', 'expired_doc', 'rejected_doc'].includes(k) ? 'Immediate Compliance Actions'
      : k === 'blocked' ? 'Dependency Recommendations'
      : k === 'deadline_soon' ? 'Upcoming Deadline Actions' : 'Document Collection';
    const reqDocs = [...r.issues.missing, ...r.issues.rejected, ...r.issues.expired];
    const who = r.owner || null;
    const unassigned = who ? '' : ' No owner is named in the register, so assign one first.';
    let title, action, outcome;
    if (k === 'overdue') {
      title = `Resolve overdue obligation ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''}`;
      action = r.blocked ? `Complete the prerequisite first (${r.blockedBy.map((b) => b.id).join(', ')}), then finish this obligation.` : reqDocs.length ? `Collect and upload: ${reqDocs.join(', ')}; then complete and verify the obligation.` : 'Complete the action described in the register and update the status.';
      outcome = 'The obligation is completed and evidenced, and no longer counts as overdue.';
    } else if (k === 'expired_doc') {
      title = `Renew expired document for ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''}`;
      action = `Obtain a renewed version of: ${r.issues.expired.join(', ')} and upload it as a new version for verification.`;
      outcome = 'A valid, verified document is on record.';
    } else if (k === 'rejected_doc') {
      title = `Replace rejected document for ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''}`;
      action = `Correct and re-upload: ${r.issues.rejected.join(', ')}. Read the rejection note first.`;
      outcome = 'The corrected document passes verification.';
    } else if (k === 'blocked') {
      title = `Unblock ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''}`;
      action = `Complete ${r.blockedBy.map((b) => `${b.id}${b.scopeShort ? ' (' + b.scopeShort + ')' : ''}`).join(', ')} first. It is not marked complete automatically.`;
      outcome = 'The prerequisite is finished and this record can proceed.';
    } else if (k === 'deadline_soon') {
      title = `Prepare ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''} — due in ${r.daysLeft} days`;
      action = reqDocs.length ? `Start preparation and collect: ${reqDocs.join(', ')}.` : 'Start preparation so it is completed before the due date.';
      outcome = 'The obligation is completed on or before its due date.';
    } else if (k === 'missing_docs') {
      title = `Collect missing documents for ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''}`;
      action = `Collect and upload: ${r.issues.missing.join(', ')}.`;
      outcome = 'All required documents are uploaded and ready for verification.';
    } else {
      title = `Verify uploaded document(s) for ${r.cid}${r.scopeShort ? ' (' + r.scopeShort + ')' : ''}`;
      action = `Review and verify or reject: ${r.issues.unverified.join(', ')}. A different person from the uploader must do this.`;
      outcome = 'The document is verified (or rejected with a reason).';
    }
    push({
      dedupe_key: `${scope.id}|rec|${r.key}`, category: k === 'awaiting_verification' ? 'Document Collection' : cat, kind: k,
      title, explanation: `${r.item.brief_description ? short(r.item.brief_description, 160) : r.cid}`, reason: (h.cards.find((c) => c.key === r.key) || {}).reason,
      priority: pr.priority, priority_points: pr.points, priority_reason: pr.why, risk_level: r.riskLevel, risk_classified: r.classified,
      compliance_key: r.key, compliance_id: r.cid, stage: r.stageId, stage_name: STAGE_NAME(h, r.stageId),
      recommended_action: action + unassigned, responsible_department: r.department, suggested_owner: who || (r.approver ? `Approver: ${r.approver}` : 'Unassigned — assign an owner'),
      due_date: r.due, required_documents: reqDocs.length ? reqDocs : r.issues.unverified, expected_outcome: outcome,
      source_refs: [{ type: 'compliance', id: r.cid, key: r.key, status: r.status, due: r.due }],
      evidence: (h.cards.find((c) => c.key === r.key) || {}).evidence || [],
      scope_label: r.scopeLabel,
    });
  }

  // Stage readiness (category E): the current stage when it is not ready to move on
  const cs = h.currentStage;
  if (cs && cs.status !== 'Completed' && (cs.blockers.length || cs.overdue || cs.blocked)) {
    const pts = cs.blocked ? 34 : cs.overdue ? 30 : 20;
    push({
      dedupe_key: `${scope.id}|stage|${cs.id}`, category: 'Stage Readiness', kind: 'stage', title: `${cs.name} is ${cs.status.toLowerCase()}`, explanation: `${cs.completed} of ${cs.mandatory} mandatory records are complete.`,
      reason: `${cs.blocked} blocked, ${cs.overdue} overdue, ${cs.docsMissing} with missing documents among the mandatory records of this stage.`,
      priority: cs.blocked && cs.overdue ? 'P2' : 'P3', priority_points: pts, priority_reason: 'It is the current stage and has blockers; the project cannot move on until they are resolved.',
      risk_level: cs.blocked ? 'high' : 'medium', risk_classified: false, compliance_key: null, compliance_id: null, stage: cs.id, stage_name: cs.name,
      recommended_action: `Clear these first: ${cs.blockers.slice(0, 5).map((b) => `${b.complianceId} (${b.why})`).join('; ')}. A person must confirm before the stage moves on; the system does not advance it.`,
      responsible_department: 'Compliance', suggested_owner: 'Compliance Manager', due_date: null, required_documents: [],
      expected_outcome: `The stage reaches “Completed” and ${h.nextStage ? h.nextStage.name : 'the next stage'} can start.`, source_refs: cs.blockers.slice(0, 8).map((b) => ({ type: 'compliance', id: b.complianceId, key: b.key })), evidence: [],
    });
  }

  // Coordination (F): urgent records nobody owns
  const unowned = rows.filter((r) => !r.completed && !r.owner && r.kind && ['overdue', 'deadline_soon', 'blocked', 'expired_doc'].includes(r.kind));
  // (blocked records only get a kind when work has started or a deadline is near, so a fresh project does not trigger this)
  if (unowned.length) {
    push({
      dedupe_key: `${scope.id}|owners`, category: 'Project Coordination', kind: 'coordination', title: `${unowned.length} urgent record(s) have no named owner`,
      explanation: 'Work that is overdue, due soon or blocked cannot be chased without an owner.', reason: `Records: ${unowned.slice(0, 8).map((r) => r.cid).join(', ')}${unowned.length > 8 ? '…' : ''}.`,
      priority: unowned.some((r) => r.level === 'critical' || r.level === 'high') ? 'P2' : 'P3', priority_points: 30, priority_reason: 'Urgent records without an owner are likely to stay late.',
      risk_level: 'medium', risk_classified: false, compliance_key: null, compliance_id: null, stage: null, stage_name: null,
      recommended_action: 'Name an owner for each (the Owner field is in the register). The system will not reassign anything by itself.', responsible_department: 'Compliance', suggested_owner: 'Compliance Manager',
      due_date: null, required_documents: [], expected_outcome: 'Every urgent record has a named owner.', source_refs: unowned.slice(0, 10).map((r) => ({ type: 'compliance', id: r.cid, key: r.key })), evidence: [],
    });
  }
  // Process improvement (G): the same obligation listed twice in the register for this project
  const groups = {};
  for (const r of rows) if (r.item.duplicate_group && !r.completed) (groups[r.item.duplicate_group] = groups[r.item.duplicate_group] || []).push(r);
  const dupGroups = Object.entries(groups).map(([g, list]) => [g, [...new Set(list.map((r) => r.cid))]]).filter(([, ids]) => ids.length >= 2);
  if (dupGroups.length) {
    push({
      dedupe_key: `${scope.id}|dups`, category: 'Compliance Process Improvement', kind: 'duplicate', title: `${dupGroups.length} obligation(s) appear more than once in the register`,
      explanation: 'The same work and documents may be asked for more than once.', reason: dupGroups.slice(0, 6).map(([g, ids]) => `${g}: ${ids.join(', ')}`).join('; ') + (dupGroups.length > 6 ? '…' : '') + '.',
      priority: 'P4', priority_points: 10, priority_reason: 'Housekeeping; reduces repeated work but is not urgent.', risk_level: 'low', risk_classified: false, compliance_key: null, compliance_id: null, stage: null, stage_name: null,
      recommended_action: 'Ask the compliance head to confirm which are really one obligation. Do not merge or delete records without that confirmation.', responsible_department: 'Compliance', suggested_owner: 'Compliance Manager',
      due_date: null, required_documents: [], expected_outcome: 'One agreed record for each (or a note on why both are needed).', source_refs: dupGroups.flatMap(([, ids]) => ids).slice(0, 20).map((id) => ({ type: 'compliance', id })), evidence: [],
    });
  }
  out.sort((a, b) => a.priority.localeCompare(b.priority) || b.priority_points - a.priority_points);
  return out;
}

/** Compact, personal-data-free facts for the AI. Only what it needs to write the narrative. */
export function aiFacts(h, recs) {
  return {
    project: { id: h.scope.id, name: h.scope.name, type: h.scope.type, location: h.scope.location || null, projectType: h.scope.projectType || null },
    today: h.today, score: h.score, category: h.category, riskPercentage: h.riskPct, deductions: h.deductions.map((d) => ({ kind: d.kind, count: d.count, points: d.points })),
    counts: h.counts, deadlines: h.buckets, currentStage: h.currentStage && { id: h.currentStage.id, name: h.currentStage.name, status: h.currentStage.status }, nextStage: h.nextStage && { id: h.nextStage.id, name: h.nextStage.name, status: h.nextStage.status },
    stages: h.stages.filter((s) => s.status !== 'Not Applicable').map((s) => ({ id: s.id, name: s.name, status: s.status, mandatory: s.mandatory, completed: s.completed, overdue: s.overdue, blocked: s.blocked, docsMissing: s.docsMissing })),
    documents: { required: h.documents.required, uploaded: h.documents.uploaded, verified: h.documents.verified, missing: h.documents.missing, pendingVerification: h.documents.pending, rejected: h.documents.rejected, expired: h.documents.expired, expiringIn30Days: h.documents.expiring },
    risks: h.cards.slice(0, 30).map((c) => ({ complianceId: c.complianceId, level: c.level, issue: c.kind, reason: c.reason, dueDate: c.dueDate, daysLeft: c.daysLeft, stage: c.stage, owner: c.owner, department: c.department, scope: c.scopeShort || null })),
    recommendations: recs.slice(0, 20).map((r) => ({ complianceId: r.compliance_id, priority: r.priority, category: r.category, title: r.title })),
    dataLimitations: h.limitations,
  };
}
