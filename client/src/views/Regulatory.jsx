// Regulatory Updates: circulars and notifications read from official sources, their AI summaries, project impact and review.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useUi, ModalHead, Chip, Empty, Fold } from '../ui/ui.jsx';
import { api, uploadFile } from '../lib/api.js';
import { ago, fmtDate, safeUrl } from '../lib/format.js';
import { APP_CLS, LIVE_APP, OPEN_STAGES_RU, PRI_CLS, RU_APPLICABILITY, RU_STAGE_NEXT, RU_STAGE_TXT } from '../lib/constants.js';

const ExtLink = ({ href, children }) => (safeUrl(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a> : null);
const effStatus = (i) => (i.decision && i.decision.status) || i.system_status;
const isRestrictedUi = (me) => !!(me && !['admin', 'company_admin'].includes(me.role) && Array.isArray(me.project_ids));
// Newest first: by published date when known, otherwise by the day the server found it.
const sortKey = (r) => (r.publication_date || (r.detected_at || '').slice(0, 10) || '') + '|' + (r.detected_at || '');
const NO_FILTERS = { q: '', authority: '', company: '', project: '', category: '', priority: '', applic: '', review: '', read: '', pubFrom: '', pubTo: '', effFrom: '', effTo: '', irrelevant: true };

export default function Regulatory() {
  const S = useStore();
  const ui = useUi();
  const [f, setF] = useSticky('regulatory.filters', NO_FILTERS);
  useEffect(() => { S.loadRegulatory(); }, []); 
  const rows = S.ru.rows || [];
  const visible = rows.filter((r) => f.irrelevant || r.relevant).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const q = f.q.trim().toLowerCase();
  const filtered = visible.filter((r) => {
    if (q && !`${r.title} ${r.authority} ${r.circular_number || ''} ${r.summary || ''} ${r.category || ''}`.toLowerCase().includes(q)) return false;
    if (f.authority && r.authority !== f.authority) return false;
    if (f.company && !(r.company_ids || []).includes(f.company)) return false;
    if (f.project && !(r.project_ids || []).includes(f.project)) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (f.applic && !((r.impact_counts || {})[f.applic] > 0)) return false;
    if (f.review && r.stage !== f.review) return false;
    if (f.read === 'unread' && r.read) return false;
    if (f.read === 'read' && !r.read) return false;
    if (f.pubFrom && (!r.publication_date || r.publication_date < f.pubFrom)) return false;
    if (f.pubTo && (!r.publication_date || r.publication_date > f.pubTo)) return false;
    if (f.effFrom && (!r.effective_date || r.effective_date < f.effFrom)) return false;
    if (f.effTo && (!r.effective_date || r.effective_date > f.effTo)) return false;
    return true;
  });
  const tiles = [
    ['Total updates', visible.length, '', 'Every relevant regulatory update you can see'],
    ['New', visible.filter((r) => !r.read && !r.archive).length, 'var(--accent)', 'Not opened by you yet'],
    ['High priority', visible.filter((r) => ['Critical', 'High'].includes(r.priority) && r.stage !== 'closed').length, 'var(--warn)', 'Critical or High priority and not closed'],
    ['Requiring review', visible.filter((r) => OPEN_STAGES_RU.includes(r.stage) || r.needs_re_review).length, 'var(--hold)', 'Waiting for a compliance review, or changed after review'],
    ['Affecting projects', visible.filter((r) => r.affected_total > 0 && !r.archive).length, 'var(--bad)', 'Potentially affect at least one project']
  ];
  const admin = S.can('manage_settings');
  const sel = (k, label, opts) => <label>{label}<select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">All</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  const date = (k, label) => <label>{label}<input type="date" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  const projs = Object.keys(S.projects).sort((a, b) => (S.projects[a].name || '').localeCompare(S.projects[b].name || ''));
  const open = (id) => ui.openModal(<RegulatoryModal id={id} />);

  let list;
  if (S.ru.rows === null) list = <Empty>Loading regulatory updates…</Empty>;
  else if (S.ru.err && !rows.length) list = <Empty>{S.ru.err}</Empty>;
  else if (!visible.length) list = <Empty><b>No regulatory updates yet.</b><div style={{ marginTop: 6 }}>{admin ? 'The server checks the configured official sources every day at 8:00 AM IST. You can run a check now, or add an official document by hand, from the buttons above.' : 'Updates appear here when the daily check finds something new on the official sources.'}</div></Empty>;
  else if (!filtered.length) list = <Empty>No updates match these filters.</Empty>;
  else list = <>
    <div className="ru-list">{filtered.map((r) => <RuCard key={r.id} r={r} onOpen={() => open(r.id)} />)}</div>
    <div className="fact-sub" style={{ marginTop: 8 }}>Showing {filtered.length} of {visible.length}.</div>
  </>;

  return (
    <>
      <div className="section-title">Regulatory Updates</div>
      <div className="ru-bar"><div className="sub">New circulars, notifications and orders from official sources, read by the server every day at 8:00 AM IST. AI summaries are suggestions: nothing becomes a mandatory compliance record until a compliance manager confirms it.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" type="button" onClick={() => { S.setRu((p) => ({ ...p, rows: null })); S.loadRegulatory(); }}>Refresh</button>
          {admin && <><button className="btn sm" type="button" onClick={() => ui.openModal(<ManualDocForm />)}>Add official document</button><button className="btn sm primary" type="button" onClick={() => startMonitoringRun(S, ui.toast, {})}>Check sources now</button></>}
        </div></div>
      <div className="grid grid-stats" style={{ marginBottom: 16 }}>{tiles.map(([l, n, c, tip]) => <div key={l} className="stat-tile" title={tip}><div className="num" style={c ? { color: c } : undefined}>{n}</div><div className="label">{l}</div></div>)}</div>
      <div className="filters">
        <label className="grow">Search<input type="search" value={f.q} placeholder="Title, authority, circular number, summary" onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        {sel('authority', 'Authority', [...new Set(rows.map((r) => r.authority).filter(Boolean))].sort().map((a) => [a, a]))}
        {sel('company', 'Company', Object.keys(S.companies).map((c) => [c, S.companies[c].name || c]))}
        {sel('project', 'Project', projs.map((p) => [p, S.projects[p].name || p]))}
        {sel('category', 'Category', ((S.ru.opts && S.ru.opts.categories) || []).map((c) => [c, c]))}
        {sel('priority', 'Priority', ['Critical', 'High', 'Medium', 'Low'].map((c) => [c, c]))}
        {sel('applic', 'Applicability', RU_APPLICABILITY.map((c) => [c, c]))}
        {sel('review', 'Review status', Object.keys(RU_STAGE_TXT).map((c) => [c, RU_STAGE_TXT[c]]))}
        {sel('read', 'Read', [['unread', 'Unread'], ['read', 'Read']])}
        {date('pubFrom', 'Published from')}{date('pubTo', 'to')}{date('effFrom', 'Effective from')}{date('effTo', 'to')}
        <label className="chk"><input type="checkbox" checked={f.irrelevant} onChange={(e) => setF({ ...f, irrelevant: e.target.checked })} /> Show items judged not relevant</label>
        <button className="btn sm" type="button" onClick={() => setF(NO_FILTERS)}>Clear</button>
      </div>
      <div>{list}</div>
    </>
  );
}

function RuCard({ r, onOpen }) {
  const n = r.affected_total || 0;
  const meta = [r.authority || 'Unknown authority', r.circular_number && `No. ${r.circular_number}`, r.publication_date && fmtDate(r.publication_date), r.category].filter(Boolean).join(' · ');
  const sum = r.summary || (r.processing === 'needs_manual' ? 'Text could not be read automatically. Open to view the official document.' : '');
  return (
    <div className={`ru-card p-${r.priority} ${r.read ? '' : 'unread'}`} tabIndex={0} onClick={(e) => { if (!e.target.closest('a')) onOpen(); }} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="ru-row"><div className="ru-title">{r.title}</div>
        <div className="ru-side">{r.needs_re_review ? <Chip cls="bad">Changed — review again</Chip> : !r.read && !r.archive && <Chip cls="warn">New</Chip>}<Chip cls={PRI_CLS[r.priority]}>{r.priority}</Chip></div></div>
      <div className="ru-meta">{meta}</div>
      {sum && <div className="ru-sum">{sum}</div>}
      {n > 0 && <div className="ru-foot"><span>{n} project{n === 1 ? '' : 's'} may be affected</span></div>}
    </div>
  );
}

/* ============================= one update: detail, and the small forms that replace it ============================= */
/** `mode` 'assign' / 'task' opens straight into that form; `focus` 'impacts' scrolls to the project impact. */
export function RegulatoryModal({ id, focus, mode }) {
  const S = useStore();
  const ui = useUi();
  const [u, setU] = useState(null);
  const [form, setForm] = useState(mode ? { kind: mode } : null);
  const [failed, setFailed] = useState(false);
  const impactsRef = useRef(null);

  const load = async () => {
    try { const x = await api('GET', '/api/regulatory/updates/' + encodeURIComponent(id)); setU(x); return x; }
    catch (e) { ui.toast(e.message); setFailed(true); return null; }
  };
  useEffect(() => {
    load().then((x) => {
      if (!x || x.read) return;
      api('POST', `/api/regulatory/updates/${encodeURIComponent(id)}/read`, {}).then(() => {
        S.markRuRead(id);
        api('POST', '/api/notifications/read', { ids: S.notes.filter((n) => n.reg_id === id).map((n) => n.id) }).then(S.loadNotes).catch(() => {});
      }).catch(() => {});
    });
  }, [id]); 
  useEffect(() => { if (u && focus === 'impacts' && !form && impactsRef.current) impactsRef.current.scrollIntoView({ block: 'start' }); }, [u]); 

  /** Run one review action; on success show the updated detail again. */
  const act = async (body, okMsg) => {
    try {
      await api('POST', `/api/regulatory/updates/${encodeURIComponent(id)}/act`, body);
      ui.toast(okMsg || 'Saved.');
      S.loadRegulatory();
      await load(); setForm(null);
      return true;
    } catch (e) { ui.toast(e.message, 6000); return false; }
  };

  if (!u) return <ModalHead title={failed ? 'Could not open this update' : 'Loading…'} />;
  if (form) {
    const back = () => setForm(null);
    if (form.kind === 'decide') return <DecideForm u={u} pid={form.pid} st={form.st} act={act} back={back} />;
    if (form.kind === 'stage') return <StageForm u={u} to={form.to} act={act} back={back} />;
    if (form.kind === 'assign') return <AssignForm u={u} act={act} back={back} />;
    if (form.kind === 'task') return <TaskForm u={u} pid={form.pid} act={act} back={back} />;
    if (form.kind === 'link') return <LinkForm u={u} pid={form.pid} act={act} back={back} />;
  }
  return <RuDetail u={u} impactsRef={impactsRef} setForm={setForm} act={act} reloadU={load} />;
}

const RuList = ({ a }) => (a && a.length ? <ul>{a.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p style={{ color: 'var(--text-muted)' }}>None stated.</p>);
const Kv = ({ k, children }) => <div><div className="ru-k">{k}</div><div className="ru-v">{children || <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Not stated</span>}</div></div>;

function RuDetail({ u, impactsRef, setForm, act, reloadU }) {
  const S = useStore();
  const ui = useUi();
  const [comment, setComment] = useState('');
  const [reanalysing, setReanalysing] = useState(false);
  const a = u.analysis, rev = S.can('review_regulatory'), imps = u.impacts || [];
  const live = imps.filter((i) => LIVE_APP.includes(effStatus(i))), other = imps.filter((i) => !LIVE_APP.includes(effStatus(i)));
  const stagesTxt = a ? (a.affected_stages || []).map((sid) => { const s = (S.stages || []).find((x) => x.id === sid); return s ? s.name : sid; }) : [];
  const nexts = RU_STAGE_NEXT[u.stage] || [];

  const reanalyse = async () => {
    setReanalysing(true);
    try { await api('POST', `/api/regulatory/updates/${encodeURIComponent(u.id)}/reanalyse`, {}); ui.toast('Analysis finished.'); S.loadRegulatory(); await reloadU(); }
    catch (e) { ui.toast(e.message, 6000); }
    setReanalysing(false);
  };
  const addComment = () => { const t = comment.trim(); if (!t) { ui.toast('Write a comment first.'); return; } act({ action: 'comment', text: t }, 'Comment added.').then((ok) => ok && setComment('')); };

  const impTable = (list) => (
    <div className="table-wrap"><table className="ru-imp"><thead><tr><th>Project</th><th>Stage</th><th>Applicability</th><th>Why</th><th>Compliance records</th><th /></tr></thead><tbody>
      {list.map((i) => {
        const st = effStatus(i), rel = i.related_compliance_ids || [], lk = i.linked_compliance_ids || [];
        const btn = (label, form) => <button className="btn sm" type="button" onClick={() => setForm(form)}>{label}</button>;
        return (
          <tr key={i.project_id}>
            <td><b>{i.project_name}</b><div className="fact-sub">{(S.companies[i.company_id] || {}).name || ''}</div></td><td>{i.stage || '—'}</td>
            <td><Chip cls={APP_CLS[st]}>{st}</Chip>{i.decision && <div className="fact-sub">Decided by {i.decision.by} · {ago(i.decision.at)}</div>}</td>
            <td className="why">{i.reason}{i.decision && i.decision.note && <div style={{ marginTop: 4, color: 'var(--text)' }}><b>Decision note:</b> {i.decision.note}</div>}{i.decision && i.decision.status !== i.system_status && <div className="fact-sub">System suggestion was: {i.system_status}</div>}</td>
            <td>{lk.map((c) => <span key={c}><Chip cls="ok">{c}</Chip> </span>)}{rel.filter((c) => !lk.includes(c)).map((c) => <span key={c}><Chip title="Possibly related — not linked yet">{c}?</Chip> </span>)}{!lk.length && !rel.length && <span className="fact-sub">None</span>}</td>
            <td>{rev && <div className="ru-acts">
              {btn('Confirm applicable', { kind: 'decide', pid: i.project_id, st: 'Confirmed Applicable' })}
              {btn('Not applicable', { kind: 'decide', pid: i.project_id, st: 'Not Applicable' })}
              {btn('Legal review', { kind: 'decide', pid: i.project_id, st: 'Legal Review Required' })}
              {i.decision && btn('Undo decision', { kind: 'decide', pid: i.project_id, st: 'reset' })}
              {btn('Link record', { kind: 'link', pid: i.project_id })}
              {btn('Create task', { kind: 'task', pid: i.project_id })}
            </div>}</td>
          </tr>
        );
      })}
    </tbody></table></div>
  );

  return (
    <>
      <ModalHead kicker="Regulatory update" title={u.title} badges={<>
        <Chip cls={PRI_CLS[u.priority]}>{u.priority} priority</Chip>
        <Chip cls={['closed', 'implemented'].includes(u.stage) ? 'ok' : ''}>{RU_STAGE_TXT[u.stage] || u.stage}</Chip>
        {u.verification === 'human_verified' ? <Chip cls="ok">AI summary checked by a person</Chip> : <Chip>AI summary — unverified</Chip>}
        {u.needs_re_review && <Chip cls="bad">Changed — review again</Chip>}
      </>} />
      <div className="modal-body modal-stack">
        <section className="panel"><h4>Regulatory information</h4>
          <div className="ru-grid">
            <Kv k="Issuing authority">{u.authority}</Kv><Kv k="Document type">{u.document_type}</Kv><Kv k="Circular / notification no.">{u.circular_number}</Kv>
            <Kv k="Publication date">{u.publication_date && fmtDate(u.publication_date)}</Kv><Kv k="Effective date">{u.effective_date && fmtDate(u.effective_date)}</Kv><Kv k="Category">{u.category}</Kv>
            <Kv k="Jurisdiction">{u.jurisdiction}</Kv><Kv k="Source">{u.source_name || (u.origin === 'manual' ? 'Added manually' : '')}</Kv><Kv k="Detected">{ago(u.detected_at)}</Kv>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
            <ExtLink href={u.official_url}>Open official document</ExtLink>
            {u.has_original && <a href={`/api/regulatory/updates/${encodeURIComponent(u.id)}/original`} target="_blank" rel="noopener">View stored copy (PDF) ↗</a>}
            <ExtLink href={u.source_url}>Open source page</ExtLink>
          </div>
        </section>

        <section className="panel"><h4>AI summary</h4>
          <div className="ru-warn">Generated by AI from the official document and checked against its text. It is a suggestion, not legal advice and not a statutory obligation until a compliance manager confirms it. Always read the official document.{u.ocr && ' This was a scanned document: its text was read by AI (OCR) and may contain reading errors.'}</div>
          {a ? <>
            <div className="ru-sec" style={{ marginTop: 0 }}><div className="ai-l">Summary</div><p>{u.summary || '—'}</p></div>
            <div className="ru-sec"><div className="ai-l">What changed</div><p>{u.what_changed || 'Not stated.'}</p></div>
            {(a.who_must_comply || []).length > 0 && <div className="ru-sec"><div className="ai-l">Who must comply (as stated)</div><p>{a.who_must_comply.join('; ')}</p></div>}
            <div className="ru-sec"><div className="ai-l">Why it matters — priority {u.priority}</div><p>{u.priority_reason || ''}{!a.creates_mandatory_obligation && <> <span className="fact-sub">The document does not appear to create a mandatory obligation.</span></>}</p></div>
            <div className="ru-sec"><div className="ai-l">Compliance implications</div><RuList a={a.compliance_implications} /></div>
            <div className="ru-sec"><div className="ai-l">Affected activities</div><RuList a={a.affected_activities} /></div>
            <div className="ru-sec"><div className="ai-l">Affected project stages</div><RuList a={stagesTxt} /></div>
            <div className="ru-sec"><div className="ai-l">Deadlines stated in the document</div>{(a.deadlines || []).length ? <ul>{a.deadlines.map((d, i) => <li key={i}>{d.description}{d.date && <> — <b>{fmtDate(d.date)}</b></>}<div className="ru-quote">“{d.evidence}”</div></li>)}</ul> : <p style={{ color: 'var(--text-muted)' }}>No deadline is stated in the document.</p>}</div>
            <div className="ru-sec"><div className="ai-l">Suggested actions (not yet decided)</div><RuList a={a.recommended_actions} /></div>
            <div className="ru-sec"><div className="ai-l">Uncertainties</div><RuList a={a.uncertainties} /></div>
            {(a.evidence || []).length > 0 && <div className="ru-sec"><div className="ai-l">Evidence quoted from the document</div>{a.evidence.map((e, i) => <div key={i} className="ru-quote">“{e.quote}”{e.supports && ` — ${e.supports}`}</div>)}</div>}
            {(a.validation_notes || []).length > 0 && <div className="ru-sec"><div className="ai-l">Checks made on the AI output</div><RuList a={a.validation_notes} /></div>}
            <div className="fact-sub" style={{ marginTop: 10 }}>Confidence: {a.confidence} · Model: {a.model || ''} · Analysed {ago(a.analysed_at)}</div>
          </> : <>
            <div className="ru-warn" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>{u.processing === 'needs_manual' ? (u.processing_note || 'No readable text could be extracted.') : ('AI analysis has not completed' + (u.processing_note ? ': ' + u.processing_note : '.') + ' The server retries automatically. You can read the official document meanwhile.')}</div>
            {S.can('manage_settings') && (u.has_text || u.has_original) && <button className="btn sm" type="button" disabled={reanalysing} onClick={reanalyse}>{reanalysing ? 'Reading and analysing…' : u.has_text ? 'Analyse now' : 'Read scan and analyse'}</button>}
          </>}
          {rev && a && !isRestrictedUi(S.me) && <div style={{ marginTop: 12 }}><button className="btn sm" type="button" onClick={() => act({ action: 'verify', verified: u.verification !== 'human_verified' }, 'Saved.')}>{u.verification === 'human_verified' ? 'Remove “checked” mark' : 'Mark as checked against the official document'}</button></div>}
        </section>

        <section className="panel" ref={impactsRef}><h4>Project impact</h4>
          <div className="fact-sub" style={{ marginBottom: 8 }}>Matched by rules from each project’s location, planning authority, type and stage — no project data is sent to the AI. “Potentially applicable” is a prompt to review, not a finding. Applicability is only confirmed by a compliance manager.</div>
          {live.length ? impTable(live) : <div className="ru-warn" style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>{u.document_type === 'General Information' || u.relevant === false ? 'This is informational; no project impact was assessed.' : imps.length ? 'No project is currently marked as potentially affected.' : 'No projects could be matched. This requires compliance review.'}</div>}
          {other.length > 0 && <Fold title={`Not applicable / need more information (${other.length})`} style={{ marginTop: 10 }}>{impTable(other)}</Fold>}
        </section>

        <section className="panel"><h4>Review and actions</h4>
          <div className="ru-stagebar"><b>{RU_STAGE_TXT[u.stage] || u.stage}</b>{u.assignee && <Chip>Assigned to {u.assignee.name}</Chip>}</div>
          <div className="fact-sub" style={{ margin: '4px 0 10px' }}>New Update → AI Analysis → Project Impact → Compliance Review → Applicable / Not Applicable / Legal Review → Action → Implementation → Closure. Nothing moves on its own.</div>
          {rev ? <div className="ru-acts">
            {nexts.map((to) => <button key={to} className="btn sm" type="button" onClick={() => setForm({ kind: 'stage', to })}>{to === 'in_review' ? (u.stage === 'new' || u.stage === 'analysed' ? 'Start compliance review' : 'Reopen for review') : 'Move to: ' + RU_STAGE_TXT[to]}</button>)}
            <button className="btn sm" type="button" onClick={() => setForm({ kind: 'assign' })}>Assign person</button>
            <button className="btn sm" type="button" onClick={() => setForm({ kind: 'task' })}>Create compliance task</button>
          </div> : <div className="readonly-note">You can read this update. Only a Compliance Manager or Admin can review it.</div>}
          <div className="ru-sec"><div className="ai-l">Tasks</div>{(u.tasks || []).length ? u.tasks.map((t) => (
            <div key={t.id} className={'ru-task' + (t.status === 'done' ? ' done' : '')}>
              {rev && <input type="checkbox" checked={t.status === 'done'} title="Mark done / open" onChange={(e) => act({ action: 'task_status', task_id: t.id, status: e.target.checked ? 'done' : 'open' }, 'Task updated.')} />}
              <div><div className="tt"><b>{t.title}</b> — {t.project_name}</div>
                <div className="fact-sub">{t.assignee ? t.assignee.name : 'Unassigned'}{t.due && ` · due ${fmtDate(t.due)}`}{t.compliance_id && ` · ${t.compliance_id}`}{t.description && ` · ${t.description}`}</div></div>
            </div>
          )) : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tasks yet. A task is only a to-do for this update; it does not create or change a compliance record.</p>}</div>
          <div className="ru-sec"><div className="ai-l">Comments</div>
            {(u.comments || []).length ? u.comments.map((c) => <div key={c.id} className="ru-hist"><b>{c.by}</b> · {ago(c.at)}<div style={{ color: 'var(--text)', marginTop: 2 }}>{c.text}</div></div>) : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No comments.</p>}
            {rev && <><textarea className="ru-textarea" placeholder="Add a comment" maxLength={1500} style={{ marginTop: 8, minHeight: 60 }} value={comment} onChange={(e) => setComment(e.target.value)} />
              <div style={{ marginTop: 6 }}><button className="btn sm" type="button" onClick={addComment}>Add comment</button></div></>}
          </div>
          <Fold title={`Review history (${(u.history || []).length})`} style={{ marginTop: 12 }}>
            {(u.history || []).slice().reverse().map((h, i) => <div key={i} className="ru-hist"><b>{h.who}</b> · {h.action} · {ago(h.at)}{h.note && <div style={{ color: 'var(--text)' }}>{h.note}</div>}</div>)}
          </Fold>
        </section>
      </div>
    </>
  );
}

/* ---------- a generic small form ---------- */
/** fields: [{id, label, type: text|textarea|select|checkbox|date|file, options, value, full, hint, placeholder, list, accept, max, checkLabel}] */
function RuForm({ kicker, title, sub, fields, submit = 'Save', busyLabel = 'Saving…', onSubmit, back, datalist }) {
  const { toast } = useUi();
  const [v, setV] = useState(() => Object.fromEntries(fields.map((f) => [f.id, f.type === 'checkbox' ? !!f.value : f.type === 'file' ? null : (f.value ?? '')])));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const vals = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x]));
    setBusy(true);
    try { await onSubmit(vals); } catch (e) { toast(e.message, 7000); }
    setBusy(false);
  };
  const ctl = (f) => {
    const set = (x) => setV((p) => ({ ...p, [f.id]: x }));
    if (f.type === 'textarea') return <textarea className="ru-textarea" placeholder={f.placeholder || ''} maxLength={f.max || 1500} value={v[f.id]} onChange={(e) => set(e.target.value)} />;
    if (f.type === 'select') return <select value={v[f.id]} onChange={(e) => set(e.target.value)}>{f.options.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</select>;
    if (f.type === 'checkbox') return <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}><input type="checkbox" checked={v[f.id]} onChange={(e) => set(e.target.checked)} /> <span>{f.checkLabel || ''}</span></label>;
    if (f.type === 'file') return <input type="file" accept={f.accept} onChange={(e) => set(e.target.files[0] || null)} />;
    return <input type={f.type || 'text'} value={v[f.id]} placeholder={f.placeholder || ''} list={f.list} onChange={(e) => set(e.target.value)} />;
  };
  return (
    <>
      <ModalHead kicker={kicker || 'Regulatory update'} title={title} />
      <div className="modal-body modal-stack"><section className="panel">
        {sub && <div className="fact-sub" style={{ marginBottom: 10, fontSize: 12.5 }}>{sub}</div>}
        <div className="setup-grid">{fields.map((f) => <div key={f.id} className="field" style={f.full ? { gridColumn: '1/-1' } : undefined}><label>{f.label}</label>{ctl(f)}{f.hint && <div className="fact-sub">{f.hint}</div>}</div>)}</div>
        {datalist}
      </section></div>
      <div className="modal-foot"><button className="btn primary" type="button" disabled={busy} onClick={go}>{busy ? busyLabel : submit}</button>{back && <button className="btn" type="button" onClick={back}>Back</button>}</div>
    </>
  );
}
function CidList() {
  const S = useStore();
  return <datalist id="ruCidList">{(S.items || []).slice(0, 400).map((i) => <option key={i.compliance_id} value={i.compliance_id}>{(i.brief_description || '').slice(0, 60)}</option>)}</datalist>;
}
const impOf = (u, pid) => (u.impacts || []).find((i) => i.project_id === pid);
const usersFor = (S, pid) => ((S.ru.opts && S.ru.opts.users) || []).filter((x) => !pid || !x.project_ids || x.project_ids.includes(pid));

