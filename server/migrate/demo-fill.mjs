// Fill the empty parts of an existing database with demo activity, so the screens have something to show: statuses on the
// register/calendar, documents in the Document Vault (verified, pending, rejected, expiring, expired), their audit trail,
// notifications and a saved document in Document Studio. It uses the database's own company and projects and creates none.
//   node migrate/demo-fill.mjs              dry run: says what it would add
//   node migrate/demo-fill.mjs --apply      adds the demo data
//   node migrate/demo-fill.mjs --remove     deletes everything this script added (and only that)
// Another database:  MONGODB_DB=vyas node migrate/demo-fill.mjs --apply
// Every record it writes carries demo: true (notification ids start with "demo:"), and it never changes an existing record:
// statuses are only added where a record has none, documents only where a record has no documents.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoClient, GridFSBucket } from 'mongodb';
import { loadWorld, Core } from '../generate.mjs';
import { notify } from '../notify.mjs';
import { runAll } from '../intel.mjs';
import { BUILTIN_TEMPLATES, renderTemplateText, cleanValues } from '../docstudio.mjs';
import { buildDocx } from '../docx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const DB_NAME = process.env.MONGODB_DB || 'compliance_tracker';
const MODE = process.argv.includes('--remove') ? 'remove' : process.argv.includes('--apply') ? 'apply' : 'dry';
const PROJECT_LIMIT = 9;          // how many projects get demo activity
const DOCS_PER_SCOPE = 45;        // keeps the amount small: the database sends data slowly

