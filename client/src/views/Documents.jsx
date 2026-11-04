// Documents: create documents from ready-made or uploaded formats, keep and download them, and review a document
// against the compliance rules. A document prepared for a compliance record is attached to that record when complete.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useRemote } from '../state/hooks.js';
import { useUi, ModalHead, Chip, Empty } from '../ui/ui.jsx';
import { api, downloadUrl, uploadFile } from '../lib/api.js';
import { docWhen } from '../lib/format.js';
import { CHECK_CLS, DOC_PRIO_CLS, DOC_TYPES, READY_CLS, SRC_TXT, VAR_TYPES } from '../lib/constants.js';
import RecordDrawer from '../components/RecordDrawer.jsx';

const enc = encodeURIComponent;
const TABS = [['create', 'Create a document'], ['mine', 'My documents'], ['review', 'Review a document']];
const MAX = 15 * 1024 * 1024;

// The format list, saved documents and reviews are shared by the tabs and the dialogs; a change in one refreshes the others.
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());
const tabSetters = new Set();   // a saved document is shown under "My documents"
const showMine = () => tabSetters.forEach((fn) => fn('mine'));
function useDocLists() {
  const [templates, tErr, reloadT] = useRemote('/api/docstudio/templates');
  const [gen, gErr, reloadG] = useRemote('/api/docstudio/generated');
  const [ana, aErr, reloadA] = useRemote('/api/docstudio/analyses');
  const reloadAll = useRef(null);
  reloadAll.current = () => { reloadT(); reloadG(); reloadA(); };
  useEffect(() => { const fn = () => reloadAll.current(); listeners.add(fn); return () => listeners.delete(fn); }, []);
  return { templates, gen, ana, err: tErr || gErr || aErr };
}
const sortedProjects = (S) => Object.keys(S.projects || {}).sort((a, b) => (S.projects[a].name || '').localeCompare(S.projects[b].name || ''));

export default function Documents() {
  const S = useStore();
  const [tab, setTab] = useSticky('documents.tab', 'create');
  useEffect(() => { tabSetters.add(setTab); return () => tabSetters.delete(setTab); }, [setTab]);
  const lists = useDocLists();
  const [q, setQ] = useSticky('documents.q', '');
  const [cat, setCat] = useSticky('documents.cat', '');
  return (
    <>
      <div className="section-title">Documents</div>
      <div className="ru-bar"><div className="sub">Create the documents your compliance work needs, keep them here, and check any document against the rules before you submit it.</div></div>
      <div className="seg doc-tabs">{TABS.map(([k, l]) => <button key={k} className={'seg-btn' + (tab === k ? ' on unk' : '')} type="button" onClick={() => setTab(k)}>{l}</button>)}</div>
      <div style={{ marginTop: 14 }}>
        {lists.err && !(lists.templates || lists.gen || lists.ana) ? <Empty>{lists.err}</Empty>
          : tab === 'create' ? <CreateTab templates={lists.templates} q={q} setQ={setQ} cat={cat} setCat={setCat} canUp={S.can('upload_docs')} />
            : tab === 'mine' ? <MineTab gen={lists.gen} /> : <ReviewTab ana={lists.ana} />}
      </div>
    </>
  );
}

