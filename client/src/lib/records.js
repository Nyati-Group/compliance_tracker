/* Compliance instances and the facts the screens derive from them.
   A master record becomes one or more "instances": one per company, project, phase or building it must be tracked against
   (see shared/core.js). Status, documents and audit all hang off the instance key. Every function here takes the store's
   data (`D`) and is free of side effects, so a screen can call it while rendering. */
import { Core } from './core.js';
import { daysUntil, todayISO } from './format.js';

export const categoryOf = (p) => Core.categoryOf(p);
export const theCompanyId = (D) => Object.keys(D.companies)[0] || null;
export const worldData = (D) => ({ items: D.items, itemById: D.itemById, profiles: D.profiles, companies: D.companies, projects: D.projects, phases: D.phases, buildings: D.buildings });
export const effectiveStageId = (D, item) => D.stageOverrides[item.compliance_id] || item.stage_id;

export function blankTracking(item) {
  return { status: 'Not Started', status_date: null, last_updated_by: null, remarks: '', evidence_link: '', next_due_date: item.due_date_parse_value && item.due_date_parse_type === 'fixed_date' ? item.due_date_parse_value : null };
}
export const getTracking = (D, key, item) => D.tracking[key] || blankTracking(item);

export function statusFromTracking(tr) {
  let status = tr.status || 'Not Started';
  if (status !== 'Compliant / Completed' && status !== 'Not Applicable' && status !== 'On Hold' && tr.next_due_date) {
    const d = daysUntil(tr.next_due_date);
    if (d !== null && d < 0) status = 'Overdue';
  }
  return status;
}

export function decorateInst(D, inst) {
  const dec = D.applic[inst.key] || null;
  const appStatus = dec ? dec.status : 'Pending Review';
  const state = Core.stateOf(appStatus);   // 'active' | 'review' | 'na'
  const tr = getTracking(D, inst.key, inst.item);
  return { ...inst, decision: dec, appStatus, state, tr, status: state === 'na' ? 'Not Applicable' : statusFromTracking(tr) };
}

/** Document health of one record: its current versions that are waiting, rejected or expired. */
export function docFlags(D, key) {
  const out = { pending: 0, rejected: 0, expired: 0, expiring: 0 };
  const today = todayISO();
  for (const d of Core.currentDocs(D.docsByKey[key] || []).values()) {
    if (d.status === 'Rejected') out.rejected++;
    else if (d.expiry_date && d.expiry_date < today) out.expired++;
    else if (d.status !== 'Verified') out.pending++;
    if (d.expiry_date && d.expiry_date >= today && Core.daysBetween(today, d.expiry_date) <= 30) out.expiring++;
  }
  return out;
}

/** Every instance for the company or project being viewed, with prerequisites and document flags worked out. */
export function buildInstances(D, ctx) {
  if (!D.cat || !(ctx.projectId || ctx.companyId)) return { inst: [], instByKey: {} };
  const inst = Core.enumerate(worldData(D), ctx).map((i) => decorateInst(D, i));
  const b = Core.computeBlocks(inst, D.deps, { state: (i) => i.state, status: (i) => i.status });
  for (const i of inst) {
    i.blockedBy = b.blockedBy[i.key] || [];
    i.blocked = i.blockedBy.length > 0 && i.status !== 'Compliant / Completed' && i.state === 'active';
    i.ready = b.readyToStart.has(i.key) && i.status === 'Not Started';
    i.docs = docFlags(D, i.key);
  }
  return { inst, instByKey: Object.fromEntries(inst.map((i) => [i.key, i])) };
}

export function ctxName(D, ctx) {
  if (ctx.projectId) return (D.projects[ctx.projectId] || {}).name || ctx.projectId;
  if (ctx.companyId) return 'Company-wide · ' + ((D.companies[ctx.companyId] || {}).name || ctx.companyId);
  return 'Nothing selected';
}

