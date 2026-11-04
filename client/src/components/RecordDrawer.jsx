// One compliance record (an instance for a company, project, phase or building): what to do, its documents,
// its status, prerequisites, applicability decision and history.
import { useEffect, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useRemote } from '../state/hooks.js';
import { useUi, ModalHead, Badge, Chip, Fold, ActionLink } from '../ui/ui.jsx';
import { api, fileApi, uploadFile } from '../lib/api.js';
import { Core } from '../lib/core.js';
import { fmtDate, fmtSize, todayISO } from '../lib/format.js';
import { STATUS_LIST, statusDef, LEVEL_TXT, LEVELS, OTHER_DOC } from '../lib/constants.js';
import { deadlineSummary, effectiveStageId, resolveInst } from '../lib/records.js';
import { PrepareModal } from '../views/Documents.jsx';

const named = (v) => { const s = String(v || '').trim(); return s && !/^unassigned$/i.test(s) ? s : ''; };   // only show a person/team when one is actually named

export default function RecordDrawer({ refKey }) {
  const S = useStore();
  const { openModal } = useUi();
  const inst = resolveInst(S, S.inst, S.instByKey, refKey);
  const [docSel, setDocSel] = useState('');
  if (!inst) return <ModalHead title="Record not found" />;
  const it = inst.item, tr = inst.tr;
  const open = (ref) => openModal(<RecordDrawer refKey={ref} />);
  const curStage = S.stages.find((s) => s.id === effectiveStageId(S, it));
  const st = statusDef(inst.status);
  const dl = deadlineSummary(it, fmtDate);
  const appCls = inst.state === 'na' ? 'neutral' : inst.state === 'review' ? 'hold' : 'ok';
  const reasonText = inst.decision && inst.decision.reason ? inst.decision.reason : '';
  const owner = named(it.owner), approver = named(it.approver);
  const shown = inst.state === 'na' ? ['neutral', '—', 'Not applicable'] : [st.cls, st.ic, inst.status];
  const hasPrereq = S.deps.edges.some((e) => e.to === it.compliance_id || e.from === it.compliance_id);

  const banners = [];
  if (inst.readOnly) banners.push(['muted', 'This record is not part of the company or project you are looking at. Pick the matching one at the top to track it.']);
  else if (inst.state === 'na') banners.push(['muted', <><b>Not applicable.</b> {reasonText} Nothing to do here.</>]);
  else if (inst.state === 'review') banners.push(['hold', <><b>Not confirmed as applicable yet.</b> Open “Does this apply?” further down and decide.</>]);
  if (inst.blocked) banners.push(['hold', <><b>Blocked.</b> Finish {inst.blockedBy.map((b, i) => <span key={b.key}>{i > 0 && ', '}<span className="mono">{b.id}</span>{b.scopeShort && ` (${b.scopeShort})`}</span>)} first.</>]);
  else if (inst.ready) banners.push(['ok', <><b>Ready to start.</b> Everything it depends on is complete.</>]);
  if (inst.docs && (inst.docs.rejected || inst.docs.expired)) banners.push(['bad', <><b>A document needs attention.</b> One was rejected or has expired — see Documents.</>]);
  const glance = (label, val) => <div><dt>{label}</dt><dd>{val}</dd></div>;

  return (
    <>
      <ModalHead kicker={it.compliance_id} title={it.brief_description} titleAttr={it.brief_description} badges={<>
        <Badge cls="neutral">{it.department}</Badge>
        {inst.scopeShort && <Badge cls="neutral">{inst.scopeShort}</Badge>}
        <Badge cls={shown[0]}><span className="ic">{shown[1]}</span>{shown[2]}</Badge>
      </>} />
      <div className="modal-body modal-stack">
        {banners.map((b, i) => <div key={i} className={'banner ' + b[0]}>{b[1]}</div>)}
        <section className="panel"><h4>What needs to be done</h4><div className="prose">{it.action_required || '—'}</div></section>
        {(owner || approver) && <section className="panel"><h4>Who is responsible</h4><div className="who">
          {owner && <div><span className="who-label">Owner</span><span className="who-name">{owner}</span></div>}
          {approver && <div><span className="who-label">Approver</span><span className="who-name">{approver}</span></div>}
        </div></section>}
        {it.penalty && <section className="panel"><h4>If this is missed</h4><div className="prose">{it.penalty}</div></section>}
        {(it.typical_timeline || it.typical_issues) && <section className="panel"><h4>What to expect</h4>
          {it.typical_timeline && <div className="prose"><b>Typical time:</b> {it.typical_timeline}</div>}
          {it.typical_issues && <div className="prose" style={{ marginTop: 6 }}><b>Common problems:</b> {it.typical_issues}</div>}
          {it.source_track && <div className="fact-sub" style={{ marginTop: 6 }}>From the {it.source_track.toLowerCase()} checklist{it.source_checklist_row && ` (${it.source_checklist_row})`}.</div>}
        </section>}

        <details className="fold more"><summary><span>More details</span></summary><div className="fold-body">
          <dl className="glance">
            {it.regulation && glance('Law', <>{it.regulation}{it.reference_section && ' — ' + it.reference_section}</>)}
            {glance('Authority', it.authority_norm || '—')}
            {glance('How often', it.frequency_norm || '—')}
            {glance('Deadline', <>{dl.main}{dl.note && <div className="fact-sub">{dl.note}</div>}</>)}
            {glance('Your target date', tr.next_due_date ? fmtDate(tr.next_due_date) : <span className="muted">Not set</span>)}
            {glance('Applies to', inst.scopeLabel)}
            {it.applicability && glance('Who it applies to', it.applicability)}
            {glance('Stage', <>{curStage ? curStage.name : 'Unmapped to Stage'}{it.stage_basis && <div className="fact-sub">{it.stage_basis}</div>}</>)}
            {glance('Level', it.compliance_level || it.level || '—')}
            {it.trigger && it.trigger !== it.applicability && glance('Starts when', it.trigger)}
            {it.due_date_raw && glance('Due date in the register', it.due_date_raw)}
            {glance('Legal check', it.legal_validation_status || '—')}
            {glance('Risk level', <RiskControl it={it} />)}
          </dl>
          {it.duplicate_group && <div className="prose-meta"><b>Possible duplicates — {it.duplicate_group}:</b> {S.items.filter((i) => i.duplicate_group === it.duplicate_group && i.compliance_id !== it.compliance_id)
            .map((o, i) => <span key={o.compliance_id}>{i > 0 && ', '}<ActionLink className="mono" onClick={() => open(o.compliance_id)}>{o.compliance_id}</ActionLink></span>)}. These records look like the same obligation; they are kept separate until a reviewer confirms.</div>}
        </div></details>

        <section className="panel"><h4>Documents</h4>
          {inst.key ? <DocsBox inst={inst} docSel={docSel} setDocSel={setDocSel} />
            : <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Documents are kept per company, project, phase or building. Choose the matching one at the top to upload.</div>}
        </section>

        {docSel && <TrackPanel inst={inst} />}

        {hasPrereq && <details className="fold" open={inst.blocked || undefined}><summary><span>Prerequisites</span>{inst.status === 'Compliant / Completed' ? <Chip cls="ok">Complete</Chip> : inst.blocked ? <Chip cls="hold">Blocked</Chip> : <Chip cls="ok">Ready</Chip>}</summary>
          <div className="fold-body"><PrereqPanel inst={inst} open={open} /></div></details>}

        <details className="fold" open={inst.state === 'review' || undefined}><summary><span>Does this apply?</span><Badge cls={appCls}>{inst.appStatus}</Badge></summary>
          <div className="fold-body"><ApplicabilityPanel inst={inst} /></div></details>

        <details className="fold"><summary><span>History of changes</span></summary><div className="fold-body"><AuditList recordKey={inst.key} /></div></details>
      </div>
    </>
  );
}

