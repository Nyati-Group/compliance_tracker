// Demo data: a company, real estate / redevelopment / EPC projects, one user per role, statuses, documents (verified,
// pending, rejected, expiring, expired), risk levels, notifications, score history, regulatory updates and a saved document.
//   node migrate/demo-data.mjs            dry run: says where it would write
//   node migrate/demo-data.mjs --apply    writes
// Only for an EMPTY database (a demo or local one): it refuses when the target already has projects, tracking or users,
// so it can never mix demo records into real data. Point it at another database with MONGODB_URI / MONGODB_DB, e.g.
//   MONGODB_DB=compliance_demo node migrate/demo-data.mjs --apply
// Every user's password is DEMO_PASSWORD (or a random one, printed at the end).
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MongoClient, GridFSBucket } from 'mongodb';
import { generate, loadWorld, Core } from '../generate.mjs';
import { runAll } from '../intel.mjs';
import { runReminders, notify } from '../notify.mjs';
import { carryAllExisting } from '../docflow.mjs';
import { seedSources, ensureIndexes } from '../regulatory-routes.mjs';
import { ingestDocument, validateAnalysis, loadStages, note } from '../regulatory.mjs';
import { BUILTIN_TEMPLATES, renderTemplateText, cleanValues } from '../docstudio.mjs';
import { buildDocx } from '../docx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const APPLY = process.argv.includes('--apply');
const DB_NAME = process.env.MONGODB_DB || 'compliance_tracker';

/* ----------------------------- the demo world ----------------------------- */
const COMPANY = { _id: 'co_demo', name: 'Nyati Demo Developers', employee_count: 140,
  facts: { owns_vehicles: true, intl_travel: false, workers_500plus: false, child_data: false, processes_spdi: true, discloses_spdi: false, govt_requests_spdi: false, transfers_spdi: false,
    covered_epf: true, covered_esi: true, covered_lwf: true, tax_audit: true, gstr9_threshold: true, msme_vendors: true, audit_committee: false, nrc: false, secretarial_audit: true, csr: true, sbo: false,
    fdi_construction: false, epc_abroad: false, has_exports: false, export_advances: false } };

// `reached` is the stage the project is working on: earlier stages are mostly complete, later ones not started.
const PROJECTS = [
  { _id: 'proj_demo_skyline', name: 'Demo Skyline Residences', category: 'real_estate', location: 'Pune, Maharashtra', planning_authority: 'Pune Municipal Corporation', project_type: 'Residential',
    rera_no: 'P52100099901', site_area_ha: 2.4, built_up_area_sqm: 38500, contract_workers_count: 180, current_stage: 'Finishing', project_manager: 'Rohan Kulkarni', compliance_manager: 'Meera Joshi', reached: 8,
    facts: { uses_cranes: true, extracts_groundwater: false, cd_waste_high: true, near_aerodrome_defence: false, land_acquisition: false, contract_labour: true, redevelopment_project: false },
    phases: [['Phase 1', 'P52100099901'], ['Phase 2', 'P52100099902']], buildings: [['Tower A', 0, true], ['Tower B', 0, true], ['Clubhouse', 1, false]] },
  { _id: 'proj_demo_greens', name: 'Demo Greens Villas', category: 'real_estate', location: 'Pimpri Chinchwad, Maharashtra', planning_authority: 'Pimpri Chinchwad Municipal Corporation', project_type: 'Township / layout',
    rera_no: 'P52100099903', site_area_ha: 6.1, built_up_area_sqm: 16200, contract_workers_count: 60, current_stage: 'Approvals', project_manager: 'Anita Deshmukh', compliance_manager: 'Meera Joshi', reached: 2,
    facts: { uses_cranes: false, extracts_groundwater: true, contract_labour: true, redevelopment_project: false },   // two questions left open, so there is applicability to review
    phases: [['Phase 1', 'P52100099903']], buildings: [['Villa cluster 1', 0, false]] },
  { _id: 'proj_demo_harbour', name: 'Demo Harbour View (redevelopment)', category: 'real_estate', location: 'Mumbai, Maharashtra', planning_authority: 'Municipal Corporation of Greater Mumbai', project_type: 'Redevelopment',
    rera_no: 'P51800099904', site_area_ha: 0.6, built_up_area_sqm: 21000, contract_workers_count: 90, current_stage: 'Plinth', project_manager: 'Vikram Shah', compliance_manager: 'Kiran Patil', reached: 4,
    facts: { uses_cranes: true, extracts_groundwater: false, cd_waste_high: true, near_aerodrome_defence: true, land_acquisition: false, contract_labour: true, redevelopment_project: true, redev_chs: true, redev_mhada: false, redev_sra: false, redev_tenanted: false, redev_cluster: false },
    phases: [['Phase 1', 'P51800099904']], buildings: [['Rehab wing', 0, true], ['Sale tower', 0, true]] },
  { _id: 'proj_demo_hospital', name: 'Demo Medical College – Satara, Maharashtra', category: 'epc', location: 'Satara, Maharashtra', client: 'PWD', contract_workers_count: 240, current_stage: 'Structure', project_manager: 'Sanjay More', compliance_manager: 'Kiran Patil', reached: 9,
    facts: { uses_cranes: true, contract_labour: true } },
  { _id: 'proj_demo_terminal', name: 'Demo Terminal Building – Ratnagiri, Maharashtra', category: 'epc', location: 'Ratnagiri, Maharashtra', client: 'MADC', contract_workers_count: 15, current_stage: 'Mobilisation', project_manager: 'Pooja Rane', compliance_manager: 'Kiran Patil', reached: 1,
    facts: {} }   // a new site: nothing answered yet
];

