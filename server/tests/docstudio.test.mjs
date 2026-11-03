// Tests for the Documents logic (no network, no database).  Run:  node --test tests/docstudio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TEMPLATES, cleanVariables, cleanValues, prefill, renderTemplateText, validateReview, reviewDocument, basicChecks, reportText, prettyDate, readUpload } from '../docstudio.mjs';
import { buildDocx, docxText, tokensIn } from '../docx.mjs';

const sample = (v) => ({ date: '2026-11-03', email: 'a@b.co', phone: '+91 98765 43210', number: '120', multiline: 'First line\nSecond line', select: v.options?.[0], text: `Sample ${v.label}` }[v.type]);
const allValues = (t) => Object.fromEntries(t.variables.map((v) => [v.key, sample(v)]));

test('every ready-made template: variables match the body, and a full fill leaves no markers', () => {
  assert.ok(BUILTIN_TEMPLATES.length >= 8);
  for (const t of BUILTIN_TEMPLATES) {
    const used = new Set(tokensIn(t.body)), declared = new Set(t.variables.map((v) => v.key));
    assert.deepEqual([...used].filter((k) => !declared.has(k)), [], `${t.name}: tokens without a variable`);
    assert.deepEqual([...declared].filter((k) => !used.has(k)), [], `${t.name}: variables not used in the body`);
    const { values, problems, missing } = cleanValues(t.variables, allValues(t));
    assert.deepEqual([problems, missing], [[], []], t.name);
    const out = renderTemplateText(t.body, t.variables, values);
    assert.ok(!/\{\{|undefined|\[object|~[a-z_]+~/.test(out), `${t.name}: leftover marker in\n${out}`);
    assert.match(out, /Sample|3 November 2026/);
  }
});
test('unfilled required values show as [Label]; empty optional ones disappear with their line', () => {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:authorisation-letter');
  const out = renderTemplateText(t.body, t.variables, { company_name: 'Nyati Group', project_name: 'Elenor' });
  assert.match(out, /\[Addressed to \(authority \/ officer\)\]/); assert.match(out, /We, Nyati Group, the promoter of the project "Elenor"/);
  assert.ok(!/valid until|Place:|RERA registration no/.test(out));   // optional lines with no value are left out
});
test('dates are written out and declaration points are numbered', () => {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:declaration-undertaking');
  const out = renderTemplateText(t.body, t.variables, { ...cleanValues(t.variables, allValues(t)).values, declaration_points: 'The land is free of dispute\n2) Plans are as sanctioned' });
  assert.match(out, /1\. The land is free of dispute\n2\. Plans are as sanctioned/); assert.match(out, /Date: 3 November 2026/);
  assert.equal(prettyDate('2026-02-30'.replace('30', '03')), '3 February 2026');
});
test('values are checked: bad date / email / phone / option are refused, blanks are reported as missing', () => {
  const vars = cleanVariables([{ key: 'd', label: 'Date', type: 'date' }, { key: 'e', label: 'Email', type: 'email' }, { key: 'p', label: 'Phone', type: 'phone' }, { key: 's', label: 'Kind', type: 'select', options: ['A', 'B'] }, { key: 'o', label: 'Optional', required: false }, { key: 'r', label: 'Req' }]);
  const r = cleanValues(vars, { d: '31/02/2026', e: 'nope', p: 'abc', s: 'C', o: '' });
  assert.equal(r.problems.length, 4); assert.deepEqual(r.missing, ['r']);
  assert.deepEqual(cleanValues(vars, { d: '2026-02-03', e: 'x@y.in', p: '+91 20 2555 1234', s: 'B', r: 'ok' }).values, { d: '2026-02-03', e: 'x@y.in', p: '+91 20 2555 1234', s: 'B', r: 'ok' });
  assert.equal(cleanValues(vars, { r: 'x'.repeat(5000) }).values.r.length, 400);
});
test('variables from the browser are cleaned: bad keys, duplicates, unknown sources and types are dropped or reset', () => {
  const v = cleanVariables([{ key: 'Good_1', label: 'A' }, { key: 'good_1' }, { key: '1bad' }, { key: 'x y' }, { key: 'ok', type: 'weird', source: 'db.passwords', label: '<b>L</b>', evil: 1 }, null, 'str']);
  assert.deepEqual(v.map((x) => x.key), ['good_1', 'ok']); assert.equal(v[1].type, 'text'); assert.equal(v[1].source, null); assert.equal(v[1].evil, undefined);
});
test('known values are filled from the project and company', () => {
  const vars = cleanVariables([{ key: 'a', label: 'A', source: 'company.name' }, { key: 'b', label: 'B', source: 'project.name' }, { key: 'c', label: 'C', source: 'project.rera_no' }, { key: 'd', label: 'D', source: 'today' }, { key: 'e', label: 'E' }]);
  assert.deepEqual(prefill(vars, { project: { name: 'Elenor', rera_no: '' }, company: { name: 'Nyati' }, user: { name: 'Asha' }, today: '2026-11-03' }), { a: 'Nyati', b: 'Elenor', d: '2026-11-03' });
});

/* ---------- review ---------- */
const DOC = 'Application for Commencement Certificate\nDate: 3 November 2026\nWe, Nyati Group, request a commencement certificate for Elenor. The architect certificate is enclosed.\nYours faithfully, authorised signatory';
const RULES = [{ tag: 'R1', label: 'UDCPR, p.12', text: '…' }, { tag: 'C1', label: 'Master sheet SAN-001', text: '…' }];
const raw = () => ({ document_type: 'Application', purpose: 'Ask for CC', summary: 'An application.', readiness: 'Ready to submit', readiness_reason: 'ok',
  checks: [{ requirement: 'Architect certificate enclosed', status: 'Met', evidence: 'The architect certificate is enclosed', rule_ref: 'R1', note: '' }, { requirement: 'Structural report', status: 'Met', evidence: 'structural report attached', rule_ref: 'R9', note: 'x' }, { requirement: 'Title documents', status: 'Missing', evidence: '', rule_ref: 'C1', note: '' }],
  suggested_changes: [{ priority: 'High', issue: 'Add RERA number', current_text: 'We, Nyati Group, request', suggested_text: 'We, Nyati Group (RERA no. ...), request', rule_ref: 'R1' }, { priority: 'Low', issue: 'Typo', current_text: 'text that is not there', suggested_text: 'x', rule_ref: '' }],
  missing_information: ['Survey number'], cautions: [] });
test('review keeps verified quotes and known rule tags, and drops invented ones', () => {
  const { result, notes } = validateReview(raw(), DOC, RULES);
  assert.equal(result.checks[0].status, 'Met'); assert.equal(result.checks[0].evidence, 'The architect certificate is enclosed'); assert.deepEqual(result.checks[0].rule, { tag: 'R1', label: 'UDCPR, p.12' });
  assert.equal(result.checks[1].status, 'Unclear'); assert.equal(result.checks[1].rule, null); assert.match(result.checks[1].note, /General practice - verify/);   // quote not in document, tag not supplied
  assert.equal(result.suggested_changes[0].current_text, 'We, Nyati Group, request'); assert.equal(result.suggested_changes[1].current_text, '');
  assert.ok(notes.length >= 2);
});
test('"Ready to submit" is not kept when something is missing or a high-priority change exists', () => {
  assert.equal(validateReview(raw(), DOC, RULES).result.readiness, 'Needs changes');
  const clean = { ...raw(), checks: [], suggested_changes: [] }; assert.equal(validateReview(clean, DOC, RULES).result.readiness, 'Ready to submit');
});
test('garbage from the AI cannot crash review or smuggle fields', () => {
  const { result } = validateReview({ readiness: 'Perfect', checks: 'x', suggested_changes: [null, 5, { issue: '' }], document_type: { a: 1 }, __proto__: { admin: 1 }, extra: 1 }, DOC, RULES);
  assert.equal(result.readiness, 'Cannot assess'); assert.deepEqual(result.checks, []); assert.equal(result.extra, undefined); assert.equal(result.document_type, 'Not identified');
  assert.doesNotThrow(() => validateReview(null, DOC, RULES)); assert.doesNotThrow(() => validateReview('text', DOC, RULES));
});
test('reviewDocument: the prompt carries the rules and the document, and the answer is validated', async () => {
  let seen;
  const r = await reviewDocument({ provider: 'x', apiKey: 'k', model: 'm' }, { text: DOC, docType: 'CC application', project: { name: 'Elenor', location: 'Pune' }, company: { name: 'Nyati' } }, {
    retrieve: () => ({ docs: [{ label: 'UDCPR, p.12', text: 'Commencement certificate rules' }], items: [{ label: 'Master sheet SAN-001', text: 'SAN-001 | ...' }] }),
    ask: async (a) => { seen = a; return { text: '```json\n' + JSON.stringify(raw()) + '\n```', model: 'm' }; } });
  assert.match(seen.prompt, /\[R1\] UDCPR, p\.12/); assert.match(seen.prompt, /\[C1\] Master sheet SAN-001/); assert.match(seen.prompt, /<document>[\s\S]*Nyati Group[\s\S]*<\/document>/); assert.match(seen.prompt, /Project: Elenor/); assert.match(seen.system, /untrusted/);
  assert.equal(r.result.checks[0].rule.label, 'UDCPR, p.12'); assert.deepEqual(r.rules_used.sort(), ['Master sheet SAN-001', 'UDCPR, p.12']);
  await assert.rejects(reviewDocument({}, { text: DOC }, { retrieve: () => ({ docs: [], items: [] }), ask: async () => ({ text: 'not json at all', model: 'm' }) }), /unreadable/);
});
test('a very long document is cut for the AI and flagged', async () => {
  const r = await reviewDocument({}, { text: 'word '.repeat(10000) }, { retrieve: () => ({ docs: [], items: [] }), ask: async (a) => { assert.match(a.prompt, /cut here for length/); return { text: '{}', model: 'm' }; } });
  assert.equal(r.truncated, true);
});
test('basic checks need no AI', () => {
  const b = basicChecks('Dear Sir, project ______ at [Location] dated ....... .');
  assert.ok(b.some((x) => /blank or placeholder/.test(x.text)) && b.some((x) => /No signature/.test(x.text)) && b.some((x) => /No date/.test(x.text)));
  assert.deepEqual(basicChecks(DOC + ' '.repeat(10) + 'x'.repeat(300)).filter((x) => x.level === 'warn'), []);
});
test('the report lists checks, changes and the caution line', () => {
  const a = { file_name: 'a.docx', created_at: '2026-11-03T10:00:00Z', project_name: 'Elenor', basic: [{ text: 'No date' }], ai: { ok: true, result: validateReview(raw(), DOC, RULES).result } };
  const t = reportText(a); assert.match(t, /Overall: Needs changes/); assert.match(t, /\[Missing\] Title documents \(Master sheet SAN-001\)/); assert.match(t, /\[High\] Add RERA number/); assert.match(t, /not legal advice/);
  assert.match(reportText({ ...a, ai: { ok: false } }), /AI review was not available/);
});
test('reading an upload: docx and text work, other types and scans without AI are refused', async () => {
  const d = await buildDocx('# Letter\nHello there'); assert.match((await readUpload(d, 'x.docx', null)).text, /Hello there/);
  assert.equal((await readUpload(Buffer.from('plain words'), 'a.txt', null)).kind, 'text');
  await assert.rejects(readUpload(Buffer.from('x'), 'a.exe', null), /Word \(\.docx\), PDF or text/);
  await assert.rejects(readUpload(Buffer.from('%PDF-1.4 broken'), 'a.pdf', null), /scan and the AI service is not set up/);
});
