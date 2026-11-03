// Tests for the Real Estate Compliance checklist records (CHK-001..209) and the project-type setup questions. No network, no database.
// Run:  node --test tests/checklist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Core } from '../generate.mjs';

const read = (f) => JSON.parse(fs.readFileSync(new URL('../../app/' + f, import.meta.url), 'utf8'));
const items = read('items.json'), cat = read('applicability.json'), stages = read('stages.json');
const chk = items.filter((i) => /^CHK-\d+$/.test(i.compliance_id));
const byId = Object.fromEntries(items.map((i) => [i.compliance_id, i]));
const project = (facts) => ({ company: null, project: { category: 'real_estate', facts }, building: null });
const ev = (id, facts) => Core.evaluate(cat, byId[id], project(facts)).status;

test('the register holds the original 306 records plus the 209 checklist records, with unique ids', () => {
  assert.equal(items.length, 515);
  assert.equal(chk.length, 209);
  assert.equal(new Set(items.map((i) => i.compliance_id)).size, 515);
  assert.equal(chk.filter((i) => i.source_track === 'New Project').length, 95);
  assert.equal(chk.filter((i) => i.source_track === 'Redevelopment').length, 114);
});
test('every checklist record has a stage, a level, original text and is conditional on the project type', () => {
  const sid = new Set(stages.map((s) => s.id));
  for (const i of chk) {
    assert.ok(sid.has(i.stage_id) && i.stage_id !== 'UNMAPPED', `${i.compliance_id} stage`);
    assert.ok(i.compliance_level, `${i.compliance_id} level`);
    assert.ok(i.brief_description && i.action_required, `${i.compliance_id} text`);
    assert.equal(i.applicability_default, 'Conditional', i.compliance_id);
    assert.ok((cat.item_flags[i.compliance_id] || []).length, `${i.compliance_id} has a setup rule`);
    assert.equal(i.legal_validation_status, 'Legal Validation Required');
  }
});
test('a new-development project: new-project records apply, redevelopment records do not', () => {
  assert.equal(ev('CHK-001', { redevelopment_project: false }), 'Applicable');
  assert.equal(ev('CHK-096', { redevelopment_project: false }), 'Not Applicable');
  assert.equal(ev('CHK-108', { redevelopment_project: false }), 'Not Applicable');
});
test('a redevelopment project: the reverse, and a track-tagged record also needs its track', () => {
  assert.equal(ev('CHK-001', { redevelopment_project: true }), 'Not Applicable');
  assert.equal(ev('CHK-096', { redevelopment_project: true }), 'Applicable');         // [ALL]
  assert.equal(ev('CHK-108', { redevelopment_project: true }), 'Pending Review');      // [CHS]: track not answered yet
  assert.equal(ev('CHK-108', { redevelopment_project: true, redev_chs: true }), 'Applicable');
  assert.equal(ev('CHK-108', { redevelopment_project: true, redev_chs: false }), 'Not Applicable');
  assert.equal(ev('CHK-114', { redevelopment_project: true, redev_mhada: true }), 'Applicable');
  assert.equal(ev('CHK-116', { redevelopment_project: true, redev_sra: false }), 'Not Applicable');
  assert.equal(ev('CHK-117', { redevelopment_project: true, redev_tenanted: true }), 'Applicable');
  assert.equal(ev('CHK-113', { redevelopment_project: true, redev_cluster: true }), 'Applicable');
});
test('until the project type is answered every checklist record waits for review', () => {
  assert.equal(ev('CHK-001', {}), 'Pending Review');
  assert.equal(ev('CHK-096', {}), 'Pending Review');
  const r = Core.evaluate(cat, byId['CHK-001'], project({ redevelopment_project: false }));
  assert.match(r.reason, /not: Redevelopment project/);
  assert.match(Core.evaluate(cat, byId['CHK-001'], project({ redevelopment_project: true })).reason, /is Yes/);
});
test('track questions are not asked once the project is answered "not a redevelopment"', () => {
  const data = { items, profiles: read('profiles.json'), projects: { p1: { category: 'real_estate', company_id: 'c1' } }, companies: { c1: {} }, phases: { ph1: { project_id: 'p1', name: 'A' } }, buildings: {} };
  const ent = (facts) => ({ company: null, project: { facts }, building: null });
  const ask = (facts) => Core.missingFacts(data, cat, 'project', data.projects.p1, ent(facts), { projectId: 'p1' });
  assert.ok(ask({}).includes('redevelopment_project') && ask({}).includes('redev_chs'));
  const afterNo = ask({ redevelopment_project: false });
  assert.ok(!afterNo.includes('redev_chs') && !afterNo.includes('redev_sra') && !afterNo.includes('redevelopment_project'));
  assert.ok(ask({ redevelopment_project: true }).includes('redev_chs'));
});
test('a real-estate project tracks project-, phase- and building-level checklist records; an EPC project tracks none', () => {
  const data = { items, profiles: read('profiles.json'), projects: { p1: { category: 'real_estate', company_id: 'c1' }, e1: { category: 'epc', company_id: 'c1' } }, companies: { c1: {} },
    phases: { ph1: { project_id: 'p1', name: 'A' }, ph2: { project_id: 'p1', name: 'B' } }, buildings: { b1: { project_id: 'p1', phase_id: 'ph1', name: 'T1' } } };
  const lvl = (l) => chk.filter((i) => i.compliance_level === l).length;
  const mine = Core.enumerate(data, { projectId: 'p1' }).filter((x) => /^CHK-/.test(x.item.compliance_id));
  assert.equal(mine.length, lvl('Project Level') + 2 * lvl('Phase Level') + lvl('Building Level'));
  assert.equal(Core.enumerate(data, { projectId: 'e1' }).filter((x) => /^CHK-/.test(x.item.compliance_id)).length, 0);
});
test('checklist records that restate an existing record are linked to it', () => {
  assert.equal(byId['CHK-060'].duplicate_group, 'RERA registration before marketing');
  assert.ok(items.filter((i) => i.duplicate_group === 'RERA registration before marketing').map((i) => i.compliance_id).includes('SAN-029'));
  assert.equal(byId['SAN-006'].duplicate_group, 'Provisional / final Fire NOC');
});
test('the original 306 records are untouched', () => {
  assert.equal(items.slice(0, 306).filter((i) => /^CHK-/.test(i.compliance_id)).length, 0);
  assert.equal(byId['SAN-016'].brief_description, 'Basic + Ancillary FSI Sanction');
  assert.equal(byId['MEP-001'].stage_id, 'S5');
});
