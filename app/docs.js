/* ============================= DOCUMENTS ============================= */
// Create documents from ready-made or uploaded formats, keep and download them, and review a document against the compliance rules.
// Uses the page's helpers (esc, api, showModal, toast, can, S, fmtDate). Loaded by index.html after the main script's helpers exist.
const DOC = { tab:'create', templates:null, cats:[], gen:null, ana:null, q:'', cat:'', loading:false, err:'', busy:false };
const enc = encodeURIComponent;
const DOC_TABS = [['create','Create a document'],['mine','My documents'],['review','Review a document']];
const READY_CLS = {'Ready to submit':'ok', 'Needs changes':'warn', 'Major gaps':'bad', 'Cannot assess':'hold'};
const CHECK_CLS = {Met:'ok', Missing:'bad', Unclear:'hold', 'Not applicable':''};
const DOC_PRIO_CLS = {High:'bad', Medium:'warn', Low:''};
const DOC_TYPES = ['Application for permission / approval','Declaration / undertaking','Authorisation letter','NOC request','Reply to notice','Agreement for sale','Board resolution','Other'];
const SRC_TXT = {'company.name':'Company name','project.name':'Project name','project.rera_no':'RERA number','project.location':'Project location','project.planning_authority':'Planning authority','today':"Today's date",'user.name':'Signed-in user'};
const docChip = (t,c)=>`<span class="chip ${c||''}">${esc(t)}</span>`;
const docWhen = iso=>iso ? fmtDate(String(iso).slice(0,10)) : '';

async function docLoad(what){
  try{
    if(what==='templates'){ const r = await api('GET','/api/docstudio/templates'); DOC.templates = r.templates; DOC.cats = r.categories; }
    if(what==='gen') DOC.gen = await api('GET','/api/docstudio/generated');
    if(what==='ana') DOC.ana = await api('GET','/api/docstudio/analyses');
    DOC.err = '';
  }catch(e){ DOC.err = e.message; if(what==='templates') DOC.templates = []; if(what==='gen') DOC.gen = []; if(what==='ana') DOC.ana = []; }
  if(S.view==='documents') docRefresh();
}
function docEnsure(){
  if(DOC.tab==='create' && DOC.templates===null) docLoad('templates');
  if(DOC.tab==='mine' && DOC.gen===null) docLoad('gen');
  if(DOC.tab==='review' && DOC.ana===null) docLoad('ana');
}
function renderDocuments(){
  docEnsure();
  return `<div class="section-title">Documents</div>
    <div class="ru-bar"><div class="sub">Create the documents your compliance work needs, keep them here, and check any document against the rules before you submit it.</div></div>
    <div class="seg doc-tabs" id="docTabs">${DOC_TABS.map(([k,l])=>`<button class="seg-btn ${DOC.tab===k?'on unk':''}" data-doctab="${k}" type="button">${l}</button>`).join('')}</div>
    <div id="docBody" style="margin-top:14px">${docBodyHtml()}</div>`;
}
function docBodyHtml(){
  if(DOC.err && !(DOC.templates||DOC.gen||DOC.ana||[]).length) return `<div class="empty-state">${esc(DOC.err)}</div>`;
  return DOC.tab==='create' ? docCreateHtml() : DOC.tab==='mine' ? docMineHtml() : docReviewHtml();
}
function docRefresh(){
  const b = document.getElementById('docBody'); if(!b) return;
  b.innerHTML = docBodyHtml(); docWire();
}
function attachDocumentsHandlers(){
  document.querySelectorAll('[data-doctab]').forEach(btn=>btn.onclick = ()=>{ DOC.tab = btn.dataset.doctab; render(); });
  docWire();
}
function docWire(){
  const q = document.getElementById('docQ'); if(q) q.oninput = ()=>{ DOC.q = q.value; const g = document.getElementById('docGrid'); if(g) g.innerHTML = docGridHtml(); docWireCards(); };
  const c = document.getElementById('docCat'); if(c) c.onchange = ()=>{ DOC.cat = c.value; const g = document.getElementById('docGrid'); if(g) g.innerHTML = docGridHtml(); docWireCards(); };
  const up = document.getElementById('docUpload'); if(up) up.onclick = ()=>openTemplateUpload();
  docWireCards();
  document.querySelectorAll('[data-gen]').forEach(el=>el.onclick = ()=>openDocDetail(el.dataset.gen));
  document.querySelectorAll('[data-ana]').forEach(el=>el.onclick = ()=>openReview(el.dataset.ana));
  const rv = document.getElementById('docRunReview'); if(rv) rv.onclick = runReview;
}
function docWireCards(){ document.querySelectorAll('[data-tpl]').forEach(el=>{ el.onclick = ()=>openDocForm({template:el.dataset.tpl}); el.onkeydown = e=>{ if(e.key==='Enter') openDocForm({template:el.dataset.tpl}); }; }); }

