import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld, Core } from './generate.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared');
export const loadDeps = () => JSON.parse(fs.readFileSync(path.join(appDir, 'dependencies.json'), 'utf8'));
const today = () => new Date().toISOString().slice(0, 10);

/** Which company/project view a tracking key belongs to (its last segment is the scope id). */
export function ctxForScope(w, scopeId) {
  if (w.companies[scopeId]) return { companyId: scopeId };
  if (w.projects[scopeId]) return { projectId: scopeId };
  if (w.phases[scopeId]) return { projectId: w.phases[scopeId].project_id };
  if (w.buildings[scopeId]) return { projectId: w.buildings[scopeId].project_id };
  return null;
}

async function viewState(db, w, ctx) {
  const insts = Core.enumerate(w, ctx);
  const keys = insts.map((i) => i.key);
  const tracking = Object.fromEntries((await db.collection('tracking').find({ _id: { $in: keys } }).toArray()).map((t) => [String(t._id), t]));
  const t0 = today();
  const cb = {
    state: (i) => Core.stateOf((w.decisions[i.key] || {}).status || 'Pending Review'),
    status: (i) => Core.effectiveStatus(tracking[i.key], t0),
  };
  return { insts, tracking, cb, blocks: Core.computeBlocks(insts, loadDeps(), cb) };
}

/**
 * May this record be marked completed? Every document it lists needs a verified, unexpired current version,
 * and none of its prerequisites may still be open. Returns {ok, issues, blockers}.
 */
export async function completionGate(db, key, world = null) {
  const w = world || await loadWorld(db);
  const pk = Core.parseKey(key);
  const item = pk && w.itemById[pk.compliance_id];
  const ctx = pk && ctxForScope(w, pk.scopeId);
  if (!item || !ctx) return { ok: false, unknown: true, issues: { missing: [], rejected: [], unverified: [], expired: [] }, blockers: [] };
  const v = await viewState(db, w, ctx);
  const docs = await db.collection('documents').find({ key }).toArray();
  const issues = Core.docIssues(item, docs, today());
  const blockers = v.blocks.blockedBy[key] || [];
  return { ok: issues.ok && !blockers.length, issues, blockers };
}

export function gateMessage(g) {
  const parts = [];
  const i = g.issues || {};
  if (i.missing && i.missing.length) parts.push(`documents not uploaded: ${i.missing.join(', ')}`);
  if (i.rejected && i.rejected.length) parts.push(`documents rejected: ${i.rejected.join(', ')}`);
  if (i.unverified && i.unverified.length) parts.push(`documents waiting for verification: ${i.unverified.join(', ')}`);
  if (i.expired && i.expired.length) parts.push(`documents expired: ${i.expired.join(', ')}`);
  if (g.blockers && g.blockers.length) parts.push(`prerequisites still open: ${g.blockers.map((b) => b.id + (b.scopeShort ? ' (' + b.scopeShort + ')' : '')).join(', ')}`);
  return parts.length ? `Cannot be marked completed yet — ${parts.join('; ')}.` : 'Cannot be marked completed.';
}

/** After a record is completed: which dependents are now free to start? */
export async function newlyReady(db, key) {
  const w = await loadWorld(db);
  const pk = Core.parseKey(key);
  const ctx = pk && ctxForScope(w, pk.scopeId);
  if (!ctx) return [];
  const v = await viewState(db, w, ctx);
  const out = [];
  for (const dk of v.blocks.unblocks[key] || []) {
    if (v.blocks.blockedBy[dk]) continue;                     // still waiting on something else
    const d = v.insts.find((i) => i.key === dk);
    const st = d && v.cb.status(d);
    if (d && st !== 'Compliant / Completed') out.push({ key: dk, id: d.item.compliance_id, text: d.item.brief_description, scopeLabel: d.scopeLabel, projectId: d.projectId || null });
  }
  return out;
}
