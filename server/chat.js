import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

// pdf-parse's package entry runs a debug routine when imported; the lib file is the clean parser.
const pdfParse = createRequire(import.meta.url)('pdf-parse/lib/pdf-parse.js');

const CHUNK_CHARS = 2600;   // ~600 tokens
const OVERLAP_CHARS = 450;  // ~100 tokens
const FIELD_MAX = 700;
const MAX_DOC_HITS = 10;
const MAX_ITEM_HITS = 5;

const STOP = new Set(('a an and are as at be by for from has have how i in is it of on or our that the this to was we what when where which who will with ' +
  'can do does should would about any all me my us under per into than then there their they them these those not no yes if').split(' '));

function tokenize(text) {
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(/[a-z0-9]+(?:[-./][a-z0-9]+)*|[ऀ-ॿ]+/g)) {   // Latin words/ids, and Devanagari (Marathi/Hindi) words
    const t = m[0];
    // IDs and clause numbers (anything with a digit) are matched whole, so "SAN-014" doesn't also hit every "…-014".
    // "No.14.1.1.6" is one token to the regex above; also index the clause number inside it.
    if (/\d/.test(t) && /^[a-z]/.test(t)) for (const c of t.matchAll(/\d+(?:\.\d+)+/g)) out.push(c[0]);
    if (/[-./]/.test(t)) { out.push(t); if (!/\d/.test(t)) for (const p of t.split(/[-./]/)) if (p.length > 1 && !STOP.has(p)) out.push(p); }
    else if (!STOP.has(t) && t.length > 1) out.push(t);
  }
  return out;
}

function tfMap(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

const cut = (v, n = FIELD_MAX) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

/* ----------------------------- knowledge index ----------------------------- */
export const knowledge = { chunks: [], df: new Map(), avgLen: 1, docs: [], items: [], stageName: {}, ready: false };

function addChunk(c) {
  c.tf = tfMap(tokenize(c.text));
  c.len = [...c.tf.values()].reduce((a, b) => a + b, 0) || 1;
  knowledge.chunks.push(c);
}

function finishIndex() {
  const df = new Map();
  let total = 0;
  for (const c of knowledge.chunks) {
    total += c.len;
    for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  knowledge.df = df;
  knowledge.avgLen = total / Math.max(1, knowledge.chunks.length);
}

function splitPage(text) {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const parts = [];
  for (let i = 0; i < clean.length; i += CHUNK_CHARS - OVERLAP_CHARS) {
    let end = Math.min(clean.length, i + CHUNK_CHARS);
    if (end < clean.length) { const nl = clean.lastIndexOf('\n', end); if (nl > i + CHUNK_CHARS * 0.6) end = nl; }
    parts.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
  }
  return parts;
}

function loadItems(appDir) {
  const items = JSON.parse(fs.readFileSync(path.join(appDir, 'items.json'), 'utf8'));
  const stages = JSON.parse(fs.readFileSync(path.join(appDir, 'stages.json'), 'utf8'));
  knowledge.stageName = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  knowledge.items = items;
  for (const it of items) {
    const text = [
      `${it.compliance_id} | Department: ${it.department} | Level: ${it.level} | Stage: ${knowledge.stageName[it.stage_id] || 'Unmapped'}`,
      `Regulation: ${cut(it.regulation)}${it.reference_section ? ' — ' + cut(it.reference_section, 200) : ''}`,
      `Description: ${cut(it.brief_description)}`,
      `Action required: ${cut(it.action_required)}`,
      `Forms/documents: ${cut(it.forms_documents)}`,
      `Authority: ${cut(it.authority_norm || it.authority_raw, 200)} | Frequency: ${cut(it.frequency_norm, 100)} | Due date: ${cut(it.due_date_raw, 200) || 'not recorded'}`,
      `Penalty: ${cut(it.penalty)}`,
      `Owner: ${cut(it.owner, 100) || 'not recorded'} | Approver: ${cut(it.approver, 100) || 'not recorded'}`,
      `Applicability: ${cut(it.applicability, 400)}`
    ].join('\n');
    addChunk({ kind: 'item', itemId: it.compliance_id, source: 'Master sheet', label: `Master sheet ${it.compliance_id}`, text });
  }
}

async function readPdfPages(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent();
      let last = null, t = '';
      for (const i of tc.items) { if (last !== null && i.transform[5] !== last) t += '\n'; t += i.str + ' '; last = i.transform[5]; }
      pages.push(t);
      return t;
    }
  });
  return pages;
}