/* ---------- create: the format gallery ---------- */
function docGridHtml(){
  const q = DOC.q.trim().toLowerCase();
  const rows = (DOC.templates||[]).filter(t=>(!DOC.cat || t.category===DOC.cat) && (!q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q)));
  if(DOC.templates===null) return '<div class="empty-state">Loading…</div>';
  if(!rows.length) return `<div class="empty-state">${(DOC.templates||[]).length ? 'No formats match your search.' : 'No formats yet.'}</div>`;
  return rows.map(t=>`<div class="doc-card" data-tpl="${esc(t.id)}" tabindex="0">
    <div class="doc-card-top">${docChip(t.category)}${t.kind==='uploaded'?docChip('Your format','ok'):''}</div>
    <div class="doc-card-name">${esc(t.name)}</div>
    <div class="doc-card-desc">${esc(t.description||'Uploaded format')}</div>
    <div class="doc-card-foot"><span>${t.fields} field${t.fields===1?'':'s'} to fill</span><span class="doc-use">Use →</span></div></div>`).join('');
}
function docCreateHtml(){
  const canUp = can('upload_docs');
  return `<div class="filters" style="margin-bottom:14px">
      <label class="grow">Search<input type="search" id="docQ" value="${esc(DOC.q)}" placeholder="Search formats, e.g. NOC, declaration, authorisation"></label>
      <label>Category<select id="docCat"><option value="">All</option>${(DOC.cats||[]).map(c=>`<option value="${esc(c)}" ${DOC.cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      ${canUp?'<button class="btn primary" id="docUpload" type="button">Upload your own format</button>':''}
    </div>
    <div class="doc-grid" id="docGrid">${docGridHtml()}</div>
    <div class="fact-sub" style="margin-top:12px">These are drafts for your team to review. Where an authority has its own official form, upload that form as your own format and fill it here.</div>`;
}

/* ---------- fill a document ---------- */
function docControl(v, val){
  const id = 'df_'+v.key, base = `id="${id}" data-key="${esc(v.key)}"`;
  if(v.type==='multiline') return `<textarea class="ru-textarea" ${base} maxlength="4000">${esc(val||'')}</textarea>`;
  if(v.type==='select') return `<select ${base}><option value="">Choose…</option>${(v.options||[]).map(o=>`<option ${o===val?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
  const type = v.type==='date' ? 'date' : v.type==='email' ? 'email' : v.type==='phone' ? 'tel' : 'text';
  return `<input ${base} type="${type}" value="${esc(val||'')}" maxlength="400" ${v.type==='number'?'inputmode="decimal"':''}>`;
}
// opts: {template} to start a new document, or {gen} to edit a saved one. ctx ({key, compliance_id, project_id, doc_name}) ties it to a compliance record:
// the finished document is then attached to that record's document list.
async function openDocForm(opts){
  let t, values = {}, title = '', pid = '', editing = null, ctx = opts.ctx || null;
  try{
    if(opts.gen){
      editing = await api('GET','/api/docstudio/generated/'+enc(opts.gen)); t = { name: editing.template_name, variables: editing.variables, id: editing.template_id, description:'' }; values = editing.values||{}; title = editing.title; pid = editing.project_id||'';
      if(!ctx && editing.record_key && editing.record_doc) ctx = {key:editing.record_key, project_id:pid, doc_name:editing.record_doc};
    }
    else{
      t = await api('GET','/api/docstudio/templates/'+enc(opts.template));
      if(ctx){ pid = ctx.project_id||''; title = ctx.doc_name + (pid && S.projects[pid] ? ' - '+(S.projects[pid].name||'') : ''); }
    }
  }catch(e){ toast(e.message, 6000); return; }
  const projs = Object.keys(S.projects||{}).sort((a,b)=>(S.projects[a].name||'').localeCompare(S.projects[b].name||''));
  const d = showModal(`<div class="modal-head"><div style="flex:1"><div class="modal-badges"><span class="modal-id mono">${editing?'Edit document':'New document'}</span>${t.kind==='uploaded'?docChip('Your format','ok'):''}</div><h3 class="modal-title">${esc(editing?editing.title:t.name)}</h3></div><button class="drawer-close" id="drawerClose" aria-label="Close">✕</button></div>
    <div class="modal-body modal-stack"><section class="panel">
      ${t.description?`<div class="fact-sub" style="margin-bottom:10px;font-size:12.5px">${esc(t.description)}</div>`:''}
      <div class="setup-grid">
        <div class="field"><label>Project (optional)</label><select id="dfProject" ${editing||(ctx&&pid)?'disabled':''}><option value="">No project</option>${projs.map(p=>`<option value="${esc(p)}" ${p===pid?'selected':''}>${esc(S.projects[p].name||p)}</option>`).join('')}</select></div>
        <div class="field"><label>Document name</label><input id="dfTitle" value="${esc(title)}" placeholder="${esc(t.name)}" maxlength="150"></div>
      </div>
      <div class="doc-fill-note" id="dfNote"></div>
      <div class="setup-grid" id="dfFields">${t.variables.map(v=>`<div class="field" ${v.type==='multiline'?'style="grid-column:1/-1"':''}><label>${esc(v.label)}${v.required?' <span class="doc-req">*</span>':' <span class="doc-opt">optional</span>'}</label>${docControl(v, values[v.key])}${v.hint?`<div class="fact-sub">${esc(v.hint)}</div>`:''}</div>`).join('')}</div>
      <div class="fact-sub" style="margin-top:8px"><span class="doc-req">*</span> Required. You can save with some fields empty: the document is kept as a draft, and empty fields show in [brackets] until you fill them.</div>
    </section></div>
    <div class="modal-foot"><button class="btn primary" id="dfSave" type="button">Save</button><button class="btn" id="dfSaveDl" type="button">Save and download Word</button>${t.can_edit?'<button class="btn" id="dfManage" type="button">Edit this format</button>':''}</div>`);
  const ctl = key=>d.querySelector(`[data-key="${key}"]`);
  const autoFilled = new Set();
  const applyPrefill = async ()=>{
    if(editing) return;
    try{
      const r = await api('POST','/api/docstudio/prefill',{template_id:t.id, project_id:d.querySelector('#dfProject').value});
      Object.entries(r.values||{}).forEach(([k,v])=>{ const el = ctl(k); if(el && (!el.value || autoFilled.has(k))){ el.value = v; autoFilled.add(k); } });
      const n = Object.keys(r.values||{}).length;
      d.querySelector('#dfNote').innerHTML = n ? `<div class="doc-auto">${n} field${n===1?' was':'s were'} filled from your records. Check them and change anything that is wrong.</div>` : '';
    }catch(e){ /* the form still works without it */ }
  };
  d.querySelectorAll('[data-key]').forEach(el=>el.addEventListener('input', ()=>autoFilled.delete(el.dataset.key)));
  d.querySelector('#dfProject').onchange = applyPrefill;
  if(ctx) d.querySelector('#dfNote').innerHTML = `<div class="doc-auto">This is the “${esc(ctx.doc_name)}” for record ${esc(String(ctx.key).split('__')[0])}. When it is complete it is added to that record's documents, ready for verification.</div>`;
  applyPrefill();
  const save = async (download)=>{
    const vals = {}; t.variables.forEach(v=>{ const el = ctl(v.key); if(el && el.value.trim()) vals[v.key] = el.value.trim(); });
    const btns = d.querySelectorAll('.modal-foot .btn'); btns.forEach(b=>b.disabled = true);
    try{
      const body = { values: vals, title: d.querySelector('#dfTitle').value.trim() };
      if(editing) body.id = editing.id; else { body.template_id = t.id; body.project_id = d.querySelector('#dfProject').value; }
      if(ctx) body.attach = {key:ctx.key, doc_name:ctx.doc_name, project_id:ctx.project_id||''};
      const r = await api('POST','/api/docstudio/generate', body);
      DOC.gen = null; await docLoad('gen');
      if(download) docDownload(r.id);
      if(ctx && r.attached && r.attached.ok){
        const n = r.attached.carried;
        toast(`Saved and added to record ${String(ctx.key).split('__')[0]} (version ${r.attached.version}). It now needs verifying.${n?` Also added to ${n} later record${n===1?'':'s'} that need it.`:''}`, 7000);
        openDrawer(ctx.key); return;
      }
      toast(r.status==='Draft' ? `Saved as a draft: ${r.missing.length} required field${r.missing.length===1?' is':'s are'} still empty.${ctx?' It is added to the record once complete.':''}` : 'Document saved.', 6000);
      if(S.view==='documents' && DOC.tab!=='mine'){ DOC.tab = 'mine'; render(); }
      openDocDetail(r.id);
    }catch(e){ toast(e.message, 7000); btns.forEach(b=>b.disabled = false); }
  };
  d.querySelector('#dfSave').onclick = ()=>save(false);
  d.querySelector('#dfSaveDl').onclick = ()=>save(true);
  const mg = d.querySelector('#dfManage'); if(mg) mg.onclick = ()=>openTemplateEditor(t.id);
}
function docDownload(id, fmt, v){
  const a = document.createElement('a'); a.href = `/api/docstudio/generated/${enc(id)}/download${fmt||v?'?'+[fmt?'format='+fmt:'', v?'v='+v:''].filter(Boolean).join('&'):''}`; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- my documents ---------- */
function docMineHtml(){
  if(DOC.gen===null) return '<div class="empty-state">Loading…</div>';
  if(!DOC.gen.length) return '<div class="empty-state"><b>No documents yet.</b><div style="margin-top:6px">Create one from the first tab. It is saved here and can be edited and downloaded any time.</div></div>';
  return `<div class="table-wrap"><table class="und-table"><thead><tr><th>Document</th><th>Format</th><th>Project</th><th>Status</th><th>Version</th><th>Last saved</th></tr></thead><tbody>
    ${DOC.gen.map(g=>`<tr data-gen="${esc(g.id)}"><td><b>${esc(g.title)}</b></td><td>${esc(g.template_name)}</td><td>${esc(g.project_name||'—')}</td><td>${docChip(g.status, g.status==='Complete'?'ok':'warn')}${g.missing?` <span class="fact-sub">${g.missing} empty</span>`:''}</td><td class="mono">v${g.version}</td><td>${docWhen(g.updated_at)}<div class="fact-sub">${esc(g.updated_by||'')}</div></td></tr>`).join('')}</tbody></table></div>`;
}
async function openDocDetail(id){
  let g; try{ g = await api('GET','/api/docstudio/generated/'+enc(id)); }catch(e){ toast(e.message,6000); return; }
  const d = showModal(`<div class="modal-head"><div style="flex:1"><div class="modal-badges"><span class="modal-id mono">${esc(g.template_name)}</span>${docChip(g.status, g.status==='Complete'?'ok':'warn')}<span class="chip">v${g.version}</span></div><h3 class="modal-title">${esc(g.title)}</h3>
      <div class="fact-sub">${g.project_name?esc(g.project_name)+' · ':''}Saved ${esc(docWhen(g.updated_at))} by ${esc(g.updated_by||g.created_by_name||'')}</div></div><button class="drawer-close" id="drawerClose" aria-label="Close">✕</button></div>
    <div class="modal-body modal-stack">
      <section class="panel"><div class="ru-acts">
        <a class="btn primary" href="/api/docstudio/generated/${enc(g.id)}/download">Download Word</a>
        <a class="btn" href="/api/docstudio/generated/${enc(g.id)}/download?format=txt">Download text</a>
        ${g.can_edit&&can('upload_docs')?'<button class="btn" id="dgEdit" type="button">Edit values</button>':''}
        ${can('upload_docs')?'<button class="btn" id="dgCheck" type="button">Check against compliance rules</button>':''}
        ${g.can_edit&&can('upload_docs')?'<button class="btn" id="dgDel" type="button">Delete</button>':''}</div>
        ${g.missing?`<div class="ru-warn" style="margin-top:10px">${g.missing} required field${g.missing===1?' is':'s are'} still empty. They show in [brackets] in the document.</div>`:''}</section>
      <section class="panel"><div class="ru-k">Preview</div><pre class="doc-preview">${esc(g.preview)}</pre></section>
      ${g.versions.length>1?`<section class="panel"><div class="ru-k">Earlier versions</div>${g.versions.slice().reverse().map(v=>`<div class="ru-hist"><b>Version ${v.version}</b> · ${esc(docWhen(v.at))} · ${esc(v.by||'')} · <a href="/api/docstudio/generated/${enc(g.id)}/download?v=${v.version}">Download</a></div>`).join('')}</section>`:''}
    </div>`);
  const e = d.querySelector('#dgEdit'); if(e) e.onclick = ()=>openDocForm({gen:g.id});
  const c = d.querySelector('#dgCheck'); if(c) c.onclick = async ()=>{ c.disabled = true; c.textContent = 'Checking… this can take up to a minute'; try{ const r = await api('POST','/api/docstudio/analyse-generated',{id:g.id}); DOC.ana = null; await docLoad('ana'); openReview(r.id); }catch(err){ toast(err.message,7000); c.disabled = false; c.textContent = 'Check against compliance rules'; } };
  const del = d.querySelector('#dgDel'); if(del) del.onclick = async ()=>{ if(!confirm('Delete this document and all its versions?')) return; try{ await api('DELETE','/api/docstudio/generated/'+enc(g.id)); DOC.gen = null; closeDrawer(); docLoad('gen'); toast('Deleted.'); }catch(err){ toast(err.message,6000); } };
}

/* ---------- prepare a document for a compliance record ---------- */
// Called from a record's document list for a document the company writes itself. The format uploaded for this document name is reused on every record.
async function openPrepare(inst, name){
  const ctx = {key:inst.key, compliance_id:inst.item.compliance_id, project_id:inst.projectId||'', doc_name:name};
  let r;
  try{ if(DOC.templates===null) await docLoad('templates'); r = await api('GET','/api/docstudio/template-for?name='+enc(name)); }
  catch(e){ toast(e.message, 6000); return; }
  const t = r.template;
  const d = showModal(`<div class="modal-head"><div style="flex:1"><div class="modal-badges"><span class="modal-id mono">${esc(inst.item.compliance_id)}</span>${docChip('Prepared by us','ok')}</div><h3 class="modal-title">${esc(name)}</h3></div><button class="drawer-close" id="drawerClose" aria-label="Close">✕</button></div>
    <div class="modal-body modal-stack">
      <section class="panel">
        ${t ? `<div class="ru-k">Format on file</div><div style="margin:4px 0 10px"><b>${esc(t.name)}</b> <span class="fact-sub">· ${t.fields} field${t.fields===1?'':'s'} to fill</span></div>
          <div class="fact-sub" style="margin-bottom:10px">The fields were found automatically in the format you uploaded. You enter the values, save, and download it. The saved document is added to this record.</div>
          <div class="ru-acts"><button class="btn primary" id="pvUse" type="button">Fill in and save</button><button class="btn" id="pvUp" type="button">Upload a different format</button></div>`
        : `<div class="ru-k">Step 1: upload the format</div><div class="fact-sub" style="margin:4px 0 10px">Upload the blank format for this document (Word is best; PDF or text also work). The fields that change each time are found for you. Next time, this same format is used automatically.</div>
          <div class="ru-acts"><button class="btn primary" id="pvUp" type="button">Upload the format</button></div>`}
      </section>
      <section class="panel"><div class="ru-k">No format of your own?</div><div class="fact-sub" style="margin:4px 0 8px">Start from one of the ready-made formats instead.</div>
        <div class="setup-grid"><div class="field"><select id="pvReady"><option value="">Choose a ready-made format…</option>${(r.ready_made||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div></div></section>
      <div class="fact-sub">Documents issued by an authority are not prepared here: upload those from the record.</div>
    </div>
    <div class="modal-foot"><button class="btn" id="pvBack" type="button">Back to the record</button></div>`);
  const use = d.querySelector('#pvUse'); if(use) use.onclick = ()=>openDocForm({template:t.id, ctx});
  d.querySelector('#pvUp').onclick = ()=>openTemplateUpload(ctx);
  d.querySelector('#pvReady').onchange = e=>{ if(e.target.value) openDocForm({template:e.target.value, ctx}); };
  d.querySelector('#pvBack').onclick = ()=>openDrawer(inst.key);
}

/* ---------- upload your own format ---------- */
function openTemplateUpload(ctx){
  ctx = ctx && ctx.doc_name ? ctx : null;
  const d = showModal(`<div class="modal-head"><div style="flex:1"><div class="modal-badges"><span class="modal-id mono">Your format</span></div><h3 class="modal-title">${ctx?'Upload the format for “'+esc(ctx.doc_name)+'”':'Upload a format'}</h3></div><button class="drawer-close" id="drawerClose" aria-label="Close">✕</button></div>
    <div class="modal-body modal-stack"><section class="panel">
      <div class="fact-sub" style="margin-bottom:10px;font-size:12.5px">Upload a Word file (best), PDF or text file. The blanks and placeholders in it (such as ______, ....., [Project name]) are found automatically. You check them next, then anyone can fill the format and download it.</div>
      <div class="setup-grid">
        <div class="field" style="grid-column:1/-1"><label>File</label><input type="file" id="tuFile" accept=".docx,.pdf,.txt,.md"></div>
        <div class="field"><label>Name</label><input id="tuName" maxlength="120" placeholder="e.g. Fire NOC application"></div>
        <div class="field"><label>Category</label><select id="tuCat">${(DOC.cats||[]).map(c=>`<option ${c==='Other'?'selected':''}>${esc(c)}</option>`).join('')}</select></div>
      </div></section></div>
    <div class="modal-foot"><button class="btn primary" id="tuGo" type="button">Upload and find fields</button></div>`);
  const file = d.querySelector('#tuFile');
  file.onchange = ()=>{ const n = d.querySelector('#tuName'); if(file.files[0] && !n.value) n.value = file.files[0].name.replace(/\.[^.]+$/,''); };
  d.querySelector('#tuGo').onclick = async ()=>{
    const f = file.files[0]; if(!f){ toast('Choose a file first.'); return; }
    if(f.size>15*1024*1024){ toast('The file is larger than 15 MB.'); return; }
    const go = d.querySelector('#tuGo'); go.disabled = true; go.textContent = 'Reading the file…';
    try{
      const q = {file_name:f.name, name:d.querySelector('#tuName').value.trim(), category:d.querySelector('#tuCat').value};
      if(ctx) q.for_doc = ctx.doc_name;                         // remembered, so this document uses the same format on every record
      const r = await docUpload('/files/docstudio/template', f, q);
      DOC.templates = null; await docLoad('templates');
      openTemplateEditor(r.id, true, ctx);
    }catch(e){ toast(e.message,8000); go.disabled = false; go.textContent = 'Upload and find fields'; }
  };
}
async function docUpload(path, file, q){
  const res = await fetch(path+'?'+new URLSearchParams(q).toString(), {method:'POST', headers:{'X-Requested-With':'fetch','Content-Type':'application/octet-stream'}, body:file});
  if(res.status===401){ location.href = '/login.html'; throw new Error('not signed in'); }
  const j = await res.json().catch(()=>({})); if(!res.ok) throw new Error(j.error||('HTTP '+res.status)); return j;
}

/* ---------- check and refine the fields of an uploaded format ---------- */
async function openTemplateEditor(id, fresh, ctx){
  let t; try{ t = await api('GET','/api/docstudio/templates/'+enc(id)); }catch(e){ toast(e.message,6000); return; }
  const srcOpts = v=>`<option value="">Type it each time</option>${Object.entries(SRC_TXT).map(([k,l])=>`<option value="${k}" ${v.source===k?'selected':''}>Fill with: ${l}</option>`).join('')}`;
  const typeOpts = v=>['text','multiline','date','number','email','phone'].map(x=>`<option value="${x}" ${v.type===x?'selected':''}>${({text:'Short text',multiline:'Long text',date:'Date',number:'Number',email:'Email',phone:'Phone'})[x]}</option>`).join('');
  const rows = vars=>vars.length ? vars.map(v=>`<div class="doc-var" data-vk="${esc(v.key)}"><div class="doc-var-main"><input class="vl" value="${esc(v.label)}" maxlength="80" aria-label="Field name"><select class="vt" aria-label="Type">${typeOpts(v)}</select><select class="vs" aria-label="Auto-fill">${srcOpts(v)}</select>
      <label class="doc-req-chk"><input type="checkbox" class="vr" ${v.required?'checked':''}> Required</label><button class="btn sm vx" type="button" title="Not a field: put the original wording back">Remove</button></div>
      <div class="fact-sub">${v.original?`Found as “${esc(v.original.slice(0,60))}”`:''}${v.count>1?` · used ${v.count} times`:''}</div></div>`).join('') : '<div class="fact-sub">No fields found. Add one below by typing the exact words in the document that should change each time.</div>';
  const d = showModal(`<div class="modal-head"><div style="flex:1"><div class="modal-badges"><span class="modal-id mono">${fresh?'Check the fields':'Edit format'}</span></div><h3 class="modal-title">${esc(t.name)}</h3></div><button class="drawer-close" id="drawerClose" aria-label="Close">✕</button></div>
    <div class="modal-body modal-stack">
      ${fresh?`<div class="doc-auto">${t.variables.length?`We found ${t.variables.length} field${t.variables.length===1?'':'s'} to fill.`:'We did not find any fields.'} Check the names, remove anything that is not a field, and add any we missed.</div>`:''}
      <section class="panel"><div class="setup-grid"><div class="field"><label>Name</label><input id="teName" value="${esc(t.name)}" maxlength="120"></div><div class="field"><label>Category</label><select id="teCat">${(DOC.cats||[]).map(c=>`<option ${c===t.category?'selected':''}>${esc(c)}</option>`).join('')}</select></div></div></section>
      <section class="panel"><div class="ru-k">Fields</div><div id="teVars">${rows(t.variables)}</div></section>
      <section class="panel"><div class="ru-k">Add a field we missed</div><div class="fact-sub" style="margin-bottom:6px">Type the exact words in the document that should change each time (for example a sample name). Every place those words appear becomes the field.</div>
        <div class="setup-grid"><div class="field"><label>Words in the document</label><input id="teFind" maxlength="300"></div><div class="field"><label>Field name</label><input id="teLabel" maxlength="80" placeholder="e.g. Applicant name"></div></div><button class="btn sm" id="teAdd" type="button">Add field</button></section>
      <section class="panel"><div class="ru-k">Preview of the format</div><pre class="doc-preview" id="tePrev">${esc(t.preview)}</pre><div class="fact-sub">Fields appear as {{field_name}}.</div></section>
    </div>
    <div class="modal-foot"><button class="btn primary" id="teSave" type="button">${fresh?'Save and use':'Save'}</button><button class="btn" id="teDel" type="button">Delete format</button></div>`);
  const collect = ()=>[...d.querySelectorAll('.doc-var')].map(r=>({key:r.dataset.vk, label:r.querySelector('.vl').value.trim(), type:r.querySelector('.vt').value, source:r.querySelector('.vs').value||null, required:r.querySelector('.vr').checked}));
  const wireRows = ()=>d.querySelectorAll('.vx').forEach(b=>b.onclick = async ()=>{ const key = b.closest('.doc-var').dataset.vk; try{ const r = await api('POST',`/api/docstudio/templates/${enc(id)}/field`,{op:'remove', key}); t.variables = r.variables; d.querySelector('#teVars').innerHTML = rows(t.variables); wireRows(); const p = await api('GET','/api/docstudio/templates/'+enc(id)); d.querySelector('#tePrev').textContent = p.preview; }catch(e){ toast(e.message,6000); } });
  wireRows();
  d.querySelector('#teAdd').onclick = async ()=>{
    const find = d.querySelector('#teFind').value.trim(); if(find.length<2){ toast('Type the exact words from the document.'); return; }
    try{ const r = await api('POST',`/api/docstudio/templates/${enc(id)}/field`,{op:'add', text:find, label:d.querySelector('#teLabel').value.trim()}); t.variables = r.variables; d.querySelector('#teVars').innerHTML = rows(t.variables); wireRows(); d.querySelector('#teFind').value = ''; d.querySelector('#teLabel').value = ''; const p = await api('GET','/api/docstudio/templates/'+enc(id)); d.querySelector('#tePrev').textContent = p.preview; toast('Field added.'); }catch(e){ toast(e.message,6000); }
  };
  d.querySelector('#teSave').onclick = async ()=>{
    const name = d.querySelector('#teName').value.trim(); if(name.length<2){ toast('Give the format a name.'); return; }
    try{ await api('PUT','/api/docstudio/templates/'+enc(id), {name, category:d.querySelector('#teCat').value, variables:collect()}); DOC.templates = null; await docLoad('templates'); toast('Saved.'); if(fresh){ openDocForm({template:id, ctx}); } else closeDrawer(); }catch(e){ toast(e.message,6000); }
  };
  d.querySelector('#teDel').onclick = async ()=>{ if(!confirm('Delete this format? Documents already made from it are kept.')) return; try{ await api('DELETE','/api/docstudio/templates/'+enc(id)); DOC.templates = null; closeDrawer(); docLoad('templates'); toast('Format deleted.'); }catch(e){ toast(e.message,6000); } };
}

/* ---------- review a document ---------- */
function docReviewHtml(){
  const projs = Object.keys(S.projects||{}).sort((a,b)=>(S.projects[a].name||'').localeCompare(S.projects[b].name||''));
  const canUp = can('upload_docs');
  const past = DOC.ana===null ? '<div class="empty-state">Loading…</div>' : !DOC.ana.length ? '<div class="fact-sub">No reviews yet.</div>' :
    `<div class="table-wrap"><table class="und-table"><thead><tr><th>Document</th><th>Project</th><th>Result</th><th>Reviewed</th></tr></thead><tbody>${DOC.ana.map(a=>`<tr data-ana="${esc(a.id)}"><td><b>${esc(a.file_name)}</b>${a.document_type?`<div class="fact-sub">${esc(a.document_type)}</div>`:''}</td><td>${esc(a.project_name||'—')}</td><td>${a.readiness?docChip(a.readiness, READY_CLS[a.readiness]):docChip('Basic checks only','hold')}</td><td>${docWhen(a.created_at)}<div class="fact-sub">${esc(a.created_by_name||'')}</div></td></tr>`).join('')}</tbody></table></div>`;
  return `${canUp?`<section class="card"><h3 style="margin-bottom:4px">Check a document before you submit it</h3>
      <div class="fact-sub" style="margin-bottom:12px;font-size:12.5px">Upload an application, declaration, letter or agreement (Word, PDF or text). It is checked against the regulations and your compliance register, and you get what is missing and the wording to change.</div>
      <div class="setup-grid">
        <div class="field" style="grid-column:1/-1"><label>Document</label><input type="file" id="rvFile" accept=".docx,.pdf,.txt,.md"></div>
        <div class="field"><label>Project (optional)</label><select id="rvProject"><option value="">No project</option>${projs.map(p=>`<option value="${esc(p)}">${esc(S.projects[p].name||p)}</option>`).join('')}</select></div>
        <div class="field"><label>What is it? (optional)</label><input id="rvType" list="rvTypes" maxlength="120" placeholder="Leave empty to detect it"><datalist id="rvTypes">${DOC_TYPES.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></div>
      </div>
      <button class="btn primary" id="docRunReview" type="button">Review document</button></section>`:''}
    <div class="section-title" style="margin-top:20px">Earlier reviews</div>${past}`;
}
async function runReview(){
  const f = document.getElementById('rvFile').files[0]; if(!f){ toast('Choose a document first.'); return; }
  if(f.size>15*1024*1024){ toast('The file is larger than 15 MB.'); return; }
  const b = document.getElementById('docRunReview'); b.disabled = true; b.textContent = 'Reading and checking… this can take up to a minute';
  try{
    const r = await docUpload('/files/docstudio/analyse', f, {file_name:f.name, project_id:document.getElementById('rvProject').value, doc_type:document.getElementById('rvType').value.trim()});
    DOC.ana = null; await docLoad('ana'); openReview(r.id);
  }catch(e){ toast(e.message,8000); }
  const nb = document.getElementById('docRunReview'); if(nb){ nb.disabled = false; nb.textContent = 'Review document'; }
}
const docList = (a,empty)=>a&&a.length ? `<ul>${a.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="fact-sub">${empty||'None.'}</p>`;
function reviewHtml(a){
  const r = a.ai && a.ai.ok ? a.ai.result : null;
  const basic = (a.basic||[]).length ? `<section class="panel"><div class="ru-k">Basic checks</div>${a.basic.map(b=>`<div class="ru-hist">${b.level==='warn'?'⚠ ':'ℹ '}${esc(b.text)}</div>`).join('')}</section>` : '';
  if(!r) return `${basic}<section class="panel"><div class="ru-warn">${esc((a.ai&&a.ai.error)||'The compliance review is not available for this document.')}</div>${can('upload_docs')?'<button class="btn" id="rvRetry" type="button">Try the compliance review again</button>':''}</section>`;
  return `<section class="panel"><div class="ru-k">What this document is</div><p><b>${esc(r.document_type)}</b>${r.purpose?` — ${esc(r.purpose)}`:''}</p><p>${esc(r.summary)}</p></section>
    ${basic}
    ${r.suggested_changes.length?`<section class="panel"><div class="ru-k">Suggested changes (${r.suggested_changes.length})</div>${r.suggested_changes.map((c,i)=>`<div class="doc-change"><div>${docChip(c.priority, DOC_PRIO_CLS[c.priority])} <b>${esc(c.issue)}</b></div>
        ${c.current_text?`<div class="doc-now"><span>Now</span>${esc(c.current_text)}</div>`:''}
        ${c.suggested_text?`<div class="doc-new"><span>Suggested</span><div>${esc(c.suggested_text)}</div><button class="btn sm" data-copy="${i}" type="button">Copy</button></div>`:''}
        ${c.rule?`<div class="fact-sub">Basis: ${esc(c.rule.label)}</div>`:''}</div>`).join('')}</section>`:''}
    ${r.checks.length?`<section class="panel"><div class="ru-k">Checks against the rules</div><div class="table-wrap"><table class="und-table"><thead><tr><th>Requirement</th><th>Result</th><th>Where</th></tr></thead><tbody>${r.checks.map(c=>`<tr><td>${esc(c.requirement)}${c.note?`<div class="fact-sub">${esc(c.note)}</div>`:''}${c.evidence?`<div class="doc-quote">“${esc(c.evidence)}”</div>`:''}</td><td>${docChip(c.status, CHECK_CLS[c.status])}</td><td class="fact-sub">${c.rule?esc(c.rule.label):'—'}</td></tr>`).join('')}</tbody></table></div></section>`:''}
    ${r.missing_information.length?`<section class="panel"><div class="ru-k">Information missing</div>${docList(r.missing_information)}</section>`:''}
    ${r.cautions.length?`<section class="panel"><div class="ru-k">Cautions</div>${docList(r.cautions)}</section>`:''}
    ${a.ai.truncated?'<div class="fact-sub">The document was long, so only the first part was checked.</div>':''}`;
}
async function openReview(id){
  let a; try{ a = await api('GET','/api/docstudio/analyses/'+enc(id)); }catch(e){ toast(e.message,6000); return; }
  const r = a.ai && a.ai.ok ? a.ai.result : null;
  const d = showModal(`<div class="modal-head"><div style="flex:1"><div class="modal-badges"><span class="modal-id mono">Document review</span>${r?docChip(r.readiness, READY_CLS[r.readiness]):docChip('Basic checks only','hold')}${a.ocr?docChip('Read from a scan'):''}</div><h3 class="modal-title">${esc(a.file_name)}</h3>
      <div class="fact-sub">${a.project_name?esc(a.project_name)+' · ':''}Reviewed ${esc(docWhen(a.created_at))}${r&&r.readiness_reason?` · ${esc(r.readiness_reason)}`:''}</div></div><button class="drawer-close" id="drawerClose" aria-label="Close">✕</button></div>
    <div class="modal-body modal-stack">${reviewHtml(a)}<div class="fact-sub">This review is a guide for your compliance team, not legal advice. Check the official text before you submit.</div></div>
    <div class="modal-foot"><a class="btn primary" href="/api/docstudio/analyses/${enc(a.id)}/report">Download report (Word)</a><a class="btn" href="/api/docstudio/analyses/${enc(a.id)}/file">Download the reviewed file</a>${a.can_edit&&can('upload_docs')?'<button class="btn" id="rvDel" type="button">Delete</button>':''}</div>`);
  d.querySelectorAll('[data-copy]').forEach(b=>b.onclick = ()=>{ const t = r.suggested_changes[Number(b.dataset.copy)].suggested_text; (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>toast('Copied.')).catch(()=>toast('Select the text and copy it.')); });
  const rt = d.querySelector('#rvRetry'); if(rt) rt.onclick = async ()=>{ rt.disabled = true; rt.textContent = 'Checking…'; try{ await api('POST',`/api/docstudio/analyses/${enc(a.id)}/retry`,{}); DOC.ana = null; docLoad('ana'); openReview(a.id); }catch(e){ toast(e.message,7000); rt.disabled = false; rt.textContent = 'Try the compliance review again'; } };
  const del = d.querySelector('#rvDel'); if(del) del.onclick = async ()=>{ if(!confirm('Delete this review?')) return; try{ await api('DELETE','/api/docstudio/analyses/'+enc(a.id)); DOC.ana = null; closeDrawer(); docLoad('ana'); toast('Deleted.'); }catch(e){ toast(e.message,6000); } };
}

/* ============================= DOCUMENT VAULT ============================= */
// The documents on file for the project chosen in the top bar (or, with "Company-wide" chosen, for every project of that company, grouped by project).
// Read-only: upload, prepare and verify happen on the record. Changing the project at the top changes what is shown here.
const VAULT = { rows:null, q:'', status:'', origin:'', old:false, err:'' };
const VLT_DL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';
async function vaultLoad(){
  try{ VAULT.rows = (await api('GET','/api/documents?orderBy=uploaded_at&dir=desc&limit=1000')).map(d=>({id:d.id, ...d.data})); VAULT.err = ''; }
  catch(e){ VAULT.rows = []; VAULT.err = e.message; }
  if(S.view==='vault') vaultRefresh();
}
function vaultProjectOf(d){
  const sid = String(d.key||'').split('__').slice(1).join('__');
  const pid = d.project_id || (S.projects[sid] && sid) || (S.phases[sid] && S.phases[sid].project_id) || (S.buildings[sid] && S.buildings[sid].project_id) || '';
  if(pid && S.projects[pid]) return {id:pid, name:S.projects[pid].name||pid, company:S.projects[pid].company_id||null};
  if(S.companies[sid]) return {id:'co:'+sid, name:'Company-wide · '+(S.companies[sid].name||sid), company:sid};
  return {id:'', name:'Other', company:null};
}
/** Is this document in the project / company chosen at the top? */
function vaultInContext(d){
  const p = vaultProjectOf(d), c = S.ctx || {};
  if(c.projectId) return p.id===c.projectId;
  if(c.companyId) return p.company===c.companyId;
  return true;
}
function vaultScope(d){
  const inst = S.instByKey && S.instByKey[d.key];
  if(inst && inst.scopeLabel) return inst.scopeLabel;
  const sid = String(d.key||'').split('__').slice(1).join('__');
  if(S.phases[sid]) return S.phases[sid].name || 'Phase';
  if(S.buildings[sid]) return S.buildings[sid].name || 'Building';
  return S.companies[sid] ? 'Company-wide' : 'Entire project';
}
function vaultStatus(d){
  if(d.status==='Rejected') return 'Rejected';
  if(d.expiry_date && d.expiry_date < todayISO()) return 'Expired';
  return d.status==='Verified' ? 'Verified' : 'Awaiting verification';
}
function vaultFiltered(){
  const q = VAULT.q.trim().toLowerCase();
  return (VAULT.rows||[]).filter(d=>{
    if(!VAULT.old && d.superseded) return false;
    if(!vaultInContext(d)) return false;
    if(VAULT.status && vaultStatus(d)!==VAULT.status) return false;
    if(VAULT.origin && Core.docOrigin(d.doc_name)!==VAULT.origin) return false;
    if(q){ const it = S.itemById[d.compliance_id]||{}; if(!`${d.doc_name} ${d.file_name} ${d.compliance_id} ${it.brief_description||''} ${it.authority_norm||it.authority_raw||''} ${d.uploaded_by||''}`.toLowerCase().includes(q)) return false; }
    return true;
  });
}
function renderVault(){
  if(VAULT.rows===null) vaultLoad();
  const opt = (v,l,cur)=>`<option value="${esc(v)}" ${cur===v?'selected':''}>${esc(l)}</option>`;
  return `<div class="section-title">Document Vault</div>
    <div class="ru-bar"><div class="sub">Documents on file for <b>${esc(ctxName())}</b>. Change the project at the top to see another project's documents. Open a record to upload, prepare or verify its documents.</div></div>
    <div class="filters" style="margin-bottom:12px">
      <label class="grow">Search<input type="search" id="vltQ" value="${esc(VAULT.q)}" placeholder="Search by document, file name, record ID, authority or uploader"></label>
      <label>Verification<select id="vltStatus"><option value="">All</option>${['Verified','Awaiting verification','Rejected','Expired'].map(s=>opt(s,s,VAULT.status)).join('')}</select></label>
      <label>Source<select id="vltOrigin"><option value="">All</option>${opt('prepared','Prepared by us',VAULT.origin)}${opt('received','Received',VAULT.origin)}</select></label>
      <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="vltOld" ${VAULT.old?'checked':''}> Include earlier versions</label>
    </div>
    <div id="vaultBody">${vaultBodyHtml()}</div>`;
}
function vaultRowHtml(d){
  const it = S.itemById[d.compliance_id]||{}, st = vaultStatus(d), prep = Core.docOrigin(d.doc_name)==='prepared';
  const cls = {Verified:'ok','Awaiting verification':'warn',Rejected:'bad',Expired:'bad'}[st]||'';
  const auth = it.authority_norm || it.authority_raw || '';
  const who = d.status==='Verified' || d.status==='Rejected' ? (d.verified_by ? `${d.status==='Rejected'?'Rejected':'Verified'} by ${d.verified_by}` : '') : `Uploaded by ${d.uploaded_by||''}`;
  return `<tr><td><b>${esc(d.doc_name)}</b> <span class="chip">v${d.version||1}</span>${d.superseded?' <span class="chip">Replaced</span>':''}
      <div class="fact-sub">${esc(d.file_name)} · ${fmtSize(d.size||0)} · ${prep?'Prepared by us':'Received'}${d.carried_from_id?' · carried from '+esc(d.carried_from_id):''}</div></td>
    <td><b>${esc((S.projects[vaultProjectOf(d).id]||{}).name || vaultProjectOf(d).name)}</b><div class="fact-sub">${esc(vaultScope(d))}</div></td>
    <td><a href="#" data-vopen="${esc(d.key)}" class="chip mono" title="Open this record">${esc(d.compliance_id)}</a><div class="fact-sub">${esc(auth || (it.brief_description||'').slice(0,60))}</div></td>
    <td>${d.issue_date?`<div>Issued: ${esc(fmtDate(d.issue_date))}</div>`:`<div class="fact-sub">Uploaded: ${esc(fmtDate(String(d.uploaded_at||'').slice(0,10)))}</div>`}${d.expiry_date?`<div style="${d.expiry_date<todayISO()?'color:var(--bad,#b42318);font-weight:600':''}">Expires: ${esc(fmtDate(d.expiry_date))}</div>`:''}</td>
    <td><span class="chip ${cls}">${esc(st)}</span>${who?`<div class="fact-sub">${esc(who)}</div>`:''}</td>
    <td style="text-align:right"><a class="btn sm" href="/files/${esc(d.file_id)}" aria-label="Download ${esc(d.doc_name)}" title="Download">${VLT_DL}</a></td></tr>`;
}
function vaultBodyHtml(){
  if(VAULT.rows===null) return '<div class="empty-state">Loading…</div>';
  if(VAULT.err) return `<div class="empty-state">${esc(VAULT.err)}</div>`;
  const rows = vaultFiltered();
  if(!rows.length){
    const any = (VAULT.rows||[]).some(vaultInContext);
    return `<div class="empty-state">${any ? 'No documents match your filters.' : `<b>No documents yet for ${esc(ctxName())}.</b><div style="margin-top:6px">Documents uploaded or prepared on a compliance record appear here.</div>`}</div>`;
  }
  const head = '<thead><tr><th>Document &amp; file</th><th>Project &amp; scope</th><th>Authority &amp; record</th><th>Issue &amp; expiry</th><th>Verification</th><th></th></tr></thead>';
  const table = list=>`<div class="table-wrap"><table class="und-table">${head}<tbody>${list.map(vaultRowHtml).join('')}</tbody></table></div>`;
  const count = `<div class="fact-sub" style="margin-bottom:8px">${rows.length} document${rows.length===1?'':'s'}</div>`;
  if(S.ctx && S.ctx.projectId) return count + table(rows);
  // company-wide view: one section per project
  const groups = new Map();
  rows.forEach(d=>{ const p = vaultProjectOf(d); (groups.get(p.id)||groups.set(p.id,{name:p.name,rows:[]}).get(p.id)).rows.push(d); });
  return count + [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(g=>`<details class="panel vlt-group" open style="margin-bottom:12px"><summary style="cursor:pointer;font-weight:600;font-size:14px">${esc(g.name)} <span class="chip">${g.rows.length}</span></summary><div style="margin-top:8px">${table(g.rows)}</div></details>`).join('');
}
function vaultRefresh(){ const b = document.getElementById('vaultBody'); if(!b) return; b.innerHTML = vaultBodyHtml(); vaultWireRows(); }
function vaultWireRows(){ document.querySelectorAll('[data-vopen]').forEach(a=>a.onclick = e=>{ e.preventDefault(); openDrawer(a.dataset.vopen); }); }
function attachVaultHandlers(){
  const on = (id, ev, fn)=>{ const el = document.getElementById(id); if(el) el[ev] = fn; };
  on('vltQ','oninput', e=>{ VAULT.q = e.target.value; vaultRefresh(); });
  on('vltStatus','onchange', e=>{ VAULT.status = e.target.value; vaultRefresh(); });
  on('vltOrigin','onchange', e=>{ VAULT.origin = e.target.value; vaultRefresh(); });
  on('vltOld','onchange', e=>{ VAULT.old = e.target.checked; vaultRefresh(); });
  vaultWireRows();
}
