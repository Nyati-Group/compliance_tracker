// Migration 001: stage framework v2 + per-record placement/level/deadline/duplicate metadata for the master register.
//   node migrate/stages-v2.mjs            dry run: prints the report, writes nothing
//   node migrate/stages-v2.mjs --apply    backs up, then writes app/items.json, app/stages.json and data-prep/stage-migration-report.md
// Idempotent: every new field is derived from the original fields (legacy_stage_* is captured once), so re-running changes nothing.
// Never touches MongoDB data other than reading stage_overrides for the report.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { STAGES_V2, enrich, duplicateIndex } from './stage-rules.mjs';
import { backup } from './backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const itemsFile = path.join(root, 'app', 'items.json');
const stagesFile = path.join(root, 'app', 'stages.json');
const reportFile = path.join(root, 'data-prep', 'stage-migration-report.md');
const APPLY = process.argv.includes('--apply');
if (fs.existsSync(path.join(here, '..', '.env'))) process.loadEnvFile(path.join(here, '..', '.env'));

const before = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
const dup = duplicateIndex();
const after = before.map((it) => enrich(it, dup));

/* ---------- validation ---------- */
const problems = [];
if (after.length !== before.length) problems.push(`record count changed ${before.length} -> ${after.length}`);
const ids = new Set(after.map((i) => i.compliance_id));
if (ids.size !== after.length) problems.push('duplicate compliance_id values in result');
const stageIds = new Set(STAGES_V2.map((s) => s.id));
// Fields this migration owns (derived). Everything else in a record is original source data and must come out byte-for-byte equal.
const DERIVED = new Set(['stage_id', 'stage_source', 'stage_confidence', 'stage_basis', 'compliance_level', 'applicability_default',
  'applicability_condition', 'trigger', 'deadline_rule', 'duplicate_group', 'legal_validation_status', 'legacy_stage_id', 'legacy_stage_source']);
after.forEach((a, i) => {
  const b = before[i];
  if (a.compliance_id !== b.compliance_id) problems.push(`${b.compliance_id}: id changed`);
  for (const k of Object.keys(b)) if (!DERIVED.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(`${b.compliance_id}: original field "${k}" changed`);
  if (!stageIds.has(a.stage_id)) problems.push(`${a.compliance_id}: unknown stage ${a.stage_id}`);
});
for (const [name, list] of Object.entries(Object.fromEntries([...dup.entries()].reduce((m, [id, g]) => (m.set(g, [...(m.get(g) || []), id]), m), new Map())))) {
  for (const id of list) if (!ids.has(id)) problems.push(`duplicate group "${name}" names unknown id ${id}`);
}

/* ---------- report ---------- */
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x) ?? '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const byStage = count(after, (i) => i.stage_id);
const byConf = count(after, (i) => i.stage_confidence);
const byLevel = count(after, (i) => i.compliance_level);
const byApp = count(after, (i) => i.applicability_default);
const byDl = count(after, (i) => i.deadline_rule.type + ' / ' + i.deadline_rule.status);
const moved = after.filter((i) => i.legacy_stage_id && i.legacy_stage_id !== 'UNMAPPED' && i.legacy_stage_id !== i.stage_id);
const lowConf = after.filter((i) => i.stage_confidence === 'low');
const lines = [];
const table = (obj) => Object.entries(obj).sort().map(([k, v]) => `| ${k} | ${v} |`).join('\n');
lines.push(`# Stage migration report (v2)\n\nGenerated ${new Date().toISOString()} · mode: ${APPLY ? 'APPLIED' : 'DRY RUN'}\n`);
lines.push(`Records: ${before.length} in, ${after.length} out. IDs preserved. Original fields untouched. Problems: ${problems.length}.\n`);
lines.push(`## Records per stage\n| Stage | Records |\n|---|---|\n${STAGES_V2.map((s) => `| ${s.name} | ${byStage[s.id] || 0} |`).join('\n')}\n`);
lines.push(`## Placement confidence\n| Confidence | Records |\n|---|---|\n${table(byConf)}\n`);
lines.push(`## Compliance level\n| Level | Records |\n|---|---|\n${table(byLevel)}\n`);
lines.push(`## Default applicability\n| Value | Records |\n|---|---|\n${table(byApp)}\n`);
lines.push(`## Deadline rule (no dates were invented; recurring/event/one-time items are marked "pending validation")\n| Type / status | Records |\n|---|---|\n${table(byDl)}\n`);
lines.push(`## Records whose stage changed from the old framework (${moved.length})\n${moved.map((i) => `- ${i.compliance_id}: ${i.legacy_stage_id} -> ${i.stage_id} (${i.stage_basis})`).join('\n') || 'none'}\n`);
lines.push(`## Low-confidence placements for legal review (${lowConf.length})\n${lowConf.map((i) => `- ${i.compliance_id} -> ${i.stage_id}: ${i.stage_basis}`).join('\n') || 'none'}\n`);
lines.push(`## Possible duplicates (kept as separate records, linked by group)\n${Object.entries(Object.fromEntries(((m) => { dup.forEach((g, id) => m.set(g, [...(m.get(g) || []), id])); return m; })(new Map()))).map(([g, l]) => `- **${g}**: ${l.join(', ')}`).join('\n')}\n`);
if (problems.length) lines.push(`## PROBLEMS\n${problems.map((p) => `- ${p}`).join('\n')}\n`);

/* ---------- stage_overrides check (read-only) ---------- */
let overrides = [];
if (process.env.MONGODB_URI) {
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    overrides = await client.db(process.env.MONGODB_DB || 'compliance_tracker').collection('stage_overrides').find().toArray();
  } catch (e) { lines.push(`(Could not read stage_overrides: ${e.message})\n`); } finally { await client.close().catch(() => {}); }
}
lines.push(`## Existing admin stage overrides in MongoDB (${overrides.length}, left untouched)\n${overrides.map((o) => `- ${o._id}: ${o.stage_id}${stageIds.has(o.stage_id) ? '' : '  <-- not a valid v2 stage id'}`).join('\n') || 'none'}\n`);

const report = lines.join('\n');
console.log(report);
if (problems.length) { console.error(`\nAborting: ${problems.length} validation problem(s).`); process.exit(1); }

if (!APPLY) { console.log('\nDRY RUN: nothing was written. Re-run with --apply to migrate.'); process.exit(0); }

await backup('pre-stages-v2');
fs.writeFileSync(itemsFile, JSON.stringify(after, null, 1) + '\n');
fs.writeFileSync(stagesFile, JSON.stringify(STAGES_V2, null, 1) + '\n');
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, report);
console.log(`\nApplied. Wrote app/items.json, app/stages.json and ${path.relative(root, reportFile)}.`);