function DecideForm({ u, pid, st, act, back }) {
  const { toast } = useUi();
  const i = impOf(u, pid), reset = st === 'reset';
  if (!i) return null;
  return <RuForm title={`${reset ? 'Undo decision' : st} — ${i.project_name}`} back={back} submit={reset ? 'Undo decision' : 'Save decision'}
    sub={reset ? 'This removes your decision and returns to the system suggestion.' : st === 'Confirmed Applicable' ? 'Confirming applicability records your decision here. It does not create a compliance record or change any status — do that separately when you are ready.' : 'Your decision is recorded with your name and the reason.'}
    fields={[{ id: 'note', type: 'textarea', label: reset ? 'Note (optional)' : 'Reason', full: true, placeholder: 'Why?' }]}
    onSubmit={(v) => { if (!reset && v.note.length < 3) { toast('Please give a short reason.'); return; } return act({ action: 'decide', project_id: pid, status: st, note: v.note }, 'Decision saved.'); }} />;
}
function StageForm({ u, to, act, back }) {
  const { toast } = useUi();
  const need = ['implemented', 'closed'].includes(to), openTasks = (u.tasks || []).filter((t) => t.status !== 'done').length;
  return <RuForm title={`Move to: ${RU_STAGE_TXT[to]}`} back={back} submit="Move"
    sub={<>{to === 'implemented' ? 'Only mark as implemented once the work has actually been done. This is never done automatically.' : to === 'closed' ? 'Closing ends the review. Everything stays on record and it can be reopened.' : 'Your name and the time are recorded in the review history.'}{to === 'closed' && openTasks > 0 && <> <b>{openTasks} task(s) are still open.</b></>}</>}
    fields={[{ id: 'note', type: 'textarea', label: need ? 'Note (required)' : 'Note (optional)', full: true }]}
    onSubmit={(v) => { if (need && v.note.length < 3) { toast('Please add a short note.'); return; } return act({ action: 'set_stage', stage: to, note: v.note, force: to === 'closed' && openTasks > 0 }, 'Moved to ' + RU_STAGE_TXT[to] + '.'); }} />;
}
function AssignForm({ u, act, back }) {
  const S = useStore();
  const { toast } = useUi();
  return <RuForm title="Assign a person to review" back={back} submit="Assign" sub="They get a notification in the bell. This does not change any compliance record."
    fields={[{ id: 'assignee', type: 'select', label: 'Assign to', options: [['', 'Choose…'], ...usersFor(S).map((x) => [x.email, `${x.name} (${x.role})`])] }, { id: 'note', type: 'textarea', label: 'Note (optional)', full: true }]}
    onSubmit={(v) => { if (!v.assignee) { toast('Choose a person.'); return; } return act({ action: 'assign', assignee: v.assignee, note: v.note }, 'Assigned.'); }} />;
}
function TaskForm({ u, pid, act, back }) {
  const S = useStore();
  const { toast } = useUi();
  const live = (u.impacts || []).filter((i) => LIVE_APP.includes(effStatus(i))), pool = live.length ? live : (u.impacts || []);
  if (!pool.length) return <><ModalHead kicker="Regulatory update" title="Create compliance task" /><div className="modal-body"><Empty>There is no project to attach a task to yet.</Empty></div><div className="modal-foot"><button className="btn" type="button" onClick={back}>Back</button></div></>;
  return <RuForm title="Create compliance task" back={back} submit="Create task" sub="A task is a to-do linked to this update and project. It does not create a compliance record or change a status." datalist={<CidList />}
    fields={[{ id: 'project_id', type: 'select', label: 'Project', value: pid || pool[0].project_id, options: pool.map((i) => [i.project_id, i.project_name]), full: true }, { id: 'title', label: 'Task', full: true, placeholder: 'e.g. Review updated fee structure and revise the budget' },
      { id: 'assignee', type: 'select', label: 'Assign to', options: [['', 'Unassigned'], ...usersFor(S).map((x) => [x.email, `${x.name} (${x.role})`])] }, { id: 'due', type: 'date', label: 'Due date' },
      { id: 'compliance_id', label: 'Related compliance record (optional)', placeholder: 'e.g. MEP-006', list: 'ruCidList' }, { id: 'description', type: 'textarea', label: 'Details (optional)', full: true }]}
    onSubmit={(v) => { if (v.title.length < 3) { toast('Give the task a short title.'); return; } return act({ action: 'task', project_id: v.project_id, title: v.title, assignee: v.assignee || undefined, due: v.due || undefined, compliance_id: v.compliance_id || undefined, description: v.description }, 'Task created.'); }} />;
}
function LinkForm({ u, pid, act, back }) {
  const { toast } = useUi();
  const i = impOf(u, pid); if (!i) return null;
  return <RuForm title={`Link a compliance record — ${i.project_name}`} back={back} submit="Link" datalist={<CidList />}
    sub={`Linking only connects this update to an existing record for your reference. ${(i.related_compliance_ids || []).length ? 'Possibly related: ' + i.related_compliance_ids.join(', ') + '.' : ''}`}
    fields={[{ id: 'compliance_id', label: 'Compliance record ID', list: 'ruCidList', placeholder: 'e.g. MEP-006', full: true }]}
    onSubmit={(v) => { if (!v.compliance_id) { toast('Enter the record ID.'); return; } return act({ action: 'link', project_id: pid, compliance_id: v.compliance_id }, 'Linked.'); }} />;
}

