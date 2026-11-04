// Migration: add the Real Estate Compliance checklist (CHK-001..CHK-209) from the consolidated CSV to the register.
//   node migrate/real-estate-checklist-v1.mjs            dry run: compares the CSV with the register and prints the report, writes nothing
//   node migrate/real-estate-checklist-v1.mjs --apply    backs up, then appends the new records to shared/items.json and writes the report
// The 306 records already in the register are never changed except for the derived "duplicate_group" link. Re-running adds nothing twice.
// After applying, run:  node migrate/applicability-v1.mjs --apply   (adds the project-type setup questions that decide these records)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrich, duplicateIndex, STAGES_V2 } from './stage-rules.mjs';
import { chkCondition } from './checklist-rules.mjs';
import { backup } from './backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const itemsFile = path.join(root, 'shared', 'items.json');
const csvFile = path.join(root, 'data-prep', 'Maharashtra_RealEstate_Compliance_Consolidated.csv');
const reportFile = path.join(root, 'data-prep', 'real-estate-checklist-report.md');
const APPLY = process.argv.includes('--apply');

/* ---------- read the CSV ---------- */
function parseCsv(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; r.push(f); f = ''; rows.push(r); r = []; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}
const grid = parseCsv(fs.readFileSync(csvFile, 'utf8').replace(/^﻿/, ''));
const head = grid[0].map((h) => h.trim());
const csv = grid.slice(1).filter((r) => r.length > 5 && r.some((x) => x.trim())).map((r, i) => ({ _row: i + 2, ...Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])) }));
const nil = (v) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return !t || /^not specified in (checklist )?source$/i.test(t) || t === '-' ? null : t; };
const keep = (v) => { const t = String(v ?? '').replace(/\r/g, '').trim(); return !t || /^not specified in (checklist )?source$/i.test(t) ? null : t; };   // keeps line breaks

/* ---------- the same normalisation the original register used (data-prep/normalize.py) ---------- */
function normAuthority(raw) {
  if (!raw) return 'Unspecified';
  const r = raw.trim(), rl = r.toLowerCase();
  if (rl.includes('other (specify)')) { const s = r.includes(')') ? r.split(')').slice(1).join(')').trim() : ''; return s || 'Other (Unspecified)'; }
  if (['state', 'state govt', 'state government'].includes(rl)) return 'State Govt';
  if (['central govt', 'central government', 'centre'].includes(rl)) return 'Central Govt';
  if (rl.includes('rera')) return 'MahaRERA';
  if (rl.includes('gram panchayat') || rl.includes('muncipal') || rl.includes('municipal')) return 'Local Municipal / Gram Panchayat';
  if (rl.includes('internal')) return 'Internal Compliance';
  if (rl === 'none') return 'Unspecified';
  return r;
}
/** The checklist has no Frequency column; the timing text says how often it recurs, so the frequency is read from it (and marked as inferred). */
function inferFrequency(timeline) {
  const t = String(timeline || '').toLowerCase();
  if (!t) return 'Unspecified';
  if (/monthly\/quarterly\/annual/.test(t)) return 'Periodic';
  if (/every 6 months|six months|half-yearly/.test(t)) return 'Half-Yearly';
  if (/every quarter|quarterly/.test(t)) return 'Quarterly';
  if (/annual/.test(t)) return 'Annual';
  if (/monthly/.test(t)) return 'Monthly';
  if (/^ongoing|during construction|construction period|^for the construction/.test(t)) return 'Ongoing / Continuous';
  if (/per case|as needed|within 30 days of notice|at or after|at booking|before every|before lead|after oc|^with |^at start|^at agreement|^within prescribed|^within 3 months|^within order|^before /.test(t)) return 'Event Based';
  if (/\d+\s*(-\s*\d+)?\+?\s*(day|week|month)/.test(t)) return 'One Time';
  return 'Unspecified';
}