/** Keep the selected company/project valid as data loads or changes. */
export function validCtx(D, ctx) {
  const p = ctx.projectId && D.projects[ctx.projectId], c = ctx.companyId && D.companies[ctx.companyId];
  if (!p && !c) { const cid = theCompanyId(D); return ctx.companyId === cid && !ctx.projectId ? ctx : { companyId: cid, projectId: null }; }
  if (ctx.projectId && !p) return { companyId: ctx.companyId, projectId: null };
  return ctx;
}
/** "p:<id>" picks a project, "c:<id>" the company-wide view. */
export function ctxFromValue(D, value) {
  const kind = value.slice(0, 1), id = value.slice(2);
  if (kind === 'p' && D.projects[id]) return { companyId: D.projects[id].company_id || null, projectId: id };
  if (kind === 'c' && D.companies[id]) return { companyId: id, projectId: null };
  return null;
}
export const ctxValue = (ctx) => (ctx.projectId ? 'p:' + ctx.projectId : ctx.companyId ? 'c:' + ctx.companyId : '');

/** Projects of one category, sorted by name. */
export const projectsIn = (D, cat) => Object.keys(D.projects).filter((id) => categoryOf(D.projects[id]) === cat).sort((a, b) => (D.projects[a].name || '').localeCompare(D.projects[b].name || ''));

/* ---------- set-up questions ---------- */
/** Questions still unanswered for a project (its own, its buildings', and the company's that it needs). */
export function unansweredFor(D, projectId) {
  const p = D.projects[projectId]; if (!p) return { proj: [], blds: [], comp: [] };
  const co = D.companies[p.company_id], W = worldData(D), ctx = { projectId };
  const proj = Core.missingFacts(W, D.cat, 'project', p, { company: co, project: p }, ctx);
  const blds = Object.entries(D.buildings).filter(([, b]) => b.project_id === projectId)
    .flatMap(([id, b]) => Core.missingFacts(W, D.cat, 'building', b, { company: co, project: p, building: b }, ctx).map((k) => ({ k, building: id })));
  const comp = co ? Core.missingFacts(W, D.cat, 'company', co, { company: co }, ctx) : [];
  return { proj, blds, comp };
}
export function unansweredCompany(D) {
  const id = theCompanyId(D), co = D.companies[id];
  return co ? Core.missingFacts(worldData(D), D.cat, 'company', co, { company: co }, { companyId: id }) : [];
}

/** Applicability tallies per project in one pass over the stored decisions. */
export function tallies(D) {
  const t = {};
  for (const d of Object.values(D.applic)) {
    const k = d.scope_type === 'company' && !d.project_id ? '_company' : d.project_id; if (!k) continue;
    const c = t[k] = t[k] || { active: 0, review: 0, na: 0 }; c[Core.stateOf(d.status)]++;
  }
  return t;
}
export const tallyText = (c) => `${c.active} applicable · ${c.review} to review · ${c.na} not applicable`;
export function summaryText(s) {
  const b = s.byStatus || {};
  return `${b['Applicable'] || 0} applicable · ${b['Pending Review'] || 0} need review · ${b['Not Applicable'] || 0} not applicable`;
}

/* ---------- stages ---------- */
export function stageStats(insts) {
  const c = { total: insts.length, na: 0, review: 0, done: 0, overdue: 0, pending: 0, started: 0, blocked: 0 };
  for (const i of insts) {
    const st = i.status;
    if (i.blocked) c.blocked++;
    if (st === 'Not Applicable') c.na++;
    else if (i.state === 'review') c.review++;
    else if (st === 'Compliant / Completed') c.done++;
    else if (st === 'Overdue') c.overdue++;
    else { c.pending++; if (st !== 'Not Started') c.started++; }
  }
  c.applicable = c.done + c.overdue + c.pending;     // confirmed applicable
  c.pct = c.applicable ? Math.round(c.done / c.applicable * 100) : 0;
  return c;
}
export function stageStatusLabel(c) {
  if (!c.applicable) return c.review ? { txt: 'Needs review', cls: 'hold' } : { txt: 'Nothing applicable', cls: '' };
  if (c.done === c.applicable) return { txt: 'Complete', cls: 'ok' };
  if (c.overdue) return { txt: 'Overdue items', cls: 'bad' };
  if (c.done || c.started) return { txt: 'In progress', cls: 'warn' };
  return { txt: 'Not started', cls: '' };
}