/* ============================= administrators ============================= */
// Settings → Regulatory sources listens for changes made from anywhere (a finished run, an edited source).
const sourceListeners = new Set();
const sourcesChanged = () => sourceListeners.forEach((fn) => fn());
let running = false;

/** Start a monitoring run (all sources, failed ones only, or one source) and report when it finishes. */
export async function startMonitoringRun(S, toast, body, sourceId) {
  if (running) { toast('A check is already running.'); return; }
  try {
    const r = await api('POST', sourceId ? `/api/regulatory/sources/${encodeURIComponent(sourceId)}/run` : '/api/regulatory/run', body || {});
    if (r.skipped) { toast(r.reason || 'A check is already running.', 5000); return; }
    running = true; toast('Checking official sources in the background… this can take a few minutes.', 6000);
    const since = new Date(Date.now() - 5000).toISOString();
    const poll = async () => {
      try {
        const runs = await api('GET', '/api/regulatory/runs');
        const mine = runs.find((x) => x.started_at >= since && x.finished_at);
        if (!mine) { setTimeout(poll, 5000); return; }
        running = false; const t = mine.totals || {};
        toast(`Check finished: ${t.new || 0} new, ${t.modified || 0} changed, ${t.duplicates || 0} duplicate, ${t.failed || 0} source problem(s).`, 8000);
        sourcesChanged(); S.loadRegulatory(); S.loadNotes();
      } catch (e) { running = false; toast(e.message); }
    };
    setTimeout(poll, 4000);
  } catch (e) { toast(e.message, 6000); }
}

