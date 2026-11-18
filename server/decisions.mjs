// Applicability decisions, kept in this server process and re-read from MongoDB only when they have changed.
//
// There is a decision per compliance record per company/project/phase/building (thousands of rows), and the dashboard,
// reminders, document checks and the browser all need them. Reading them all from Atlas on every request was slow
// enough to time out, so:
//   - every write to the collection bumps a small version stamp (meta/applicability_version); readers compare it (plus
//     the row count, which also catches inserts or deletes made elsewhere) with the copy they hold;
//   - the copy holds only what is needed everywhere: status, source and the history count for every row, plus who decided
//     and any rule suggestion for the few manual decisions. Which record and company/project a row belongs to is worked
//     out from its key. The reason text, flags and history are read for one record (or one generate run) when needed.
import { ObjectId } from 'mongodb';

const MAX_AGE_MS = 10 * 60 * 1000;   // re-read at least this often, in case something changed the rows without the stamp
const caches = new WeakMap();        // db -> { version, map, at, loading, loadingVersion }

async function currentVersion(db) {
  const [m, n] = await Promise.all([
    db.collection('meta').findOne({ _id: 'applicability_version' }),
    db.collection('applicability').estimatedDocumentCount()
  ]);
  return `${m?.v || '0'}.${n}`;
}

/** Call after any write to the applicability collection. */
export async function decisionsChanged(db) {
  await db.collection('meta').updateOne({ _id: 'applicability_version' },
    { $set: { v: new ObjectId().toHexString(), at: new Date().toISOString() } }, { upsert: true });
}

const byId = (docs) => Object.fromEntries(docs.map((d) => [String(d._id), d]));

async function load(db) {
  const A = db.collection('applicability');
  const [rows, manual, companies, projects, phases, buildings] = await Promise.all([
    A.find({}, { projection: { status: 1, source: 1, history_count: { $size: { $ifNull: ['$history', []] } } } }).toArray(),
    A.find({ source: 'manual' }, { projection: { decided_by: 1, decided_at: 1, auto_suggestion: 1 } }).toArray(),
    ...['companies', 'projects', 'phases', 'buildings'].map((c) => db.collection(c).find({}, { projection: { company_id: 1, project_id: 1 } }).toArray())
  ]).then(([r, m, ...s]) => [r, byId(m), ...s.map(byId)]);
  const map = {};
  for (const { _id, ...d } of rows) {
    const key = String(_id), i = key.lastIndexOf('__'), sid = i < 0 ? null : key.slice(i + 2);
    const pid = projects[sid] ? sid : (phases[sid] || buildings[sid] || {}).project_id || null;
    map[key] = {
      compliance_id: i < 0 ? key : key.slice(0, i),
      scope_type: companies[sid] ? 'company' : projects[sid] ? 'project' : phases[sid] ? 'phase' : buildings[sid] ? 'building' : null,
      scope_id: sid,
      company_id: companies[sid] ? sid : (projects[pid] || {}).company_id || null,
      project_id: pid,
      ...d,
      ...(manual[key] ? { decided_by: manual[key].decided_by, decided_at: manual[key].decided_at, auto_suggestion: manual[key].auto_suggestion } : {})
    };
  }
  return map;
}

/** { version, map: { key -> { compliance_id, scope_type, scope_id, company_id, project_id, status, source, history_count, ... } } }.
 *  Do not modify the map. */
export async function readDecisions(db) {
  let c = caches.get(db);
  if (!c) caches.set(db, (c = {}));
  const version = await currentVersion(db);
  if (c.map && c.version === version && Date.now() - c.at < MAX_AGE_MS) return c;
  if (c.loading && c.loadingVersion === version) return c.loading;   // one read at a time, shared by everyone waiting
  c.loadingVersion = version;
  c.loading = load(db).then((map) => {
    // The version was read before the rows: a write during the read changes the stamp, so the next caller reads again.
    Object.assign(c, { version, map, at: Date.now() });
    return c;
  }).finally(() => { if (c.loadingVersion === version) c.loading = null; });
  return c.loading;
}

/** The stored reason (and flags) of some decisions, for code that compares or reuses them. */
export async function readReasons(db, keys) {
  const out = {};
  for (let i = 0; i < keys.length; i += 2000) {
    const docs = await db.collection('applicability').find({ _id: { $in: keys.slice(i, i + 2000) } }, { projection: { reason: 1, flags: 1 } }).toArray();
    for (const d of docs) out[String(d._id)] = d;
  }
  return out;
}