const USERS = [
  ['admin@demo.test', 'Asha Admin', 'admin', null],
  ['companyadmin@demo.test', 'Chetan Company Admin', 'company_admin', null],
  ['manager@demo.test', 'Meera Joshi', 'head', null],
  ['depthead@demo.test', 'Dinesh Dept Head', 'dept_head', null],
  ['owner@demo.test', 'Omkar Owner', 'owner', null],
  ['approver@demo.test', 'Aparna Approver', 'approver', null],
  ['pm@demo.test', 'Rohan Kulkarni', 'project_manager', ['proj_demo_skyline']],
  ['auditor@demo.test', 'Arun Auditor', 'readonly', null]
];

// Fictional regulatory updates: the text is written for the demo and the links go nowhere.
const REG_UPDATES = [
  { authority: 'MahaRERA (demo)', category: 'RERA', title: 'Demo circular: quarterly progress reports to include geo-tagged site photographs',
    text: 'DEMO DOCUMENT - not a real circular. Circular No. DEMO/RERA/2026/07. All promoters of registered real estate projects in Maharashtra shall upload geo-tagged photographs of each building with every quarterly progress report from 1 January 2027. Quarterly progress reports filed without photographs shall be treated as not filed. Promoters shall also display the QR code of the project registration at the site office.',
    raw: { relevant: true, who_must_comply: ['promoters of registered real estate projects'], document_type: 'Circular', circular_number: 'DEMO/RERA/2026/07', publication_date: '2026-10-20', effective_date: '2027-01-01', category: 'RERA',
      jurisdiction: { scope: 'state', places: ['Maharashtra'] }, what_changed: 'Quarterly progress reports must now carry geo-tagged photographs of each building.', summary: 'Promoters must add geo-tagged building photographs to every quarterly progress report from 1 January 2027; reports without them are treated as not filed.',
      compliance_implications: ['Quarterly progress report process must collect site photographs', 'Site office must display the registration QR code'], affected_activities: ['quarterly progress report', 'site display'], affected_stages: ['S8'], affected_project_categories: ['real_estate'],
      laws_referenced: ['Real Estate (Regulation and Development) Act, 2016'], deadlines: [{ description: 'Photographs required with quarterly progress reports', date: '2027-01-01', evidence: 'with every quarterly progress report from 1 January 2027' }],
      recommended_actions: ['Brief site engineers on photograph requirements', 'Update the QPR checklist'], creates_mandatory_obligation: true, needs_legal_review: false, priority: 'High', priority_reason: 'Binding change for every registered project with a fixed start date.',
      evidence: [{ quote: 'Quarterly progress reports filed without photographs shall be treated as not filed', supports: 'consequence' }], uncertainties: [], confidence: 'high' } },
  { authority: 'Pune Municipal Corporation (demo)', category: 'Building & Planning', title: 'Demo order: revised fire NOC fee schedule for high-rise buildings',
    text: 'DEMO DOCUMENT - not a real order. Order No. DEMO/PMC/FIRE/112. The Pune Municipal Corporation revises the fire NOC scrutiny fee for buildings above 45 metres with effect from 15 November 2026. Applications already submitted before that date are processed at the old rate. Developers in Pune shall pay the revised fee at the time of applying for provisional fire NOC.',
    raw: { relevant: true, who_must_comply: ['developers in Pune'], document_type: 'Order', circular_number: 'DEMO/PMC/FIRE/112', publication_date: '2026-10-28', effective_date: '2026-11-15', category: 'Fire & Life Safety',
      jurisdiction: { scope: 'city', places: ['Pune'] }, what_changed: 'Higher fire NOC scrutiny fee for buildings above 45 m.', summary: 'Pune revises the fire NOC scrutiny fee for buildings above 45 metres from 15 November 2026; earlier applications keep the old rate.',
      compliance_implications: ['Budget for the revised provisional fire NOC fee'], affected_activities: ['provisional fire NOC application'], affected_stages: ['S3'], affected_project_categories: ['real_estate'],
      laws_referenced: ['Maharashtra Fire Prevention and Life Safety Measures Act, 2006'], deadlines: [{ description: 'Revised fee applies', date: '2026-11-15', evidence: 'with effect from 15 November 2026' }],
      recommended_actions: ['Submit pending fire NOC applications before 15 November 2026'], creates_mandatory_obligation: true, needs_legal_review: false, priority: 'Medium', priority_reason: 'Cost change with limited scope.',
      evidence: [{ quote: 'Applications already submitted before that date are processed at the old rate', supports: 'transition' }], uncertainties: ['The new fee amount is in an annexure that is not part of the text.'], confidence: 'medium' } },
  { authority: 'Labour Department (demo)', category: 'Labour & Safety', title: 'Demo notification: monthly safety audit for sites with 100 or more workers',
    text: 'DEMO DOCUMENT - not a real notification. Notification DEMO/LAB/2026/33. Every construction site in Maharashtra engaging 100 or more building workers shall conduct a monthly safety audit by a competent person and keep the report at the site for inspection. The first audit shall be completed by 31 December 2026.',
    raw: { relevant: true, who_must_comply: ['construction sites engaging 100 or more building workers'], document_type: 'Notification', circular_number: 'DEMO/LAB/2026/33', publication_date: '2026-10-30', category: 'Labour & Safety',
      jurisdiction: { scope: 'state', places: ['Maharashtra'] }, what_changed: 'Monthly third-party safety audits at large sites.', summary: 'Sites with 100 or more building workers must run a monthly safety audit by a competent person; the first is due by 31 December 2026.',
      compliance_implications: ['Appoint a competent person for monthly audits', 'Keep audit reports on site'], affected_activities: ['site safety'], affected_stages: ['S5'], affected_project_categories: ['real_estate', 'epc'],
      laws_referenced: ['Building and Other Construction Workers Act, 1996'], deadlines: [{ description: 'First monthly safety audit', date: '2026-12-31', evidence: 'The first audit shall be completed by 31 December 2026' }],
      recommended_actions: ['Shortlist competent persons', 'Add the audit to each large site’s monthly checklist'], creates_mandatory_obligation: true, needs_legal_review: false, priority: 'Critical', priority_reason: 'Binding obligation with a near deadline.',
      evidence: [{ quote: 'conduct a monthly safety audit by a competent person', supports: 'obligation' }], uncertainties: [], confidence: 'high' } },
  { authority: 'Environment Department (demo)', category: 'Environment', title: 'Demo advisory: dust control during the dry season',
    text: 'DEMO DOCUMENT - not a real advisory. Advisory DEMO/ENV/09. Construction sites are advised to sprinkle water on haul roads, cover stored sand and aggregates, and install wind barriers of at least three metres during the dry season. This advisory does not create new obligations.',
    raw: { relevant: true, who_must_comply: ['construction sites'], document_type: 'Advisory', circular_number: 'DEMO/ENV/09', publication_date: '2026-09-12', category: 'Environment',
      jurisdiction: { scope: 'state', places: ['Maharashtra'] }, what_changed: 'Guidance only.', summary: 'Advisory on dust control at construction sites: sprinkling, covering stored material and wind barriers. It creates no new obligations.',
      compliance_implications: [], affected_activities: ['dust control'], affected_stages: ['S5'], affected_project_categories: ['real_estate', 'epc'], laws_referenced: [], deadlines: [],
      recommended_actions: ['Share with site teams'], creates_mandatory_obligation: false, needs_legal_review: false, priority: 'Low', priority_reason: 'Advisory only.',
      evidence: [{ quote: 'This advisory does not create new obligations', supports: 'non-binding' }], uncertainties: [], confidence: 'high' } }
];