/** An administrator adds an official document by hand: link + optional pasted text or uploaded PDF. */
export function ManualDocForm({ sourceId, sources }) {
  const S = useStore();
  const ui = useUi();
  return <RuForm kicker="Add official document" title="Add a document from an official source" busyLabel="Reading and analysing… this can take up to a minute" submit="Add and analyse"
    sub="Use this for sites that cannot be monitored automatically. Give the link to the official document. If the server cannot read the page itself, paste its text or upload the PDF. Only official government documents belong here."
    fields={[{ id: 'authority', label: 'Issuing authority', placeholder: 'e.g. MahaRERA', value: ((sources || []).find((s) => s._id === sourceId) || {}).authority || '' }, { id: 'official_url', label: 'Link to the official document or page', placeholder: 'https://…' },
      { id: 'title', label: 'Title', full: true }, { id: 'circular_number', label: 'Circular / notification no. (optional)' }, { id: 'category', type: 'select', label: 'Category', value: ((S.ru.opts && S.ru.opts.categories) || ['General'])[0], options: ((S.ru.opts && S.ru.opts.categories) || ['General']).map((c) => [c, c]) },
      { id: 'publication_date', type: 'date', label: 'Publication date (optional)' }, { id: 'effective_date', type: 'date', label: 'Effective date (optional)' },
      { id: 'file', type: 'file', accept: 'application/pdf,.pdf', label: 'PDF (optional)', hint: 'Up to 15 MB.' }, { id: 'text', type: 'textarea', max: 200000, full: true, label: 'Or paste the document text (optional)', placeholder: 'Only if the server cannot read the link itself' }]}
    onSubmit={async (v) => {
      if (!safeUrl(v.official_url)) { ui.toast('Enter the official link, starting with https://'); return; }
      if (v.authority.length < 2 || v.title.length < 3) { ui.toast('Enter the authority and the title.'); return; }
      const meta = { authority: v.authority, title: v.title, official_url: v.official_url, circular_number: v.circular_number, publication_date: v.publication_date, effective_date: v.effective_date, category: v.category, source_id: sourceId || '' };
      const r = v.file ? await uploadFile('/files/regulatory', v.file, meta, 'application/pdf') : await api('POST', '/api/regulatory/manual', { ...meta, text: v.text });
      ui.toast(r.status === 'duplicate' ? 'This document is already on record.' : r.status === 'unchanged' ? 'Nothing changed — already on record.' : 'Document added.', 5000);
      await S.loadRegulatory();
      if (r.id) ui.openModal(<RegulatoryModal id={r.id} />); else ui.closeModal();
    }} />;
}