/* ---------- status ---------- */
function TrackPanel({ inst }) {
  const S = useStore();
  const { toast } = useUi();
  const tr = inst.tr, can = S.can('edit_tracking');
  const editable = can && !inst.readOnly && inst.state !== 'na';
  const [status, setStatus] = useState(tr.status);
  const [nextDue, setNextDue] = useState(tr.next_due_date || '');
  const [remarks, setRemarks] = useState(tr.remarks || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (status === 'Not Applicable' && !remarks.trim()) { toast('Give the reason in Remarks, or use the Applicability decision above.'); return; }
    const patch = { status, next_due_date: nextDue || null, remarks };
    setBusy(true);
    let res = await S.saveTracking(inst, patch);
    // The server refuses "completed" while documents are missing/unverified or a prerequisite is open.
    if (res && res.blocked && res.canOverride) {
      const why = window.prompt(res.message + '\n\nIf you are sure, type the reason to complete it anyway. The reason is recorded on the record and in the audit trail.');
      if (why && why.trim()) res = await S.saveTracking(inst, { ...patch, override_reason: why.trim() });
    } else if (res && res.blocked) toast(res.message, 9000);
    setBusy(false);
  };
  return (
    <div className="panel">
      <h4 style={{ marginBottom: 10 }}>Update status</h4>
      {!can && <div className="readonly-note">Your role can view this but not change it.</div>}
      {inst.state === 'na' && <div className="readonly-note">Marked not applicable, so there is nothing to track.</div>}
      <div className="setup-grid">
        <div className="field"><label>Status</label><select value={status} disabled={!editable} onChange={(e) => setStatus(e.target.value)}>{STATUS_LIST.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label>Next due date</label><input type="date" value={nextDue} disabled={!editable} onChange={(e) => setNextDue(e.target.value)} /></div>
      </div>
      <div className="field"><label>Remarks</label><textarea rows={2} value={remarks} disabled={!editable} onChange={(e) => setRemarks(e.target.value)} /></div>
      {tr.evidence_link && <div className="field"><label>Earlier evidence link</label><div className="val"><a href={tr.evidence_link} target="_blank" rel="noopener noreferrer">{tr.evidence_link}</a></div></div>}
      <button className="btn primary" type="button" disabled={!editable || busy} onClick={save}>Save status</button>
      {tr.updated_at && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Last updated {new Date(tr.updated_at).toLocaleString()}{tr.last_updated_by && ' by ' + tr.last_updated_by}</div>}
    </div>
  );
}

/* ---------- risk level (feeds the health score; the register carries none, a suggestion comes from the penalty wording) ---------- */
function RiskControl({ it }) {
  const S = useStore();
  const { toast } = useUi();
  const cur = (S.risk || {})[it.compliance_id], sug = ((S.riskProposals || {}).proposals || {})[it.compliance_id];
  const [level, setLevel] = useState(cur ? cur.level : '');
  const save = async (lv) => {
    if (!lv) { toast('Choose a level.'); return; }
    try { await api('PUT', '/api/risk_overrides/' + encodeURIComponent(it.compliance_id), { level: lv }); await S.reload(['risk_overrides']); setLevel(lv); toast('Risk level saved. The project scores will update.'); }
    catch (e) { toast(e.message); }
  };
  return (
    <>
      {cur ? <><b>{LEVEL_TXT[cur.level]}</b> <span className="fact-sub">set by {cur.set_by || ''}{cur.source === 'suggested' && ' (accepted from the suggestion)'}</span></>
        : <span className="muted">Risk classification pending validation</span>}
      {sug && !cur && <div className="fact-sub">Suggested: <b>{LEVEL_TXT[sug.level]}</b> — {sug.basis} (not validated)</div>}
      {S.can('decide_applicability') && <div className="risk-edit">
        <select title="Risk level for this record" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Choose…</option>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_TXT[l]}</option>)}</select>
        <button className="btn sm" type="button" onClick={() => save(level)}>Save</button>
        {sug && !cur && <button className="btn sm" type="button" onClick={() => save(sug.level)}>Use suggestion</button>}
      </div>}
    </>
  );
}