// Which pages need OCR. A page is unreadable when its text layer is empty (scanned image) or garbled: legacy-font Marathi/Hindi
// extracts as symbols, so it has almost no common English words, is not proper Unicode Devanagari, and is full of stray symbols.
const EN_COMMON = new Set('the of and to in is shall be for by as any under act with that this or from which are'.split(' '));
function pageStats(text) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean), c = String(text).replace(/\s/g, '').length || 1;
  return {
    chars: c - (text.trim() ? 0 : 1),
    en: words.length ? words.filter((w) => EN_COMMON.has(w.replace(/^[^a-z]+|[^a-z]+$/g, ''))).length / words.length : 0,
    dev: (text.match(/[\u0900-\u097f]/g) || []).length / c,
    sym: (text.match(/[{}|^~@\\<>=*#$%]/g) || []).length / c
  };
}
function pagesToOcr(pages) {
  const small = pages.filter((t) => t.replace(/\s/g, '').length < 100).length;
  if (pages.length && small >= pages.length * 0.5) return pages.map((_, i) => i);   // a scanned document: every page
  return pages.flatMap((t, i) => { const s = pageStats(t); return s.chars >= 100 && s.en < 0.05 && s.dev < 0.3 && s.sym >= 0.015 ? [i] : []; });
}

const OCR_GROUP = 4;   // pages per OCR request, so long answers are never cut off
const ocrKnowledgePrompt = (nums) => 'This is a legal document (Indian real estate law: Act, Rules, Regulations, notification, circular or Government Resolution). ' +
  `Transcribe ONLY these pages of the PDF (counting from 1 at the first page): ${nums.join(', ')}. Start each page with a line exactly like "=== PAGE ${nums[0]} ===". ` +
  'Keep the original language and script (English, Marathi or Hindi) exactly as printed, including section numbers, dates, amounts and tables; write [illegible] for unreadable words. ' +
  'When a page is in Marathi or Hindi, after its original text add a line "ENGLISH TRANSLATION:" followed by a faithful English translation of that page (keep all numbers, dates and section references exact). Output only the transcription.';

/** Splits OCR output on its "=== PAGE n ===" markers into { pageNumber: text }. */
function splitOcrPages(text) {
  const parts = String(text).split(/^\s*=+\s*PAGE\s+(\d+)\s*=+\s*$/im), out = {};
  for (let i = 1; i < parts.length; i += 2) out[Number(parts[i])] = (parts[i + 1] || '').trim();
  return out;
}

/** OCR the given page indexes (0-based), a few pages per request, saving progress to `cacheFile` so a restart resumes. Returns { n: text }. */
async function ocrPages(ai, buf, idx, cacheFile, rec) {
  let done = {};
  try { done = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* no cache yet */ }
  const todo = idx.map((i) => i + 1).filter((n) => !(done[n] && done[n].length > 20));
  for (let g = 0; g < todo.length; g += OCR_GROUP) {
    const nums = todo.slice(g, g + OCR_GROUP);
    if (!ai) { rec.note = 'needs OCR but no AI key is configured'; break; }
    console.log(`Ask AI: OCR "${rec.file.slice(0, 50)}" pages ${nums[0]}-${nums[nums.length - 1]}…`);
    try {
      const got = splitOcrPages((await ocrPdf(ai, buf, { instruction: ocrKnowledgePrompt(nums), maxTokens: 32768 })).text);
      for (const n of nums) if (got[n]) done[n] = got[n];
      try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(done)); } catch { /* read-only folder: the text is still used this time, just not remembered */ }
    } catch (e) { rec.note = `OCR stopped: ${String(e.message).slice(0, 120)}`; break; }
  }
  return done;
}
// Document name as shown to users: no copy markers, upload ids or underscores ("MahaRERA General Regulations 2017 - Copy" -> "MahaRERA General Regulations 2017").
const friendlyName = (n) => String(n).replace(/\s*(-\s*Copy|\(\d+\))\s*$/i, '').replace(/_\d{8,}$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function addPages(pages, name) {
  let n = 0;
  pages.forEach((txt, idx) => {
    // The UDCPR prints "UDCPR - 2020 <page no.>" at the top of each page; cite that number as well as the PDF page.
    const printed = txt.match(/^\s*UDCPR\s*-\s*20\d\d\s*\n?\s*(\d{1,4})\b/)?.[1];
    const front = /^\s*UDCPR\s*-\s*20\d\d\s*\n?\s*[IVXLC]+\b/.test(txt); // Roman-numeral pages = contents/index, not regulations
    const shown = printed || idx + 1; // page number as printed in the document, which is what a reader will look for
    const label = `${friendlyName(name)}, p.${shown}`;
    for (const part of splitPage(txt)) {
      addChunk({ kind: 'doc', source: name, page: idx + 1, shown: Number(shown), label, text: part, front });
      n++;
    }
  });
  return { pages: pages.length, chunks: n };
}

async function loadTextFile(file, name) {
  const txt = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const part of splitPage(txt)) { addChunk({ kind: 'doc', source: name, page: null, label: name, text: part }); n++; }
  return { pages: 1, chunks: n };
}

