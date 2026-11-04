// Run:  node tests/health.test.mjs      (from the server folder)
// Tests the health engine with synthetic projects built from the real register. No database, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../generate.mjs';
import { computeHealth, buildRecommendations, mergeSettings } from '../health.mjs';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared');
const j = (f) => JSON.parse(fs.readFileSync(path.join(app, f), 'utf8'));
const items = j('items.json'), cat = j('applicability.json'), profiles = j('profiles.json'), stages = j('stages.json'), deps = j('dependencies.json');
const itemById = Object.fromEntries(items.map((i) => [i.compliance_id, i]));
const TODAY = '2026-10-28';
const add = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// one real-estate project with one phase and two buildings, all lifts answered, so every applicability is decided
function world() {
  const w = { items, itemById, profiles, cat,
    companies: { co: { name: 'Co', facts: {}, employee_count: 30 } },
    projects: { p1: { name: 'Project One', company_id: 'co', category: 'real_estate', facts: {}, built_up_area_sqm: 30000 } },
    phases: { ph1: { project_id: 'p1', name: 'Phase 1' } },
    buildings: { bA: { project_id: 'p1', phase_id: 'ph1', name: 'Tower A', facts: { has_lift: true } }, bB: { project_id: 'p1', phase_id: 'ph1', name: 'Tower B', facts: { has_lift: false } } } };
  w.insts = Core.enumerate(w, { projectId: 'p1' });
  w.decisions = {};
  for (const i of w.insts) { const ev = Core.evaluate(cat, i.item, Core.entitiesFor(w, i)); w.decisions[i.key] = { status: ev.status, reason: ev.reason, source: 'auto' }; }
  return w;
}
const run = (w, extra = {}) => computeHealth({ insts: w.insts, decisions: w.decisions, tracking: {}, docsByKey: {}, deps, stages, stageOverrides: {}, riskOverrides: {}, proposals: {}, settings: {}, today: TODAY,
  scope: { type: 'project', id: 'p1', name: 'Project One' }, itemById, ...extra });
const activeKeys = (w) => w.insts.filter((i) => Core.stateOf(w.decisions[i.key].status) === 'active').map((i) => i.key);
const verifiedDocs = (w, keys) => Object.fromEntries(keys.map((k) => [k, Core.requiredDocs(itemById[Core.parseKey(k).compliance_id]).map((n, ix) => ({ id: k + ix, key: k, doc_name: n, doc_name_lc: n.toLowerCase(), version: 1, superseded: false, status: 'Verified' }))]));
const keyOf = (w, cid, scopeId) => w.insts.find((i) => i.item.compliance_id === cid && (!scopeId || i.scopeId === scopeId)).key;
let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('  PASS  ' + name); } catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; } };

const w = world(); const keys = activeKeys(w);
console.log(`Synthetic project: ${w.insts.length} instances, ${keys.length} applicable`);

t('Scenario 1 - healthy project: everything done and verified', () => {
  const tracking = Object.fromEntries(keys.map((k) => [k, { status: 'Compliant / Completed' }]));
  const h = run(w, { tracking, docsByKey: verifiedDocs(w, keys) });
  assert.equal(h.score, 100); assert.equal(h.category, 'Healthy'); assert.equal(h.counts.critical + h.counts.high, 0);
  assert.equal(h.counts.overdue, 0); assert.equal(buildRecommendations(h, {}).filter((r) => r.priority === 'P1' || r.priority === 'P2').length, 0);
});

t('Nothing done yet: low score, but nothing is called critical without a classification', () => {
  const h = run(w);
  assert.ok(h.score <= 5, 'score ' + h.score);
  assert.equal(h.counts.critical, 0); assert.equal(h.counts.high, 0);
  assert.ok(h.limitations.some((l) => /pending validation/.test(l)));
});

