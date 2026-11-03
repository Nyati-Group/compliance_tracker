// Documents that move on by themselves: when a document is saved against one compliance record, every other active record of the same
// project that lists the same document, in the same or a later stage, gets its own copy straight away. A person's own upload is never replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { loadWorld, Core } from './generate.mjs';
import { ctxForScope } from './gate.mjs';
import { notify } from './notify.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
let ORDER = null;
const stageOrder = (id) => {
  if (!ORDER) { try { ORDER = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(appDir, 'stages.json'), 'utf8')).map((s) => [s.id, s.order])); } catch { ORDER = {}; } }
  return typeof ORDER[id] === 'number' ? ORDER[id] : null;
};
/** Is target stage the same as, or after, the source stage? Unknown stages never block a carry. */
export const stageAllows = (srcStage, tgtStage) => { const a = stageOrder(srcStage), b = stageOrder(tgtStage); return a === null || b === null || b >= a; };

function copyFile(bucket, fileId, fileName, key) {
  return new Promise((ok, no) => {
    const up = bucket.openUploadStream(fileName, { metadata: { key, carried: true } });
    up.on('finish', () => ok(String(up.id))).on('error', no);
    bucket.openDownloadStream(new ObjectId(fileId)).on('error', no).pipe(up);
  });
}

/**
 * Copy a saved document to the later records that need it. Returns the keys that received it.
 * `world` may be passed in to avoid reloading it when several documents are carried in one go.
 */
export async function carryForward(db, bucket, src, world = null) {
  if (!src || src.superseded || src.status === 'Rejected' || !src.file_id || !ObjectId.isValid(src.file_id)) return [];
  const w = world || await loadWorld(db);
  const pk = Core.parseKey(src.key), ctx = pk && ctxForScope(w, pk.scopeId);
  if (!ctx || !ctx.projectId) return [];                          // company-wide records are not carried between projects
  const insts = Core.enumerate(w, ctx);
  const from = insts.find((i) => i.key === src.key);
  const docs = db.collection('documents'), out = [];
  for (const t of insts) {
    if (t.key === src.key) continue;
    if (Core.stateOf((w.decisions[t.key] || {}).status || 'Pending Review') !== 'active') continue;
    if (!stageAllows(from && from.item.stage_id, t.item.stage_id)) continue;
    const listed = Core.requiredDocs(t.item).find((n) => n.toLowerCase() === src.doc_name_lc);
    if (!listed) continue;
    const cur = await docs.find({ key: t.key, doc_name_lc: src.doc_name_lc, superseded: { $ne: true } }).sort({ version: -1 }).limit(1).next();
    if (cur && cur.carried_from_key !== src.key) continue;       // somebody uploaded their own: leave it
    if (cur && cur.carried_from === String(src._id)) continue;   // already carried
    const fileId = await copyFile(bucket, src.file_id, src.file_name, t.key);
    const verified = src.status === 'Verified';
    const row = {
      key: t.key, compliance_id: t.item.compliance_id, project_id: t.projectId || src.project_id || null, doc_name: listed, doc_name_lc: src.doc_name_lc, file_name: src.file_name,
      file_id: fileId, size: src.size, version: cur ? (cur.version || 1) + 1 : 1, superseded: false, status: verified ? 'Verified' : 'Pending Verification',
      issue_date: src.issue_date || null, expiry_date: src.expiry_date || null, uploaded_by: src.uploaded_by, uploaded_by_email: src.uploaded_by_email, uploaded_at: new Date().toISOString(),
      carried_from: String(src._id), carried_from_key: src.key, carried_from_id: src.compliance_id,
      ...(verified ? { verified_by: src.verified_by, verified_by_email: src.verified_by_email, verified_at: src.verified_at, verification_note: src.verification_note || '' } : {})
    };
    const r = await docs.insertOne(row);
    if (cur) await docs.updateMany({ key: t.key, doc_name_lc: src.doc_name_lc, _id: { $ne: r.insertedId } }, { $set: { superseded: true } });
    await notify(db, { id: `carried:${r.insertedId}`, type: 'doc_carried', level: 'info', cap: 'upload_docs', key: t.key, compliance_id: t.item.compliance_id, project_id: row.project_id,
      title: `${t.item.compliance_id}: ${listed} added automatically`, message: `${listed} was already on file for ${src.compliance_id}, so it has been added here too.` });
    out.push(t.key);
  }
  return out;
}

/** Keep carried copies in step when the source document is verified or rejected. Returns the keys changed. */
export async function mirrorStatus(db, src) {
  const docs = db.collection('documents');
  const copies = await docs.find({ carried_from: String(src._id), superseded: { $ne: true } }).toArray();
  if (!copies.length) return [];
  await docs.updateMany({ carried_from: String(src._id), superseded: { $ne: true } }, { $set: { status: src.status, verified_by: src.verified_by, verified_by_email: src.verified_by_email, verified_at: src.verified_at, verification_note: src.verification_note || '' } });
  return copies.map((c) => c.key);
}

/** Once at start: carry everything already on file. Safe to repeat: documents already carried are skipped. */
export async function carryAllExisting(db, bucket) {
  const w = await loadWorld(db);
  const rows = await db.collection('documents').find({ superseded: { $ne: true }, carried_from: { $exists: false } }).toArray();
  let n = 0;
  for (const d of rows) { try { n += (await carryForward(db, bucket, d, w)).length; } catch (e) { console.warn('carry-forward skipped:', e.message); } }
  return n;
}