/* ---------- build the new records ---------- */
const chkRows = csv.filter((r) => /^CHK-\d+$/.test(r['Compliance ID']));
const problems = [];
const existing = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
const have = new Set(existing.map((i) => i.compliance_id));
const col = (r, k) => r[k] ?? '';
const built = chkRows.map((r) => {
  const id = r['Compliance ID'], n = Number(id.slice(4));
  const track = nil(r['Source Sheet(s)']) || 'New Project';
  const timeline = nil(r['Typical Timeline']) || nil(r['Due Date']);
  const freq = inferFrequency(timeline), byNature = ['Event Based', 'Ongoing / Continuous', 'As Required'].includes(freq);
  const desc = keep(col(r, 'Brief Description of compliance'));
  return {
    compliance_id: id, compliance_id_source_formula_broken: false, sheet_row: r._row, sr_no: n,
    department: nil(r['Department']), compliance_type_raw: nil(r['Compliance Type']), level: 'Project Level',
    regulation: nil(r['Regulation']), reference_section: nil(r['Reference Section/Rule']), brief_description: desc,
    action_required: keep(r['Action Required for compliance']), forms_documents: keep(r['Forms filed or document submitted to any authority (if any)']),
    authority_raw: nil(r['Authority']), authority_norm: normAuthority(nil(r['Authority'])),
    frequency_raw: null, frequency_norm: freq, frequency_basis: freq === 'Unspecified' ? null : 'inferred_from_typical_timeline',
    due_date_raw: null, due_date_parse_type: null, due_date_parse_value: null, due_date_parse_status: byNature ? 'undated_by_nature' : 'due_date_to_be_set',
    penalty: keep(r['Penalty/ Implications']), owner_raw: nil(r['Owner']), owner: nil(r['Owner']) || 'Unassigned', approver_raw: nil(r['Approver']), approver: nil(r['Approver']) || 'Unassigned',
    applicability: chkCondition(track, desc), applicability_source: nil(r['Applicability / Trigger Condition']),
    typical_timeline: timeline, typical_issues: keep(r['Typical Issues Faced']),
    source_track: track, source_checklist_row: nil(r['Source Checklist Row(s)']), merge_notes: nil(r['Merge Notes']),
  };
});
const ids = chkRows.map((r) => r['Compliance ID']);
if (new Set(ids).size !== ids.length) problems.push('duplicate CHK ids in the CSV');
for (let n = 1; n <= ids.length; n++) if (!ids.includes('CHK-' + String(n).padStart(3, '0'))) problems.push(`CHK-${String(n).padStart(3, '0')} is missing from the CSV (ids are not contiguous)`);
built.forEach((b) => { if (!b.brief_description) problems.push(`${b.compliance_id}: no description`); if (!b.action_required) problems.push(`${b.compliance_id}: no action text`); });

/* ---------- compare the CSV with the register ---------- */
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const nonChk = csv.filter((r) => !/^CHK-\d+$/.test(r['Compliance ID']));
const perDept = {}; const diffs = [];
for (const r of nonChk) {
  const d = r['Department']; perDept[d] = (perDept[d] || 0) + 1;
  const it = existing.filter((i) => i.department === d)[perDept[d] - 1];
  if (!it) { problems.push(`CSV has more "${d}" rows than the register (row ${r._row})`); continue; }
  if (norm(it.brief_description) !== norm(r['Brief Description of compliance'])) diffs.push(`${it.compliance_id} (CSV row ${r._row}): description differs`);
}
for (const d of new Set(existing.map((i) => i.department))) if ((perDept[d] || 0) !== existing.filter((i) => i.department === d).length) problems.push(`"${d}": CSV has ${perDept[d] || 0} rows, register has ${existing.filter((i) => i.department === d).length}`);

/* ---------- enrich (stage, level, applicability, deadline, duplicate links) and validate ---------- */
const dup = duplicateIndex();
const fresh = built.filter((b) => !have.has(b.compliance_id));
const skipped = built.length - fresh.length;
const enrichedNew = fresh.map((b) => enrich(b, dup));
const DERIVED = new Set(['duplicate_group']);
const reEnriched = existing.map((it) => enrich(it, dup));
reEnriched.forEach((a, i) => { for (const k of Object.keys(existing[i])) if (!DERIVED.has(k) && JSON.stringify(a[k]) !== JSON.stringify(existing[i][k])) problems.push(`${existing[i].compliance_id}: field "${k}" would change`); });
const stageIds = new Set(STAGES_V2.map((s) => s.id));
enrichedNew.forEach((a) => { if (!stageIds.has(a.stage_id) || a.stage_id === 'UNMAPPED') problems.push(`${a.compliance_id}: no stage placed`); if (a.applicability_default !== 'Conditional') problems.push(`${a.compliance_id}: not conditional`); });
const result = [...reEnriched, ...enrichedNew];
if (new Set(result.map((i) => i.compliance_id)).size !== result.length) problems.push('duplicate compliance_id in result');
for (const [g, list] of Object.entries(Object.fromEntries([...dup.entries()].reduce((m, [id, g]) => (m.set(g, [...(m.get(g) || []), id]), m), new Map())))) for (const id of list) if (!result.some((i) => i.compliance_id === id)) problems.push(`duplicate group "${g}" names unknown id ${id}`);