/** Index the register synchronously (fast), then the PDFs/text files in knowledgeDir (slow, so the caller shouldn't block on it). */
/**
 * `getAi` (optional) returns the AI config used to OCR scanned PDFs. OCR results are cached in knowledge/.ocr-cache/ (by file hash),
 * so each scan is read once. Identical copies of a file (same bytes) are indexed once. `knowledge.files` records the outcome per file.
 */
export function initKnowledge(appDir, knowledgeDir, getAi = () => null) {
  loadItems(appDir);
  finishIndex();
  knowledge.ready = true;
  console.log(`Ask AI: indexed ${knowledge.items.length} register items.`);
  return (async () => {
    if (!fs.existsSync(knowledgeDir)) { console.warn(`Ask AI: no knowledge folder at ${knowledgeDir}; answering from the register only.`); return; }
    const files = fs.readdirSync(knowledgeDir).filter((f) => /\.(pdf|txt|md)$/i.test(f) && !/^readme\./i.test(f));
    if (!files.length) { console.warn('Ask AI: knowledge folder has no PDF/TXT files; add the UDCPR and RERA PDFs and restart.'); return; }
    const cacheDir = path.join(knowledgeDir, '.ocr-cache'), byHash = new Map();
    knowledge.files = [];
    for (const f of files) {
      const name = f.replace(/\.[^.]+$/, ''), rec = { file: f, status: 'failed', pages: 0, chunks: 0, ocr: false, note: '' };
      knowledge.files.push(rec);
      try {
        const buf = fs.readFileSync(path.join(knowledgeDir, f)), hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (byHash.has(hash)) { Object.assign(rec, { status: 'duplicate', note: `Same file as "${byHash.get(hash)}" (already indexed)` }); continue; }
        byHash.set(hash, f);
        let r;
        if (!/\.pdf$/i.test(f)) r = await loadTextFile(path.join(knowledgeDir, f), name);
        else {
          const pages = await readPdfPages(buf), bad = pagesToOcr(pages);
          if (!bad.length) r = addPages(pages, name);
          else {
            rec.ocr = true; rec.ocr_pages = bad.length;
            const done = await ocrPages(getAi(), buf, bad, path.join(cacheDir, `${hash}.json`), rec);
            const missing = [];
            // OCR text replaces the unreadable pages; a page OCR could not read is left empty rather than indexed as garbage.
            const merged = pages.map((t, i) => (bad.includes(i) ? (done[i + 1] || (missing.push(i + 1), '')) : t));
            r = addPages(merged, name);
            const tr = Object.values(done).some((t) => t.includes('ENGLISH TRANSLATION:'));
            rec.note = `${bad.length} of ${pages.length} pages unreadable as text (scanned or garbled Marathi/Hindi font): read with OCR${tr ? ' + English translation' : ''}` + (missing.length ? `; ${missing.length} page(s) not read yet (${rec.note || 'retry on next start'})` : '');
            if (missing.length) { rec.partial = true; rec.missing = missing; }
          }
        }
        Object.assign(rec, { status: rec.partial ? 'partial' : 'indexed', pages: r.pages, chunks: r.chunks });
        knowledge.docs.push({ name, ...r });
        console.log(`Ask AI: indexed "${f}" (${r.pages} pages, ${r.chunks} chunks${rec.ocr ? ', OCR' : ''}).`);
      } catch (e) { rec.note = e.message; console.error(`Ask AI: could not read "${f}":`, e.message); }
    }
    finishIndex();
  })();
}