/* ---------- what this record waits for, and what waits for it ---------- */
function PrereqPanel({ inst, open }) {
  const S = useStore();
  const id = inst.item.compliance_id;
  const edgesIn = S.deps.edges.filter((e) => e.to === id), edgesOut = S.deps.edges.filter((e) => e.from === id);
  const short = (x) => { const it = S.itemById[x]; return it ? (it.brief_description || '').slice(0, 70) : x; };
  const by = inst.blockedBy || [];
  return (
    <section className="panel"><h4>Prerequisites</h4>
      {inst.status === 'Compliant / Completed' ? <div className="prose" style={{ fontSize: 12.5 }}>This record is complete.</div>
        : by.length ? <>
          <div className="prose" style={{ fontSize: 12.5, marginBottom: 6 }}>Finish {by.length === 1 ? 'this record' : 'these records'} first. It cannot be marked completed until then{S.can('override_completion') && ' (a Compliance Manager or admin can override with a reason)'}.</div>
          {by.map((b) => {
            const p = S.itemById[b.id] || {}, act = String(p.action_required || '').replace(/\s+/g, ' ').trim().slice(0, 150);
            return (
              <div key={b.key} className="setup-row clickable" style={{ alignItems: 'flex-start' }} onClick={() => open(b.key)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div><span className="mono"><b>{b.id}</b></span>{b.scopeShort && ' · ' + b.scopeShort} — {short(b.id)}</div>
                  <div className="fact-sub">Owner: {p.owner || '—'} · Approver: {p.approver || '—'}</div>
                  {act && <div className="fact-sub">Needed: {act}{act.length >= 150 && '…'}</div>}
                  {b.basis && <div className="fact-sub">Why: {b.basis}</div>}
                </div>
                <Badge cls={statusDef(b.status).cls}>{b.status}</Badge>
              </div>
            );
          })}
        </>
          : edgesIn.length ? <div className="prose" style={{ fontSize: 12.5 }}><Chip cls="ok">Ready to start</Chip> Every prerequisite that applies is complete.</div>
            : <div className="prose" style={{ fontSize: 12.5 }}>Nothing has to be completed before this record.</div>}
      {edgesOut.length > 0 && <div className="prose-meta"><b>Completing this unblocks:</b> {edgesOut.map((e, i) => <span key={e.to}>{i > 0 && ', '}<ActionLink className="mono" onClick={() => open(e.to)}>{e.to}</ActionLink></span>)}</div>}
      <div className="fact-sub" style={{ marginTop: 8 }}>These prerequisites are proposed from the wording of the register and are not yet legally validated.</div>
    </section>
  );
}

/* ---------- applicability decision ---------- */
function ApplicabilityPanel({ inst }) {
  const S = useStore();
  const { toast } = useUi();
  const [status, setStatus] = useState(inst.appStatus);
  const [reason, setReason] = useState('');
  if (inst.readOnly) return <section className="panel"><h4>Applicability</h4><div className="prose" style={{ fontSize: 12.5 }}>This record belongs to a {inst.scopeType}-level scope that is not in the view you are looking at. Pick the company or project at the top to track it.</div></section>;
  const d = inst.decision, can = S.can('edit_tracking');
  const cls = inst.state === 'na' ? 'neutral' : inst.state === 'review' ? 'hold' : 'ok';
  const decide = async (st, why) => {
    try { await api('POST', '/api/applicability', { key: inst.key, status: st, reason: why }); await S.reload(['applicability']); toast(st === 'auto' ? 'Back to automatic.' : 'Decision saved.'); setReason(''); }
    catch (e) { toast(e.message); }
  };
  return (
    <section className="panel"><h4>Applicability — {inst.scopeLabel}</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}><Badge cls={cls}>{inst.appStatus}</Badge>
        <Chip>{d ? (d.source === 'manual' ? 'Decided by ' + d.decided_by : 'Decided by the rules') : 'Not evaluated yet'}</Chip></div>
      <div className="prose" style={{ fontSize: 12.5 }}>{d ? d.reason : 'Not evaluated yet. Save the set-up for this company or project to evaluate it.'}</div>
      {d && d.auto_suggestion && <div className="readonly-note" style={{ marginTop: 8, borderLeft: '3px solid var(--warn)' }}>The rules now suggest <b>{d.auto_suggestion.status}</b> ({d.auto_suggestion.reason}). The decision above was made by a person and has not been changed.</div>}
      {can && <>
        <div className="field" style={{ marginTop: 10 }}><label>Change the decision</label><select value={status} onChange={(e) => setStatus(e.target.value)}>{Core.APPLICABILITY.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label>Reason (needed for Not Applicable and Legal Validation Required)</label><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" type="button" onClick={() => decide(status, reason)}>Save decision</button>
          {d && d.source === 'manual' && <button className="btn" type="button" onClick={() => decide('auto', '')}>Back to automatic</button>}
        </div>
      </>}
      {d && d.history && d.history.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>History ({d.history.length})</summary>
        {d.history.slice().reverse().map((h, i) => <div key={i} className="audit-entry"><b>{h.by}</b> — {h.from || 'new'} → <b>{h.to}</b> ({h.source})<br />{new Date(h.at).toLocaleString()} · {h.reason || ''}</div>)}</details>}
    </section>
  );
}

function AuditList({ recordKey }) {
  const [rows, err] = useRemote(recordKey ? `/api/audit?${new URLSearchParams({ key: recordKey, orderBy: 'at', dir: 'desc', limit: '25' })}` : null, 5000);
  const list = recordKey ? (rows || []).map((r) => r.data) : [];
  if (recordKey && !rows && !err) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>;
  return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{list.length ? list.map((a, i) => <div key={i} className="audit-entry"><b>{a.who}</b> — {a.old_status} → <b>{a.new_status}</b><br />{new Date(a.at).toLocaleString()} {a.remark && '· ' + a.remark}</div>) : 'No status changes recorded yet.'}</div>;
}

/* ---------- documents: versions, verification, expiry ---------- */
function docStatusChip(d) {
  if (d.status === 'Rejected') return <Chip cls="bad">Rejected</Chip>;
  if (d.expiry_date && d.expiry_date < todayISO()) return <Chip cls="bad">Expired</Chip>;
  if (d.status === 'Verified') return <Chip cls="ok">Verified</Chip>;
  return <Chip cls="warn">Awaiting verification</Chip>;
}
function DocMeta({ d }) {
  const bits = [d.file_name, fmtSize(d.size), 'uploaded by ' + d.uploaded_by, new Date(d.uploaded_at).toLocaleDateString('en-IN')];
  if (d.issue_date) bits.push('issued ' + fmtDate(d.issue_date));
  if (d.expiry_date) bits.push('expires ' + fmtDate(d.expiry_date));
  return <>
    <div className="meta">{bits.join(' · ')}</div>
    {d.verified_by && <div className="meta">{d.status === 'Rejected' ? 'Rejected' : 'Verified'} by {d.verified_by} on {new Date(d.verified_at).toLocaleDateString('en-IN')}{d.verification_note && ' — ' + d.verification_note}</div>}
  </>;
}

function DocsBox({ inst, docSel, setDocSel }) {
  const S = useStore();
  const { toast, openModal } = useUi();
  const it = inst.item, me = S.me;
  useEffect(() => { S.reload(['documents']); }, [inst.key]); 
  const docs = S.docsByKey[inst.key] || [];
  const editable = S.can('upload_docs') && inst.state !== 'na' && !inst.readOnly;
  const canVerify = S.can('verify_docs') && !inst.readOnly;
  const req = Core.requiredDocs(it);
  const cur = Core.currentDocs(docs);                       // latest version of each named document
  const today = todayISO();
  const verifiedCount = req.filter((n) => { const d = cur.get(n.toLowerCase()); return d && d.status === 'Verified' && !(d.expiry_date && d.expiry_date < today); }).length;
  const [other, setOther] = useState('');
  const [file, setFile] = useState(null);
  const [issue, setIssue] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  // every uploaded file grouped by document name, newest version first
  const groups = new Map();
  for (const d of docs) { const k = String(d.doc_name).toLowerCase(); (groups.get(k) || groups.set(k, []).get(k)).push(d); }
  for (const list of groups.values()) list.sort((a, b) => (b.version || 1) - (a.version || 1));

  const refresh = async () => { await S.reload(['documents']); S.loadNotes(); };
  const upload = async () => {
    const name = docSel === OTHER_DOC ? other.trim() : docSel;
    if (!name) { toast(docSel === OTHER_DOC ? 'Enter a document name.' : 'Select a document.'); return; }
    if (!file) { toast('Choose a file to upload.'); return; }
    if (file.size > 15 * 1024 * 1024) { toast('File is larger than 15 MB.'); return; }
    if (issue && expiry && expiry < issue) { toast('The expiry date is before the issue date.'); return; }
    setBusy(true);
    try {
      const q = { key: inst.key, compliance_id: it.compliance_id, project_id: inst.projectId || '', doc_name: name, file_name: file.name };
      if (issue) q.issue_date = issue; if (expiry) q.expiry_date = expiry;
      const j = await uploadFile('/files', file, q);
      toast(j.version > 1 ? `Saved as version ${j.version}. It needs verifying.` : 'Document uploaded. It needs verifying.');
      setFile(null); setFileKey((k) => k + 1); setIssue(''); setExpiry('');
    } catch (e) { toast('Upload failed: ' + e.message); }
    setBusy(false);
    refresh();
  };
  const verify = async (id) => { try { await fileApi('POST', `/files/${encodeURIComponent(id)}/verify`, { status: 'Verified' }); toast('Verified.'); } catch (e) { toast(e.message); } refresh(); };
  const reject = async (id) => {
    const note = window.prompt('Why is this document rejected? (required — the uploader will see it)');
    if (!note || !note.trim()) return;
    try { await fileApi('POST', `/files/${encodeURIComponent(id)}/verify`, { status: 'Rejected', note: note.trim() }); toast('Rejected. The uploader has been notified.'); } catch (e) { toast(e.message); }
    refresh();
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this uploaded file?')) return;
    try { await fileApi('DELETE', '/files/' + encodeURIComponent(id)); toast('Deleted.'); } catch (e) { toast('Delete failed: ' + e.message); }
    refresh();
  };

  const fileRow = (d, isCurrent) => {
    const own = d.uploaded_by_email === me.email && me.role !== 'admin';
    const pending = isCurrent && d.status !== 'Verified' && d.status !== 'Rejected';
    return (
      <div className="doc-file" style={{ alignItems: 'flex-start' }} key={d.id}>
        <div style={{ minWidth: 0 }}><div><b>{d.doc_name}</b> <Chip>v{d.version || 1}</Chip> {isCurrent ? docStatusChip(d) : <Chip>Replaced</Chip>}</div><DocMeta d={d} />
          {canVerify && pending && <div className="doc-actions">{own ? <span className="fact-sub">Another person must verify this upload.</span> : <>
            <button className="btn sm primary" type="button" onClick={() => verify(d.id)}>Verify</button>
            <button className="btn sm" type="button" onClick={() => reject(d.id)}>Reject</button></>}</div>}
        </div>
        <div style={{ whiteSpace: 'nowrap' }}><a className="btn sm" href={'/files/' + encodeURIComponent(d.file_id)} style={{ textDecoration: 'none', display: 'inline-block' }}>Download</a>
          {editable && isCurrent && <> <button className="btn sm" type="button" onClick={() => remove(d.id)}>Delete</button></>}</div>
      </div>
    );
  };

  return (
    <div>
      {req.length ? <>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{verifiedCount} of {req.length} required documents verified{inst.scopeType === 'company' && ' · shared by every project of this company'}</div>
        <div>{req.map((n) => {
          const d = cur.get(n.toLowerCase()), prep = Core.docOrigin(n) === 'prepared', done = d && d.status === 'Verified';
          return (
            <div key={n} className={'doc-check ' + (done ? 'done' : 'pending')} style={{ flexWrap: 'wrap' }}>
              <span className="st">{done ? '✓' : '○'}</span>
              <span style={{ flex: 1, minWidth: 140 }}>{n} <Chip style={{ fontSize: 10.5 }} title={prep ? 'The company writes this document, so it can be prepared here from a format.' : 'Issued by an authority or another party. Upload the copy you receive.'}>{prep ? 'Prepared by us' : 'Received'}</Chip>
                {d && d.carried_from_id && <div className="meta">Added automatically from {d.carried_from_id}</div>}</span>
              {d ? docStatusChip(d) : <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>Not uploaded</span>}
              {prep && editable && <button className="btn sm" type="button" onClick={() => openModal(<PrepareModal inst={inst} name={n} />)}>{d ? 'Prepare new version' : 'Prepare'}</button>}
            </div>
          );
        })}</div>
      </> : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No specific documents are listed for this item. Use "Other document" to upload one.</div>}
      <div className="field" style={{ marginTop: 12 }}><label>Select a document</label>
        <select value={docSel} onChange={(e) => setDocSel(e.target.value)}>
          <option value="">— Choose a document —</option>
          {req.map((n) => <option key={n} value={n}>{n}{cur.get(n.toLowerCase()) ? ' (upload new version)' : ''}</option>)}
          <option value={OTHER_DOC}>Other document…</option>
        </select>
      </div>
      {editable ? docSel && <div>
        {docSel === OTHER_DOC && <input type="text" placeholder="Document name" style={{ marginBottom: 8 }} value={other} onChange={(e) => setOther(e.target.value)} />}
        <div className="doc-upload" style={{ marginTop: 0 }}><input key={fileKey} type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files[0] || null)} /></div>
        <div className="setup-grid" style={{ marginTop: 8 }}>
          <div className="field" style={{ marginBottom: 6 }}><label>Issue date (optional)</label><input type="date" value={issue} onChange={(e) => setIssue(e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 6 }}><label>Expiry date (optional)</label><input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
        </div>
        <button className="btn primary" type="button" disabled={busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</button>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>PDF or Word (.doc, .docx) · max 15 MB · uploading the same document again saves a new version and keeps the old one.</div>
      </div> : <div className="readonly-note">{inst.state === 'na' ? 'Marked not applicable, so uploads are switched off.' : 'Your current role cannot upload documents.'}</div>}
      {!docSel && <div className="prose-meta" style={{ marginTop: 12 }}>Select a document above to upload it and update the tracking status.</div>}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--text-muted)', marginBottom: 4 }}>Uploaded documents ({groups.size})</div>
        {groups.size ? [...groups.values()].map(([latest, ...older]) => (
          <div className="doc-vgroup" key={latest.id}>{fileRow(latest, !latest.superseded)}
            {older.length > 0 && <details style={{ marginTop: 4 }}><summary style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--text-muted)' }}>Earlier versions ({older.length})</summary>{older.map((o) => fileRow(o, false))}</details>}
          </div>
        )) : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nothing uploaded yet.</div>}
      </div>
    </div>
  );
}

