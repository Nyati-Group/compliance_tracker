// Tests for "prepared by us" vs "received" documents and the carry-forward stage rule (no network, no database).  Run:  node --test tests/docflow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Core } from '../generate.mjs';
import { stageAllows } from '../docflow.mjs';

const origin = (n) => Core.docOrigin(n);

test('documents the company writes are "prepared"', () => {
  for (const n of ['Authorization letter', 'Application for Registration', 'Board Resolution for Authorized Representative', 'Safety Policy', 'Accident Register', 'Training Register', 'Work at Height Permit',
    'Undertaking', '8. Undertaking', 'Appointment Letter', 'Mock Drill Report', 'Form B Affidavit', 'Occupancy Certificate Application', 'Compliance Affidavit filed with RERA Authority', 'Indemnity Bond', 'Log Book'])
    assert.equal(origin(n), 'prepared', n);
});
test('documents issued by an authority or another party are "received"', () => {
  for (const n of ['Fire NOC', 'Provisional Fire NOC', 'Commencement certificate', 'Lift Licence', 'RERA Registration Certificate', 'Form C Registration Certificate', '7/12 Extract', 'Sanction Layout', 'Challan', 'Insurance policy',
    'Test Certificates', 'Copy of NOC', 'Form 3 CA Certificate', 'MGT-14', 'Committee Order', 'Water NOC', 'CC Copy', 'Title Search', 'Passport details', 'Aadhaar'])
    assert.equal(origin(n), 'received', n);
});
test('empty or placeholder names are received (nothing to prepare)', () => { for (const n of ['', '-', 'NA', 'Documents', null]) assert.equal(origin(n), 'received'); });
test('every document named in the register gets an origin', () => {
  const items = JSON.parse(fs.readFileSync(new URL('../../shared/items.json', import.meta.url), 'utf8'));
  const names = new Set(); for (const i of items) for (const n of Core.requiredDocs(i)) names.add(n);
  assert.ok(names.size > 300);
  const prepared = [...names].filter((n) => origin(n) === 'prepared').length;
  assert.ok(prepared > 80 && prepared < names.size - 80, `prepared=${prepared} of ${names.size}`);
});
test('a document goes to the same or a later stage, never an earlier one', () => {
  assert.equal(stageAllows('S2', 'S2'), true);
  assert.equal(stageAllows('S2', 'S4'), true);
  assert.equal(stageAllows('S4', 'S2'), false);
  assert.equal(stageAllows(undefined, 'S1'), true);   // an unmapped stage never blocks
  assert.equal(stageAllows('S3', 'Sx'), true);
});