t('Scenario 2 - critical obligation overdue: risk card, score drop, P1 recommendation with owner and source', () => {
  const k = keyOf(w, 'SAN-001', 'p1');
  const base = run(w, { tracking: Object.fromEntries(keys.map((x) => [x, { status: 'Compliant / Completed' }])), docsByKey: verifiedDocs(w, keys) });
  const tracking = Object.fromEntries(keys.map((x) => [x, { status: 'Compliant / Completed' }])); tracking[k] = { status: 'In Progress', next_due_date: add(-9) };
  const docsByKey = verifiedDocs(w, keys); delete docsByKey[k];
  const h = run(w, { tracking, docsByKey, riskOverrides: { 'SAN-001': { level: 'critical' } } });
  assert.ok(h.score < base.score, `${h.score} < ${base.score}`);
  const card = h.cards.find((c) => c.complianceId === 'SAN-001'); assert.ok(card); assert.equal(card.level, 'critical'); assert.equal(card.kind, 'overdue');
  assert.equal(card.owner, 'Sanctioning Team'); assert.equal(card.dueDate, add(-9));
  const rec = buildRecommendations(h, {}).find((r) => r.compliance_id === 'SAN-001');
  assert.equal(rec.priority, 'P1'); assert.ok(rec.priority_reason.length > 20); assert.equal(rec.source_refs[0].id, 'SAN-001'); assert.equal(rec.suggested_owner, 'Sanctioning Team');
  assert.ok(h.deductions.some((d) => d.kind === 'critical_overdue'));
});

t('Scenario 3 - mandatory document missing close to the deadline', () => {
  const k = keyOf(w, 'HEA-008', 'p1');   // lists one document: "Excavation Permit"
  const tracking = { [k]: { status: 'In Progress', next_due_date: add(5) } };
  const h = run(w, { tracking });
  const card = h.cards.find((c) => c.complianceId === 'HEA-008'); assert.ok(card);
  assert.equal(card.kind, 'missing_docs'); assert.ok(h.documents.issues.some((i) => i.complianceId === 'HEA-008' && i.issue === 'Not uploaded'));
  assert.ok(h.deductions.some((d) => d.kind === 'missing_documents'));
  assert.ok(buildRecommendations(h, {}).find((r) => r.compliance_id === 'HEA-008').required_documents.includes('Excavation Permit'));
});

t('Scenario 4 - expired certificate: flagged, deducted, renewal recommended', () => {
  const k = keyOf(w, 'HEA-008', 'p1');
  const docsByKey = { [k]: [{ id: 'd1', key: k, doc_name: 'Excavation Permit', doc_name_lc: 'excavation permit', version: 1, superseded: false, status: 'Verified', expiry_date: add(-20) }] };
  const h = run(w, { tracking: { [k]: { status: 'Compliant / Completed' } }, docsByKey });
  const card = h.cards.find((c) => c.complianceId === 'HEA-008'); assert.equal(card.kind, 'expired_doc');
  assert.ok(h.documents.expired >= 1); assert.ok(h.deductions.some((d) => d.kind === 'expired_document'));
  const rec = buildRecommendations(h, {}).find((r) => r.compliance_id === 'HEA-008'); assert.match(rec.title, /Renew expired document/);
});

t('Scenario 5 - blocked stage: prerequisite incomplete', () => {
  const ph = Object.keys(w.phases)[0];
  // work has started on SAN-034 while its prerequisite SAN-033 is still open
  const h = run(w, { tracking: { [keyOf(w, 'SAN-033', ph)]: { status: 'In Progress' }, [keyOf(w, 'SAN-034', ph)]: { status: 'In Progress' } } });
  const s8 = h.stages.find((s) => s.id === 'S8'); assert.equal(s8.status, 'Blocked');
  assert.ok(s8.blockers.some((b) => b.complianceId === 'SAN-034' && /SAN-033/.test(b.why)));
  const rec = buildRecommendations(h, {}).find((r) => r.compliance_id === 'SAN-034'); assert.match(rec.title, /Unblock SAN-034/); assert.match(rec.recommended_action, /SAN-033/);
});

t('A record that is merely waiting its turn is not flagged as a blocker', () => {
  const h = run(w);                                   // nothing started anywhere
  assert.equal(h.cards.filter((c) => c.kind === 'blocked').length, 0);
  assert.ok(h.counts.blocked > 0, 'it is still counted as blocked for information');
  assert.equal(h.stages.filter((s) => s.status === 'Blocked').length, 0);
  assert.ok(!buildRecommendations(h, {}).some((r) => /^Unblock/.test(r.title)));
  assert.ok(h.scoreNote && /not been completed yet/.test(h.scoreNote));
});