/* ----------------------------- helpers ----------------------------- */
let seed = 20261104;
const rand = () => {   // mulberry32: repeatable, so every run gives the same demo
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const at = (offset, hour = 11) => { const d = new Date(Date.now() + offset * 86400000); d.setUTCHours(hour, Math.floor(rand() * 60), 0, 0); return d.toISOString(); };
const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {   // the same format as server.js
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 64)).toString('base64')}`;
}
/** A small but valid one-page PDF that says what it stands for. */
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
const store = (bucket, buffer, filename, meta) => new Promise((ok, fail) => { const up = bucket.openUploadStream(filename, { metadata: meta }); up.on('finish', () => ok(String(up.id))).on('error', fail); up.end(buffer); });

/* ----------------------------- run ----------------------------- */
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(DB_NAME);
try {
  const host = (process.env.MONGODB_URI.match(/@([^/?]+)/) || process.env.MONGODB_URI.match(/\/\/([^/?]+)/) || [])[1] || '?';
  const [projects, tracking, users] = await Promise.all(['projects', 'tracking', 'users'].map((c) => db.collection(c).countDocuments()));
  console.log(`Target: database "${DB_NAME}" on ${host} (${projects} projects, ${tracking} tracking rows, ${users} users).`);
  if (projects || tracking || users) {
    console.error('This database already has data. Demo data is only written to an empty database. Set MONGODB_DB (and MONGODB_URI) to a separate one, e.g. MONGODB_DB=compliance_demo.');
    process.exit(1);
  }
  if (!APPLY) { console.log('DRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }

  const password = process.env.DEMO_PASSWORD || crypto.randomBytes(9).toString('base64url');
  if (password.length < 10) throw new Error('DEMO_PASSWORD must be at least 10 characters.');
  const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
  const now = new Date().toISOString();

  /* company, projects, phases, buildings */
  await db.collection('companies').insertOne({ ...COMPANY, updated_by: 'demo', updated_at: now });
  for (const p of PROJECTS) {
    const { phases = [], buildings = [], reached, ...doc } = p;
    await db.collection('projects').insertOne({ ...doc, company_id: COMPANY._id, notes: '', created_at: at(-200), updated_by: 'demo', updated_at: now });
    const phaseIds = [];
    for (const [i, [name, rera]] of phases.entries()) { const id = `ph_${p._id.slice(5)}_${i + 1}`; phaseIds.push(id); await db.collection('phases').insertOne({ _id: id, project_id: p._id, name, rera_no: rera, created_at: at(-200) }); }
    for (const [i, [name, ph, lift]] of buildings.entries()) await db.collection('buildings').insertOne({ _id: `bld_${p._id.slice(5)}_${i + 1}`, project_id: p._id, phase_id: phaseIds[ph] || null, name, facts: { has_lift: lift }, created_at: at(-190) });
  }
  const summary = await generate(db, { all: true }, 'demo');
  console.log('Applicability:', JSON.stringify(summary.byStatus || summary));

  /* users, one per role */
  const hash = await hashPassword(password);
  for (const [email, name, role, project_ids] of USERS) await db.collection('users').insertOne({ _id: email, name, role, active: true, project_ids, passwordHash: hash, tv: 0, created_at: now });

  /* statuses, documents and audit, by how far each project has got */
  const w = await loadWorld(db);
  const stageOrder = Object.fromEntries(JSON.parse((await import('node:fs')).readFileSync(path.join(here, '..', '..', 'shared', 'stages.json'), 'utf8')).map((s) => [s.id, s.order]));
  const verifiers = ['Meera Joshi', 'Aparna Approver', 'Dinesh Dept Head'], uploaders = [['Omkar Owner', 'owner@demo.test'], ['Rohan Kulkarni', 'pm@demo.test'], ['Meera Joshi', 'manager@demo.test']];
  const counts = { tracking: 0, documents: 0, audit: 0 };
  const putDoc = async (inst, name, { status, version = 1, superseded = false, expiry = null, note: vnote = '', daysAgo = 30 }) => {
    const [upBy, upEmail] = pick(uploaders), file = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}.pdf`;
    const buffer = demoPdf(name, [`Demo document for ${inst.item.compliance_id} (${inst.scopeLabel}).`, 'This is sample data for the compliance tracker demo.', `Version ${version}`]);
    const file_id = await store(bucket, buffer, file, { key: inst.key });
    const issue = day(-daysAgo - 5);
    const doc = { key: inst.key, compliance_id: inst.item.compliance_id, project_id: inst.projectId || null, doc_name: name, doc_name_lc: name.toLowerCase(), file_name: file, file_id, size: buffer.length, version, superseded,
      status, issue_date: issue, expiry_date: expiry, uploaded_by: upBy, uploaded_by_email: upEmail, uploaded_at: at(-daysAgo) };
    if (status !== 'Pending Verification') Object.assign(doc, { verified_by: pick(verifiers), verified_by_email: 'manager@demo.test', verified_at: at(-daysAgo + 2), verification_note: vnote });
    const r = await db.collection('documents').insertOne(doc); counts.documents++;
    if (status === 'Pending Verification' && !superseded) await notify(db, { id: `approval:${r.insertedId}`, type: 'approval_request', level: 'info', cap: 'verify_docs', key: inst.key, compliance_id: inst.item.compliance_id, project_id: inst.projectId || null,
      title: `${inst.item.compliance_id}: document waiting for verification`, message: `${name} (version ${version}) was uploaded by ${upBy}.` });
    if (status === 'Rejected') await notify(db, { id: `rejected:${r.insertedId}`, type: 'doc_rejected', level: 'bad', cap: 'upload_docs', key: inst.key, compliance_id: inst.item.compliance_id, project_id: inst.projectId || null,
      title: `${inst.item.compliance_id}: document rejected`, message: `${name} (version ${version}) was rejected: ${vnote}` });
  };
  const track = async (inst, status, extra = {}) => {
    const old = 'Not Started', by = pick(uploaders)[0], when = at(-Math.floor(rand() * 40) - 1);
    await db.collection('tracking').replaceOne({ _id: inst.key }, { status, status_date: when.slice(0, 10), remarks: extra.remarks || '', evidence_link: '', next_due_date: extra.due || null, last_updated_by: by, updated_at: when }, { upsert: true }); counts.tracking++;
    if (status !== old) { await db.collection('audit').insertOne({ key: inst.key, compliance_id: inst.item.compliance_id, project_id: inst.projectId || null, scope_type: inst.scopeType, scope_id: inst.scopeId, old_status: old, new_status: status, who: by, remark: extra.remarks || '', at: when }); counts.audit++; }
  };
  const REMARKS = { 'In Progress': ['Drawings with the architect', 'Application being prepared', 'Waiting for site survey'], 'Submitted / Under Review': ['Submitted on the portal', 'Queried by the authority, reply sent'], 'On Hold': ['Paused until the land title query is closed'] };

  const scopes = [...PROJECTS.map((p) => ({ ctx: { projectId: p._id }, reached: p.reached })), { ctx: { companyId: COMPANY._id }, reached: 8 }];
  for (const { ctx, reached } of scopes) {
    for (const inst of Core.enumerate(w, ctx)) {
      const dec = w.decisions[inst.key];
      if (!dec || Core.stateOf(dec.status) !== 'active') continue;
      const order = stageOrder[inst.item.stage_id] ?? 9, docs = Core.requiredDocs(inst.item), r = rand();
      if (order < reached || (order === reached && r < 0.5)) {
        // done: every required document verified; now and then one expires soon, has expired, or was replaced by a newer version
        await track(inst, 'Compliant / Completed', { remarks: 'Completed and filed' });
        for (const [i, name] of docs.entries()) {
          const x = rand();
          if (i === 0 && x < 0.08) await putDoc(inst, name, { status: 'Verified', expiry: day(Math.floor(rand() * 25) + 3), daysAgo: 300 });
          else if (i === 0 && x < 0.13) await putDoc(inst, name, { status: 'Verified', expiry: day(-Math.floor(rand() * 20) - 2), daysAgo: 400 });
          else if (i === 0 && x < 0.2) { await putDoc(inst, name, { status: 'Verified', superseded: true, daysAgo: 120 }); await putDoc(inst, name, { status: 'Verified', version: 2, daysAgo: 40 }); }
          else await putDoc(inst, name, { status: 'Verified', daysAgo: 60 + Math.floor(rand() * 90) });
        }
      } else if (order === reached) {
        // the current stage: a mix of overdue, submitted, in progress (sometimes with a rejected upload) and due soon
        const m = rand();
        if (m < 0.1) await track(inst, 'In Progress', { due: day(-Math.floor(rand() * 20) - 1), remarks: pick(REMARKS['In Progress']) });   // past its due date, so it shows as overdue
        else if (m < 0.4) await track(inst, 'In Progress', { due: day(Math.floor(rand() * 25) + 1), remarks: pick(REMARKS['In Progress']) });
        else if (m < 0.62) { await track(inst, 'Submitted / Under Review', { due: day(Math.floor(rand() * 30) + 5), remarks: pick(REMARKS['Submitted / Under Review']) }); for (const name of docs.slice(0, 2)) await putDoc(inst, name, { status: 'Pending Verification', daysAgo: 4 }); }
        else if (m < 0.68) { await track(inst, 'In Progress', { due: day(Math.floor(rand() * 14) + 1), remarks: pick(REMARKS['In Progress']) }); if (docs[0]) await putDoc(inst, docs[0], { status: 'Rejected', note: 'Unsigned copy; upload the signed and stamped version.', daysAgo: 9 }); }
        else if (m < 0.71) await track(inst, 'On Hold', { remarks: REMARKS['On Hold'][0] });
        else await track(inst, 'Not Started', { due: day(Math.floor(rand() * 45) + 2) });
      } else if (order === reached + 1 && r < 0.3) await track(inst, 'Not Started', { due: day(Math.floor(rand() * 90) + 20) });
    }
  }
  console.log(`Tracking rows: ${counts.tracking}, documents: ${counts.documents}, audit entries: ${counts.audit}`);
  console.log(`Documents carried forward to later records: ${await carryAllExisting(db, bucket)}`);

  /* risk levels: the register's suggestions accepted, plus a few set by hand */
  const proposals = JSON.parse((await import('node:fs')).readFileSync(path.join(here, '..', '..', 'shared', 'risk-proposals.json'), 'utf8')).proposals || {};
  const risk = Object.entries(proposals).map(([cid, p]) => ({ _id: cid, level: p.level, source: 'suggested', reason: p.basis, set_by: 'Meera Joshi', at: now }));
  for (const it of w.items.filter((i) => !proposals[i.compliance_id]).slice(0, 40)) risk.push({ _id: it.compliance_id, level: pick(['high', 'medium', 'medium', 'low']), source: 'manual', reason: 'Set during the demo review', set_by: 'Meera Joshi', at: now });
  if (risk.length) await db.collection('risk_overrides').insertMany(risk);

  /* settings */
  await db.collection('settings').insertMany([
    { _id: 'reminders', enabled: true, days: [30, 15, 7, 3, 1, 0], overdue_days: [1, 7, 14, 30], updated_by: 'demo', updated_at: now }
  ]);

  /* health scores, recommendations, reminder notices */
  await runAll(db);
  const rem = await runReminders(db);
  console.log(`Reminder notices: ${JSON.stringify(rem.made || rem)}`);

  /* score history: four weeks of daily snapshots that improve towards today's score */
  const snaps = await db.collection('health_snapshots').find().toArray(), past = [];
  for (const s of snaps) {
    for (let d = 1; d <= 28; d++) {
      const f = d / 28, date = day(-d);
      past.push({ ...s, _id: `${s.scope_id}:${date}`, date, at: at(-d, 2), score: Math.max(0, Math.round(s.score - f * 14 + (rand() - 0.5) * 3)),
        counts: { ...s.counts, completed: Math.max(0, Math.round(s.counts.completed * (1 - f * 0.35))), overdue: Math.round(s.counts.overdue * (1 + f * 0.6)), critical: Math.round((s.counts.critical || 0) * (1 + f * 0.5)) },
        stages: s.stages.map((x) => ({ ...x, status: x.status === 'Completed' && rand() < f * 0.5 ? 'In Progress' : x.status })), data_version: 'demo-history' });
    }
  }
  if (past.length) await db.collection('health_snapshots').insertMany(past);
  console.log(`Score history: ${past.length} snapshots`);

  /* regulatory updates: sources, and four fictional documents analysed with a fixed (not AI) analysis */
  await ensureIndexes(db);
  await seedSources(db);
  const stages = loadStages(path.join(here, '..', '..', 'shared'));
  const deps = { ai: null, stages, items: w.items, store: (buffer, filename, meta) => store(bucket, buffer, filename, meta) };
  const regIds = [];
  for (const [i, u] of REG_UPDATES.entries()) {
    const r = await ingestDocument(db, { ...deps, analyse: async (ai, { text }) => ({ ...validateAnalysis({ title: u.title, authority: u.authority, ...u.raw }, text, { stages }), model: 'demo data (no AI)' }) },
      { source: { _id: null, name: 'Demo source', authority: u.authority, category: u.category, url: null }, url: `https://demo.invalid/regulatory/${i + 1}.pdf`, titleHint: u.title, text: u.text, kind: 'html', origin: 'manual', user: 'demo', authority: u.authority, category: u.category });
    regIds.push(r.id);
  }
  // one update already under review: a decision, a task, a comment and an assignee
  const reg = db.collection('regulatory_updates'), first = await reg.findOne({ _id: regIds[0] });
  if (first && (first.impacts || []).length) {
    const imp = first.impacts.find((x) => x.system_status !== 'Not Applicable') || first.impacts[0], when = at(-1);
    await reg.updateOne({ _id: first._id, 'impacts.project_id': imp.project_id }, { $set: { 'impacts.$.decision': { status: 'Confirmed Applicable', note: 'QPR due next month; site team briefed.', by: 'Meera Joshi', by_email: 'manager@demo.test', at: when }, stage: 'in_review', verification: 'human_verified', verified_by: 'Meera Joshi', verified_at: when,
      assignee: { email: 'owner@demo.test', name: 'Omkar Owner', by: 'Meera Joshi', at: when, note: 'Please collect the photographs' } },
      $push: { tasks: { id: 't_demo1', title: 'Collect geo-tagged photographs for the next QPR', description: '', project_id: imp.project_id, project_name: imp.project_name, compliance_id: null, assignee: { email: 'owner@demo.test', name: 'Omkar Owner' }, due: day(20), status: 'open', created_by: 'Meera Joshi', created_at: when },
        comments: { id: 'c_demo1', text: 'Checked against the circular text; applies to all our registered projects.', project_id: null, by: 'Meera Joshi', at: when },
        history: { $each: [note('Meera Joshi', 'decision', `${imp.project_name}: Confirmed Applicable`), note('Meera Joshi', 'task', 'Task created')] } } });
  }
  await reg.updateOne({ _id: regIds[3] }, { $addToSet: { reads: 'admin@demo.test' } });
  console.log(`Regulatory updates: ${regIds.length}`);

  /* a saved document made from a ready-made format */
  const tpl = BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:authorisation-letter') || BUILTIN_TEMPLATES[0];
  const p0 = PROJECTS[0], { values, missing } = cleanValues(tpl.variables, { date: day(-3), place: 'Pune', authority_name: 'The Executive Engineer, Building Permission Department', company_name: COMPANY.name, project_name: p0.name, project_location: p0.location, rera_no: p0.rera_no,
    authorised_person: 'Rohan Kulkarni, Project Manager', purpose: 'to submit and collect documents for the occupancy certificate of Tower A', signatory_name: 'Asha Admin', signatory_designation: 'Director' });
  const text = renderTemplateText(tpl.body, tpl.variables, values), buffer = await buildDocx(text), fileId = await store(bucket, buffer, 'authorisation-letter.docx', { generated: 'gen_demo1' });
  await db.collection('doc_generated').insertOne({ _id: 'gen_demo1', title: `${tpl.name} - ${p0.name}`, values, status: missing.length ? 'Draft' : 'Complete', missing, version: 1, file_id: fileId, size: buffer.length, text, updated_at: at(-3), updated_by: 'Asha Admin',
    template: { id: tpl.id, name: tpl.name, format: 'text', variables: tpl.variables, body: tpl.body }, template_id: tpl.id, template_name: tpl.name, project_id: p0._id, project_name: p0.name, company_id: COMPANY._id,
    created_by: 'admin@demo.test', created_by_name: 'Asha Admin', created_at: at(-3), versions: [{ version: 1, file_id: fileId, at: at(-3), by: 'Asha Admin' }] });

  console.log(`\nDone. Sign in as any of these (password: ${password}):`);
  for (const [email, , role, pids] of USERS) console.log(`  ${email.padEnd(26)} ${role}${pids ? ' (only ' + pids.join(', ') + ')' : ''}`);
} finally { await client.close(); }
