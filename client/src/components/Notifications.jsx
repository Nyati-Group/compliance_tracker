// The bell in the top bar and its panel: reminders, document approvals, unblocked records and regulatory notices.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useUi, Chip, Empty } from '../ui/ui.jsx';
import { api } from '../lib/api.js';
import { ago, fmtDate } from '../lib/format.js';
import { PRI_CLS, RU_STAGE_TXT } from '../lib/constants.js';
import RecordDrawer from './RecordDrawer.jsx';
import { RegulatoryModal } from '../views/Regulatory.jsx';

export default function Bell() {
  const S = useStore();
  const { toast, openModal } = useUi();
  const [open, setOpen] = useState(false);
  const panel = useRef(null), btn = useRef(null);
  const unread = S.notes.filter((x) => !x.read).length;

  useEffect(() => {
    if (!open) return;
    const click = (e) => { if (!panel.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('click', click); document.removeEventListener('keydown', key); };
  }, [open]);

  const setRead = (id) => S.setNotes((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)));
  const markRead = async (id) => { try { await api('POST', '/api/notifications/read', { ids: [id] }); } catch { /* best effort */ } setRead(id); };
  const dismiss = async (id) => {
    try { await api('POST', '/api/notifications/dismiss', { ids: [id] }); } catch (e) { toast(e.message); return; }
    S.setNotes((list) => list.filter((x) => x.id !== id));
  };
  const markAll = async () => {
    try { await api('POST', '/api/notifications/read', { all: true }); S.setNotes((list) => list.map((n) => ({ ...n, read: true }))); } catch (e) { toast(e.message); }
  };
  const openNote = async (n, act) => {
    setOpen(false);
    markRead(n.id);
    if (n.reg_id) { await S.ensureRuOptions(); openModal(<RegulatoryModal id={n.reg_id} focus={act === 'review' ? 'impacts' : null} mode={act === 'assign' || act === 'task' ? act : null} />); return; }
    if (n.key) openModal(<RecordDrawer refKey={n.key} />);
  };

  return (
    <>
      <button ref={btn} className="pill bell" type="button" aria-label="Notifications" aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open) S.loadNotes(); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: -2 }}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="note-panel" ref={panel} role="dialog" aria-label="Notifications">
          <div className="note-head"><b>Notifications</b><span>{unread > 0 && <button className="btn sm" type="button" onClick={markAll}>Mark all read</button>}</span></div>
          {S.notes.length ? S.notes.map((n) => (
            <div key={n.id} className={'note' + (n.read ? '' : ' unread')} onClick={(e) => { if (!e.target.closest('a')) openNote(n); }}>
              <span className={'lvl ' + (n.level || 'info')} />
              <div style={{ minWidth: 0 }}>
                <div className="t">{n.title}</div>
                {n.reg_id ? <RegNoteBody n={n} onAct={(act) => (act === 'read' ? markRead(n.id) : act === 'dismiss' ? dismiss(n.id) : openNote(n, act))} />
                  : <div className="m">{n.message}</div>}
                <div className="w">{ago(n.at)}</div>
              </div>
            </div>
          )) : <Empty style={{ padding: '30px 16px' }}>Nothing yet. Reminders, document approvals and unblocked records show up here.</Empty>}
        </div>
      )}
    </>
  );
}

function RegNoteBody({ n, onAct }) {
  const S = useStore();
  const live = S.ru.rows && S.ru.rows.find((r) => r.id === n.reg_id), stage = live ? live.stage : n.review_stage, rev = S.can('review_regulatory');
  const co = (n.company_ids || []).map((c) => (S.companies[c] || {}).name).filter(Boolean)[0], pr = (n.project_ids || []).map((p) => (S.projects[p] || {}).name).filter(Boolean);
  const bits = [n.authority, n.publication_date && fmtDate(n.publication_date), n.priority && <Chip cls={PRI_CLS[n.priority]}>{n.priority}</Chip>, stage && <Chip>{RU_STAGE_TXT[stage] || stage}</Chip>].filter(Boolean);
  const act = (a) => (e) => { e.stopPropagation(); onAct(a); };
  return (
    <>
      <div className="m">{n.message}</div>
      <div className="m ru-note-meta">{bits.map((b, i) => <span key={i}>{i > 0 && ' · '}{b}</span>)}</div>
      {(co || pr.length > 0) && <div className="m">{co && co + ' · '}{pr.length > 0 && pr.slice(0, 2).join(', ') + (pr.length > 2 ? ` +${pr.length - 2} more` : '')}</div>}
      {n.applicability && <div className="m">{n.applicability}</div>}
      <div className="ru-nacts">
        <button className="btn sm" type="button" onClick={act('open')}>Open update</button>
        {rev && n.type === 'regulatory_update' && <>
          <button className="btn sm" type="button" onClick={act('review')}>Review applicability</button>
          <button className="btn sm" type="button" onClick={act('assign')}>Assign</button>
          <button className="btn sm" type="button" onClick={act('task')}>Create task</button>
        </>}
        {n.source_url && /^https?:\/\//i.test(n.source_url) && <a className="btn sm" href={n.source_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Official source ↗</a>}
        {!n.read && <button className="btn sm" type="button" onClick={act('read')}>Mark read</button>}
        <button className="btn sm" type="button" onClick={act('dismiss')}>Dismiss</button>
      </div>
    </>
  );
}
