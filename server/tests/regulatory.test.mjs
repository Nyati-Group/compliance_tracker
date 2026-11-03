// Pure-logic tests for Regulatory Updates (no network, no database).  Run:  node --test tests/regulatory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyArchive, validateAnalysis, matchImpacts, urlKey, circKey, nextIstRun, extractCandidates, assertPublicUrl, htmlToText, isoDate, effectiveStatus, parseJsonLoose } from '../regulatory.mjs';

const STAGES = [{ id: 'S0', name: 'Stage 0' }, { id: 'S2', name: 'Stage 2' }, { id: 'S3', name: 'Stage 3' }];
const DOC = 'MAHARERA CIRCULAR No. 52/2026. All promoters shall upload quarterly progress updates on the portal before 30 November 2026. Non-compliance may attract action under Section 63.';
const good = () => ({
  relevant: true, title: 'Quarterly progress updates', authority: 'MahaRERA', document_type: 'Circular', circular_number: 'No. 52/2026', publication_date: '2026-10-01', effective_date: '2026-11-01',
  category: 'RERA', jurisdiction: { scope: 'state', places: ['Maharashtra'] }, what_changed: 'Quarterly uploads required.', summary: 'Promoters must upload quarterly progress.', compliance_implications: ['Quarterly upload'],
  affected_activities: ['RERA reporting'], affected_stages: ['S3', 'S9'], affected_project_categories: ['real_estate'], affected_project_types: [], laws_referenced: ['RERA 2016'],
  deadlines: [{ description: 'Upload before 30 November 2026', date: '2026-11-30', evidence: 'upload quarterly progress updates on the portal before 30 November 2026' }],
  recommended_actions: ['Prepare the upload'], creates_mandatory_obligation: true, needs_legal_review: false, priority: 'Critical', priority_reason: 'Binding with deadline',
  evidence: [{ quote: 'All promoters shall upload quarterly progress updates', supports: 'obligation' }], uncertainties: [], confidence: 'high'
});

test('valid analysis keeps verified facts and drops unknown stage ids', () => {
  const { analysis: a } = validateAnalysis(good(), DOC, { stages: STAGES });
  assert.equal(a.circular_number, 'No. 52/2026');
  assert.deepEqual(a.affected_stages, ['S3']);
  assert.equal(a.deadlines.length, 1);
  assert.equal(a.priority, 'Critical');
});
test('invented circular number is removed', () => {
  const g = good(); g.circular_number = 'No. 99/2031';
  const { analysis: a, notes } = validateAnalysis(g, DOC, { stages: STAGES });
  assert.equal(a.circular_number, null);
  assert.ok(notes.some((n) => /Circular number/.test(n)));
});
test('deadline without a quote from the document is discarded', () => {
  const g = good(); g.deadlines = [{ description: 'Pay a fee by 1 Jan', date: '2027-01-01', evidence: 'the fee must be paid by the first of January' }];
  const { analysis: a } = validateAnalysis(g, DOC, { stages: STAGES });
  assert.equal(a.deadlines.length, 0);
  assert.notEqual(a.priority, 'Critical');          // Critical needs a verified deadline
});
test('invalid dates become null, not guessed', () => {
  const g = good(); g.publication_date = '31/02/2026'; g.effective_date = '2026-13-40';
  const { analysis: a } = validateAnalysis(g, DOC, { stages: STAGES });
  assert.equal(a.publication_date, null); assert.equal(a.effective_date, null);
  assert.equal(isoDate('2026-02-30'), null);
});
test('no verifiable evidence lowers confidence and caps priority', () => {
  const g = good(); g.evidence = [{ quote: 'text that is not in the document anywhere', supports: 'x' }]; g.deadlines = []; g.priority = 'High';
  const { analysis: a } = validateAnalysis(g, DOC, { stages: STAGES });
  assert.equal(a.confidence, 'low'); assert.equal(a.priority, 'Medium');
});
test('general information is never mandatory and is low priority', () => {
  const g = good(); g.document_type = 'General Information'; g.priority = 'Critical';
  const { analysis: a } = validateAnalysis(g, DOC, { stages: STAGES });
  assert.equal(a.creates_mandatory_obligation, false); assert.equal(a.priority, 'Low');
});
test('court judgments always need legal review; advisories cannot be High', () => {
  let g = good(); g.document_type = 'Court Judgment';
  assert.equal(validateAnalysis(g, DOC, { stages: STAGES }).analysis.needs_legal_review, true);
  g = good(); g.document_type = 'Advisory'; g.priority = 'High';
  assert.equal(validateAnalysis(g, DOC, { stages: STAGES }).analysis.priority, 'Medium');
});
test('garbage from the AI cannot crash validation or smuggle fields', () => {
  const { analysis: a } = validateAnalysis({ priority: 'URGENT!!', document_type: 'Hack', deadlines: 'x', evidence: [null, 5], title: { a: 1 }, __proto__: { admin: true }, impacts: [{ project_id: 'p1' }] }, DOC, { stages: STAGES, titleHint: 'Hint title' });
  assert.equal(a.title, 'Hint title'); assert.equal(a.document_type, 'General Information'); assert.equal(a.impacts, undefined); assert.equal(a.admin, undefined);
});
test('parseJsonLoose handles code fences', () => assert.equal(parseJsonLoose('```json\n{"a":1}\n```').a, 1));

