// Word (.docx) support for the Documents feature: read text, find fill-in fields, swap them for {{keys}}, fill values in, and build a plain
// document from text. A .docx is a zip of XML; text lives in <w:t> nodes inside <w:p> paragraphs, and one visible phrase is often split
// over several nodes, so every edit works on the paragraph's joined text and then writes the change back across the nodes.
import JSZip from 'jszip';

const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const P_RE = /<w:p(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/w:p>/g;
const T_RE = /<w:t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/w:t>/g;
export const MAX_DOCX_BYTES = 15 * 1024 * 1024;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xmlDecode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
export const xmlEncode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export async function openDocx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw Object.assign(new Error('This is not a .docx file. Save the document as Word (.docx) and try again.'), { status: 400 });
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw Object.assign(new Error('The Word file could not be opened (it may be damaged or password-protected).'), { status: 400 }); }
  if (!zip.file('word/document.xml')) throw Object.assign(new Error('This is not a Word document.'), { status: 400 });
  return zip;
}

/** Joined text of the <w:t> nodes in one paragraph, with the node positions needed to write edits back. */
function nodesOf(pXml) {
  const nodes = []; let off = 0;
  pXml.replace(T_RE, (m, inner, idx) => { const text = xmlDecode(inner); nodes.push({ m, idx, text, s: off, e: off + text.length }); off += text.length; return m; });
  return nodes;
}
const joined = (nodes) => nodes.map((n) => n.text).join('');
const tNode = (text) => `<w:t xml:space="preserve">${xmlEncode(text).replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">')}</w:t>`;

/** Apply edits [{s,e,rep}] (positions in the joined text) to one paragraph's XML. Later edits first, so earlier positions stay valid. */
function editParagraph(pXml, nodes, edits) {
  for (const ed of [...edits].sort((a, b) => b.s - a.s)) {
    let first = true;
    for (const n of nodes) {
      if (!(n.s < ed.e && n.e > ed.s) && !(ed.s === ed.e && n.s <= ed.s && ed.s <= n.e && first)) continue;
      const a = Math.max(ed.s, n.s) - n.s, b = Math.min(ed.e, n.e) - n.s;
      n.text = n.text.slice(0, a) + (first ? ed.rep : '') + n.text.slice(Math.max(a, b));
      first = false;
    }
  }
  let i = 0;
  return pXml.replace(T_RE, () => tNode(nodes[i++].text));
}

/**
 * Walk every paragraph of the document (body, tables, headers, footers). `fn(text, prevText, part)` returns edits for that paragraph.
 * Returns the new .docx buffer. `prevText` is the paragraph before, so a blank in a table cell can take its label from the cell beside it.
 */
export async function mapParagraphs(buffer, fn) {
  const zip = await openDocx(buffer);
  for (const name of Object.keys(zip.files).filter((n) => PARTS.test(n))) {
    let xml = await zip.file(name).async('string'), prev = '';
    xml = xml.replace(P_RE, (p) => {
      const nodes = nodesOf(p), text = joined(nodes);
      const edits = text ? fn(text, prev, name) || [] : [];
      if (text.trim()) prev = text;
      return edits.length ? editParagraph(p, nodes, edits) : p;
    });
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Plain text of the document, one line per paragraph, for reading and analysis. */
export async function docxText(buffer) {
  const zip = await openDocx(buffer), lines = [];
  for (const name of Object.keys(zip.files).filter((n) => PARTS.test(n)).sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)))) {
    const xml = await zip.file(name).async('string');
    for (const p of xml.match(P_RE) || []) { const t = joined(nodesOf(p)).replace(/\s+/g, ' ').trim(); if (t) lines.push(t); }
  }
  return { lines, text: lines.join('\n') };
}

/* ------------------------------ fill-in field detection ------------------------------ */
const BLANK = /_{3,}|\.{5,}|…{2,}|\bX{4,}\b/g;
const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,40})\s*\}\}/g;
const BRACKET = /\[([^\[\]\n]{2,60})\]/g;
const ANGLE = /<([A-Za-z][^<>\n=]{1,50})>/g;
const JUNK_INNER = /^(\d+|[ivxlc]+|x|illegible|sic|…|\.+|_+|\s*)$/i;
const LABEL_STOP = new Set(['i', 'of', 'the', 'a', 'an', 'at', 'to', 'in', 'on', 'and', 'or', 'is', 'am', 'by', 'for', 'as', 'with', 'aged']);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';