function SourceForm({ s }) {
  const S = useStore();
  const ui = useUi();
  const edit = !!s;
  const cats = ((S.ru.opts && S.ru.opts.categories) || ['General']).map((c) => [c, c]);
  return <RuForm kicker={edit ? 'Edit source' : 'Add source'} title={edit ? s.name : 'Add an official source'} submit={edit ? 'Save' : 'Add source'}
    sub="Only official government or regulator pages. “Web page” reads PDF links from a listing page; “Feed” reads an RSS/Atom feed; “Manual only” just keeps a record of the source for adding documents by hand."
    fields={[{ id: 'name', label: 'Name', value: s && s.name, full: true }, { id: 'authority', label: 'Issuing authority', value: s && s.authority }, { id: 'kind', type: 'select', label: 'How it is read', value: (s && s.kind) || 'html', options: [['html', 'Web page'], ['rss', 'Feed (RSS / Atom)'], ['manual', 'Manual only']] },
      { id: 'url', label: 'Address of the official page or feed', value: s && s.url, placeholder: 'https://…', full: true }, { id: 'category', type: 'select', label: 'Category', value: (s && s.category) || 'General', options: cats },
      { id: 'include', label: 'Only links containing (optional)', value: s && s.include, placeholder: 'e.g. circular', hint: 'A text pattern. Leave empty to read every PDF link on the page.' }, { id: 'exclude', label: 'Skip links containing (optional)', value: s && s.exclude, placeholder: 'default skips tenders and recruitment', hint: 'Replaces the default skip list when filled.' },
      { id: 'note', type: 'textarea', label: 'Notes', value: s && s.note, full: true },
      { id: 'robots_confirmed', type: 'checkbox', full: true, value: s && s.robots_confirmed, label: 'Permission', checkLabel: 'I have confirmed that this site allows automated reading (only needed when its robots.txt cannot be read). Sites that forbid it in robots.txt are never read.' },
      { id: 'enabled', type: 'checkbox', full: true, value: s && s.enabled, label: 'Monitoring', checkLabel: 'Check this source every day' }]}
    onSubmit={async (v) => {
      const body = { name: v.name, authority: v.authority, kind: v.kind, url: v.url, category: v.category, include: v.include, exclude: v.exclude, note: v.note, robots_confirmed: v.robots_confirmed, enabled: v.enabled };
      if (edit) await api('PUT', '/api/regulatory/sources/' + encodeURIComponent(s._id), body); else await api('POST', '/api/regulatory/sources', body);
      ui.toast(edit ? 'Source saved.' : 'Source added.'); ui.closeModal(); sourcesChanged();
    }} />;
}