/* Stage 0: the set-up steps for the selected company or project (they decide what applies). */
export function setupSteps(D, ctx, inst) {
  const review = inst.filter((i) => i.state === 'review').length;
  if (ctx.projectId) {
    const id = ctx.projectId, p = D.projects[id];
    if (!p) return { kind: 'project', id, steps: [] };
    const epc = categoryOf(p) === 'epc', un = unansweredFor(D, id);
    const blds = Object.values(D.buildings).filter((b) => b.project_id === id);
    const phs = Object.values(D.phases).filter((x) => x.project_id === id);
    return { kind: 'project', id, steps: epc ? [
      ['Site entered', !!p.location],
      ['Project questions answered', un.proj.length === 0],
      ['Company answers it depends on', un.comp.length === 0],
      ['No applicability left to review', review === 0]
    ] : [
      ['Basics entered (location or authority, and type)', !!(p.location || p.planning_authority) && !!p.project_type],
      ['Site or built-up area entered', !!(p.site_area_ha || p.built_up_area_sqm)],
      ['Project questions answered', un.proj.length === 0],
      ['At least one phase', phs.length > 0],
      ['Buildings added and their questions answered', blds.length > 0 && un.blds.length === 0],
      ['Company answers it depends on', un.comp.length === 0],
      ['No applicability left to review', review === 0]
    ] };
  }
  const id = ctx.companyId, co = D.companies[id];
  if (!co) return { kind: 'company', id, steps: [] };
  return { kind: 'company', id, steps: [
    ['Employee count entered', co.employee_count != null && co.employee_count !== ''],
    ['Company questions answered', unansweredCompany(D).length === 0],
    ['No applicability left to review', review === 0]
  ] };
}

/* ---------- finding a record from anywhere ---------- */
/** Find the instance for an instance key; works whichever view is selected. */
export function instFromKey(D, key) {
  const pk = Core.parseKey(key); if (!pk) return null;
  const sid = pk.scopeId;
  let ctx = null;
  if (D.companies[sid]) ctx = { companyId: sid };
  else if (D.projects[sid]) ctx = { projectId: sid };
  else if (D.phases[sid]) ctx = { projectId: D.phases[sid].project_id };
  else if (D.buildings[sid]) ctx = { projectId: D.buildings[sid].project_id };
  if (!ctx) return null;
  const { instByKey } = buildInstances(D, ctx);
  return instByKey[key] || null;
}
/** An instance key, or a plain compliance ID (shown read-only when it is not part of the current view). */
export function resolveInst(D, inst, instByKey, ref) {
  if (instByKey[ref]) return instByKey[ref];
  if (Core.parseKey(ref)) { const f = instFromKey(D, ref); if (f) return f; }
  const item = D.itemById[ref];
  if (!item) return null;
  const match = inst.find((i) => i.item.compliance_id === ref);
  if (match) return match;
  const pseudo = decorateInst(D, { key: null, item, scopeType: Core.scopeTypeFor(item), scopeId: null, scopeLabel: 'Not part of this view', readOnly: true });
  return { ...pseudo, blockedBy: [], blocked: false, ready: false, docs: null };
}

export function deadlineSummary(it, fmtDate) {
  const d = it.deadline_rule || {};
  if (d.type === 'fixed') return { main: d.date ? fmtDate(d.date) : (d.text || 'Fixed date'), note: 'Fixed date from the master' };
  if (d.type === 'rule') return { main: d.text || 'Rule-based', note: 'Rule from the master' };
  if (d.type === 'continuous') return { main: 'Continuous obligation', note: 'No single due date; applies throughout' + (d.text ? ' · source text: ' + d.text : '') };
  const kind = { recurring: 'Recurs ' + (d.period || ''), event: 'Triggered by an event', one_time: 'One-time obligation', unknown: 'Timing not specified in the master' }[d.type] || '';
  return { main: 'Deadline Pending Validation', note: kind + (d.text ? ' · source text: ' + d.text : '') };
}

/* ---------- the reminder and health-score settings, with defaults filled in ---------- */
export const withDefaults = (base, saved) => ({ ...base, ...(saved || {}) });