function cleanLabel(raw) {
  let s = String(raw).replace(/\s+/g, ' ').replace(/[:;\-–—_.…,]+\s*$/g, '').replace(/^[\s(]+|[\s)]+$/g, '').trim();
  const words = s.split(' ');
  if (words.length > 8) s = words.slice(-8).join(' ');
  return cap(s);
}
/** A readable name for a blank, from the words just before it ("Name of the project: ____" -> "Name of the project"). */
function labelFromBefore(before, prevText) {
  const tail = before.replace(/\s+/g, ' ').trim();
  let words = tail.split(' ').filter(Boolean);
  // "I, ____ son of ____": skip lone filler words and keep the phrase that names the field
  const take = [];
  for (let i = words.length - 1; i >= 0 && take.length < 6; i--) {
    const w = words[i].replace(/[:;,.\-–—()]+$/g, '');
    if (take.length && /[.;]$/.test(words[i])) break;
    take.unshift(words[i]);
    if (/[:]$/.test(words[i]) && take.length > 1) break;
  }
  if (/^\s*(I|We|Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?|Sri)[,.\s]*$/i.test(tail)) return 'Name';
  let label = cleanLabel(take.join(' '));
  const meaningful = label.split(' ').filter((w) => !LABEL_STOP.has(w.toLowerCase().replace(/[^a-z.]/g, '')));
  if (meaningful.length === 0 && prevText) label = cleanLabel(prevText.slice(-60));
  return label;
}
export function guessType(label) {
  const l = label.toLowerCase();
  if (/\be-?mail\b/.test(l)) return 'email';
  if (/\b(phone|mobile|contact no|telephone|tel\.?)\b/.test(l)) return 'phone';
  if (/\bdate\b|\bdated\b|\bdob\b|\bvalid (till|upto|until)\b/.test(l)) return 'date';
  if (/\b(address|description|details|reason|remarks|purpose|scope|particulars|observations?|facts)\b/.test(l)) return 'multiline';
  if (/\b(amount|rs\.?|inr|fee|fees|cost|area|sq\.? ?(m|ft)|number of|no\. of|floors|units|percentage|%)\b/.test(l)) return 'number';
  return 'text';
}
/** Which saved record a field can be filled from. Only clear matches; the user can change it. */
export function guessSource(label) {
  const l = label.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(name of )?(the )?(company|developer|promoter|builder|firm|organisation|organization)( name)?$/.test(l) || /^(company|promoter|developer) name$/.test(l)) return 'company.name';
  if (/^(name of )?(the )?(real estate )?project( name)?$/.test(l) || /^project name$/.test(l)) return 'project.name';
  if (/rera (registration )?(no|number)|registration (no|number)|maharera/.test(l)) return 'project.rera_no';
  if (/(project|site|property|plot) (address|location)|^location( of (the )?(project|site))?$/.test(l)) return 'project.location';
  if (/planning authority|sanctioning authority|local authority|municipal corporation/.test(l)) return 'project.planning_authority';
  if (/^(date|dated|today)$/.test(l) || /^date of (letter|application|declaration|issue)$/.test(l)) return 'today';
  return null;
}

/**
 * Finds fill-in fields in a paragraph's text: {{key}} tokens, [Square] and <Angle> placeholders, and blanks (____ ..... ……).
 * `state` = { vars: Map(key -> variable), labels: Map(lowercased label -> key) } shared across the document.
 * Returns edits that turn each field into {{key}}.
 */
export function detectInText(text, prevText, state) {
  if (/\.{5,}\s*\d+\s*$/.test(text)) return [];                 // a table-of-contents leader line, not a blank
  const hits = [];
  const taken = (s, e) => hits.some((h) => s < h.e && e > h.s);
  for (const m of text.matchAll(TOKEN)) hits.push({ s: m.index, e: m.index + m[0].length, kind: 'token', key: m[1].toLowerCase(), label: cap(m[1].replace(/_/g, ' ')), raw: m[0] });
  for (const m of text.matchAll(BRACKET)) { if (JUNK_INNER.test(m[1].trim()) || taken(m.index, m.index + m[0].length)) continue; hits.push({ s: m.index, e: m.index + m[0].length, kind: 'bracket', label: cleanLabel(m[1]), raw: m[0] }); }
  for (const m of text.matchAll(ANGLE)) { if (taken(m.index, m.index + m[0].length)) continue; hits.push({ s: m.index, e: m.index + m[0].length, kind: 'angle', label: cleanLabel(m[1]), raw: m[0] }); }
  for (const m of text.matchAll(BLANK)) { if (taken(m.index, m.index + m[0].length)) continue; hits.push({ s: m.index, e: m.index + m[0].length, kind: 'blank', raw: m[0] }); }
  hits.sort((a, b) => a.s - b.s);
  const edits = [];
  hits.forEach((h, i) => {
    if (h.kind === 'blank') {
      const before = text.slice(i ? Math.max(hits[i - 1].e, 0) : 0, h.s);
      const alone = !text.slice(0, h.s).trim() && !text.slice(h.e).trim();
      h.label = alone ? cleanLabel(prevText || '') || 'Field' : labelFromBefore(before || text.slice(0, h.s), prevText);
      if (!h.label) h.label = 'Field';
    }
    const lk = h.label.toLowerCase();
    let key = h.kind === 'token' ? h.key : state.labels.get(lk);
    if (!key) {
      key = slug(h.label); let n = 2;
      while (state.vars.has(key) && state.vars.get(key).label.toLowerCase() !== lk) key = `${slug(h.label).slice(0, 36)}_${n++}`;
    }
    state.labels.set(lk, key);
    const v = state.vars.get(key);
    if (v) { v.count++; }
    else state.vars.set(key, { key, label: h.label, type: guessType(h.label), required: true, source: guessSource(h.label), original: h.raw, count: 1 });
    edits.push({ s: h.s, e: h.e, rep: `{{${key}}}` });
  });
  return edits;
}
export const newState = () => ({ vars: new Map(), labels: new Map() });

