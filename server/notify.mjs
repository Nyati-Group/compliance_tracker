import { loadWorld, Core } from './generate.mjs';

export const DEFAULT_SETTINGS = { enabled: true, days: [30, 15, 7, 3, 1, 0], overdue_days: [1, 7, 14, 30] };
const COMPLETE = new Set(['Compliant / Completed', 'Not Applicable', 'On Hold']);

export async function getSettings(db) {
  const s = await db.collection('settings').findOne({ _id: 'reminders' });
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

/** Create a notification once. The id is a dedupe key, so running the same check twice never repeats it. */
export async function notify(db, n) {
  const { id, ...rest } = n;
  const doc = { level: 'info', cap: 'edit_tracking', key: null, compliance_id: null, project_id: null, ...rest, at: new Date().toISOString(), read_by: [] };
  const r = await db.collection('notifications').updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
  return r.upsertedCount > 0;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Deadline reminders and document-expiry notices, driven by the configurable day lists. */
export async function runReminders(db, today = new Date().toISOString().slice(0, 10)) {
  const set = await getSettings(db);
  const made = { due: 0, overdue: 0, doc_expiring: 0, doc_expired: 0 };
  if (!set.enabled) return { skipped: true, made };
  const w = await loadWorld(db);
  const insts = Core.enumerateAll(w);
  const tracking = Object.fromEntries((await db.collection('tracking').find().toArray()).map((t) => [String(t._id), t]));
  const ops = [];
  const push = (type, o) => ops.push({ updateOne: { filter: { _id: o.id }, update: { $setOnInsert: { type, level: o.level, cap: o.cap, title: o.title, message: o.message, key: o.key, compliance_id: o.cid, project_id: o.pid || null, at: new Date().toISOString(), read_by: [] } }, upsert: true } });

  for (const inst of insts) {
    if (Core.stateOf((w.decisions[inst.key] || {}).status || 'Pending Review') !== 'active') continue;
    const tr = tracking[inst.key];
    const due = (tr && tr.next_due_date) || (inst.item.due_date_parse_type === 'fixed_date' ? inst.item.due_date_parse_value : null);
    if (!due) continue;
    if (tr && COMPLETE.has(tr.status)) continue;              // finished, not applicable, or on hold: nothing to remind about
    const d = Core.daysBetween(today, due);
    const where = inst.scopeLabel ? ` — ${inst.scopeLabel}` : '';
    const what = `${inst.item.compliance_id}: ${(inst.item.brief_description || '').slice(0, 90)}${where}`;
    if (d >= 0 && set.days.includes(d)) push('due', { id: `due:${inst.key}:${due}:${d}`, level: d <= 3 ? 'warn' : 'info', cap: 'edit_tracking', key: inst.key, cid: inst.item.compliance_id, pid: inst.projectId, title: d === 0 ? 'Due today' : `Due in ${plural(d, 'day')}`, message: what });
    else if (d < 0 && set.overdue_days.includes(-d)) push('overdue', { id: `overdue:${inst.key}:${due}:${-d}`, level: 'bad', cap: 'edit_tracking', key: inst.key, cid: inst.item.compliance_id, pid: inst.projectId, title: `Overdue by ${plural(-d, 'day')}`, message: what });
  }

  // Documents that are about to expire, or already have.
  const docs = (await db.collection('documents').find({ superseded: { $ne: true }, expiry_date: { $type: 'string' } }).toArray());
  for (const doc of docs) {
    if (!doc.expiry_date) continue;
    const d = Core.daysBetween(today, doc.expiry_date);
    const what = `${doc.compliance_id}: ${doc.doc_name} (${doc.file_name})`;
    const id0 = String(doc._id);
    if (d >= 0 && set.days.includes(d)) push('doc_expiring', { id: `docexp:${id0}:${d}`, level: d <= 7 ? 'warn' : 'info', cap: 'upload_docs', key: doc.key, cid: doc.compliance_id, pid: doc.project_id, title: d === 0 ? 'Document expires today' : `Document expires in ${plural(d, 'day')}`, message: what });
    else if (d < 0 && set.overdue_days.includes(-d)) push('doc_expired', { id: `docexpd:${id0}:${-d}`, level: 'bad', cap: 'upload_docs', key: doc.key, cid: doc.compliance_id, pid: doc.project_id, title: `Document expired ${plural(-d, 'day')} ago`, message: what });
  }

  if (ops.length) {
    const r = await db.collection('notifications').bulkWrite(ops, { ordered: false });
    // count new ones by type from the upserted ids
    for (const id of Object.values(r.upsertedIds || {})) { const t = String(id).split(':')[0]; const k = { due: 'due', overdue: 'overdue', docexp: 'doc_expiring', docexpd: 'doc_expired' }[t]; if (k) made[k]++; }
  }
  return { skipped: false, made, checked: insts.length };
}
