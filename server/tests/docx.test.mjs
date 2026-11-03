// Tests for the .docx engine (no network, no database).  Run:  node --test tests/docx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildDocx, docxText, makeDocxTemplate, makeTextTemplate, fillDocx, fillText, addFieldToDocx, addFieldToText, removeFieldFromDocx, tokensIn, mapParagraphs, guessType, guessSource, openDocx } from '../docx.mjs';

const keys = (vars) => vars.map((v) => v.key);
const byLabel = (vars) => Object.fromEntries(vars.map((v) => [v.label, v]));

test('blanks take their label from the words before them', () => {
  const { text, variables } = makeTextTemplate('Name of the project: ____________\nRERA Registration No: ..........\nDate: ______\nI, ________ son of ________ residing at ________');
  const l = byLabel(variables);
  assert.ok(l['Name of the project'] && l['RERA Registration No'] && l['Date']);
  assert.equal(l['Name of the project'].source, 'project.name');
  assert.equal(l['RERA Registration No'].source, 'project.rera_no');
  assert.equal(l['Date'].type, 'date');
  assert.match(text, /^Name of the project: \{\{name_of_the_project\}\}/);
  assert.deepEqual(variables.map((v) => v.label), ['Name of the project', 'RERA Registration No', 'Date', 'Name', 'Son of', 'Residing at']);
});
test('square and angle placeholders are found and {{tokens}} are kept', () => {
  const { text, variables } = makeTextTemplate('To, [Name of Authority]\nProject <Project Name> at {{location}}\nSee [1] and [Annexure] for [ ] boxes');
  assert.deepEqual(keys(variables).sort(), ['annexure', 'location', 'name_of_authority', 'project_name'].sort());
  assert.match(text, /^To, \{\{name_of_authority\}\}/m);
  assert.match(text, /See \[1\]/);                          // a citation number is not a field
});
test('the same label is one variable used several times', () => {
  const { variables } = makeTextTemplate('Project name: ____\nBody text.\nProject name: ______');
  assert.equal(variables.length, 1); assert.equal(variables[0].count, 2);
});
test('a table-of-contents leader line is not a blank', () => {
  assert.equal(makeTextTemplate('Chapter 1 ............ 12').variables.length, 0);
});
test('type and source guesses', () => {
  assert.equal(guessType('Email address'), 'email'); assert.equal(guessType('Mobile no'), 'phone'); assert.equal(guessType('Plot area in sq m'), 'number'); assert.equal(guessType('Project address'), 'multiline');
  assert.equal(guessSource('Name of Company'), 'company.name'); assert.equal(guessSource('Planning Authority'), 'project.planning_authority'); assert.equal(guessSource('Name of the applicant'), null);
});

test('docx round trip: detect, fill, read back', async () => {
  const src = await buildDocx('# Application\n\nName of the project: ________\nCompany: [Company Name]\n\n| Applicant | ______ |');
  const { buffer, variables } = await makeDocxTemplate(src);
  assert.ok(keys(variables).includes('company_name') && keys(variables).includes('name_of_the_project'));
  const t = (await docxText(buffer)).text; assert.match(t, /\{\{name_of_the_project\}\}/);
  const filled = await fillDocx(buffer, (k) => ({ name_of_the_project: 'Nyati <Elenor> & Co', company_name: 'Nyati Group' }[k] ?? null));
  const out = (await docxText(filled)).text;
  assert.match(out, /Name of the project: Nyati <Elenor> & Co/); assert.match(out, /Company: Nyati Group/);
  assert.match(out, /\{\{applicant\}\}/);                    // unfilled stays a marker the caller can show as [Applicant]
  await openDocx(filled);                                     // still a valid zip with document.xml
});
test('a phrase split over several runs is still found and replaced, keeping the text around it', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', '<w:document xmlns:w="x"><w:body><w:p><w:pPr/><w:r><w:rPr><w:b/></w:rPr><w:t>Project: [Proj</w:t></w:r><w:r><w:t xml:space="preserve">ect Na</w:t></w:r><w:r><w:t>me] is here.</w:t></w:r></w:p><w:p/><w:p w:rsidR="1"/><w:p><w:r><w:t>Last</w:t></w:r></w:p></w:body></w:document>');
  const { buffer, variables } = await makeDocxTemplate(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(keys(variables), ['project_name']);
  assert.equal((await docxText(buffer)).text, 'Project: {{project_name}} is here.\nLast');
  const filled = await fillDocx(buffer, () => 'Elenor');
  assert.equal((await docxText(filled)).text, 'Project: Elenor is here.\nLast');
  const xml = await (await JSZip.loadAsync(filled)).file('word/document.xml').async('string');
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Project: Elenor/);   // formatting of the first run is kept
});
test('a multi-line value becomes line breaks', async () => {
  const { buffer } = await makeDocxTemplate(await buildDocx('Address: ______'));
  const filled = await fillDocx(buffer, () => 'Line one\nLine two');
  const xml = await (await JSZip.loadAsync(filled)).file('word/document.xml').async('string');
  assert.match(xml, /Line one<\/w:t><w:br\/><w:t xml:space="preserve">Line two/);
});
test('add a field by its text, and take it back out', async () => {
  const src = await buildDocx('The builder, Nyati Group, agrees. Nyati Group signs.');
  const a = await addFieldToDocx(src, 'Nyati Group', 'company'); assert.equal(a.replaced, 2);
  assert.equal((await docxText(a.buffer)).text, 'The builder, {{company}}, agrees. {{company}} signs.');
  const b = await removeFieldFromDocx(a.buffer, 'company', 'Nyati Group'); assert.equal((await docxText(b)).text, 'The builder, Nyati Group, agrees. Nyati Group signs.');
  assert.deepEqual(addFieldToText('a X b X', 'X', 'k'), { text: 'a {{k}} b {{k}}', replaced: 2 });
});
test('text templates fill and report their tokens', () => {
  assert.deepEqual(tokensIn('Hi {{ A }} and {{b_2}} and {{a}}').sort(), ['a', 'b_2']);
  assert.equal(fillText('Hi {{a}} {{b}}', (k) => (k === 'a' ? 'X' : null)), 'Hi X {{b}}');
});
test('not a docx is refused with a clear message', async () => {
  await assert.rejects(openDocx(Buffer.from('hello world')), /not a \.docx/);
  await assert.rejects(openDocx(Buffer.from('PK\x03\x04garbage')), /could not be opened|not a Word/);
  const z = new JSZip(); z.file('x.txt', 'hi'); await assert.rejects(openDocx(await z.generateAsync({ type: 'nodebuffer' })), /not a Word document/);
});
test('built documents have headings, bullets and tables', async () => {
  const b = await buildDocx('# Title\n## Sub\n- one\n>> right\n| A | B |\n| 1 | 2 |');
  const t = (await docxText(b)).text; assert.match(t, /Title/); assert.match(t, /•\s+one/); assert.match(t, /A\nB\n1\n2/);
});