/* ---------- report ---------- */
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x) ?? '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const table = (o) => Object.entries(o).sort().map(([k, v]) => `| ${k} | ${v} |`).join('\n');
const L = [];
L.push(`# Real Estate Compliance checklist import\n\nGenerated ${new Date().toISOString()} · mode: ${APPLY ? 'APPLIED' : 'DRY RUN'}\n`);
L.push(`CSV rows: ${csv.length} (${nonChk.length} already in the register, ${chkRows.length} checklist rows). Register before: ${existing.length}. New records ${APPLY ? 'added' : 'to add'}: ${fresh.length}${skipped ? ` (${skipped} already present, skipped)` : ''}. Register after: ${result.length}. Problems: ${problems.length}.\n`);
L.push(`## Comparison with the 306 records already in the register\nAll ${nonChk.length} non-checklist CSV rows were matched to the register by department and order. Descriptions that differ: ${diffs.length}.${diffs.length ? '\n\n' + diffs.slice(0, 20).map((d) => '- ' + d).join('\n') : ''}\n`);
L.push(`## New records by track\n| Track | Records |\n|---|---|\n${table(count(enrichedNew, (i) => i.source_track))}\n`);
L.push(`## New records per stage\n| Stage | Records |\n|---|---|\n${STAGES_V2.map((s) => `| ${s.name} | ${enrichedNew.filter((i) => i.stage_id === s.id).length} |`).join('\n')}\n`);
L.push(`## Stage placement confidence\n| Confidence | Records |\n|---|---|\n${table(count(enrichedNew, (i) => i.stage_confidence))}\n`);
L.push(`## Level (how each is tracked)\n| Level | Records |\n|---|---|\n${table(count(enrichedNew, (i) => i.compliance_level))}\n`);
L.push(`## Frequency (read from the typical timeline; the checklist has no Frequency column)\n| Frequency | Records |\n|---|---|\n${table(count(enrichedNew, (i) => i.frequency_norm))}\n`);
L.push(`## Linked to records that already exist (duplicate groups)\n${[...new Set(enrichedNew.map((i) => i.duplicate_group).filter(Boolean))].sort().map((g) => `- ${g}: ${result.filter((i) => i.duplicate_group === g).map((i) => i.compliance_id).join(', ')}`).join('\n')}\n`);
L.push(`## Needs a reviewer\n- Every new record starts as "Legal Validation Required"; the stage and the setup question that decides it are proposals.\n- Owner and approver are not in the checklist, so all ${enrichedNew.length} show "Unassigned".\n- The checklist's penalty and frequency columns are empty. Frequency was inferred from the timeline text where it was clear.\n- Stage placements with low confidence: ${enrichedNew.filter((i) => i.stage_confidence === 'low').map((i) => i.compliance_id).join(', ') || 'none'}.\n`);
if (problems.length) L.push(`## Problems\n${problems.map((p) => '- ' + p).join('\n')}\n`);
const report = L.join('\n');

console.log(report.split('\n').slice(0, 60).join('\n'));
if (problems.length) { console.log(`\n${problems.length} problem(s). Nothing written.`); process.exit(1); }
if (!APPLY) { console.log('\nDry run only. Re-run with --apply to write shared/items.json.'); process.exit(0); }
await backup('before-real-estate-checklist');
fs.writeFileSync(itemsFile, JSON.stringify(result, null, 1) + '\n');
fs.writeFileSync(reportFile, report + '\n');
console.log(`\nWrote ${result.length} records to shared/items.json and the report to data-prep/real-estate-checklist-report.md`);