t('Scenario 6 - Not Applicable is excluded from score and stage readiness but kept in the list', () => {
  const k = keyOf(w, 'HEA-008', 'p1');
  const before = run(w);
  const w2 = { ...w, decisions: { ...w.decisions, [k]: { status: 'Not Applicable', reason: 'No excavation on this site' } } };
  const after = run(w2);
  assert.equal(after.counts.applicable, before.counts.applicable - 1);
  assert.ok(after.excluded.some((e) => e.cid === 'HEA-008' && e.reason === 'Not applicable'));
  assert.ok(!after.included.some((r) => r.cid === 'HEA-008'));
  assert.ok(!after.stages.flatMap((s) => s.blockers).some((b) => b.complianceId === 'HEA-008'));
});

t('No double counting: one record with several problems causes one deduction', () => {
  const k = keyOf(w, 'HEA-008', 'p1');
  const docsByKey = { [k]: [{ id: 'd1', key: k, doc_name: 'Excavation Permit', doc_name_lc: 'excavation permit', version: 1, superseded: false, status: 'Verified', expiry_date: add(-5) }] };
  const h = run(w, { tracking: { [k]: { status: 'In Progress', next_due_date: add(-3) } }, docsByKey, riskOverrides: { 'HEA-008': { level: 'critical' } } });
  const all = h.deductions.flatMap((d) => d.items).filter((i) => i.cid === 'HEA-008');
  assert.equal(all.length, 1, 'deductions for this record: ' + all.length);
  assert.ok(all[0].also.length >= 1, 'the other causes are shown but not scored');
});

t('Not every overdue record is P1', () => {
  const tracking = Object.fromEntries(['SAN-001', 'HEA-008', 'EC-005'].map((c) => [keyOf(w, c, 'p1'), { status: 'In Progress', next_due_date: add(-4) }]));
  const h = run(w, { tracking, riskOverrides: { 'EC-005': { level: 'low' } } });
  const pri = buildRecommendations(h, {}).filter((r) => ['SAN-001', 'HEA-008', 'EC-005'].includes(r.compliance_id)).map((r) => r.priority);
  assert.ok(pri.length === 3 && !pri.every((p) => p === 'P1'), pri.join(','));
});

t('Weights, factors and bands are configurable and the score stays inside 0..100', () => {
  const tracking = Object.fromEntries(keys.slice(0, 20).map((k) => [k, { status: 'Compliant / Completed' }]));
  const docsByKey = verifiedDocs(w, keys.slice(0, 20));
  const a = run(w, { tracking, docsByKey });
  const b = run(w, { tracking, docsByKey, settings: { factors: { not_started: 0.5 } } });
  assert.ok(b.score > a.score, `${b.score} > ${a.score}`);
  const c = run(w, { tracking, docsByKey, settings: { bands: { healthy: 10, good: 5, attention: 3, at_risk: 1 } } });
  assert.equal(c.category, 'Healthy');
  for (const h of [a, b, c]) assert.ok(h.score >= 0 && h.score <= 100);
});

t('Different projects are scored from their own records only', () => {
  const w3 = world(); const k = keyOf(w3, 'SAN-001', 'p1');
  const h1 = run(w3, { tracking: { [k]: { status: 'Compliant / Completed' } } }), h2 = run(w3);
  assert.ok(h1.score >= h2.score); assert.ok(h1.included.every((r) => r.key.endsWith('__p1') || r.key.includes('ph1') || r.key.includes('bA') || r.key.includes('bB')));
});

t('Score explanation is complete: every record is either included or excluded with a reason', () => {
  const h = run(w);
  assert.equal(h.included.length + h.excluded.length, w.insts.length);
  assert.ok(h.excluded.every((e) => e.reason && e.detail));
  assert.ok(h.included.every((r) => r.weight > 0 && r.factor >= 0));
});

console.log(`\n${pass} tests passed${process.exitCode ? ', SOME FAILED' : ''}`);