/* ---------- create: the format gallery ---------- */
function CreateTab({ templates, q, setQ, cat, setCat, canUp }) {
  const ui = useUi();
  const list = templates ? templates.templates : null, cats = templates ? templates.categories : [];
  const ql = q.trim().toLowerCase();
  const rows = (list || []).filter((t) => (!cat || t.category === cat) && (!ql || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(ql)));
  const use = (id) => ui.openModal(<DocForm template={id} />);
  return (
    <>
      <div className="filters" style={{ marginBottom: 14 }}>
        <label className="grow">Search<input type="search" value={q} placeholder="Search formats, e.g. NOC, declaration, authorisation" onChange={(e) => setQ(e.target.value)} /></label>
        <label>Category<select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All</option>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        {canUp && <button className="btn primary" type="button" onClick={() => ui.openModal(<TemplateUpload cats={cats} />)}>Upload your own format</button>}
      </div>
      <div className="doc-grid">
        {list === null ? <Empty>Loading…</Empty> : !rows.length ? <Empty>{list.length ? 'No formats match your search.' : 'No formats yet.'}</Empty>
          : rows.map((t) => (
            <div key={t.id} className="doc-card" tabIndex={0} onClick={() => use(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') use(t.id); }}>
              <div className="doc-card-top"><Chip>{t.category}</Chip>{t.kind === 'uploaded' && <Chip cls="ok">Your format</Chip>}</div>
              <div className="doc-card-name">{t.name}</div>
              <div className="doc-card-desc">{t.description || 'Uploaded format'}</div>
              <div className="doc-card-foot"><span>{t.fields} field{t.fields === 1 ? '' : 's'} to fill</span><span className="doc-use">Use →</span></div>
            </div>
          ))}
      </div>
      <div className="fact-sub" style={{ marginTop: 12 }}>These are drafts for your team to review. Where an authority has its own official form, upload that form as your own format and fill it here.</div>
    </>
  );
}

/* ---------- fill a document ---------- */
function FieldControl({ v, value, onChange }) {
  if (v.type === 'multiline') return <textarea className="ru-textarea" maxLength={4000} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (v.type === 'select') return <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{(v.options || []).map((o) => <option key={o}>{o}</option>)}</select>;
  const type = v.type === 'date' ? 'date' : v.type === 'email' ? 'email' : v.type === 'phone' ? 'tel' : 'text';
  return <input type={type} maxLength={400} inputMode={v.type === 'number' ? 'decimal' : undefined} value={value} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * {template} starts a new document; {gen} edits a saved one. `ctx` ({key, project_id, doc_name}) ties it to a compliance
 * record: the finished document is then attached to that record's document list.
 */
export function DocForm({ template, gen, ctx: ctxIn }) {
  const S = useStore();
  const ui = useUi();
  const [st, setSt] = useState(null);           // {t, editing, ctx}
  const [values, setValues] = useState({});
  const [pid, setPid] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const autoFilled = useRef(new Set());

  useEffect(() => {
    (async () => {
      let t, editing = null, ctx = ctxIn || null, p = '', ti = '', vals = {};
      if (gen) {
        editing = await api('GET', '/api/docstudio/generated/' + enc(gen));
        t = { name: editing.template_name, variables: editing.variables, id: editing.template_id, description: '' };
        vals = editing.values || {}; ti = editing.title; p = editing.project_id || '';
        if (!ctx && editing.record_key && editing.record_doc) ctx = { key: editing.record_key, project_id: p, doc_name: editing.record_doc };
      } else {
        t = await api('GET', '/api/docstudio/templates/' + enc(template));
        if (ctx) { p = ctx.project_id || ''; ti = ctx.doc_name + (p && S.projects[p] ? ' - ' + (S.projects[p].name || '') : ''); }
      }
      setSt({ t, editing, ctx }); setValues(Object.fromEntries(t.variables.map((v) => [v.key, vals[v.key] || '']))); setPid(p); setTitle(ti);
      if (!editing) prefill(t, p);
    })().catch((e) => { ui.toast(e.message, 6000); ui.closeModal(); });
  }, []); 

  /** Fill fields from the records (company, project, user); a value typed by hand is never overwritten. */
  const prefill = async (t, projectId) => {
    try {
      const r = await api('POST', '/api/docstudio/prefill', { template_id: t.id, project_id: projectId });
      setValues((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(r.values || {})) if (k in next && (!next[k] || autoFilled.current.has(k))) { next[k] = v; autoFilled.current.add(k); }
        return next;
      });
      const n = Object.keys(r.values || {}).length;
      setNote(n ? `${n} field${n === 1 ? ' was' : 's were'} filled from your records. Check them and change anything that is wrong.` : null);
    } catch { /* the form still works without it */ }
  };
  if (!st) return <ModalHead title="Loading…" />;
  const { t, editing, ctx } = st;

  const save = async (dl) => {
    const vals = {}; for (const v of t.variables) if (String(values[v.key] || '').trim()) vals[v.key] = String(values[v.key]).trim();
    setBusy(true);
    try {
      const body = { values: vals, title: title.trim() };
      if (editing) body.id = editing.id; else { body.template_id = t.id; body.project_id = pid; }
      if (ctx) body.attach = { key: ctx.key, doc_name: ctx.doc_name, project_id: ctx.project_id || '' };
      const r = await api('POST', '/api/docstudio/generate', body);
      changed();
      if (dl) downloadUrl(`/api/docstudio/generated/${enc(r.id)}/download`);
      if (ctx && r.attached && r.attached.ok) {
        const n = r.attached.carried;
        ui.toast(`Saved and added to record ${String(ctx.key).split('__')[0]} (version ${r.attached.version}). It now needs verifying.${n ? ` Also added to ${n} later record${n === 1 ? '' : 's'} that need it.` : ''}`, 7000);
        S.reload(['documents']);
        ui.openModal(<RecordDrawer refKey={ctx.key} />); return;
      }
      ui.toast(r.status === 'Draft' ? `Saved as a draft: ${r.missing.length} required field${r.missing.length === 1 ? ' is' : 's are'} still empty.${ctx ? ' It is added to the record once complete.' : ''}` : 'Document saved.', 6000);
      showMine();
      ui.openModal(<DocDetail id={r.id} />);
    } catch (e) { ui.toast(e.message, 7000); setBusy(false); }
  };

  return (
    <>
      <ModalHead kicker={editing ? 'Edit document' : 'New document'} title={editing ? editing.title : t.name} badges={t.kind === 'uploaded' && <Chip cls="ok">Your format</Chip>} />
      <div className="modal-body modal-stack"><section className="panel">
        {t.description && <div className="fact-sub" style={{ marginBottom: 10, fontSize: 12.5 }}>{t.description}</div>}
        <div className="setup-grid">
          <div className="field"><label>Project (optional)</label><select value={pid} disabled={!!editing || !!(ctx && pid)} onChange={(e) => { setPid(e.target.value); prefill(t, e.target.value); }}><option value="">No project</option>{sortedProjects(S).map((p) => <option key={p} value={p}>{S.projects[p].name || p}</option>)}</select></div>
          <div className="field"><label>Document name</label><input value={title} placeholder={t.name} maxLength={150} onChange={(e) => setTitle(e.target.value)} /></div>
        </div>
        <div className="doc-fill-note">
          {ctx ? <div className="doc-auto">This is the “{ctx.doc_name}” for record {String(ctx.key).split('__')[0]}. When it is complete it is added to that record's documents, ready for verification.</div>
            : note && <div className="doc-auto">{note}</div>}
        </div>
        <div className="setup-grid">{t.variables.map((v) => (
          <div key={v.key} className="field" style={v.type === 'multiline' ? { gridColumn: '1/-1' } : undefined}>
            <label>{v.label}{v.required ? <> <span className="doc-req">*</span></> : <> <span className="doc-opt">optional</span></>}</label>
            <FieldControl v={v} value={values[v.key] || ''} onChange={(x) => { autoFilled.current.delete(v.key); setValues({ ...values, [v.key]: x }); }} />
            {v.hint && <div className="fact-sub">{v.hint}</div>}
          </div>
        ))}</div>
        <div className="fact-sub" style={{ marginTop: 8 }}><span className="doc-req">*</span> Required. You can save with some fields empty: the document is kept as a draft, and empty fields show in [brackets] until you fill them.</div>
      </section></div>
      <div className="modal-foot">
        <button className="btn primary" type="button" disabled={busy} onClick={() => save(false)}>Save</button>
        <button className="btn" type="button" disabled={busy} onClick={() => save(true)}>Save and download Word</button>
        {t.can_edit && <button className="btn" type="button" disabled={busy} onClick={() => ui.openModal(<TemplateEditor id={t.id} />)}>Edit this format</button>}
      </div>
    </>
  );
}

/* ---------- my documents ---------- */
function MineTab({ gen }) {
  const ui = useUi();
  if (gen === null) return <Empty>Loading…</Empty>;
  if (!gen.length) return <Empty><b>No documents yet.</b><div style={{ marginTop: 6 }}>Create one from the first tab. It is saved here and can be edited and downloaded any time.</div></Empty>;
  return (
    <div className="table-wrap"><table className="und-table"><thead><tr><th>Document</th><th>Format</th><th>Project</th><th>Status</th><th>Version</th><th>Last saved</th></tr></thead><tbody>
      {gen.map((g) => (
        <tr key={g.id} onClick={() => ui.openModal(<DocDetail id={g.id} />)}>
          <td><b>{g.title}</b></td><td>{g.template_name}</td><td>{g.project_name || '—'}</td>
          <td><Chip cls={g.status === 'Complete' ? 'ok' : 'warn'}>{g.status}</Chip>{g.missing > 0 && <> <span className="fact-sub">{g.missing} empty</span></>}</td>
          <td className="mono">v{g.version}</td><td>{docWhen(g.updated_at)}<div className="fact-sub">{g.updated_by || ''}</div></td>
        </tr>
      ))}
    </tbody></table></div>
  );
}

function DocDetail({ id }) {
  const S = useStore();
  const ui = useUi();
  const [g, err] = useRemote('/api/docstudio/generated/' + enc(id));
  const [checking, setChecking] = useState(false);
  if (!g) return <ModalHead title={err || 'Loading…'} />;
  const base = `/api/docstudio/generated/${enc(g.id)}/download`, up = S.can('upload_docs');
  const check = async () => {
    setChecking(true);
    try { const r = await api('POST', '/api/docstudio/analyse-generated', { id: g.id }); changed(); ui.openModal(<ReviewModal id={r.id} />); }
    catch (e) { ui.toast(e.message, 7000); setChecking(false); }
  };
  const del = async () => {
    if (!window.confirm('Delete this document and all its versions?')) return;
    try { await api('DELETE', '/api/docstudio/generated/' + enc(g.id)); changed(); ui.closeModal(); ui.toast('Deleted.'); } catch (e) { ui.toast(e.message, 6000); }
  };
  return (
    <>
      <ModalHead kicker={g.template_name} title={g.title} badges={<><Chip cls={g.status === 'Complete' ? 'ok' : 'warn'}>{g.status}</Chip><Chip>v{g.version}</Chip></>}
        sub={`${g.project_name ? g.project_name + ' · ' : ''}Saved ${docWhen(g.updated_at)} by ${g.updated_by || g.created_by_name || ''}`} />
      <div className="modal-body modal-stack">
        <section className="panel"><div className="ru-acts">
          <a className="btn primary" href={base}>Download Word</a>
          <a className="btn" href={base + '?format=txt'}>Download text</a>
          {g.can_edit && up && <button className="btn" type="button" onClick={() => ui.openModal(<DocForm gen={g.id} />)}>Edit values</button>}
          {up && <button className="btn" type="button" disabled={checking} onClick={check}>{checking ? 'Checking… this can take up to a minute' : 'Check against compliance rules'}</button>}
          {g.can_edit && up && <button className="btn" type="button" onClick={del}>Delete</button>}
        </div>
          {g.missing > 0 && <div className="ru-warn" style={{ marginTop: 10 }}>{g.missing} required field{g.missing === 1 ? ' is' : 's are'} still empty. They show in [brackets] in the document.</div>}</section>
        <section className="panel"><div className="ru-k">Preview</div><pre className="doc-preview">{g.preview}</pre></section>
        {g.versions.length > 1 && <section className="panel"><div className="ru-k">Earlier versions</div>
          {g.versions.slice().reverse().map((v) => <div key={v.version} className="ru-hist"><b>Version {v.version}</b> · {docWhen(v.at)} · {v.by || ''} · <a href={`${base}?v=${v.version}`}>Download</a></div>)}</section>}
      </div>
    </>
  );
}

/* ---------- prepare a document for a compliance record ---------- */
// Opened from a record's document list for a document the company writes itself. The format uploaded for this document
// name is reused on every record.
export function PrepareModal({ inst, name }) {
  const ui = useUi();
  const ctx = { key: inst.key, compliance_id: inst.item.compliance_id, project_id: inst.projectId || '', doc_name: name };
  const [r, err] = useRemote('/api/docstudio/template-for?name=' + enc(name));
  const [cats] = useRemote('/api/docstudio/templates');
  if (!r) return <ModalHead title={err || 'Loading…'} />;
  const t = r.template;
  const upload = () => ui.openModal(<TemplateUpload ctx={ctx} cats={cats ? cats.categories : []} />);
  return (
    <>
      <ModalHead kicker={inst.item.compliance_id} title={name} badges={<Chip cls="ok">Prepared by us</Chip>} />
      <div className="modal-body modal-stack">
        <section className="panel">{t ? <>
          <div className="ru-k">Format on file</div><div style={{ margin: '4px 0 10px' }}><b>{t.name}</b> <span className="fact-sub">· {t.fields} field{t.fields === 1 ? '' : 's'} to fill</span></div>
          <div className="fact-sub" style={{ marginBottom: 10 }}>The fields were found automatically in the format you uploaded. You enter the values, save, and download it. The saved document is added to this record.</div>
          <div className="ru-acts"><button className="btn primary" type="button" onClick={() => ui.openModal(<DocForm template={t.id} ctx={ctx} />)}>Fill in and save</button><button className="btn" type="button" onClick={upload}>Upload a different format</button></div>
        </> : <>
          <div className="ru-k">Step 1: upload the format</div><div className="fact-sub" style={{ margin: '4px 0 10px' }}>Upload the blank format for this document (Word is best; PDF or text also work). The fields that change each time are found for you. Next time, this same format is used automatically.</div>
          <div className="ru-acts"><button className="btn primary" type="button" onClick={upload}>Upload the format</button></div>
        </>}</section>
        <section className="panel"><div className="ru-k">No format of your own?</div><div className="fact-sub" style={{ margin: '4px 0 8px' }}>Start from one of the ready-made formats instead.</div>
          <div className="setup-grid"><div className="field"><select value="" onChange={(e) => { if (e.target.value) ui.openModal(<DocForm template={e.target.value} ctx={ctx} />); }}>
            <option value="">Choose a ready-made format…</option>{(r.ready_made || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div></div></section>
        <div className="fact-sub">Documents issued by an authority are not prepared here: upload those from the record.</div>
      </div>
      <div className="modal-foot"><button className="btn" type="button" onClick={() => ui.openModal(<RecordDrawer refKey={inst.key} />)}>Back to the record</button></div>
    </>
  );
}

/* ---------- upload your own format ---------- */
function TemplateUpload({ ctx: ctxIn, cats }) {
  const ui = useUi();
  const ctx = ctxIn && ctxIn.doc_name ? ctxIn : null;
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [cat, setCat] = useState('Other');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!file) { ui.toast('Choose a file first.'); return; }
    if (file.size > MAX) { ui.toast('The file is larger than 15 MB.'); return; }
    setBusy(true);
    try {
      const q = { file_name: file.name, name: name.trim(), category: cat };
      if (ctx) q.for_doc = ctx.doc_name;                         // remembered, so this document uses the same format on every record
      const r = await uploadFile('/files/docstudio/template', file, q);
      changed();
      ui.openModal(<TemplateEditor id={r.id} fresh ctx={ctx} />);
    } catch (e) { ui.toast(e.message, 8000); setBusy(false); }
  };
  return (
    <>
      <ModalHead kicker="Your format" title={ctx ? `Upload the format for “${ctx.doc_name}”` : 'Upload a format'} />
      <div className="modal-body modal-stack"><section className="panel">
        <div className="fact-sub" style={{ marginBottom: 10, fontSize: 12.5 }}>Upload a Word file (best), PDF or text file. The blanks and placeholders in it (such as ______, ....., [Project name]) are found automatically. You check them next, then anyone can fill the format and download it.</div>
        <div className="setup-grid">
          <div className="field" style={{ gridColumn: '1/-1' }}><label>File</label><input type="file" accept=".docx,.pdf,.txt,.md" onChange={(e) => { const f = e.target.files[0] || null; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '')); }} /></div>
          <div className="field"><label>Name</label><input maxLength={120} placeholder="e.g. Fire NOC application" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Category</label><select value={cat} onChange={(e) => setCat(e.target.value)}>{(cats || []).map((c) => <option key={c}>{c}</option>)}</select></div>
        </div>
      </section></div>
      <div className="modal-foot"><button className="btn primary" type="button" disabled={busy} onClick={go}>{busy ? 'Reading the file…' : 'Upload and find fields'}</button></div>
    </>
  );
}