/* ----------------------------- retrieval (BM25 + exact id match) ----------------------------- */
function bm25(c, qTerms) {
  const N = knowledge.chunks.length, k1 = 1.4, b = 0.75;
  let s = 0;
  for (const t of qTerms) {
    const f = c.tf.get(t);
    if (!f) continue;
    const n = knowledge.df.get(t) || 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / knowledge.avgLen));
  }
  return c.front ? s * 0.25 : s; // contents pages repeat every heading, so they'd otherwise outrank the text itself
}

/** `extraQueries` are focused search phrases (from rewriteQueries). Each is ranked on its own and the rankings are merged, so a
 *  multi-topic question ("refuge area, fire lift and road width") doesn't let one topic crowd the others out. */
export function retrieve(question, extraQueries = []) {
  const qTerms = [...new Set(tokenize(question))];
  const qLower = String(question).toLowerCase();
  const scored = knowledge.chunks.map((c) => ({ c, s: bm25(c, qTerms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  // A clause number in the question (e.g. 14.1.1.6): the page where it is a heading comes first, with the page after it
  // (clause text runs on), ahead of pages that merely mention it.
  const docChunks = knowledge.chunks.filter((c) => c.kind === 'doc');
  const lead = [];
  for (const num of new Set(String(question).match(/\b\d+(?:\.\d+)+\b/g) || [])) {
    const re = new RegExp(`(?:^|\\n)\\s*(?:\\(?\\d+\\)?\\s*)?${num.replace(/\./g, '\\.')}(?![.\\d]*\\d)`);
    for (const c of docChunks.filter((x) => !x.front && re.test(x.text)).slice(0, 2)) {
      if (!lead.includes(c)) lead.push(c);
      const nxt = knowledge.chunks[knowledge.chunks.indexOf(c) + 1];
      if (nxt && nxt.source === c.source && !lead.includes(nxt)) lead.push(nxt);
    }
  }
  const rankings = [scored.filter((x) => x.c.kind === 'doc').map((x) => x.c)];
  for (const eq of extraQueries) {
    const terms = [...new Set(tokenize(eq))];
    rankings.push(knowledge.chunks.filter((c) => c.kind === 'doc').map((c) => ({ c, s: bm25(c, terms) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.c));
  }
  const rrf = new Map(); // reciprocal-rank fusion
  rankings.forEach((list) => list.slice(0, 20).forEach((c, i) => rrf.set(c, (rrf.get(c) || 0) + 1 / (30 + i))));
  const fused = [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const docs = [...new Set([...lead, ...fused])].slice(0, MAX_DOC_HITS + lead.length);
  const items = scored.filter((x) => x.c.kind === 'item').slice(0, MAX_ITEM_HITS).map((x) => x.c);
  // A compliance ID typed in the question (e.g. "san-014") always wins, however it scores.
  for (const it of knowledge.items) {
    if (qLower.includes(it.compliance_id.toLowerCase())) {
      const c = knowledge.chunks.find((x) => x.itemId === it.compliance_id);
      if (c && !items.includes(c)) items.unshift(c);
    }
  }
  return { docs, items: items.slice(0, MAX_ITEM_HITS + 3) };
}

/* ----------------------------- live tracking context ----------------------------- */
const COMPLETE = new Set(['Compliant / Completed', 'Not Applicable', 'On Hold']);
const dayDiff = (iso, today) => Math.round((new Date(iso + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);

function effStatus(tr, today) {
  const st = tr.status || 'Not Started';
  if (!COMPLETE.has(st) && tr.next_due_date && dayDiff(tr.next_due_date, today) < 0) return 'Overdue';
  return st;
}

export async function trackingContext(db, itemChunks, today) {
  const [trackDocs, projectDocs, otherDocs] = await Promise.all([
    db.collection('tracking').find().toArray(),
    db.collection('projects').find().toArray(),
    Promise.all(['companies', 'phases', 'buildings'].map((c) => db.collection(c).find().toArray()))
  ]);
  // Tracking keys end in a company, project, phase or building id; show its name.
  const projName = Object.fromEntries([...projectDocs, ...otherDocs.flat()].map((p) => [String(p._id), p.name || String(p._id)]));
  const label = (key) => { const [id, proj] = String(key).split('__'); return proj ? `${id} (${projName[proj] || proj})` : id; };

  const counts = {};
  const overdue = [], soon = [];
  for (const d of trackDocs) {
    const st = effStatus(d, today);
    counts[st] = (counts[st] || 0) + 1;
    if (st === 'Overdue') overdue.push(`${label(d._id)} due ${d.next_due_date}`);
    else if (!COMPLETE.has(st) && d.next_due_date) { const n = dayDiff(d.next_due_date, today); if (n <= 30) soon.push(`${label(d._id)} due ${d.next_due_date} (${n} days)`); }
  }
  let summary = [
    `[Tracker summary — ${trackDocs.length} tracked entries; items never updated are "Not Started" and have no entry]`,
    `Status counts: ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none yet'}`,
    `Overdue (${overdue.length}): ${overdue.slice(0, 25).join('; ') || 'none'}${overdue.length > 25 ? '; …more' : ''}`,
    `Due within 30 days (${soon.length}): ${soon.slice(0, 25).join('; ') || 'none'}${soon.length > 25 ? '; …more' : ''}`
  ].join('\n');

  // Latest compliance-health score per project (operational indicator, written by the health dashboard).
  try {
    const snaps = await db.collection('health_snapshots').find().sort({ date: -1 }).limit(200).toArray();
    const seen = new Set(), health = [];
    for (const s of snaps) { if (seen.has(s.scope_id)) continue; seen.add(s.scope_id); health.push(`${s.scope_name}: score ${s.score} (${s.category}); ${s.counts.overdue} overdue, ${s.counts.critical} critical, ${s.counts.blocked} blocked; as of ${s.date}`); }
    if (health.length) summary += `\n[Project health — an operational indicator, not a legal finding]\n${health.join('\n')}`;
  } catch { /* health data is optional */ }

  const ids = new Set(itemChunks.map((c) => c.itemId));
  const lines = [];
  for (const d of trackDocs) {
    if (!ids.has(String(d._id).split('__')[0])) continue;
    lines.push(`[Tracking] ${label(d._id)}: status ${effStatus(d, today)}; next due ${d.next_due_date || 'not set'}; remarks: ${cut(d.remarks, 300) || 'none'}; last updated by ${d.last_updated_by || 'n/a'} on ${d.updated_at ? d.updated_at.slice(0, 10) : 'n/a'}`);
  }
  const noEntry = [...ids].filter((id) => !trackDocs.some((d) => String(d._id).split('__')[0] === id));
  if (noEntry.length) lines.push(`[Tracking] No tracking entry yet (so status is Not Started) for: ${noEntry.join(', ')}`);
  return { summary, lines };
}

/* ----------------------------- model call ----------------------------- */
/** Builds the <context> text. Every passage gets a tag (S1, S2…) so the model can say which ones it used; `refs` maps tag -> source. */
export function buildContext({ docs, items }, tracking, today) {
  const refs = {};
  let n = 0;
  const tag = (ref) => { const k = `S${++n}`; refs[k] = ref; return k; };
  const parts = [`Today's date: ${today}`];
  const live = [tracking.summary, ...tracking.lines].join('\n');
  parts.push(`[${tag({ kind: 'tracker' })} Live tracker data]\n${live}`);
  parts.push(docs.length
    ? docs.map((c) => `[${tag({ kind: 'doc', c })} Document: ${c.label}]\n${c.text}`).join('\n\n')
    : '[No UDCPR/RERA passages were retrieved for this question. The regulation PDFs may not be loaded or nothing matched.]');
  if (items.length) parts.push(items.map((c) => `[${tag({ kind: 'item', c })} Master sheet ${c.itemId}]\n${c.text}`).join('\n\n'));
  return { text: parts.join('\n\n'), refs };
}

/** Splits the model's trailing "SOURCES_USED: S1, S3" line off the answer and turns the tags into display labels. */
export function extractSources(answer, refs) {
  const m = answer.match(/\n?[ \t>*_#-]*SOURCES_USED\s*:?\**\s*([^\n]*)\s*$/i);
  const body = (m ? answer.slice(0, m.index) : answer).trim();
  let tags = m ? (m[1].match(/S\d+/gi) || []).map((t) => t.toUpperCase()) : [];
  if (!m) {
    // The model left out its SOURCES_USED line. Fall back to passages where a regulation/table the answer names starts.
    const nums = [...new Set(body.match(/\b\d+(?:\.\d+){1,5}\b/g) || [])].filter((x) => x.length >= 3);
    const tables = [...new Set([...body.matchAll(/Table\s*(?:No\.?\s*)?(\d+\s*-\s*[A-Z])\b/gi)].map((x) => x[1].replace(/\s+/g, '')))];
    for (const [t, r] of Object.entries(refs)) {
      if (r.kind !== 'doc' || tags.length >= 4) continue;
      const hit = nums.some((n) => new RegExp(`(?:^|\\n)\\s*(?:\\(?\\d+\\)?\\s*)?${n.replace(/\./g, '\\.')}(?![.\\d]*\\d)`).test(r.c.text)) ||
        tables.some((k) => new RegExp(`Table\\s*(?:No\\.?\\s*)?${k[0]}\\s*-\\s*${k.slice(-1)}\\b`, 'i').test(r.c.text));
      if (hit) tags.push(t);
    }
    for (const [t, r] of Object.entries(refs)) if (r.kind === 'item' && body.toUpperCase().includes(r.c.itemId)) tags.push(t);
  }
  const pages = new Map(); // document -> printed start pages used
  const labels = [];
  for (const t of new Set(tags)) {
    const r = refs[t];
    if (!r) continue;
    if (r.kind === 'doc') { if (!pages.has(r.c.source)) pages.set(r.c.source, new Set()); pages.get(r.c.source).add(r.c.shown); }
    else if (r.kind === 'item') { if (body.toUpperCase().includes(r.c.itemId)) labels.push(`Master sheet ${r.c.itemId}`); } // retrieved-but-unmentioned rows aren't sources
    else labels.push('Live tracker data');
  }
  const docLabels = [];
  for (const [name, set] of pages) {
    // Pages of one continuing section (251, 252, 253) count as one source, shown at its start page.
    let prev = null;
    for (const p of [...set].sort((a, b) => a - b)) { if (prev === null || p > prev + 1) docLabels.push(`${friendlyName(name)}, p.${p}`); prev = p; }
  }
  return { body, sources: [...docLabels, ...labels] };
}

/**
 * One structured-JSON call for the project-intelligence analysis. Reuses the same provider and keys as Ask AI
 * (Gemini first, else Claude) and the same fallback to a lighter model when the main one is out of quota.
 * Returns {text, model}. Throws an Error with .status on provider errors.
 */
export async function askJson({ provider, apiKey, model, fallbackModel, system, prompt }) {
  const once = async (m) => {
    if (provider === 'gemini') {
      const j = await geminiCall(apiKey, m, {
        systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' }
      });
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (!text) throw Object.assign(new Error('The AI returned an empty response.'), { status: 502 });
      return text;
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m, max_tokens: 4096, temperature: 0.2, system, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(90_000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || `model API error ${r.status}`), { status: r.status });
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw Object.assign(new Error('The AI returned an empty response.'), { status: 502 });
    return text;
  };
  try { return { text: await once(model), model }; }
  catch (e) {
    if (fallbackModel && fallbackModel !== model && (e.status === 429 || e.status === 503)) return { text: await once(fallbackModel), model: fallbackModel, usedFallback: true };
    throw e;
  }
}

/**
 * OCR for scanned PDFs: the model reads the page images and returns the text exactly as printed (Marathi, Hindi and English).
 * Returns { text, model }. Throws on provider errors; the caller decides what to do with an empty result.
 */
export async function ocrPdf({ provider, apiKey, model, fallbackModel }, buffer, { instruction: custom, maxTokens = 16384 } = {}) {
  const instruction = custom || 'Transcribe all the text in this scanned document exactly as printed, page by page, in reading order. Keep the original language and script (Marathi, Hindi or English); do not translate, summarise or correct it. Keep numbers, dates and circular numbers exactly as shown, and include text from stamps and tables. If a word is unreadable write [illegible]. Output only the transcription.';
  const b64 = buffer.toString('base64');
  const once = async (m) => {
    if (provider === 'gemini') {
      const j = await geminiCall(apiKey, m, {
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: b64 } }, { text: instruction }] }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens }
      });
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m, max_tokens: Math.min(maxTokens, 16000), temperature: 0, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: instruction }] }] }), signal: AbortSignal.timeout(120_000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || `model API error ${r.status}`), { status: r.status });
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  };
  try { return { text: await once(model), model }; }
  catch (e) {
    if (fallbackModel && fallbackModel !== model && (e.status === 429 || e.status === 503)) return { text: await once(fallbackModel), model: fallbackModel };
    throw e;
  }
}

