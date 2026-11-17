// Migration: apply the Nov 2026 update of the consolidated CSV to the register (shared/items.json).
//   node migrate/hr-expansion-v1.mjs            dry run: compares the CSV with the register and prints the report, writes nothing
//   node migrate/hr-expansion-v1.mjs --apply    backs up, then writes shared/items.json and data-prep/hr-expansion-report.md
// What it does:
//   - adds the HR compliance expansion records (HR-001..HR-023: Labour Codes, professional tax, salary TDS)
//   - copies each record's Merge Notes from the CSV, and keeps the part a reviewer should read (repealed-Act flags,
//     corrected thresholds/due dates, "Verify:" points) as `review_note`, shown on the record
//   - takes the updated due-date wording for existing records (FIN-010: monthly and annual PTRC filers)
// Nothing else on an existing record changes. Re-running adds nothing twice.
// After applying:  node migrate/applicability-v1.mjs --apply   then   node migrate/refresh-applicability.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrich, duplicateIndex, STAGES_V2 } from './stage-rules.mjs';
import { backup } from './backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const itemsFile = path.join(root, 'shared', 'items.json');
const csvFile = path.join(root, 'data-prep', 'Maharashtra_RealEstate_Compliance_Consolidated.csv');
const reportFile = path.join(root, 'data-prep', 'hr-expansion-report.md');
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
const keep = (v) => { const t = String(v ?? '').replace(/\r/g, '').trim(); return !t || /^not specified in (checklist )?source$/i.test(t) ? null : t; };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ---------- the same normalisation the original register used (data-prep/normalize.py) ---------- */
function normFrequency(raw) {
  if (!raw) return 'Unspecified';
  const r = raw.trim().toLowerCase();
  if (r.includes('event') || r === 'on joining') return 'Event Based';   // "On Joining" is triggered by each joining
  if (/^one[- ]?time/.test(r)) return 'One Time';
  if (/continuous|ongoing|on going/.test(r)) return 'Ongoing / Continuous';
  if (r.includes('monthly')) return 'Monthly';
  if (r.includes('quarterly')) return 'Quarterly';
  if (r.includes('half') && r.includes('year')) return 'Half-Yearly';
  if (/annual|yearly/.test(r)) return 'Annual';
  if (/as required|as prescribed/.test(r)) return 'As Required';
  if (r.includes('periodic')) return 'Periodic';
  return 'Other / Unparsed';
}
function normAuthority(raw) {
  if (!raw) return 'Unspecified';
  const r = raw.trim(), rl = r.toLowerCase();
  if (['state', 'state govt', 'state government'].includes(rl)) return 'State Govt';
  if (['central govt', 'central government', 'centre'].includes(rl)) return 'Central Govt';
  if (rl.includes('rera')) return 'MahaRERA';
  if (rl.includes('gram panchayat') || rl.includes('muncipal') || rl.includes('municipal')) return 'Local Municipal / Gram Panchayat';
  if (rl.includes('internal')) return 'Internal Compliance';
  return r;
}
/** Only the plain "Nth of the following month" wording is turned into a rule the calendar can use; the rest is set later. */
function parseDue(raw) {
  const m = String(raw || '').match(/^(?:with every wage payment \(monthly wages by the )?(\d{1,2})(?:st|nd|rd|th)(?: day)? of (?:the )?(?:next|following) month/i);
  return m ? { due_date_parse_type: 'rule', due_date_parse_value: `monthly:day=${Number(m[1])}:offset=+1month`, due_date_parse_status: 'rule' } : null;
}
const BOILERPLATE = [/^original master-sheet record retained\.?\s*/i, /^distinct checklist item retained as a separate record\.?\s*/i, /^new record added \d{1,2}-\w{3}-\d{4} \(hr compliance expansion\)\.?\s*/i];
const reviewNote = (notes) => { let t = String(notes || '').replace(/\s+/g, ' ').trim(); for (const b of BOILERPLATE) t = t.replace(b, ''); return t || null; };

/* ---------- match the CSV to the register ---------- */
const existing = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
const byId = new Map(existing.map((i) => [i.compliance_id, i]));
const problems = [];
const rowFor = new Map();                         // compliance_id -> CSV row
const perDept = {};
for (const r of csv) {
  const id = r['Compliance ID'].trim();
  if (/^(CHK|HR)-\d+$/.test(id)) { if (rowFor.has(id)) problems.push(`duplicate id ${id} in the CSV`); rowFor.set(id, r); continue; }
  // The original register rows carry a broken ID formula in the sheet, so they are matched by department and order (as before).
  const d = r['Department']; perDept[d] = (perDept[d] || 0) + 1;
  const it = existing.filter((i) => i.department === d && !/^(CHK|HR)-/.test(i.compliance_id))[perDept[d] - 1];
  if (!it) { problems.push(`CSV has more "${d}" rows than the register (row ${r._row})`); continue; }
  if (norm(it.brief_description) !== norm(r['Brief Description of compliance'])) problems.push(`${it.compliance_id} (CSV row ${r._row}): description differs from the register`);
  rowFor.set(it.compliance_id, r);
}
for (const it of existing) if (!rowFor.has(it.compliance_id)) problems.push(`${it.compliance_id}: in the register but not in the CSV`);

/* ---------- build the HR records ---------- */
const hrRows = csv.filter((r) => /^HR-\d+$/.test(r['Compliance ID'].trim()));
const built = hrRows.map((r) => {
  const id = r['Compliance ID'].trim();
  const freqRaw = nil(r['Frequency']), dueRaw = nil(r['Due Date']), freq = normFrequency(freqRaw);
  const parsed = parseDue(dueRaw);
  return {
    compliance_id: id, compliance_id_source_formula_broken: false, sheet_row: r._row, sr_no: Number(id.slice(3)),
    department: nil(r['Department']), compliance_type_raw: nil(r['Compliance Type']), level: /project/i.test(r['Compliance Type']) ? 'Project Level' : 'Entity Level',
    regulation: nil(r['Regulation']), reference_section: nil(r['Reference Section/Rule']), brief_description: keep(r['Brief Description of compliance']),
    action_required: keep(r['Action Required for compliance']), forms_documents: keep(r['Forms filed or document submitted to any authority (if any)']),
    authority_raw: nil(r['Authority']), authority_norm: normAuthority(nil(r['Authority'])),
    frequency_raw: freqRaw, frequency_norm: freq,
    due_date_raw: dueRaw, due_date_parse_type: parsed?.due_date_parse_type ?? null, due_date_parse_value: parsed?.due_date_parse_value ?? null,
    due_date_parse_status: parsed?.due_date_parse_status ?? (['Event Based', 'Ongoing / Continuous', 'As Required'].includes(freq) ? 'undated_by_nature' : 'due_date_to_be_set'),
    penalty: keep(r['Penalty/ Implications']), owner_raw: nil(r['Owner']), owner: nil(r['Owner']) || 'Unassigned', approver_raw: nil(r['Approver']), approver: nil(r['Approver']) || 'Unassigned',
    applicability: nil(r['Applicability / Trigger Condition']),
    typical_timeline: nil(r['Typical Timeline']), typical_issues: keep(r['Typical Issues Faced']),
    source_track: null, source_checklist_row: null, merge_notes: nil(r['Merge Notes']), review_note: reviewNote(r['Merge Notes']),
  };
});
const ids = hrRows.map((r) => r['Compliance ID'].trim());
for (let n = 1; n <= ids.length; n++) if (!ids.includes('HR-' + String(n).padStart(3, '0'))) problems.push(`HR-${String(n).padStart(3, '0')} is missing from the CSV (ids are not contiguous)`);
built.forEach((b) => { if (!b.brief_description) problems.push(`${b.compliance_id}: no description`); if (!b.action_required) problems.push(`${b.compliance_id}: no action text`); });

/* ---------- update the existing records: notes and due-date wording only ---------- */
const dup = duplicateIndex();
const changes = [];
const updated = existing.map((it) => {
  const r = rowFor.get(it.compliance_id);
  if (!r) return it;
  const next = { ...it };
  const notes = nil(r['Merge Notes']), rn = reviewNote(r['Merge Notes']);
  if (notes !== (it.merge_notes ?? null) && (it.merge_notes !== undefined || rn)) next.merge_notes = notes;   // register rows only gain the field when there is something to read
  if (rn !== (it.review_note ?? null)) { next.review_note = rn; if (rn) changes.push(`${it.compliance_id}: note — ${rn.slice(0, 140)}${rn.length > 140 ? '…' : ''}`); }
  const due = nil(r['Due Date']);
  if (!/^CHK-/.test(it.compliance_id) && due && norm(due) !== norm(it.due_date_raw)) {
    // Keep the parsed rule only while the wording still starts the same way (FIN-010 keeps "15th day of next month" for monthly filers).
    if (it.due_date_parse_type && !norm(due).startsWith(norm(it.due_date_raw))) problems.push(`${it.compliance_id}: due date changed in a way the parsed rule may not follow ("${it.due_date_raw}" -> "${due}")`);
    next.due_date_raw = due;
    changes.push(`${it.compliance_id}: due date "${it.due_date_raw}" -> "${due}"`);
  }
  // enrich() fills legacy_stage_* from the current stage when they are null (true for the checklist records); keep them as stored.
  return { ...enrich(next, dup), legacy_stage_id: it.legacy_stage_id, legacy_stage_source: it.legacy_stage_source };
});
// Nothing but the fields above (and what enrich derives from them) may change.
const MAY_CHANGE = new Set(['merge_notes', 'review_note', 'due_date_raw', 'deadline_rule', 'trigger']);
updated.forEach((a, i) => { const b = existing[i]; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!MAY_CHANGE.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(`${b.compliance_id}: field "${k}" would change`); });

const have = new Set(existing.map((i) => i.compliance_id));
const fresh = built.filter((b) => !have.has(b.compliance_id)).map((b) => enrich(b, dup));
const stageIds = new Set(STAGES_V2.map((s) => s.id));
fresh.forEach((a) => { if (!stageIds.has(a.stage_id) || a.stage_id === 'UNMAPPED') problems.push(`${a.compliance_id}: no stage placed`); });
const result = [...updated, ...fresh];
if (new Set(result.map((i) => i.compliance_id)).size !== result.length) problems.push('duplicate compliance_id in result');

/* ---------- report ---------- */
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x) ?? '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const table = (o) => Object.entries(o).sort().map(([k, v]) => `| ${k} | ${v} |`).join('\n');
const L = [];
L.push(`# HR compliance expansion and register update (Nov 2026)\n\nGenerated ${new Date().toISOString()} · mode: ${APPLY ? 'APPLIED' : 'DRY RUN'}\n`);
L.push(`CSV rows: ${csv.length}. Register before: ${existing.length}. New records ${APPLY ? 'added' : 'to add'}: ${fresh.length}${built.length - fresh.length ? ` (${built.length - fresh.length} already present, skipped)` : ''}. Register after: ${result.length}. Existing records updated: ${new Set(changes.map((c) => c.split(':')[0])).size}. Problems: ${problems.length}.\n`);
L.push(`## New records\n| ID | Frequency | Stage | Applies |\n|---|---|---|---|\n${fresh.map((i) => `| ${i.compliance_id} | ${i.frequency_norm} | ${i.stage_id} | ${i.applicability_default === 'Conditional' ? 'Conditional: ' + i.applicability_condition : i.applicability_default} |`).join('\n')}\n`);
L.push(`## New records by frequency\n| Frequency | Records |\n|---|---|\n${table(count(fresh, (i) => i.frequency_norm))}\n`);
L.push(`## Changes to existing records\n${changes.map((c) => '- ' + c).join('\n') || 'None.'}\n`);
L.push(`## Needs a reviewer\n- Every new record starts as "Legal Validation Required". Several carry a "Verify:" point in their note.\n- Approver is not in the CSV, so all ${fresh.length} new records show "Unassigned".\n- ${changes.filter((c) => /repealed/i.test(c)).length} existing records cite an Act that has been repealed and replaced by a Labour Code; their wording is unchanged until a reviewer updates it.\n- HR-009 (creche, 50 or more employees) uses the setup question "more than 50 workers".\n`);
if (problems.length) L.push(`## Problems\n${problems.map((p) => '- ' + p).join('\n')}\n`);
const report = L.join('\n');

console.log(report);
if (problems.length) { console.log(`\n${problems.length} problem(s). Nothing written.`); process.exit(1); }
if (!APPLY) { console.log('\nDry run only. Re-run with --apply to write shared/items.json.'); process.exit(0); }
await backup('before-hr-expansion');
fs.writeFileSync(itemsFile, JSON.stringify(result, null, 1) + '\n');
fs.writeFileSync(reportFile, report + '\n');
console.log(`\nWrote ${result.length} records to shared/items.json and the report to data-prep/hr-expansion-report.md`);