/* ---------- check and refine the fields of an uploaded format ---------- */
function TemplateEditor({ id, fresh, ctx }) {
  const ui = useUi();
  const [t, setT] = useState(null);
  const [cats] = useRemote('/api/docstudio/templates');
  const [name, setName] = useState('');
  const [cat, setCat] = useState('');
  const [vars, setVars] = useState([]);
  const [find, setFind] = useState(''), [label, setLabel] = useState('');
  const load = async (keepForm) => {
    const x = await api('GET', '/api/docstudio/templates/' + enc(id));
    setT(x);
    if (!keepForm) { setName(x.name); setCat(x.category); setVars(x.variables); }
    return x;
  };
  useEffect(() => { load(false).catch((e) => { ui.toast(e.message, 6000); ui.closeModal(); }); }, []); 
  if (!t) return <ModalHead title="Loading…" />;

  const field = async (body, msg) => {
    try {
      const r = await api('POST', `/api/docstudio/templates/${enc(id)}/field`, body);
      // keep the edits made to the other fields; take the server's list for which fields exist
      setVars((prev) => r.variables.map((v) => prev.find((p) => p.key === v.key) || v));
      await load(true);
      if (msg) ui.toast(msg);
      return true;
    } catch (e) { ui.toast(e.message, 6000); return false; }
  };
  const add = async () => {
    if (find.trim().length < 2) { ui.toast('Type the exact words from the document.'); return; }
    if (await field({ op: 'add', text: find.trim(), label: label.trim() }, 'Field added.')) { setFind(''); setLabel(''); }
  };
  const save = async () => {
    if (name.trim().length < 2) { ui.toast('Give the format a name.'); return; }
    try {
      await api('PUT', '/api/docstudio/templates/' + enc(id), { name: name.trim(), category: cat, variables: vars.map((v) => ({ key: v.key, label: v.label.trim(), type: v.type, source: v.source || null, required: !!v.required })) });
      changed(); ui.toast('Saved.');
      if (fresh) ui.openModal(<DocForm template={id} ctx={ctx} />); else ui.closeModal();
    } catch (e) { ui.toast(e.message, 6000); }
  };
  const del = async () => {
    if (!window.confirm('Delete this format? Documents already made from it are kept.')) return;
    try { await api('DELETE', '/api/docstudio/templates/' + enc(id)); changed(); ui.closeModal(); ui.toast('Format deleted.'); } catch (e) { ui.toast(e.message, 6000); }
  };
  const setVar = (key, patch) => setVars(vars.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  return (
    <>
      <ModalHead kicker={fresh ? 'Check the fields' : 'Edit format'} title={t.name} />
      <div className="modal-body modal-stack">
        {fresh && <div className="doc-auto">{t.variables.length ? `We found ${t.variables.length} field${t.variables.length === 1 ? '' : 's'} to fill.` : 'We did not find any fields.'} Check the names, remove anything that is not a field, and add any we missed.</div>}
        <section className="panel"><div className="setup-grid">
          <div className="field"><label>Name</label><input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Category</label><select value={cat} onChange={(e) => setCat(e.target.value)}>{((cats && cats.categories) || [t.category]).map((c) => <option key={c}>{c}</option>)}</select></div>
        </div></section>
        <section className="panel"><div className="ru-k">Fields</div>
          {vars.length ? vars.map((v) => (
            <div key={v.key} className="doc-var">
              <div className="doc-var-main">
                <input className="vl" value={v.label} maxLength={80} aria-label="Field name" onChange={(e) => setVar(v.key, { label: e.target.value })} />
                <select className="vt" aria-label="Type" value={v.type} onChange={(e) => setVar(v.key, { type: e.target.value })}>{Object.entries(VAR_TYPES).map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select>
                <select className="vs" aria-label="Auto-fill" value={v.source || ''} onChange={(e) => setVar(v.key, { source: e.target.value || null })}><option value="">Type it each time</option>{Object.entries(SRC_TXT).map(([k, l]) => <option key={k} value={k}>Fill with: {l}</option>)}</select>
                <label className="doc-req-chk"><input type="checkbox" className="vr" checked={!!v.required} onChange={(e) => setVar(v.key, { required: e.target.checked })} /> Required</label>
                <button className="btn sm vx" type="button" title="Not a field: put the original wording back" onClick={() => field({ op: 'remove', key: v.key })}>Remove</button>
              </div>
              <div className="fact-sub">{v.original && `Found as “${v.original.slice(0, 60)}”`}{v.count > 1 && ` · used ${v.count} times`}</div>
            </div>
          )) : <div className="fact-sub">No fields found. Add one below by typing the exact words in the document that should change each time.</div>}
        </section>
        <section className="panel"><div className="ru-k">Add a field we missed</div><div className="fact-sub" style={{ marginBottom: 6 }}>Type the exact words in the document that should change each time (for example a sample name). Every place those words appear becomes the field.</div>
          <div className="setup-grid"><div className="field"><label>Words in the document</label><input maxLength={300} value={find} onChange={(e) => setFind(e.target.value)} /></div><div className="field"><label>Field name</label><input maxLength={80} placeholder="e.g. Applicant name" value={label} onChange={(e) => setLabel(e.target.value)} /></div></div>
          <button className="btn sm" type="button" onClick={add}>Add field</button></section>
        <section className="panel"><div className="ru-k">Preview of the format</div><pre className="doc-preview">{t.preview}</pre><div className="fact-sub">Fields appear as {'{{field_name}}'}.</div></section>
      </div>
      <div className="modal-foot"><button className="btn primary" type="button" onClick={save}>{fresh ? 'Save and use' : 'Save'}</button><button className="btn" type="button" onClick={del}>Delete format</button></div>
    </>
  );
}

/* ---------- review a document ---------- */
function ReviewTab({ ana }) {
  const S = useStore();
  const ui = useUi();
  const [file, setFile] = useState(null);
  const [pid, setPid] = useState('');
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!file) { ui.toast('Choose a document first.'); return; }
    if (file.size > MAX) { ui.toast('The file is larger than 15 MB.'); return; }
    setBusy(true);
    try { const r = await uploadFile('/files/docstudio/analyse', file, { file_name: file.name, project_id: pid, doc_type: type.trim() }); changed(); ui.openModal(<ReviewModal id={r.id} />); }
    catch (e) { ui.toast(e.message, 8000); }
    setBusy(false);
  };
  return (
    <>
      {S.can('upload_docs') && <section className="card"><h3 style={{ marginBottom: 4 }}>Check a document before you submit it</h3>
        <div className="fact-sub" style={{ marginBottom: 12, fontSize: 12.5 }}>Upload an application, declaration, letter or agreement (Word, PDF or text). It is checked against the regulations and your compliance register, and you get what is missing and the wording to change.</div>
        <div className="setup-grid">
          <div className="field" style={{ gridColumn: '1/-1' }}><label>Document</label><input type="file" accept=".docx,.pdf,.txt,.md" onChange={(e) => setFile(e.target.files[0] || null)} /></div>
          <div className="field"><label>Project (optional)</label><select value={pid} onChange={(e) => setPid(e.target.value)}><option value="">No project</option>{sortedProjects(S).map((p) => <option key={p} value={p}>{S.projects[p].name || p}</option>)}</select></div>
          <div className="field"><label>What is it? (optional)</label><input list="rvTypes" maxLength={120} placeholder="Leave empty to detect it" value={type} onChange={(e) => setType(e.target.value)} /><datalist id="rvTypes">{DOC_TYPES.map((x) => <option key={x} value={x} />)}</datalist></div>
        </div>
        <button className="btn primary" type="button" disabled={busy} onClick={run}>{busy ? 'Reading and checking… this can take up to a minute' : 'Review document'}</button></section>}
      <div className="section-title" style={{ marginTop: 20 }}>Earlier reviews</div>
      {ana === null ? <Empty>Loading…</Empty> : !ana.length ? <div className="fact-sub">No reviews yet.</div> : (
        <div className="table-wrap"><table className="und-table"><thead><tr><th>Document</th><th>Project</th><th>Result</th><th>Reviewed</th></tr></thead><tbody>
          {ana.map((a) => (
            <tr key={a.id} onClick={() => ui.openModal(<ReviewModal id={a.id} />)}>
              <td><b>{a.file_name}</b>{a.document_type && <div className="fact-sub">{a.document_type}</div>}</td><td>{a.project_name || '—'}</td>
              <td>{a.readiness ? <Chip cls={READY_CLS[a.readiness]}>{a.readiness}</Chip> : <Chip cls="hold">Basic checks only</Chip>}</td>
              <td>{docWhen(a.created_at)}<div className="fact-sub">{a.created_by_name || ''}</div></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </>
  );
}

const DocList = ({ a, empty }) => (a && a.length ? <ul>{a.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="fact-sub">{empty || 'None.'}</p>);

function ReviewModal({ id }) {
  const S = useStore();
  const ui = useUi();
  const [a, err, reload] = useRemote('/api/docstudio/analyses/' + enc(id));
  const [retrying, setRetrying] = useState(false);
  if (!a) return <ModalHead title={err || 'Loading…'} />;
  const r = a.ai && a.ai.ok ? a.ai.result : null, up = S.can('upload_docs');
  const copy = (text) => (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => ui.toast('Copied.')).catch(() => ui.toast('Select the text and copy it.'));
  const retry = async () => {
    setRetrying(true);
    try { await api('POST', `/api/docstudio/analyses/${enc(a.id)}/retry`, {}); changed(); await reload(); } catch (e) { ui.toast(e.message, 7000); }
    setRetrying(false);
  };
  const del = async () => {
    if (!window.confirm('Delete this review?')) return;
    try { await api('DELETE', '/api/docstudio/analyses/' + enc(a.id)); changed(); ui.closeModal(); ui.toast('Deleted.'); } catch (e) { ui.toast(e.message, 6000); }
  };
  const basic = (a.basic || []).length > 0 && <section className="panel"><div className="ru-k">Basic checks</div>{a.basic.map((b, i) => <div key={i} className="ru-hist">{b.level === 'warn' ? '⚠ ' : 'ℹ '}{b.text}</div>)}</section>;
  return (
    <>
      <ModalHead kicker="Document review" title={a.file_name} badges={<>{r ? <Chip cls={READY_CLS[r.readiness]}>{r.readiness}</Chip> : <Chip cls="hold">Basic checks only</Chip>}{a.ocr && <Chip>Read from a scan</Chip>}</>}
        sub={`${a.project_name ? a.project_name + ' · ' : ''}Reviewed ${docWhen(a.created_at)}${r && r.readiness_reason ? ` · ${r.readiness_reason}` : ''}`} />
      <div className="modal-body modal-stack">
        {!r ? <>{basic}<section className="panel"><div className="ru-warn">{(a.ai && a.ai.error) || 'The compliance review is not available for this document.'}</div>
          {up && <button className="btn" type="button" disabled={retrying} onClick={retry}>{retrying ? 'Checking…' : 'Try the compliance review again'}</button>}</section></> : <>
          <section className="panel"><div className="ru-k">What this document is</div><p><b>{r.document_type}</b>{r.purpose && ` — ${r.purpose}`}</p><p>{r.summary}</p></section>
          {basic}
          {r.suggested_changes.length > 0 && <section className="panel"><div className="ru-k">Suggested changes ({r.suggested_changes.length})</div>{r.suggested_changes.map((c, i) => (
            <div key={i} className="doc-change"><div><Chip cls={DOC_PRIO_CLS[c.priority]}>{c.priority}</Chip> <b>{c.issue}</b></div>
              {c.current_text && <div className="doc-now"><span>Now</span>{c.current_text}</div>}
              {c.suggested_text && <div className="doc-new"><span>Suggested</span><div>{c.suggested_text}</div><button className="btn sm" type="button" onClick={() => copy(c.suggested_text)}>Copy</button></div>}
              {c.rule && <div className="fact-sub">Basis: {c.rule.label}</div>}</div>
          ))}</section>}
          {r.checks.length > 0 && <section className="panel"><div className="ru-k">Checks against the rules</div><div className="table-wrap"><table className="und-table"><thead><tr><th>Requirement</th><th>Result</th><th>Where</th></tr></thead><tbody>
            {r.checks.map((c, i) => <tr key={i}><td>{c.requirement}{c.note && <div className="fact-sub">{c.note}</div>}{c.evidence && <div className="doc-quote">“{c.evidence}”</div>}</td><td><Chip cls={CHECK_CLS[c.status]}>{c.status}</Chip></td><td className="fact-sub">{c.rule ? c.rule.label : '—'}</td></tr>)}
          </tbody></table></div></section>}
          {r.missing_information.length > 0 && <section className="panel"><div className="ru-k">Information missing</div><DocList a={r.missing_information} /></section>}
          {r.cautions.length > 0 && <section className="panel"><div className="ru-k">Cautions</div><DocList a={r.cautions} /></section>}
          {a.ai.truncated && <div className="fact-sub">The document was long, so only the first part was checked.</div>}
        </>}
        <div className="fact-sub">This review is a guide for your compliance team, not legal advice. Check the official text before you submit.</div>
      </div>
      <div className="modal-foot">
        <a className="btn primary" href={`/api/docstudio/analyses/${enc(a.id)}/report`}>Download report (Word)</a>
        <a className="btn" href={`/api/docstudio/analyses/${enc(a.id)}/file`}>Download the reviewed file</a>
        {a.can_edit && up && <button className="btn" type="button" onClick={del}>Delete</button>}
      </div>
    </>
  );
}