const projects = [
  { _id: 'p_pune', name: 'Pune Tower', company_id: 'c1', category: 'real_estate', location: 'Baner, Pune', planning_authority: 'PMC', current_stage: 'S3' },
  { _id: 'p_bihar', name: 'Medical College - Bhojpur, Bihar', company_id: 'c1', category: 'epc', location: 'Bhojpur, Bihar' },
  { _id: 'p_blank', name: 'Nyati Blank', company_id: 'c1', category: 'real_estate' },
  { _id: 'p_pcmc', name: 'PCMC Site', company_id: 'c1', category: 'real_estate', location: 'Wakad', planning_authority: 'PCMC' }
];
const A = (over) => ({ ...validateAnalysis(good(), DOC, { stages: STAGES }).analysis, ...over });
const by = (imps) => Object.fromEntries(imps.map((i) => [i.project_id, i.system_status]));

test('Maharashtra update: Pune applies, Bihar does not, blank project needs information', () => {
  const s = by(matchImpacts(A({}), projects));
  assert.equal(s.p_pune, 'Potentially Applicable'); assert.equal(s.p_bihar, 'Not Applicable'); assert.equal(s.p_blank, 'Insufficient Information');
});
test('category mismatch is Not Applicable even in the right state', () => {
  const s = by(matchImpacts(A({ affected_project_categories: ['epc'] }), projects));
  assert.equal(s.p_pune, 'Not Applicable');
});
test('named authority matches the project planning authority (with alias)', () => {
  const s = by(matchImpacts(A({ jurisdiction: { scope: 'authority', places: ['Pimpri Chinchwad Municipal Corporation'] }, affected_project_categories: [] }), projects));
  assert.equal(s.p_pcmc, 'Potentially Applicable'); assert.equal(s.p_pune, 'Not Applicable'); assert.equal(s.p_blank, 'Insufficient Information');
});
test('national scope applies everywhere in category', () => {
  const s = by(matchImpacts(A({ jurisdiction: { scope: 'national', places: [] } }), projects));
  assert.equal(s.p_pune, 'Potentially Applicable'); assert.equal(s.p_blank, 'Potentially Applicable');
});
test('court judgment => Legal Review Required for projects that could be affected', () => {
  const s = by(matchImpacts(A({ document_type: 'Court Judgment', needs_legal_review: true }), projects));
  assert.equal(s.p_pune, 'Legal Review Required'); assert.equal(s.p_bihar, 'Not Applicable');
});
test('informational or irrelevant documents produce no project impacts', () => {
  assert.deepEqual(matchImpacts(A({ document_type: 'General Information' }), projects), []);
  assert.deepEqual(matchImpacts(A({ relevant: false }), projects), []);
});
test('human decision overrides the system suggestion', () => {
  const [i] = matchImpacts(A({}), [projects[0]]);
  assert.equal(effectiveStatus(i), 'Potentially Applicable');
  assert.equal(effectiveStatus({ ...i, decision: { status: 'Not Applicable' } }), 'Not Applicable');
});
test('matching never leaks project data into the analysis object', () => {
  const imps = matchImpacts(A({}), projects);
  assert.ok(imps.every((i) => i.reason && !/undefined/.test(i.reason)));
});