async function geminiCall(apiKey, model, body, tries = 3) {
  for (let i = 1; ; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90_000)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    // Busy (503) or rate-limited (429) responses are usually brief; wait and retry before giving up.
    const daily = /per day|PerDay/i.test(j?.error?.message || ''); // a daily quota won't clear in seconds, so don't wait on it
    if ((r.status === 503 || r.status === 429) && !daily && i < tries) { await new Promise((ok) => setTimeout(ok, 1500 * i)); continue; }
    const e = new Error(j?.error?.message || `model API error ${r.status}`); e.status = r.status; throw e;
  }
}

/** Asks a small model for focused search phrases covering each topic in the question. Returns [] on any failure. */
export async function rewriteQueries({ apiKey, model, question, history }) {
  try {
    const prior = history.slice(-2).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
    const j = await geminiCall(apiKey, model, {
      contents: [{ role: 'user', parts: [{ text:
        'You help search the Maharashtra UDCPR (development control regulations) and the RERA Act. Turn the user\'s question into 3 to 6 short keyword search queries (3-8 words each) that would find the regulation text needed to answer it. ' +
        'Give each distinct topic in the question its own query, add the key facts it depends on (e.g. building height, road width, use), use wording the regulations themselves would use, and keep any regulation numbers. ' +
        'Output one query per line and nothing else.\n\n' + (prior ? `Earlier in the chat:\n${prior}\n\n` : '') + `Question: ${question}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 }
    }, 2);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return text.split('\n').map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter((l) => l.length > 2 && l.length < 120).slice(0, 6);
  } catch { return []; }
}

export async function askGemini({ apiKey, model, system, history, question, context }) {
  const contents = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: `<context>\n${context}\n</context>\n\nQuestion: ${question}` }] }
  ];
  const j = await geminiCall(apiKey, model, {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
  });
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(j.promptFeedback?.blockReason ? `blocked: ${j.promptFeedback.blockReason}` : `empty response (${cand?.finishReason || 'unknown'})`);
  return text;
}

export async function askModel({ apiKey, model, system, history, question, context }) {
  const messages = [...history, { role: 'user', content: `<context>\n${context}\n</context>\n\nQuestion: ${question}` }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1200, temperature: 0.1, system, messages }),
    signal: AbortSignal.timeout(90_000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || `model API error ${r.status}`); e.status = r.status; throw e; }
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