/** Turn a .docx into a template: fields become {{keys}}. Returns { buffer, variables }. */
export async function makeDocxTemplate(buffer) {
  const state = newState();
  const out = await mapParagraphs(buffer, (text, prev) => detectInText(text, prev, state));
  return { buffer: out, variables: [...state.vars.values()] };
}
/** Same for plain text (one paragraph per line). Returns { text, variables }. */
export function makeTextTemplate(text) {
  const state = newState(), lines = String(text).split(/\r?\n/); let prev = '';
  const out = lines.map((line) => {
    const edits = line.trim() ? detectInText(line, prev, state) : [];
    if (line.trim()) prev = line;
    return [...edits].sort((a, b) => b.s - a.s).reduce((l, ed) => l.slice(0, ed.s) + ed.rep + l.slice(ed.e), line);
  });
  return { text: out.join('\n'), variables: [...state.vars.values()] };
}

/** Replace every occurrence of `find` (exact text) with {{key}}. Returns { buffer|text, replaced }. */
export async function addFieldToDocx(buffer, find, key) {
  let replaced = 0;
  const out = await mapParagraphs(buffer, (text) => {
    const edits = []; let i = 0;
    while ((i = text.indexOf(find, i)) >= 0) { edits.push({ s: i, e: i + find.length, rep: `{{${key}}}` }); i += find.length; replaced++; }
    return edits;
  });
  return { buffer: out, replaced };
}
export function addFieldToText(text, find, key) {
  const parts = String(text).split(find); return { text: parts.join(`{{${key}}}`), replaced: parts.length - 1 };
}
/** Put the original wording back where a field was removed. */
export async function removeFieldFromDocx(buffer, key, original) {
  return mapParagraphs(buffer, (text) => [...text.matchAll(TOKEN)].filter((m) => m[1].toLowerCase() === key).map((m) => ({ s: m.index, e: m.index + m[0].length, rep: original })));
}
export const removeFieldFromText = (text, key, original) => String(text).replace(TOKEN, (m, k) => (k.toLowerCase() === key ? original : m));

/** Fill a docx template. `valueOf(key)` returns the text to insert, or null to leave the {{key}} marker (shown as [Label] by the caller). */
export function fillDocx(buffer, valueOf) {
  return mapParagraphs(buffer, (text) => [...text.matchAll(TOKEN)].map((m) => ({ s: m.index, e: m.index + m[0].length, rep: String(valueOf(m[1].toLowerCase()) ?? m[0]) })));
}
export const fillText = (text, valueOf) => String(text).replace(TOKEN, (m, k) => String(valueOf(k.toLowerCase()) ?? m));
export const tokensIn = (text) => [...new Set([...String(text).matchAll(TOKEN)].map((m) => m[1].toLowerCase()))];

/* ------------------------------ building a document from text ------------------------------ */
// Light markup used by the built-in templates:  "# Title" centred heading, "## Heading" bold, ">> text" right-aligned,
// "- item" bullet, "| a | b |" table row, blank line = space.
const run = (text, o = {}) => `<w:r><w:rPr>${o.bold ? '<w:b/>' : ''}${o.italic ? '<w:i/>' : ''}${o.size ? `<w:sz w:val="${o.size}"/>` : ''}</w:rPr>${tNode(text)}</w:r>`;
const para = (text, o = {}) => `<w:p><w:pPr><w:spacing w:after="${o.after ?? 120}" w:line="276" w:lineRule="auto"/>${o.align ? `<w:jc w:val="${o.align}"/>` : ''}${o.indent ? `<w:ind w:left="${o.indent}" w:hanging="${o.hanging || 0}"/>` : ''}</w:pPr>${text === '' ? '' : run(text, o)}</w:p>`;
const cell = (text, w) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${para(text, { after: 60 })}</w:tc>`;

export function textToBodyXml(text) {
  const lines = String(text).replace(/\r/g, '').split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); i++; }
      i--;
      const cols = Math.max(...rows.map((r) => r.length)), w = Math.floor(9000 / cols);
      out.push(`<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${rows.map((r) => `<w:tr>${Array.from({ length: cols }, (_, c) => cell(r[c] || '', w)).join('')}</w:tr>`).join('')}</w:tbl>`);
      out.push(para('', { after: 120 }));
    } else if (/^# /.test(l)) out.push(para(l.slice(2), { bold: true, size: 30, align: 'center', after: 200 }));
    else if (/^## /.test(l)) out.push(para(l.slice(3), { bold: true, size: 24, after: 100 }));
    else if (/^>> /.test(l)) out.push(para(l.slice(3), { align: 'right' }));
    else if (/^- /.test(l)) out.push(para('•  ' + l.slice(2), { indent: 540, hanging: 270 }));
    else out.push(para(l));
  }
  return out.join('');
}

export async function buildDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Mangal"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${textToBodyXml(text)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