function srcStatus(s) {
  if (s.kind === 'manual') return <Chip>Manual only</Chip>;
  if (!s.enabled) return <Chip>Off</Chip>;
  if (s.last_status === 'ok') return <Chip cls="ok">Monitoring</Chip>;
  if (s.last_status === 'blocked') return <Chip cls="bad">Blocked</Chip>;
  if (s.last_status === 'failed') return <Chip cls="bad">Failed</Chip>;
  return <Chip cls="hold">Not checked yet</Chip>;
}

/** Settings → Regulatory sources (administrators). */
export function RegSources() {
  const S = useStore();
  const ui = useUi();
  const [st, setSt] = useState({ sources: null, runs: [], ai: true, err: '' });
  const load = async () => {
    try {
      const [s, runs] = await Promise.all([api('GET', '/api/regulatory/sources'), api('GET', '/api/regulatory/runs')]);
      setSt({ sources: s.sources, runs, ai: s.ai, err: '' });
      S.ensureRuOptions();
    } catch (e) { setSt((p) => ({ ...p, sources: p.sources || [], err: e.message })); }
  };
  const admin = S.can('manage_settings');
  useEffect(() => { if (!admin) return undefined; load(); sourceListeners.add(load); return () => sourceListeners.delete(load); }, [admin]); 
  if (!admin) return null;
  if (st.sources === null) return <div className="card" style={{ marginBottom: 18 }}><h3>Regulatory sources</h3><Empty style={{ padding: 20 }}>Loading…</Empty></div>;
  const run = (body, id) => startMonitoringRun(S, ui.toast, body, id);
  const toggle = async (s, on) => {
    try { await api('PUT', '/api/regulatory/sources/' + encodeURIComponent(s._id), { enabled: on }); ui.toast(on ? 'Monitoring turned on.' : 'Monitoring turned off.'); }
    catch (e) { ui.toast(e.message, 6000); }
    load();
  };
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h3 style={{ marginBottom: 4 }}>Regulatory sources</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 10 }}>The server reads these official pages every day at 8:00 AM IST (even when nobody is signed in), finds new or changed documents, and has them analysed by AI. It follows each site’s robots.txt and never bypasses a CAPTCHA or login. For sites that cannot be read automatically, use “Add document”. {!st.ai && <b style={{ color: 'var(--bad)' }}>No AI key is configured on the server, so documents are stored but not analysed.</b>}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn primary" type="button" onClick={() => ui.openModal(<SourceForm />)}>Add source</button>
        <button className="btn" type="button" onClick={() => ui.openModal(<ManualDocForm sources={st.sources} />)}>Add official document</button>
        <button className="btn" type="button" onClick={() => run({})}>Check all now</button>
        <button className="btn" type="button" onClick={() => run({ retry: true })}>Retry failed</button>
      </div>
      <div className="table-wrap"><table className="src-table"><thead><tr><th>Source</th><th>How</th><th>Status</th><th>Last checked</th><th /></tr></thead><tbody>
        {st.sources.length ? st.sources.map((s) => (
          <tr key={s._id}>
            <td><b>{s.name}</b><div className="fact-sub">{s.authority} · {s.category || 'General'}</div>{s.url && <div className="fact-sub"><ExtLink href={s.url}>{s.url.replace(/^https?:\/\//, '').slice(0, 60)}</ExtLink></div>}{s.note && <div className="src-note">{s.note}</div>}</td>
            <td>{s.kind === 'manual' ? 'Manual' : s.kind === 'rss' ? 'Feed' : 'Web page'}<div className="fact-sub">Daily, 8:00 AM IST</div></td>
            <td>{srcStatus(s)}{s.last_error && <div className="src-err">{s.last_error}</div>}</td>
            <td>{s.last_checked ? ago(s.last_checked) : '—'}{s.last_checked && <div className="fact-sub">{s.last_new || 0} new/changed</div>}</td>
            <td><div className="ru-acts">
              {s.kind !== 'manual' ? <>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={!!s.enabled} onChange={(e) => toggle(s, e.target.checked)} /> On</label>
                <button className="btn sm" type="button" onClick={() => run({}, s._id)}>Run now</button>
              </> : <button className="btn sm" type="button" onClick={() => ui.openModal(<ManualDocForm sourceId={s._id} sources={st.sources} />)}>Add document</button>}
              <button className="btn sm" type="button" onClick={() => ui.openModal(<SourceForm s={s} />)}>Edit</button>
            </div></td>
          </tr>
        )) : <tr><td colSpan={5}>No sources yet.</td></tr>}
      </tbody></table></div>
      {st.err && <div className="src-err">{st.err}</div>}
      <Fold title="Monitoring history" style={{ marginTop: 12 }}>
        {st.runs.length ? st.runs.slice(0, 8).map((r) => (
          <div key={r._id || r.started_at} className="ru-hist"><b>{ago(r.started_at)}</b> · {r.trigger}{r.by && r.by !== 'scheduler' && ` by ${r.by}`} · {r.finished_at ? `${r.totals.new} new, ${r.totals.modified} changed, ${r.totals.failed} source problem(s)` : 'running…'}
            {r.error && <> · <span style={{ color: 'var(--bad)' }}>{r.error}</span></>}
            {(r.sources || []).filter((x) => x.status !== 'ok' && x.status !== 'manual').map((x, i) => <div key={i} className="src-err">{x.name}: {x.error || x.status}</div>)}</div>
        )) : <div className="fact-sub">No runs yet.</div>}
      </Fold>
    </div>
  );
}
