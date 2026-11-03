// Migration 003: adds the client's project lists (real estate + ongoing EPC) to the single company.
//   node migrate/projects-v1.mjs            dry run
//   node migrate/projects-v1.mjs --apply    backs up, then writes, then generates applicability
// Idempotent: a project is matched by name (case/space-insensitive) and created only if missing. Existing projects keep their
// data; they only gain a "category". Nothing is renamed or deleted.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { generate } from '../generate.mjs';
import { backup } from './backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const APPLY = process.argv.includes('--apply');

const REAL_ESTATE = ['Nyati Evoque', 'Nyati Era III', 'Nyati Era IV', 'Nyati Exuberance IV', 'Nyati Esteban II', 'Nyati Esteban III', 'Nyati Elenor',
  'Nyati Emblem', 'Nyati Equinox I', 'Nyati Equinox II', 'Nyati Emerald I', 'Nyati Emerald II', 'Nyati Emerald III', 'Nyati Evania'];
const EPC = [
  'Maharashtra State Police Housing and Welfare Corporation Ltd – Kandivali, Maharashtra',
  'BMC-Transportation & Commercial Hub - Dahisar, Maharashtra',
  'Medical College & Hospital - Bhojpur, Bihar',
  'Medical College & Hospital - Munger, Bihar',
  'Symbiosis Medical College – Lavale, Pune, Maharashtra',
  'HSCC India - Medical College - Jalgaon, Maharashtra',
  'PWD - Medical College- Satara, Maharashtra',
  'Airport Authority of India – Udaipur, Rajasthan',
  'MIDC - Incubation Center– Kalamboli, Maharashtra',
  'PWD - Admin Building – Ratnagiri, Maharashtra',
  'Maharashtra Airport Development Co. Ltd - Terminal Building– Ratnagiri, Maharashtra',
  'MIDC - Smart City – Ratnagiri, Maharashtra',
  'Indian Institute of Creative Technologies – Goregaon, Mumbai, Maharashtra'
];

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
// The site is whatever follows the last dash: "PWD - Medical College- Satara, Maharashtra" -> "Satara, Maharashtra"
const siteOf = (name) => { const m = name.match(/[–-]\s*([^–-]+)$/); return m ? m[1].trim() : ''; };

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'compliance_tracker');
try {
  const company = (await db.collection('companies').find().limit(1).toArray())[0];
  if (!company) throw new Error('No company exists. Run migrate/setup-v1.mjs first.');
  const existing = await db.collection('projects').find().toArray();
  const byName = new Map(existing.map((p) => [norm(p.name), p]));
  const plan = { create: [], categorise: [], leave: [] };
  const seenIds = new Set(existing.map((p) => p._id));
  const want = [...REAL_ESTATE.map((n) => ({ name: n, category: 'real_estate' })), ...EPC.map((n) => ({ name: n, category: 'epc', location: siteOf(n) }))];
  for (const w of want) {
    const cur = byName.get(norm(w.name));
    if (cur) { if (cur.category !== w.category) plan.categorise.push({ id: cur._id, ...w }); else plan.leave.push(w.name); continue; }
    const id = 'proj_' + slug(w.name);
    if (seenIds.has(id)) throw new Error(`id clash for ${w.name}`);
    seenIds.add(id);
    plan.create.push({ _id: id, ...w });
  }
  const listed = new Set(want.map((w) => norm(w.name)));
  const unlisted = existing.filter((p) => !listed.has(norm(p.name)));
  console.log(`To create: ${plan.create.length} (${plan.create.filter((p) => p.category === 'real_estate').length} real estate, ${plan.create.filter((p) => p.category === 'epc').length} EPC)`);
  console.log(`Existing projects that match the list and get a category: ${plan.categorise.map((p) => p.name).join(', ') || 'none'}`);
  console.log(`Already complete: ${plan.leave.length}`);
  console.log(`Existing projects NOT in the client's list (left exactly as they are, category set to real estate): ${unlisted.map((p) => p.name).join(', ') || 'none'}`);
  plan.create.filter((p) => p.category === 'epc').forEach((p) => console.log(`   EPC  ${p._id}  site: ${p.location}`));
  if (!APPLY) { console.log('\nDRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }

  await backup('pre-projects-v1');
  const now = new Date().toISOString();
  for (const p of plan.create) {
    const doc = { name: p.name, company_id: company._id, category: p.category, location: p.location || '', rera_no: '', current_stage: '', facts: {}, created_at: now, updated_by: 'migration' };
    await db.collection('projects').updateOne({ _id: p._id }, { $setOnInsert: doc }, { upsert: true });
    if (p.category === 'real_estate') {
      await db.collection('phases').updateOne({ _id: `ph_${p._id.replace(/^proj_/, '')}_1` }, { $setOnInsert: { project_id: p._id, name: 'Phase 1', rera_no: '', created_at: now, updated_by: 'migration' } }, { upsert: true });
    }
  }
  for (const p of plan.categorise) await db.collection('projects').updateOne({ _id: p.id }, { $set: { category: p.category, ...(p.location && !existing.find((e) => e._id === p.id).location ? { location: p.location } : {}) } });
  for (const p of unlisted) await db.collection('projects').updateOne({ _id: p._id, category: { $exists: false } }, { $set: { category: 'real_estate' } });
  const summary = await generate(db, { all: true }, 'migration');
  console.log('\nApplied. Engine summary:', JSON.stringify(summary));
} finally { await client.close(); }