test('old documents found on a listing are background info: Low priority, flagged archive', () => {
  const old = applyArchive({ publication_date: '2011-08-25', detected_at: '2026-10-28T10:00:00Z', priority: 'High', priority_reason: 'x', origin: 'monitor' }, 180);
  assert.equal(old, true);
  const fresh = { publication_date: '2026-10-01', detected_at: '2026-10-28T10:00:00Z', priority: 'High', origin: 'monitor' };
  assert.equal(applyArchive(fresh, 180), false); assert.equal(fresh.priority, 'High');
  const unknown = { publication_date: null, detected_at: '2026-10-28T10:00:00Z', priority: 'High', origin: 'monitor' };
  assert.equal(applyArchive(unknown, 180), false);
  const manual = { publication_date: '2015-01-01', detected_at: '2026-10-28T10:00:00Z', priority: 'High', origin: 'manual' };
  assert.equal(applyArchive(manual, 180), false);          // an admin deliberately adding a document is never treated as archive
});
test('url and circular keys normalise duplicates', () => {
  assert.equal(urlKey('https://www.Example.gov.in/a/b.pdf#x'), urlKey('https://example.gov.in/a/b.pdf'));
  assert.equal(circKey('MahaRERA', 'No. 52/2026'), circKey('mahaRERA', 'no 52 2026'));
  assert.equal(circKey('MahaRERA', null), null);
});
test('08:00 IST scheduling', () => {
  const t = (iso) => new Date(nextIstRun(Date.parse(iso))).toISOString();
  assert.equal(t('2026-10-28T01:00:00Z'), '2026-10-28T02:30:00.000Z');   // 06:30 IST -> 08:00 IST today
  assert.equal(t('2026-10-28T03:00:00Z'), '2026-10-29T02:30:00.000Z');   // 08:30 IST -> tomorrow
  assert.equal(t('2026-10-28T20:00:00Z'), '2026-10-29T02:30:00.000Z');   // 01:30 IST next day -> 08:00 that day
});
test('listing: PDFs found, tenders and recruitment skipped, include pattern respected', () => {
  const html = '<a href="/x/circular/1.pdf">Circular on fees</a><a href="/x/tender/2.pdf">Tender for works</a><a href="/y/3.pdf">Recruitment notice</a><a href="/z/other.pdf">Org chart</a><a href="javascript:alert(1)">bad</a><a href="/page">Not a pdf</a>';
  assert.deepEqual(extractCandidates(html, 'text/html', 'https://a.gov.in/list', {}).map((c) => c.title), ['Circular on fees', 'Org chart']);
  assert.deepEqual(extractCandidates(html, 'text/html', 'https://a.gov.in/list', { include: 'circular' }).map((c) => c.title), ['Circular on fees']);
});
test('RSS items are read', () => {
  const rss = '<rss><channel><item><title>New notification</title><link>https://a.gov.in/n1.pdf</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const c = extractCandidates(rss, 'application/rss+xml', 'https://a.gov.in/feed', {});
  assert.equal(c.length, 1); assert.equal(c[0].date, '2026-10-26');
});
test('private network targets are refused', async () => {
  for (const u of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.1.2.3/', 'http://192.168.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'ftp://example.com/', 'https://user:pw@example.com/'])
    await assert.rejects(assertPublicUrl(u), undefined, u);
});
test('html to text drops scripts and tags', () => {
  const t = htmlToText('<html><script>evil()</script><body><p>Hello &amp; welcome</p><style>x{}</style></body></html>');
  assert.equal(t, 'Hello & welcome');
});