/* ----------------------------- helpers (as in demo-data.mjs) ----------------------------- */
let seed = 20261118;
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const at = (offset, hour = 11) => { const d = new Date(Date.now() + offset * 86400000); d.setUTCHours(hour, Math.floor(rand() * 60), 0, 0); return d.toISOString(); };
function demoPdf(title, lines) {
  const esc = (s) => String(s).replace(/[()\\]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '-');
  const content = ['BT /F1 16 Tf 60 780 Td (' + esc(title) + ') Tj ET', ...lines.map((l, i) => `BT /F1 11 Tf 60 ${750 - i * 18} Td (${esc(l)}) Tj ET`)].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
const store = (bucket, buffer, filename, meta) => new Promise((ok, fail) => { const up = bucket.openUploadStream(filename, { metadata: { ...meta, demo: true } }); up.on('finish', () => ok(String(up.id))).on('error', fail); up.end(buffer); });

const PEOPLE = [['Ganesh Patil', 'Site Engineer'], ['Sneha Kulkarni', 'Compliance Executive'], ['Rahul Deshmukh', 'Project Manager'], ['Priya Joshi', 'Liaison Officer']];
const VERIFIERS = ['Compliance Head', 'Legal Team', 'Project Director'];
const REMARKS = { 'In Progress': ['Drawings with the architect', 'Application being prepared', 'Waiting for site survey', 'Documents being collected from the consultant'],
  'Submitted / Under Review': ['Submitted on the portal', 'Queried by the authority, reply sent', 'Inspection scheduled'], 'On Hold': ['Paused until the land title query is closed'] };

/* ----------------------------- run ----------------------------- */
const client = new MongoClient(process.env.MONGODB_URI, { compressors: ['zlib'], maxPoolSize: 3 });
await client.connect();
const db = client.db(DB_NAME);
const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
try {
  if (MODE === 'remove') {
    const files = await db.collection('uploads.files').find({ 'metadata.demo': true }, { projection: { _id: 1 } }).toArray();
    for (const f of files) await bucket.delete(f._id);
    const r = {};
    for (const c of ['tracking', 'documents', 'audit', 'doc_generated']) r[c] = (await db.collection(c).deleteMany({ demo: true })).deletedCount;
    r.notifications = (await db.collection('notifications').deleteMany({ $or: [{ demo: true }, { _id: /^demo:/ }] })).deletedCount;
    r.files = files.length;
    await runAll(db);   // health scores and recommendations without the demo activity
    console.log(`Removed from "${DB_NAME}": ${JSON.stringify(r)}`);
    process.exit(0);
  }

  const w = await loadWorld(db);
  const stageOrder = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'shared', 'stages.json'), 'utf8')).map((s) => [s.id, s.order]));
  const hasTracking = new Set((await db.collection('tracking').find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
  const hasDocs = new Set(await db.collection('documents').distinct('key'));
  const demoAlready = await db.collection('documents').countDocuments({ demo: true });
  const companyId = Object.keys(w.companies)[0];
  if (!companyId) throw new Error('This database has no company. Use migrate/demo-data.mjs for an empty database.');
  if (demoAlready) { console.log(`"${DB_NAME}" already has ${demoAlready} demo documents. Run with --remove first to start again.`); process.exit(0); }

  // A spread of projects (real estate first, then EPC), each placed at a stage so earlier stages look done.
  const projects = Object.entries(w.projects).sort(([, a], [, b]) => (a.category === 'epc') - (b.category === 'epc'));
  const chosen = [...projects.filter(([, p]) => p.category !== 'epc').slice(0, 6), ...projects.filter(([, p]) => p.category === 'epc').slice(0, 3)].slice(0, PROJECT_LIMIT);
  const reachedOf = [8, 5, 3, 9, 6, 2, 7, 4, 1];
  const scopes = [...chosen.map(([id], i) => ({ ctx: { projectId: id }, reached: reachedOf[i % reachedOf.length], name: w.projects[id].name })), { ctx: { companyId }, reached: 8, name: w.companies[companyId].name }];

  const plan = { tracking: [], documents: [], audit: [], notifications: [] };
  for (const { ctx, reached } of scopes) {
    let docsHere = 0;
    for (const inst of Core.enumerate(w, ctx)) {
      const dec = w.decisions[inst.key];
      if (!dec || Core.stateOf(dec.status) !== 'active' || hasTracking.has(inst.key)) continue;
      const order = stageOrder[inst.item.stage_id] ?? 9, r = rand();
      const docs = hasDocs.has(inst.key) || docsHere >= DOCS_PER_SCOPE ? [] : Core.requiredDocs(inst.item).slice(0, 2);
      const track = (status, extra = {}) => plan.tracking.push({ inst, status, ...extra });
      const doc = (name, o) => { plan.documents.push({ inst, name, ...o }); docsHere++; };
      if (order < reached || (order === reached && r < 0.4)) {
        track('Compliant / Completed', { remarks: 'Completed and filed' });
        docs.forEach((name, i) => {
          const x = rand();
          if (i === 0 && x < 0.1) doc(name, { status: 'Verified', expiry: day(Math.floor(rand() * 25) + 3), daysAgo: 300 });        // expiring soon
          else if (i === 0 && x < 0.16) doc(name, { status: 'Verified', expiry: day(-Math.floor(rand() * 20) - 2), daysAgo: 400 }); // expired
          else doc(name, { status: 'Verified', daysAgo: 60 + Math.floor(rand() * 90) });
        });
      } else if (order === reached) {
        const m = rand();
        if (m < 0.12) track('In Progress', { due: day(-Math.floor(rand() * 20) - 1), remarks: pick(REMARKS['In Progress']) });   // overdue
        else if (m < 0.42) track('In Progress', { due: day(Math.floor(rand() * 25) + 1), remarks: pick(REMARKS['In Progress']) });
        else if (m < 0.64) { track('Submitted / Under Review', { due: day(Math.floor(rand() * 30) + 5), remarks: pick(REMARKS['Submitted / Under Review']) }); docs.forEach((name) => doc(name, { status: 'Pending Verification', daysAgo: 4 })); }
        else if (m < 0.72) { track('In Progress', { due: day(Math.floor(rand() * 14) + 1), remarks: pick(REMARKS['In Progress']) }); if (docs[0]) doc(docs[0], { status: 'Rejected', note: 'Unsigned copy; upload the signed and stamped version.', daysAgo: 9 }); }
        else if (m < 0.75) track('On Hold', { remarks: REMARKS['On Hold'][0] });
        else track('Not Started', { due: day(Math.floor(rand() * 45) + 2) });
      } else if (order === reached + 1 && r < 0.3) track('Not Started', { due: day(Math.floor(rand() * 90) + 20) });
    }
  }
  const count = (arr, f) => arr.reduce((m, x) => (m[f(x)] = (m[f(x)] || 0) + 1, m), {});
  console.log(`Target: database "${DB_NAME}". Projects: ${scopes.map((s) => s.name).join(', ')}.`);
  console.log(`Statuses to add: ${plan.tracking.length} ${JSON.stringify(count(plan.tracking, (t) => t.status))}`);
  console.log(`Documents to add: ${plan.documents.length} ${JSON.stringify(count(plan.documents, (d) => d.expiry ? (d.expiry < day(0) ? 'Expired' : 'Expiring') : d.status))}`);
  if (MODE === 'dry') { console.log('DRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }

  /* statuses and their audit trail */
  const trackingDocs = [], auditDocs = [];
  for (const t of plan.tracking) {
    const [by] = pick(PEOPLE), when = at(-Math.floor(rand() * 40) - 1);
    trackingDocs.push({ _id: t.inst.key, status: t.status, status_date: when.slice(0, 10), remarks: t.remarks || '', evidence_link: '', next_due_date: t.due || null, last_updated_by: by, updated_at: when, demo: true });
    if (t.status !== 'Not Started') auditDocs.push({ key: t.inst.key, compliance_id: t.inst.item.compliance_id, project_id: t.inst.projectId || null, scope_type: t.inst.scopeType, scope_id: t.inst.scopeId, old_status: 'Not Started', new_status: t.status, who: by, remark: t.remarks || '', at: when, demo: true });
  }
  if (trackingDocs.length) await db.collection('tracking').insertMany(trackingDocs, { ordered: false });
  if (auditDocs.length) await db.collection('audit').insertMany(auditDocs, { ordered: false });

  /* documents (a one-page PDF each, marked DEMO) */
  let n = 0;
  for (const d of plan.documents) {
    const [upBy] = pick(PEOPLE), file = `demo-${d.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}.pdf`;
    const buffer = demoPdf(`DEMO - ${d.name}`, [`Sample document for ${d.inst.item.compliance_id} (${d.inst.scopeLabel}).`, 'DEMO DATA - not a real document. It will be removed.']);
    const file_id = await store(bucket, buffer, file, { key: d.inst.key });
    const doc = { key: d.inst.key, compliance_id: d.inst.item.compliance_id, project_id: d.inst.projectId || null, doc_name: d.name, doc_name_lc: d.name.toLowerCase(), file_name: file, file_id, size: buffer.length, version: 1, superseded: false,
      status: d.status, issue_date: day(-d.daysAgo - 5), expiry_date: d.expiry || null, uploaded_by: upBy, uploaded_by_email: 'demo@demo.invalid', uploaded_at: at(-d.daysAgo), demo: true };
    if (d.status !== 'Pending Verification') Object.assign(doc, { verified_by: pick(VERIFIERS), verified_by_email: 'demo@demo.invalid', verified_at: at(-d.daysAgo + 2), verification_note: d.note || '' });
    const r = await db.collection('documents').insertOne(doc);
    if (d.status === 'Pending Verification') await notify(db, { id: `demo:approval:${r.insertedId}`, demo: true, type: 'approval_request', level: 'info', cap: 'verify_docs', key: d.inst.key, compliance_id: d.inst.item.compliance_id, project_id: d.inst.projectId || null,
      title: `${d.inst.item.compliance_id}: document waiting for verification`, message: `${d.name} was uploaded by ${upBy}.` });
    if (d.status === 'Rejected') await notify(db, { id: `demo:rejected:${r.insertedId}`, demo: true, type: 'doc_rejected', level: 'bad', cap: 'upload_docs', key: d.inst.key, compliance_id: d.inst.item.compliance_id, project_id: d.inst.projectId || null,
      title: `${d.inst.item.compliance_id}: document rejected`, message: `${d.name} was rejected: ${d.note}` });
    if (++n % 50 === 0) console.log(`  ${n} / ${plan.documents.length} documents`);
  }

  /* overdue notices for the overdue statuses */
  for (const t of plan.tracking.filter((x) => x.due && x.due < day(0)).slice(0, 15))
    await notify(db, { id: `demo:overdue:${t.inst.key}`, demo: true, type: 'overdue', level: 'bad', key: t.inst.key, compliance_id: t.inst.item.compliance_id, project_id: t.inst.projectId || null,
      title: `${t.inst.item.compliance_id}: overdue`, message: `${t.inst.item.brief_description?.slice(0, 90) || t.inst.item.compliance_id} was due on ${t.due}.` });

  /* a saved document in Document Studio */
  const tpl = BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:authorisation-letter') || BUILTIN_TEMPLATES[0];
  const [pid, p] = chosen[0];
  if (tpl && !(await db.collection('doc_generated').findOne({ _id: 'gen_demo_fill' }))) {
    const { values, missing } = cleanValues(tpl.variables, { date: day(-3), place: 'Pune', authority_name: 'The Executive Engineer, Building Permission Department', company_name: w.companies[companyId].name, project_name: p.name, project_location: p.location || '', rera_no: p.rera_no || '',
      authorised_person: 'Rahul Deshmukh, Project Manager', purpose: 'to submit and collect documents for the occupancy certificate', signatory_name: 'Director', signatory_designation: 'Director' });
    const text = renderTemplateText(tpl.body, tpl.variables, values), buffer = await buildDocx(text), fileId = await store(bucket, buffer, 'demo-authorisation-letter.docx', { generated: 'gen_demo_fill' });
    await db.collection('doc_generated').insertOne({ _id: 'gen_demo_fill', demo: true, title: `DEMO - ${tpl.name} - ${p.name}`, values, status: missing.length ? 'Draft' : 'Complete', missing, version: 1, file_id: fileId, size: buffer.length, text, updated_at: at(-3), updated_by: 'Demo data',
      template: { id: tpl.id, name: tpl.name, format: 'text', variables: tpl.variables, body: tpl.body }, template_id: tpl.id, template_name: tpl.name, project_id: pid, project_name: p.name, company_id: companyId,
      created_by: 'demo@demo.invalid', created_by_name: 'Demo data', created_at: at(-3), versions: [{ version: 1, file_id: fileId, at: at(-3), by: 'Demo data' }] });
  }

  await runAll(db);   // health scores and recommendations with the demo activity
  console.log(`Done. Added ${trackingDocs.length} statuses, ${auditDocs.length} audit entries and ${plan.documents.length} documents to "${DB_NAME}". Remove them with --remove.`);
} finally { await client.close(); }
