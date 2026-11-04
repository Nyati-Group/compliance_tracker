// HTTP routes for Documents: templates (ready-made and uploaded), filling and saving documents, and reviewing a document against the rules.
// Reading and creating need a signed-in user with the "upload_docs" capability for writes. A document tied to a project follows that
// project's access; a document without a project belongs to the person who made it (and to administrators).
import crypto from 'node:crypto';
import { rawBody, rateLimit } from './http.mjs';
import { ObjectId } from 'mongodb';
import { canSee, canWriteScope, hasCap } from './access.mjs';
import { MAX_DOCX_BYTES, docxText, makeDocxTemplate, makeTextTemplate, addFieldToDocx, addFieldToText, removeFieldFromDocx, removeFieldFromText, buildDocx, slug } from './docx.mjs';
import { BUILTIN_TEMPLATES, builtinById, CATEGORIES, cleanVariables, cleanValues, prefill, renderTemplateText, renderTemplateDocx, readUpload, basicChecks, reviewDocument, reportText } from './docstudio.mjs';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(s);
const rid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const UPLOAD_EXT = /\.(docx|pdf|txt|md)$/i;

export function registerDocStudio(app, { db, bucket, requireCap, withScopes, aiConfig, attach = null }) {
  const templates = () => db.collection('doc_templates');
  const generated = () => db.collection('doc_generated');
  const analyses = () => db.collection('doc_analyses');
  const fail = (res, e, fallback = 'server error') => { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); console.error(e); return res.status(500).json({ error: fallback }); };
  const upload = requireCap('upload_docs');
  const store = (buffer, filename, meta) => new Promise((ok, no) => { const up = bucket.openUploadStream(filename, { metadata: meta }); up.on('finish', () => ok(String(up.id))).on('error', no); up.end(buffer); });
  const load = (fileId) => new Promise((ok, no) => { if (!ObjectId.isValid(fileId)) return no(Object.assign(new Error('File not found.'), { status: 404 })); const ch = []; bucket.openDownloadStream(new ObjectId(fileId)).on('data', (c) => ch.push(c)).on('error', () => no(Object.assign(new Error('File not found.'), { status: 404 }))).on('end', () => ok(Buffer.concat(ch))); });
  const drop = (fileId) => (ObjectId.isValid(fileId) ? bucket.delete(new ObjectId(fileId)).catch(() => {}) : null);
  const aiLimiter = rateLimit({ windowMs: 60_000, limit: 6, key: (req) => req.user?._id || req.ip, message: { error: 'Too many reviews in a minute. Please wait a moment.' } });

  /* ---------- access ---------- */
  const mine = (d, req) => d.created_by === req.user._id;
  const canReadDoc = (d, req) => req.allowed.all || mine(d, req) || (!!d.project_id && canSee(req.allowed, d.project_id));
  const canWriteDoc = (d, req) => req.allowed.all || mine(d, req) || (!!d.project_id && canWriteScope(req.allowed, d.project_id));
  const projectOf = async (pid) => (pid ? db.collection('projects').findOne({ _id: pid }) : null);
  const companyOf = async (p) => (p?.company_id ? db.collection('companies').findOne({ _id: p.company_id }) : null);
  const checkProject = async (req, pid) => {
    if (!pid) return null;
    if (!validId(pid)) throw Object.assign(new Error('Unknown project.'), { status: 400 });
    const p = await projectOf(pid); if (!p || !canWriteScope(req.allowed, pid)) throw Object.assign(new Error('You do not have access to that project.'), { status: 403 });
    return p;
  };

  /* ---------- templates ---------- */
  const tplLight = (t) => ({ id: t.id || t._id, name: t.name, category: t.category, description: t.description || '', kind: t.kind || 'builtin', format: t.format || 'text', fields: (t.variables || []).length, created_by_name: t.created_by_name || null, created_at: t.created_at || null, can_edit: t.kind === 'uploaded' });
  const findTemplate = async (id) => {
    if (typeof id === 'string' && id.startsWith('builtin:')) { const b = builtinById(id); return b ? { ...b, _id: b.id, kind: 'builtin', format: 'text' } : null; }
    return validId(id) ? templates().findOne({ _id: id, deleted: { $ne: true } }) : null;
  };
  const canEditTemplate = (t, req) => t.kind === 'uploaded' && (mine(t, req) || hasCap(req.user, 'manage_company'));

  app.get('/api/docstudio/templates', async (req, res) => {
    try {
      const up = await templates().find({ deleted: { $ne: true } }, { projection: { body: 0 } }).sort({ created_at: -1 }).limit(300).toArray();
      res.json({ categories: CATEGORIES, templates: [...BUILTIN_TEMPLATES.map((b) => tplLight({ ...b, kind: 'builtin', format: 'text' })), ...up.map(tplLight)] });
    } catch (e) { fail(res, e); }
  });
  // The format saved for a named document (set when a format was uploaded for it), so each record's document reuses it.
  app.get('/api/docstudio/template-for', async (req, res) => {
    try {
      const name = clip(String(req.query.name || ''), 150).toLowerCase();
      const t = name ? await templates().findOne({ for_doc: name, deleted: { $ne: true } }, { projection: { body: 0 }, sort: { created_at: -1 } }) : null;
      res.json({ template: t ? tplLight(t) : null, ready_made: BUILTIN_TEMPLATES.map((b) => ({ id: b.id, name: b.name })) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/docstudio/templates/:id', async (req, res) => {
    try {
      const t = await findTemplate(req.params.id); if (!t) return res.status(404).json({ error: 'Template not found.' });
      let preview = '';
      if (t.format === 'docx') preview = (await docxText(await load(t.file_id)).catch(() => ({ text: '' }))).text.slice(0, 6000);
      else preview = String(t.body || '').slice(0, 6000);
      res.json({ ...tplLight(t), variables: t.variables, preview, source_name: t.source_name || null, can_edit: canEditTemplate(t, req) });
    } catch (e) { fail(res, e); }
  });

  // Upload a format (.docx, .pdf or .txt): fill-in fields are found automatically and shown for review before anyone uses it.
  app.post('/files/docstudio/template', upload, rawBody({ limit: MAX_DOCX_BYTES, tooLarge: 'File is larger than 15 MB.' }), async (req, res) => {
    try {
      const fileName = clip(String(req.query.file_name || ''), 200).replace(/[\\/]/g, '_');
      if (!UPLOAD_EXT.test(fileName)) return res.status(400).json({ error: 'Upload a Word (.docx), PDF or text file.' });
      if (!Buffer.isBuffer(req.body) || req.body.length < 20) return res.status(400).json({ error: 'The file is empty.' });
      const name = clip(String(req.query.name || ''), 120) || fileName.replace(/\.[^.]+$/, '');
      const category = CATEGORIES.includes(req.query.category) ? req.query.category : 'Other';
      const forDoc = clip(String(req.query.for_doc || ''), 150).toLowerCase();
      const t = { _id: rid('tpl'), name, category, description: clip(String(req.query.description || ''), 400), kind: 'uploaded', for_doc: forDoc || null, source_name: fileName, created_by: req.user._id, created_by_name: req.user.name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (/\.docx$/i.test(fileName)) {
        const r = await makeDocxTemplate(req.body);
        t.format = 'docx'; t.variables = cleanVariables(r.variables); t.file_id = await store(r.buffer, `${slug(name)}-template.docx`, { template: t._id });
        t.preview = (await docxText(r.buffer)).text.slice(0, 6000);
      } else {
        const src = await readUpload(req.body, fileName, aiConfig());
        const r = makeTextTemplate(src.text.slice(0, 200000));
        t.format = 'text'; t.body = r.text; t.variables = cleanVariables(r.variables); t.ocr = src.ocr;
        t.original_file_id = /\.pdf$/i.test(fileName) ? await store(req.body, fileName, { template: t._id }) : null;
        t.preview = r.text.slice(0, 6000);
      }
      const { preview, ...doc } = t;
      await templates().insertOne(doc);
      res.json({ ok: true, id: t._id, ...tplLight(doc), variables: t.variables, preview });
    } catch (e) { fail(res, e, 'could not read that file'); }
  });

  // Rename, recategorise and refine the variables (label, type, required, auto-fill source). The field keys themselves stay fixed.
  app.put('/api/docstudio/templates/:id', upload, async (req, res) => {
    try {
      const t = await findTemplate(req.params.id); if (!t) return res.status(404).json({ error: 'Template not found.' });
      if (!canEditTemplate(t, req)) return res.status(403).json({ error: 'Only the person who added this format (or an administrator) can change it.' });
      const set = { updated_at: new Date().toISOString() };
      if (req.body?.name !== undefined) { const n = clip(req.body.name, 120); if (n.length < 2) return res.status(400).json({ error: 'Give the format a name.' }); set.name = n; }
      if (CATEGORIES.includes(req.body?.category)) set.category = req.body.category;
      if (req.body?.description !== undefined) set.description = clip(req.body.description, 400);
      if (Array.isArray(req.body?.variables)) {
        const edited = Object.fromEntries(cleanVariables(req.body.variables).map((v) => [v.key, v]));
        set.variables = t.variables.map((v) => (edited[v.key] ? { ...v, ...edited[v.key], key: v.key, original: v.original, count: v.count } : v));
      }
      await templates().updateOne({ _id: t._id }, { $set: set });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Add a field the detector missed (by the exact words in the document), or remove one it got wrong (the original wording comes back).
  app.post('/api/docstudio/templates/:id/field', upload, async (req, res) => {
    try {
      const t = await findTemplate(req.params.id); if (!t) return res.status(404).json({ error: 'Template not found.' });
      if (!canEditTemplate(t, req)) return res.status(403).json({ error: 'Only the person who added this format (or an administrator) can change it.' });
      const op = req.body?.op, vars = [...t.variables], set = { updated_at: new Date().toISOString() };
      if (op === 'add') {
        const find = clip(req.body.text, 300), label = clip(req.body.label, 80) || find.slice(0, 40);
        if (find.length < 2) return res.status(400).json({ error: 'Type the exact words in the document that should become a field.' });
        let key = slug(label), n = 2; while (vars.some((v) => v.key === key)) key = `${slug(label).slice(0, 36)}_${n++}`;
        const r = t.format === 'docx' ? await addFieldToDocx(await load(t.file_id), find, key) : addFieldToText(t.body, find, key);
        if (!r.replaced) return res.status(404).json({ error: 'Those words were not found in the document. Copy them exactly as they appear.' });
        if (t.format === 'docx') { set.file_id = await store(r.buffer, `${slug(t.name)}-template.docx`, { template: t._id }); } else set.body = r.text;
        vars.push(...cleanVariables([{ key, label, type: req.body.type, required: true, original: find, count: r.replaced }]));
      } else if (op === 'remove') {
        const key = clip(req.body.key, 41), v = vars.find((x) => x.key === key); if (!v) return res.status(404).json({ error: 'No such field.' });
        const original = v.original || v.label;
        if (t.format === 'docx') { set.file_id = await store(await removeFieldFromDocx(await load(t.file_id), key, original), `${slug(t.name)}-template.docx`, { template: t._id }); } else set.body = removeFieldFromText(t.body, key, original);
        vars.splice(vars.indexOf(v), 1);
      } else return res.status(400).json({ error: 'Unknown change.' });
      set.variables = vars;
      await templates().updateOne({ _id: t._id }, { $set: set });
      res.json({ ok: true, variables: vars });
    } catch (e) { fail(res, e); }
  });

  // Removing a format hides it; documents already made from it keep working.
  app.delete('/api/docstudio/templates/:id', upload, async (req, res) => {
    try {
      const t = await findTemplate(req.params.id); if (!t) return res.status(404).json({ error: 'Template not found.' });
      if (!canEditTemplate(t, req)) return res.status(403).json({ error: 'Only the person who added this format (or an administrator) can remove it.' });
      await templates().updateOne({ _id: t._id }, { $set: { deleted: true, deleted_at: new Date().toISOString() } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /* ---------- filling and saving ---------- */
  app.post('/api/docstudio/prefill', withScopes, async (req, res) => {
    try {
      const t = await findTemplate(req.body?.template_id); if (!t) return res.status(404).json({ error: 'Template not found.' });
      const pid = clip(req.body?.project_id, 100), p = pid && validId(pid) ? await projectOf(pid) : null;
      if (pid && (!p || !canSee(req.allowed, pid))) return res.status(403).json({ error: 'You do not have access to that project.' });
      res.json({ values: prefill(t.variables, { project: p, company: await companyOf(p) || (!p ? await db.collection('companies').findOne({}) : null), user: req.user }) });
    } catch (e) { fail(res, e); }
  });

  const GEN_KEEP_VERSIONS = 10;
  // Create a document from a template, or (with `id`) save a new version of one. Missing required values are allowed: it is saved as a Draft.
  app.post('/api/docstudio/generate', upload, withScopes, async (req, res) => {
    try {
      const b = req.body || {}, existing = b.id ? (validId(b.id) ? await generated().findOne({ _id: b.id }) : null) : null;
      if (b.id && (!existing || !canWriteDoc(existing, req))) return res.status(404).json({ error: 'Document not found.' });
      const snap = existing ? existing.template : null;
      let tpl = snap;
      if (!tpl) {
        const t = await findTemplate(b.template_id); if (!t) return res.status(404).json({ error: 'Template not found.' });
        tpl = { id: String(t._id), name: t.name, format: t.format, variables: t.variables, body: t.format === 'text' ? t.body : undefined, file_id: t.format === 'docx' ? t.file_id : undefined };
      }
      const project = existing ? await projectOf(existing.project_id) : await checkProject(req, clip(b.project_id, 100));
      const { values, problems, missing } = cleanValues(tpl.variables, b.values);
      if (problems.length) return res.status(400).json({ error: problems.join(' ') });
      const title = clip(b.title, 150) || existing?.title || `${tpl.name}${project ? ' - ' + project.name : ''}`;
      let buffer, text = null;
      if (tpl.format === 'docx') buffer = await renderTemplateDocx(await load(tpl.file_id), tpl.variables, values);
      else { text = renderTemplateText(tpl.body, tpl.variables, values); buffer = await buildDocx(text); }
      const now = new Date().toISOString(), version = (existing?.version || 0) + 1;
      const fileId = await store(buffer, `${slug(title) || 'document'}.docx`, { generated: existing?._id || null });
      const doc = { title, values, status: missing.length ? 'Draft' : 'Complete', missing, version, file_id: fileId, size: buffer.length, text, updated_at: now, updated_by: req.user.name };
      const entry = { version, file_id: fileId, at: now, by: req.user.name };
      const id = existing ? existing._id : rid('gen');
      // When prepared for a compliance record, a finished document is attached to that record (a draft stays here until it is complete).
      let attached = null;
      if (b.attach && typeof b.attach === 'object' && attach) {
        if (missing.length) attached = { ok: false, reason: `Not added to the record yet: ${missing.length} required field${missing.length === 1 ? ' is' : 's are'} still empty.` };
        else attached = { ok: true, ...(await attach(req, b.attach, buffer, `${slug(title) || 'document'}.docx`, id)) };
      }
      if (existing) {
        const versions = [...(existing.versions || []), entry], old = versions.splice(0, Math.max(0, versions.length - GEN_KEEP_VERSIONS));
        await generated().updateOne({ _id: existing._id }, { $set: { ...doc, versions, ...(attached?.ok ? { record_key: b.attach.key, record_doc: b.attach.doc_name } : {}) } });
        await Promise.all(old.map((v) => drop(v.file_id)));
        return res.json({ ok: true, id, version, status: doc.status, missing, attached });
      }
      await generated().insertOne({ _id: id, ...doc, template: tpl, template_id: tpl.id, template_name: tpl.name, project_id: project?._id || null, project_name: project?.name || null, company_id: project?.company_id || null,
        ...(attached?.ok ? { record_key: b.attach.key, record_doc: b.attach.doc_name } : {}), created_by: req.user._id, created_by_name: req.user.name, created_at: now, versions: [entry] });
      res.json({ ok: true, id, version, status: doc.status, missing, attached });
    } catch (e) { fail(res, e, 'could not create the document'); }
  });

  const genLight = (d) => ({ id: d._id, title: d.title, template_name: d.template_name, project_id: d.project_id, project_name: d.project_name, status: d.status, missing: (d.missing || []).length, version: d.version, size: d.size, created_by_name: d.created_by_name, created_at: d.created_at, updated_at: d.updated_at, updated_by: d.updated_by });
  app.get('/api/docstudio/generated', withScopes, async (req, res) => {
    try {
      const rows = await generated().find({}, { projection: { template: 0, text: 0, values: 0, versions: 0 } }).sort({ updated_at: -1 }).limit(500).toArray();
      res.json(rows.filter((d) => canReadDoc(d, req)).map(genLight));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/docstudio/generated/:id', withScopes, async (req, res) => {
    try {
      const d = validId(req.params.id) && await generated().findOne({ _id: req.params.id });
      if (!d || !canReadDoc(d, req)) return res.status(404).json({ error: 'Document not found.' });
      const preview = d.text ?? (await docxText(await load(d.file_id)).catch(() => ({ text: '' }))).text;
      res.json({ ...genLight(d), values: d.values, variables: d.template.variables, template_id: d.template_id, record_key: d.record_key || null, record_doc: d.record_doc || null, versions: (d.versions || []).map(({ version, at, by }) => ({ version, at, by })), preview: preview.slice(0, 20000), can_edit: canWriteDoc(d, req) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/docstudio/generated/:id/download', withScopes, async (req, res) => {
    try {
      const d = validId(req.params.id) && await generated().findOne({ _id: req.params.id });
      if (!d || !canReadDoc(d, req)) return res.status(404).json({ error: 'Document not found.' });
      const v = Number(req.query.v), entry = (d.versions || []).find((x) => x.version === v) || (d.versions || []).at(-1);
      const buf = await load(entry.file_id), base = (slug(d.title) || 'document') + (v && entry.version !== d.version ? `-v${entry.version}` : '');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.query.format === 'txt') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base + '.txt')}`); return res.send((await docxText(buf)).text + '\n'); }
      res.setHeader('Content-Type', DOCX_MIME); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base + '.docx')}`); res.send(buf);
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/docstudio/generated/:id', upload, withScopes, async (req, res) => {
    try {
      const d = validId(req.params.id) && await generated().findOne({ _id: req.params.id });
      if (!d || !canWriteDoc(d, req)) return res.status(404).json({ error: 'Document not found.' });
      await generated().deleteOne({ _id: d._id }); await Promise.all((d.versions || []).map((v) => drop(v.file_id)));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /* ---------- review against the compliance rules ---------- */
  const friendlyAiError = (e) => (e?.status === 429 || e?.status === 503 ? 'The AI service is busy or has reached its limit for now. Try again later.' : e?.status === 502 ? e.message : 'The AI review could not be completed. Try again.');
  async function review(buffer, fileName, { project, company, docType, user, generatedId, fileId, existingId }) {
    const ai = aiConfig(), now = new Date().toISOString();
    const src = await readUpload(buffer, fileName, ai);
    const rec = { file_name: fileName, doc_type_hint: docType || '', project_id: project?._id || null, project_name: project?.name || null, company_id: project?.company_id || null, generated_id: generatedId || null,
      text_length: src.text.length, ocr: src.ocr, basic: basicChecks(src.text), ai: null };
    if (!ai) rec.ai = { ok: false, error: 'The AI service is not set up, so only the basic checks ran.' };
    else try { const r = await reviewDocument(ai, { text: src.text, docType, project, company }); rec.ai = { ok: true, result: r.result, notes: r.notes, model: null, rules_used: r.rules_used, truncated: r.truncated, at: now }; }
    catch (e) { console.warn('document review failed:', e.message); rec.ai = { ok: false, error: friendlyAiError(e) }; }
    if (existingId) { await analyses().updateOne({ _id: existingId }, { $set: { ...rec, updated_at: now } }); return { id: existingId, ...rec }; }
    const id = rid('ana');
    await analyses().insertOne({ _id: id, ...rec, file_id: fileId, created_by: user._id, created_by_name: user.name, created_at: now });
    return { id, ...rec, created_at: now };
  }
  const anaLight = (a) => ({ id: a._id, file_name: a.file_name, project_id: a.project_id, project_name: a.project_name, created_by_name: a.created_by_name, created_at: a.created_at, readiness: a.ai?.ok ? a.ai.result.readiness : null, document_type: a.ai?.ok ? a.ai.result.document_type : null, ai_ok: !!a.ai?.ok, basic: (a.basic || []).length });

  app.post('/files/docstudio/analyse', upload, aiLimiter, withScopes, rawBody({ limit: MAX_DOCX_BYTES, tooLarge: 'File is larger than 15 MB.' }), async (req, res) => {
    try {
      const fileName = clip(String(req.query.file_name || ''), 200).replace(/[\\/]/g, '_');
      if (!UPLOAD_EXT.test(fileName)) return res.status(400).json({ error: 'Upload a Word (.docx), PDF or text file.' });
      if (!Buffer.isBuffer(req.body) || req.body.length < 20) return res.status(400).json({ error: 'The file is empty.' });
      const project = await checkProject(req, clip(String(req.query.project_id || ''), 100));
      const fileId = await store(req.body, fileName, { analysis: true });
      try { const a = await review(req.body, fileName, { project, company: await companyOf(project), docType: clip(String(req.query.doc_type || ''), 120), user: req.user, fileId }); res.json({ ok: true, id: a.id }); }
      catch (e) { await drop(fileId); throw e; }
    } catch (e) { fail(res, e, 'could not review that file'); }
  });
  app.post('/api/docstudio/analyse-generated', upload, aiLimiter, withScopes, async (req, res) => {
    try {
      const d = validId(req.body?.id) && await generated().findOne({ _id: req.body.id });
      if (!d || !canReadDoc(d, req)) return res.status(404).json({ error: 'Document not found.' });
      const project = await projectOf(d.project_id), buf = await load(d.file_id), fileId = await store(buf, `${slug(d.title)}.docx`, { analysis: true });
      try { const a = await review(buf, `${slug(d.title) || 'document'}.docx`, { project, company: await companyOf(project), docType: d.template_name, user: req.user, fileId, generatedId: d._id }); res.json({ ok: true, id: a.id }); }
      catch (e) { await drop(fileId); throw e; }
    } catch (e) { fail(res, e, 'could not review that document'); }
  });
  app.get('/api/docstudio/analyses', withScopes, async (req, res) => {
    try {
      const rows = await analyses().find({}, { projection: { basic: 1, file_name: 1, project_id: 1, project_name: 1, created_by: 1, created_by_name: 1, created_at: 1, 'ai.ok': 1, 'ai.result.readiness': 1, 'ai.result.document_type': 1 } }).sort({ created_at: -1 }).limit(300).toArray();
      res.json(rows.filter((a) => canReadDoc(a, req)).map(anaLight));
    } catch (e) { fail(res, e); }
  });
  const getAna = async (req) => { const a = validId(req.params.id) && await analyses().findOne({ _id: req.params.id }); return a && canReadDoc(a, req) ? a : null; };
  app.get('/api/docstudio/analyses/:id', withScopes, async (req, res) => {
    try { const a = await getAna(req); if (!a) return res.status(404).json({ error: 'Review not found.' }); const { file_id, ...rest } = a; res.json({ ...rest, id: a._id, can_edit: canWriteDoc(a, req) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/docstudio/analyses/:id/retry', upload, aiLimiter, withScopes, async (req, res) => {
    try {
      const a = await getAna(req); if (!a || !canWriteDoc(a, req)) return res.status(404).json({ error: 'Review not found.' });
      const project = await projectOf(a.project_id);
      await review(await load(a.file_id), a.file_name, { project, company: await companyOf(project), docType: a.doc_type_hint, user: req.user, existingId: a._id });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'could not review that file'); }
  });
  app.get('/api/docstudio/analyses/:id/report', withScopes, async (req, res) => {
    try {
      const a = await getAna(req); if (!a) return res.status(404).json({ error: 'Review not found.' });
      res.setHeader('Content-Type', DOCX_MIME); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('review-' + (slug(a.file_name.replace(/\.[^.]+$/, '')) || 'document') + '.docx')}`);
      res.send(await buildDocx(reportText(a)));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/docstudio/analyses/:id/file', withScopes, async (req, res) => {
    try {
      const a = await getAna(req); if (!a) return res.status(404).json({ error: 'Review not found.' });
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`); res.send(await load(a.file_id));
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/docstudio/analyses/:id', upload, withScopes, async (req, res) => {
    try { const a = await getAna(req); if (!a || !canWriteDoc(a, req)) return res.status(404).json({ error: 'Review not found.' }); await analyses().deleteOne({ _id: a._id }); await drop(a.file_id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  return { ensureIndexes: async () => { await generated().createIndex({ updated_at: -1 }); await analyses().createIndex({ created_at: -1 }); await templates().createIndex({ created_at: -1 }); } };
}
