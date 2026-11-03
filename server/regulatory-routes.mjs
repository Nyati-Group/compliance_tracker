// HTTP routes for Regulatory Updates. Mounted from server.js before the generic /api/:col routes.
// Reading: any signed-in user, limited to updates that touch projects they may see.
// Reviewing (confirm / assign / task / close): capability review_regulatory + write access to the project concerned.
// Sources, manual documents, manual runs: capability manage_settings (administrators).
import express from 'express';
import { ObjectId } from 'mongodb';
import { isRestricted, canSee, canWriteScope, ROLE_INFO } from './access.mjs';
import { notify } from './notify.mjs';
import {
  CATEGORIES, STAGES, STAGE_LABEL, APPLICABILITY, DEFAULT_EXCLUDE, SEED_SOURCES, effectiveStatus, ingestDocument, reanalyse, runMonitoring,
  politeFetch, assertPublicUrl, loadProfiles, isoDate, note, loadStages
} from './regulatory.mjs';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(s);
const MAX_PDF = 15 * 1024 * 1024;

export function registerRegulatory(app, { db, bucket, requireCap, withScopes, aiConfig, items, appDir }) {
  const updates = () => db.collection('regulatory_updates');
  const sources = () => db.collection('regulatory_sources');
  const stages = loadStages(appDir);
  const deps = () => ({
    ai: aiConfig(), stages, items,
    load: (fileId) => new Promise((ok, fail) => { const chunks = []; bucket.openDownloadStream(new ObjectId(fileId)).on('data', (c) => chunks.push(c)).on('error', fail).on('end', () => ok(Buffer.concat(chunks))); }),
    store: (buffer, filename, meta) => new Promise((ok, fail) => { const up = bucket.openUploadStream(filename, { metadata: meta }); up.on('finish', () => ok(String(up.id))).on('error', fail); up.end(buffer); })
  });
  const fail = (res, e, fallback = 'server error') => { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); console.error(e); return res.status(500).json({ error: fallback }); };

  /* ---------- visibility ---------- */
  const visibleImpacts = (u, allowed) => (u.impacts || []).filter((i) => canSee(allowed, i.project_id));
  // A restricted user sees an update only if it could affect one of their projects (or someone already decided on it there);
  // an update that was assessed "Not Applicable" for their project stays out of their list and bell.
  const canSeeUpdate = (u, allowed) => allowed.all || visibleImpacts(u, allowed).some((i) => i.decision || effectiveStatus(i) !== 'Not Applicable');
  const light = (u, me, allowed) => {
    const imps = visibleImpacts(u, allowed), by = {};
    for (const i of imps) { const s = effectiveStatus(i); by[s] = (by[s] || 0) + 1; }
    const live = imps.filter((i) => ['Potentially Applicable', 'Confirmed Applicable', 'Legal Review Required'].includes(effectiveStatus(i)));
    return {
      id: u._id, title: u.title, authority: u.authority, source_name: u.source_name, circular_number: u.circular_number, publication_date: u.publication_date, effective_date: u.effective_date,
      category: u.category, document_type: u.document_type, summary: u.summary, priority: u.priority, stage: u.stage, processing: u.processing, relevant: u.relevant !== false,
      verification: u.verification, archive: !!u.archive, official_url: u.official_url, origin: u.origin, needs_re_review: !!u.needs_re_review, detected_at: u.detected_at, created_at: u.created_at, updated_at: u.updated_at,
      read: (u.reads || []).includes(me), assignee: u.assignee || null, task_count: (u.tasks || []).length, open_tasks: (u.tasks || []).filter((t) => t.status !== 'done').length,
      impact_counts: by, affected: live.map((i) => ({ project_id: i.project_id, name: i.project_name, company_id: i.company_id, status: effectiveStatus(i) })).slice(0, 40), affected_total: live.length,
      company_ids: [...new Set(imps.map((i) => i.company_id).filter(Boolean))], project_ids: imps.map((i) => i.project_id), has_original: !!u.original_file_id
    };
  };
  const detail = (u, me, allowed) => {
    const { content_text, ...rest } = u;
    return { ...rest, id: u._id, impacts: visibleImpacts(u, allowed), read: (u.reads || []).includes(me), reads: undefined, has_original: !!u.original_file_id, has_text: !!content_text, text_length: (content_text || '').length, stage_label: STAGE_LABEL[u.stage] };
  };

  /* ---------- reading ---------- */
  app.get('/api/regulatory/updates', withScopes, async (req, res) => {
    try {
      const rows = await updates().find({}, { projection: { content_text: 0 } }).sort({ detected_at: -1 }).limit(1500).toArray();
      res.json(rows.filter((u) => canSeeUpdate(u, req.allowed)).map((u) => light(u, req.user._id, req.allowed)));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/regulatory/updates/:id', withScopes, async (req, res) => {
    try {
      const u = validId(req.params.id) && await updates().findOne({ _id: req.params.id });
      if (!u || !canSeeUpdate(u, req.allowed)) return res.status(404).json({ error: 'not found' });
      res.json(detail(u, req.user._id, req.allowed));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/regulatory/updates/:id/original', withScopes, async (req, res) => {
    try {
      const u = validId(req.params.id) && await updates().findOne({ _id: req.params.id }, { projection: { impacts: 1, original_file_id: 1 } });
      if (!u || !u.original_file_id || !canSeeUpdate(u, req.allowed) || !ObjectId.isValid(u.original_file_id)) return res.status(404).json({ error: 'not found' });
      res.setHeader('Content-Type', 'application/pdf'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `inline; filename="${u._id}.pdf"`);
      bucket.openDownloadStream(new ObjectId(u.original_file_id)).on('error', () => res.destroy()).pipe(res);
    } catch (e) { fail(res, e); }
  });
  app.get('/api/regulatory/options', withScopes, async (req, res) => {
    try {
      const users = (await db.collection('users').find({}, { projection: { name: 1, role: 1, project_ids: 1 } }).toArray())
        .filter((u) => (ROLE_INFO[u.role]?.caps || []).includes('edit_tracking'))
        .map((u) => ({ email: String(u._id), name: u.name || String(u._id), role: u.role, project_ids: Array.isArray(u.project_ids) && !['admin', 'company_admin'].includes(u.role) ? u.project_ids.map(String) : null }));
      res.json({ categories: CATEGORIES, stages: STAGES.map((s) => ({ id: s, label: STAGE_LABEL[s] })), applicability: APPLICABILITY, users });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/regulatory/updates/:id/read', withScopes, async (req, res) => {
    try {
      const u = validId(req.params.id) && await updates().findOne({ _id: req.params.id }, { projection: { impacts: 1 } });
      if (!u || !canSeeUpdate(u, req.allowed)) return res.status(404).json({ error: 'not found' });
      await updates().updateOne({ _id: u._id }, req.body?.read === false ? { $pull: { reads: req.user._id } } : { $addToSet: { reads: req.user._id } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  /* ---------- review workflow ---------- */
  const NEXT = {
    new: ['in_review'], analysed: ['in_review'], in_review: ['applicable', 'not_applicable', 'legal_review'], applicable: ['action', 'implemented', 'in_review'],
    legal_review: ['applicable', 'not_applicable', 'action', 'in_review'], action: ['implemented', 'in_review'], implemented: ['closed', 'in_review'], not_applicable: ['closed', 'in_review'], closed: ['in_review']
  };
  const pushHistory = (who, action, text, extra = {}) => ({ $each: [{ ...note(who, action, text), ...extra }], $slice: -120 });

  app.post('/api/regulatory/updates/:id/act', requireCap('review_regulatory'), withScopes, async (req, res) => {
    try {
      const u = validId(req.params.id) && await updates().findOne({ _id: req.params.id });
      if (!u || !canSeeUpdate(u, req.allowed)) return res.status(404).json({ error: 'not found' });
      const b = req.body || {}, me = req.user, who = me.name || me._id, id = u._id;
      const bad = (m, code = 400) => res.status(code).json({ error: m });
      const impact = (pid) => (u.impacts || []).find((i) => i.project_id === pid);
      const needProject = () => { const i = impact(String(b.project_id || '')); if (!i) { bad('Choose one of the projects shown for this update.'); return null; } if (!canWriteScope(req.allowed, i.project_id)) { bad('You do not have access to that project.', 403); return null; } return i; };
      const ok = async (extra = {}) => res.json({ ok: true, ...(extra), update: detail(await updates().findOne({ _id: id }), me._id, req.allowed) });
      const touch = { updated_at: new Date().toISOString() };
      const addressee = async (email) => (email ? db.collection('users').findOne({ _id: String(email) }, { projection: { name: 1, role: 1, project_ids: 1 } }) : null);
      const tell = (to, title, message, pid) => notify(db, { id: `regact:${id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`, type: 'regulatory_assignment', level: 'info', cap: 'edit_tracking', to, title, message, reg_id: id, project_ids: pid ? [pid] : [], authority: u.authority, priority: u.priority, source_url: u.official_url, publication_date: u.publication_date, summary: u.summary });

      switch (b.action) {
        case 'decide': {
          const i = needProject(); if (!i) return;
          const status = b.status === 'reset' ? null : b.status;
          if (status && !['Confirmed Applicable', 'Not Applicable', 'Legal Review Required', 'Insufficient Information'].includes(status)) return bad('Choose Confirmed Applicable, Not Applicable or Legal Review Required.');
          if ((status === 'Not Applicable' || status === 'Confirmed Applicable') && clip(b.note, 600).length < 3) return bad('Please add a short reason for your decision.');
          await updates().updateOne({ _id: id, 'impacts.project_id': i.project_id }, { $set: { 'impacts.$.decision': status ? { status, note: clip(b.note, 600), by: who, by_email: me._id, at: touch.updated_at } : null, ...touch, needs_re_review: false }, $push: { history: pushHistory(who, 'decision', `${i.project_name}: ${status || 'decision cleared'}${b.note ? ` — ${clip(b.note, 300)}` : ''}`, { project_id: i.project_id }) } });
          if (['new', 'analysed'].includes(u.stage)) await updates().updateOne({ _id: id }, { $set: { stage: 'in_review' } });
          return ok();
        }
        case 'set_stage': {
          if (isRestricted(me)) return bad('Only users with access to every project can move the whole update.', 403);
          const to = String(b.stage || '');
          if (!(NEXT[u.stage] || []).includes(to)) return bad(`An update in "${STAGE_LABEL[u.stage]}" cannot move to "${STAGE_LABEL[to] || to}".`);
          if (['implemented', 'closed'].includes(to) && clip(b.note, 600).length < 3) return bad('Please add a short note (what was done / why it can be closed).');
          if (to === 'closed' && u.stage === 'implemented' && (u.tasks || []).some((t) => t.status !== 'done') && !b.force) return bad('There are open tasks. Complete them first, or confirm to close anyway.');
          await updates().updateOne({ _id: id }, { $set: { stage: to, needs_re_review: false, ...touch, ...(to === 'closed' ? { closed_by: who, closed_at: touch.updated_at } : {}), ...(to === 'implemented' ? { implemented_by: who, implemented_at: touch.updated_at } : {}) }, $push: { history: pushHistory(who, 'stage', `${STAGE_LABEL[u.stage]} → ${STAGE_LABEL[to]}${b.note ? ` — ${clip(b.note, 400)}` : ''}`) } });
          return ok();
        }
        case 'assign': {
          const t = await addressee(b.assignee); if (!t) return bad('Choose a person from the list.');
          await updates().updateOne({ _id: id }, { $set: { assignee: { email: String(t._id), name: t.name || String(t._id), by: who, at: touch.updated_at, note: clip(b.note, 400) }, ...touch }, $push: { history: pushHistory(who, 'assign', `Assigned for review to ${t.name || t._id}${b.note ? ` — ${clip(b.note, 300)}` : ''}`) } });
          await tell(String(t._id), 'Regulatory update assigned to you', `${u.title} (${u.authority}). ${clip(b.note, 300)}`);
          return ok();
        }
        case 'task': {
          const i = needProject(); if (!i) return;
          const title = clip(b.title, 200); if (title.length < 3) return bad('Give the task a short title.');
          const due = b.due ? isoDate(b.due) : null; if (b.due && !due) return bad('The due date must be valid.');
          const t = b.assignee ? await addressee(b.assignee) : null; if (b.assignee && !t) return bad('Choose a person from the list.');
          if (b.compliance_id && !items.some((x) => x.compliance_id === b.compliance_id)) return bad('That compliance record does not exist.');
          const task = { id: `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title, description: clip(b.description, 1000), project_id: i.project_id, project_name: i.project_name, compliance_id: b.compliance_id || null, assignee: t ? { email: String(t._id), name: t.name || String(t._id) } : null, due, status: 'open', created_by: who, created_at: touch.updated_at };
          await updates().updateOne({ _id: id }, { $push: { tasks: task, history: pushHistory(who, 'task', `Task created for ${i.project_name}: ${title}`, { project_id: i.project_id }) }, $set: touch });
          if (t) await tell(String(t._id), 'Regulatory task assigned to you', `${title} — ${i.project_name}${due ? `, due ${due}` : ''}. From: ${u.title}`, i.project_id);
          return ok({ task });
        }
        case 'task_status': {
          const t = (u.tasks || []).find((x) => x.id === b.task_id); if (!t) return bad('Task not found.', 404);
          if (!canWriteScope(req.allowed, t.project_id)) return bad('You do not have access to that project.', 403);
          const status = b.status === 'done' ? 'done' : 'open';
          await updates().updateOne({ _id: id, 'tasks.id': t.id }, { $set: { 'tasks.$.status': status, 'tasks.$.done_by': status === 'done' ? who : null, 'tasks.$.done_at': status === 'done' ? touch.updated_at : null, ...touch }, $push: { history: pushHistory(who, 'task', `Task "${t.title}" marked ${status}`, { project_id: t.project_id }) } });
          return ok();
        }
        case 'link': case 'unlink': {
          const i = needProject(); if (!i) return;
          const cid = String(b.compliance_id || ''); if (!items.some((x) => x.compliance_id === cid)) return bad('That compliance record does not exist.');
          await updates().updateOne({ _id: id, 'impacts.project_id': i.project_id }, { [b.action === 'link' ? '$addToSet' : '$pull']: { 'impacts.$.linked_compliance_ids': cid }, $set: touch, $push: { history: pushHistory(who, b.action, `${b.action === 'link' ? 'Linked' : 'Unlinked'} ${cid} (${i.project_name})`, { project_id: i.project_id }) } });
          return ok();
        }
        case 'comment': {
          const text = clip(b.text, 1500); if (text.length < 1) return bad('Write a comment first.');
          const pid = b.project_id ? String(b.project_id) : null; if (pid && !canWriteScope(req.allowed, pid)) return bad('You do not have access to that project.', 403);
          await updates().updateOne({ _id: id }, { $push: { comments: { id: `c_${Date.now().toString(36)}`, text, project_id: pid, by: who, at: touch.updated_at }, history: pushHistory(who, 'comment', text.slice(0, 200), pid ? { project_id: pid } : {}) }, $set: touch });
          return ok();
        }
        case 'verify': {
          if (isRestricted(me)) return bad('Only users with access to every project can verify an analysis.', 403);
          const v = b.verified === false ? 'ai_unverified' : 'human_verified';
          await updates().updateOne({ _id: id }, { $set: { verification: v, verified_by: v === 'human_verified' ? who : null, verified_at: v === 'human_verified' ? touch.updated_at : null, ...touch }, $push: { history: pushHistory(who, 'verify', v === 'human_verified' ? 'AI analysis checked against the official document' : 'Verification removed') } });
          return ok();
        }
        default: return bad('Unknown action.');
      }
    } catch (e) { fail(res, e); }
  });

  /* ---------- administration: sources, manual documents, runs ---------- */
  const admin = requireCap('manage_settings');
  const cleanSource = (b, existing) => {
    const out = {};
    const name = clip(b.name, 120), authority = clip(b.authority, 200);
    if (!existing || b.name !== undefined) { if (name.length < 3) throw Object.assign(new Error('Give the source a name.'), { status: 400 }); out.name = name; }
    if (!existing || b.authority !== undefined) { if (authority.length < 2) throw Object.assign(new Error('Enter the issuing authority.'), { status: 400 }); out.authority = authority; }
    if (b.url !== undefined || !existing) {
      const url = clip(b.url, 500);
      if (url) { try { const x = new URL(url); if (!['https:', 'http:'].includes(x.protocol)) throw 0; } catch { throw Object.assign(new Error('The address must start with https:// or http://'), { status: 400 }); } }
      if (!url && (b.kind || existing?.kind) !== 'manual') throw Object.assign(new Error('Enter the address of the official page to monitor, or choose "Manual only".'), { status: 400 });
      out.url = url || null;
    }
    if (b.kind !== undefined || !existing) { if (!['html', 'rss', 'manual'].includes(b.kind || 'html')) throw Object.assign(new Error('Choose how this source is read.'), { status: 400 }); out.kind = b.kind || 'html'; }
    if (b.category !== undefined) out.category = CATEGORIES.includes(b.category) ? b.category : 'General';
    if (b.frequency !== undefined) out.frequency = 'daily';
    if (b.include !== undefined || b.exclude !== undefined) {
      for (const k of ['include', 'exclude']) if (b[k] !== undefined) { const v = clip(b[k], 300); if (v) { try { new RegExp(v); } catch { throw Object.assign(new Error(`The ${k} pattern is not valid.`), { status: 400 }); } } out[k] = v || null; }
    }
    if (b.title_from_row !== undefined) out.title_from_row = b.title_from_row === true;
    if (b.note !== undefined) out.note = clip(b.note, 600);
    if (b.robots_confirmed !== undefined) out.robots_confirmed = b.robots_confirmed === true;
    if (b.enabled !== undefined) out.enabled = b.enabled === true;
    return out;
  };
  app.get('/api/regulatory/sources', admin, async (req, res) => {
    try { res.json({ sources: await sources().find().sort({ name: 1 }).toArray(), default_exclude: DEFAULT_EXCLUDE.source, ai: !!aiConfig() }); } catch (e) { fail(res, e); }
  });
  app.post('/api/regulatory/sources', admin, async (req, res) => {
    try {
      const d = cleanSource(req.body || {});
      if (d.kind !== 'manual' && d.url) await assertPublicUrl(d.url);
      const id = `src_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const doc = { _id: id, category: 'General', frequency: 'daily', enabled: false, include: null, exclude: null, note: '', robots_confirmed: false, last_checked: null, last_status: null, last_error: null, last_success: null, consecutive_failures: 0, seen: [], created_by: req.user.name, created_at: new Date().toISOString(), ...d, history: [note(req.user.name, 'created', d.url || '')] };
      if (doc.kind === 'manual') doc.enabled = false;
      await sources().insertOne(doc); res.json({ ok: true, source: doc });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/regulatory/sources/:id', admin, async (req, res) => {
    try {
      const s = validId(req.params.id) && await sources().findOne({ _id: req.params.id }); if (!s) return res.status(404).json({ error: 'not found' });
      const d = cleanSource(req.body || {}, s);
      if (d.url && d.url !== s.url && (d.kind || s.kind) !== 'manual') await assertPublicUrl(d.url);
      if ((d.kind || s.kind) === 'manual') d.enabled = false;
      const changed = Object.keys(d).filter((k) => JSON.stringify(d[k]) !== JSON.stringify(s[k]));
      if (!changed.length) return res.json({ ok: true, source: s });
      const reset = d.url && d.url !== s.url ? { seen: [], last_success: null } : {};
      await sources().updateOne({ _id: s._id }, { $set: { ...d, ...reset, updated_by: req.user.name, updated_at: new Date().toISOString() }, $push: { history: pushHistory(req.user.name, 'edited', changed.map((k) => (k === 'enabled' ? `enabled=${d.enabled}` : k === 'robots_confirmed' ? `robots_confirmed=${d.robots_confirmed}` : k)).join(', ')) } });
      res.json({ ok: true, source: await sources().findOne({ _id: s._id }) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/regulatory/sources/:id/run', admin, async (req, res) => {
    try {
      const s = validId(req.params.id) && await sources().findOne({ _id: req.params.id }); if (!s) return res.status(404).json({ error: 'not found' });
      if (s.kind === 'manual') return res.status(400).json({ error: 'This is a manual source - add documents by hand.' });
      res.json({ ok: true, ...(await startRun({ trigger: 'manual', user: req.user.name, sourceId: s._id })) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/regulatory/run', admin, async (req, res) => {
    try { res.json({ ok: true, ...(await startRun({ trigger: req.body?.retry ? 'retry' : 'manual', user: req.user.name, onlyFailed: req.body?.retry === true })) }); } catch (e) { fail(res, e); }
  });
  // A run can take minutes (polite delays + AI), so it continues in the background; the page polls /runs.
  async function startRun(opts) {
    const p = runMonitoring(db, deps(), opts).catch((e) => ({ skipped: false, error: e.message }));
    const quick = await Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), 600))]);
    if (quick && quick.skipped) return { skipped: true, reason: quick.reason };
    return { started: true };
  }
  app.get('/api/regulatory/runs', admin, async (req, res) => {
    try { res.json(await db.collection('regulatory_runs').find().sort({ started_at: -1 }).limit(30).toArray()); } catch (e) { fail(res, e); }
  });
  app.post('/api/regulatory/updates/:id/reanalyse', admin, async (req, res) => {
    try {
      const r = await reanalyse(db, deps(), req.params.id, req.user.name);
      if (r.status === 'skipped') { const u = await updates().findOne({ _id: req.params.id }, { projection: { processing_note: 1 } }); return res.status(422).json({ error: u?.processing_note || 'The document could not be read.' }); }
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  // An administrator adds an official document by hand (for sites that cannot be monitored): link + optional pasted text or uploaded PDF.
  async function addManual({ meta, text, buffer, user }) {
    const url = clip(meta.official_url, 600);
    const x = await assertPublicUrl(url);
    const authority = clip(meta.authority, 200), title = clip(meta.title, 300);
    if (authority.length < 2) throw Object.assign(new Error('Enter the issuing authority.'), { status: 400 });
    if (title.length < 3) throw Object.assign(new Error('Enter the title of the document.'), { status: 400 });
    let source = null; if (meta.source_id && validId(meta.source_id)) source = await sources().findOne({ _id: meta.source_id });
    let type = buffer ? 'application/pdf' : '';
    if (!text && !buffer) {
      try { const d = await politeFetch(url, { checkRobots: false, retries: 1, accept: 'application/pdf,text/html,*/*' }); buffer = d.buffer; type = d.type; }
      catch (e) { throw Object.assign(new Error(`The server could not read that page itself (${e.message}) Paste the text of the official document, or upload its PDF, and keep the official link.`), { status: 422 }); }
    }
    const r = await ingestDocument(db, { ...deps(), profiles: await loadProfiles(db) }, { source: source || { _id: null, name: 'Added manually', authority, category: meta.category, url: null }, url: x.href, titleHint: title, dateHint: meta.publication_date, buffer, type, text: text || undefined, kind: buffer ? undefined : 'html', origin: 'manual', user, authority, category: CATEGORIES.includes(meta.category) ? meta.category : undefined });
    if (r.id && (meta.circular_number || meta.publication_date || meta.effective_date)) {
      const set = {}; if (clip(meta.circular_number, 120)) set.circular_number = clip(meta.circular_number, 120);
      if (isoDate(meta.publication_date)) set.publication_date = meta.publication_date; if (isoDate(meta.effective_date)) set.effective_date = meta.effective_date;
      if (Object.keys(set).length) await updates().updateOne({ _id: r.id }, { $set: set });
    }
    return r;
  }
  app.post('/api/regulatory/manual', admin, async (req, res) => {
    try {
      const b = req.body || {}; const text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim().slice(0, 200_000) : '';
      const r = await addManual({ meta: b, text, user: req.user.name });
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });
  // The page's CSRF rule requires /files* + the fetch header for non-JSON bodies; the PDF is posted raw, details travel in the query string.
  app.post('/files/regulatory', admin, express.raw({ type: () => true, limit: MAX_PDF }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'Upload a PDF file.' });
      const r = await addManual({ meta: req.query, buffer: req.body, user: req.user.name });
      res.json({ ok: true, ...r });
    } catch (e) { if (e.type === 'entity.too.large') return res.status(413).json({ error: 'File is larger than 15 MB.' }); fail(res, e); }
  });

  return { deps };
}

/** Insert the verified starting sources once (never overwrites an existing source). */
export async function seedSources(db) {
  let added = 0;
  for (const s of SEED_SOURCES) {
    const { _id, ...rest } = s;
    const r = await db.collection('regulatory_sources').updateOne({ _id }, { $setOnInsert: { frequency: 'daily', include: null, exclude: null, robots_confirmed: false, last_checked: null, last_status: null, last_error: null, last_success: null, consecutive_failures: 0, seen: [], created_by: 'migration', created_at: new Date().toISOString(), history: [], ...rest } }, { upsert: true });
    if (r.upsertedCount) added++;
  }
  return added;
}
export async function ensureIndexes(db) {
  await db.collection('regulatory_updates').createIndexes([{ key: { url_key: 1 }, unique: true }, { key: { content_hash: 1 } }, { key: { circ_key: 1 }, sparse: true }, { key: { detected_at: -1 } }, { key: { 'impacts.project_id': 1 } }, { key: { processing: 1 } }]);
  await db.collection('regulatory_runs').createIndexes([{ key: { started_at: -1 } }]);
}
