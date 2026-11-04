import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'shared');
export const Core = createRequire(import.meta.url)(path.join(appDir, 'core.js'));

const mapById = (docs) => Object.fromEntries(docs.map(({ _id, ...rest }) => [String(_id), rest]));

/** Everything the engine needs, read fresh from the master files and MongoDB. */
export async function loadWorld(db) {
  const items = JSON.parse(fs.readFileSync(path.join(appDir, 'items.json'), 'utf8'));
  const cat = JSON.parse(fs.readFileSync(path.join(appDir, 'applicability.json'), 'utf8'));
  const profiles = JSON.parse(fs.readFileSync(path.join(appDir, 'profiles.json'), 'utf8'));
  const [companies, projects, phases, buildings, decisions] = await Promise.all(
    ['companies', 'projects', 'phases', 'buildings', 'applicability'].map(async (c) => mapById(await db.collection(c).find().toArray())));
  return { items, itemById: Object.fromEntries(items.map((i) => [i.compliance_id, i])), cat, profiles, companies, projects, phases, buildings, decisions };
}

/**
 * Create or refresh applicability decisions. Idempotent:
 *  - new instance            -> insert an automatic decision
 *  - automatic decision      -> update only if the evaluation changed (history appended)
 *  - manual decision (a person's call) -> never overwritten; if the rules now disagree, the suggestion is stored beside it
 * scope: {all:true} | {projectId} | {companyId}
 */
export async function generate(db, scope, who = 'system', world = null) {
  const w = world || await loadWorld(db);
  let insts;
  if (scope.all) insts = Core.enumerateAll(w);
  else if (scope.projectId) {
    const p = w.projects[scope.projectId];
    insts = [...Core.enumerate(w, { projectId: scope.projectId }), ...(p && p.company_id ? Core.enumerate(w, { companyId: p.company_id }) : [])];
  } else {
    // A company-level answer can also decide project records (e.g. contract-labour PF), so refresh the company's projects too.
    insts = Core.enumerate(w, { companyId: scope.companyId });
    for (const [pid, p] of Object.entries(w.projects)) if (p.company_id === scope.companyId) insts.push(...Core.enumerate(w, { projectId: pid }));
  }

  const now = new Date().toISOString();
  const col = db.collection('applicability');
  const ops = [];
  const summary = { instances: insts.length, created: 0, updated: 0, unchanged: 0, manual_disagree: 0, byStatus: {} };
  for (const inst of insts) {
    const ev = Core.evaluate(w.cat, inst.item, Core.entitiesFor(w, inst));
    const cur = w.decisions[inst.key];
    let finalStatus = ev.status;
    if (!cur) {
      summary.created++;
      ops.push({ insertOne: { document: {
        _id: inst.key, compliance_id: inst.item.compliance_id, scope_type: inst.scopeType, scope_id: inst.scopeId,
        company_id: inst.companyId || null, project_id: inst.projectId || null,
        status: ev.status, reason: ev.reason, flags: ev.flags, source: 'auto', decided_by: who, decided_at: now,
        history: [{ at: now, by: who, from: null, to: ev.status, reason: ev.reason, source: 'auto' }]
      } } });
    } else if (cur.source === 'manual') {
      finalStatus = cur.status;
      const differs = ev.status !== cur.status;
      if (differs) summary.manual_disagree++;
      if (differs && (!cur.auto_suggestion || cur.auto_suggestion.status !== ev.status || cur.auto_suggestion.reason !== ev.reason)) {
        ops.push({ updateOne: { filter: { _id: inst.key }, update: { $set: { auto_suggestion: { status: ev.status, reason: ev.reason, at: now } } } } });
      } else if (!differs && cur.auto_suggestion) {
        ops.push({ updateOne: { filter: { _id: inst.key }, update: { $unset: { auto_suggestion: '' } } } });
      } else summary.unchanged++;
    } else if (cur.status !== ev.status || cur.reason !== ev.reason) {
      summary.updated++;
      ops.push({ updateOne: { filter: { _id: inst.key }, update: {
        $set: { status: ev.status, reason: ev.reason, flags: ev.flags, decided_by: who, decided_at: now },
        $push: { history: { at: now, by: who, from: cur.status, to: ev.status, reason: ev.reason, source: 'auto' } } } } });
    } else summary.unchanged++;
    summary.byStatus[finalStatus] = (summary.byStatus[finalStatus] || 0) + 1;
  }
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  return summary;
}

/** A person's decision on one instance. status "auto" hands the record back to the rules. */
export async function decide(db, { key, status, reason }, user) {
  const w = await loadWorld(db);
  const parsed = Core.parseKey(key);
  const item = parsed && w.itemById[parsed.compliance_id];
  if (!item) throw Object.assign(new Error('Unknown compliance record.'), { status: 400 });
  const all = Core.enumerateAll(w);
  const inst = all.find((i) => i.key === key);
  if (!inst) throw Object.assign(new Error('That record is not part of any company or project yet.'), { status: 400 });
  const now = new Date().toISOString();
  const cur = w.decisions[key];
  const why = String(reason || '').trim().slice(0, 1000);
  let next;
  if (status === 'auto') {
    const ev = Core.evaluate(w.cat, item, Core.entitiesFor(w, inst));
    next = { status: ev.status, reason: ev.reason, flags: ev.flags, source: 'auto' };
  } else {
    if (!Core.APPLICABILITY.includes(status)) throw Object.assign(new Error('Choose a valid applicability status.'), { status: 400 });
    if ((status === 'Not Applicable' || status === 'Legal Validation Required') && !why) throw Object.assign(new Error(`A reason is required for "${status}".`), { status: 400 });
    next = { status, reason: why || 'Set manually.', source: 'manual', flags: cur?.flags || {} };
  }
  const entry = { at: now, by: user.name, from: cur?.status || null, to: next.status, reason: next.reason, source: next.source };
  await db.collection('applicability').updateOne({ _id: key }, {
    $set: { ...next, compliance_id: item.compliance_id, scope_type: inst.scopeType, scope_id: inst.scopeId, company_id: inst.companyId || null, project_id: inst.projectId || null, decided_by: user.name, decided_at: now },
    $unset: { auto_suggestion: '' },
    $push: { history: entry }
  }, { upsert: true });
  return { ok: true, status: next.status };
}
