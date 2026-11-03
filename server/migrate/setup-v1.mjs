// Migration 002: company / phase structure and first applicability decisions.
//   node migrate/setup-v1.mjs            dry run: shows what would be created and the resulting applicability split
//   node migrate/setup-v1.mjs --apply    backs up, then writes
// Adds only: a default company, company_id on projects that have none, a "Phase 1" for projects with no phase, and applicability
// decisions. Existing projects, tracking, documents and audit rows are not modified or deleted. Safe to re-run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { generate, loadWorld, Core } from '../generate.mjs';
import { backup } from './backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const APPLY = process.argv.includes('--apply');
const DEFAULT_COMPANY = { _id: 'co_nyati', name: 'Nyati', facts: {} };

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'compliance_tracker');
try {
  const w = await loadWorld(db);
  const plan = { company: null, projectsToAssign: [], phasesToCreate: [] };
  let companyId = Object.keys(w.companies)[0];
  if (!companyId) { plan.company = DEFAULT_COMPANY; companyId = DEFAULT_COMPANY._id; w.companies[companyId] = { name: DEFAULT_COMPANY.name, facts: {} }; }
  for (const [id, p] of Object.entries(w.projects)) {
    if (!p.company_id) { plan.projectsToAssign.push(id); p.company_id = companyId; }
    if (!Object.values(w.phases).some((x) => x.project_id === id)) {
      const ph = { _id: `ph_${id.replace(/^proj_/, '')}_1`, project_id: id, name: 'Phase 1', rera_no: p.rera_no || '' };
      plan.phasesToCreate.push(ph); w.phases[ph._id] = { project_id: id, name: ph.name };
    }
  }
  console.log('Plan:');
  console.log(` company to create: ${plan.company ? plan.company.name : 'none (already exists: ' + w.companies[companyId].name + ')'}`);
  console.log(` projects to assign to it: ${plan.projectsToAssign.map((i) => w.projects[i].name || i).join(', ') || 'none'}`);
  console.log(` phases to create: ${plan.phasesToCreate.map((p) => `${p.name} for ${w.projects[p.project_id].name}`).join(', ') || 'none'}`);

  // What the engine would decide (computed in memory so a dry run shows real numbers).
  const insts = Core.enumerateAll(w);
  const split = {};
  for (const inst of insts) { const s = Core.evaluate(w.cat, inst.item, Core.entitiesFor(w, inst)).status; split[s] = (split[s] || 0) + 1; }
  const byScope = insts.reduce((m, i) => (m[i.scopeType] = (m[i.scopeType] || 0) + 1, m), {});
  console.log(` instances: ${insts.length} ${JSON.stringify(byScope)}; applicability split: ${JSON.stringify(split)}`);

  if (!APPLY) { console.log('\nDRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }

  await backup('pre-setup-v1');
  const now = new Date().toISOString();
  if (plan.company) await db.collection('companies').updateOne({ _id: plan.company._id }, { $setOnInsert: { ...plan.company, created_at: now, updated_by: 'migration' } }, { upsert: true });
  for (const id of plan.projectsToAssign) await db.collection('projects').updateOne({ _id: id, company_id: { $exists: false } }, { $set: { company_id: companyId } });
  for (const ph of plan.phasesToCreate) await db.collection('phases').updateOne({ _id: ph._id }, { $setOnInsert: { ...ph, created_at: now, updated_by: 'migration' } }, { upsert: true });
  const summary = await generate(db, { all: true }, 'migration');
  console.log('\nApplied. Engine summary:', JSON.stringify(summary));
} finally { await client.close(); }
