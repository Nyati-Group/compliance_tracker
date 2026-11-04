import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useUi, Chip, Badge, Empty } from '../ui/ui.jsx';
import { STATUS_DEFS, STATUS_LIST, statusDef } from '../lib/constants.js';
import { fmtDate } from '../lib/format.js';
import { categoryOf, ctxName, effectiveStageId, setupSteps, stageStats, stageStatusLabel } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { openSetup } from './Setup.jsx';

export const NoContext = () => <Empty>No company or project yet. Open the Projects tab to add one.</Empty>;

export function StatusLegend() {
  return <div className="legend">{Object.entries(STATUS_DEFS).map(([k, v]) => <span key={k}><i style={{ background: `var(--${v.cls})` }} />{k}</span>)}</div>;
}

/** Small chips shown beside a status: waiting on a prerequisite, ready to start, document problems. */
export function FlagChips({ i }) {
  if (i.state !== 'active' || i.status === 'Compliant / Completed') return null;
  const chips = [];
  if (i.blocked) chips.push(<Chip key="b" cls="hold" title={'Waiting for: ' + i.blockedBy.map((b) => b.id).join(', ')}>Blocked</Chip>);
  else if (i.ready) chips.push(<Chip key="r" cls="ok" title="All prerequisites are complete">Ready to start</Chip>);
  if (i.docs) {
    if (i.docs.rejected) chips.push(<Chip key="dr" cls="bad">Doc rejected</Chip>);
    if (i.docs.expired) chips.push(<Chip key="de" cls="bad">Doc expired</Chip>);
    if (i.docs.pending) chips.push(<Chip key="dp" cls="warn">Doc awaiting verification</Chip>);
  }
  return chips.length ? <div className="flag-chips">{chips}</div> : null;
}

const NO_FILTERS = { dept: '', owner: '', status: '', level: '' };

export default function Stages() {
  const S = useStore();
  const ui = useUi();
  const [SF, setSF] = useSticky('stages.filters', NO_FILTERS);
  const [openStages, setOpenStages] = useSticky('stages.open', () => new Set(['S0', 'S1']));
  if (!S.inst.length && !S.ctx.projectId && !S.ctx.companyId) return <NoContext />;

  const pick = (f) => [...new Set(S.inst.map(f).filter(Boolean))].sort();
  const sel = (key, label, opts) => (
    <label>{label}<select value={SF[key]} onChange={(e) => setSF({ ...SF, [key]: e.target.value })}><option value="">All</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
  );
  const matches = (i) => (!SF.dept || i.item.department === SF.dept) && (!SF.owner || i.item.owner === SF.owner) && (!SF.status || i.status === SF.status) && (!SF.level || i.item.compliance_level === SF.level);
  const grouped = {};
  for (const s of S.stages) grouped[s.id] = { stage: s, items: [] };
  for (const i of S.inst.filter(matches)) {
    const sid = effectiveStageId(S, i.item);
    if (!grouped[sid]) grouped[sid] = { stage: { id: sid, name: 'Unmapped to Stage', order: 999, description: '' }, items: [] };
    grouped[sid].items.push(i);
  }
  const filtering = SF.dept || SF.owner || SF.status || SF.level;
  const ordered = Object.values(grouped).filter((g) => g.stage.id !== 'UNMAPPED' || g.items.length).sort((a, b) => a.stage.order - b.stage.order);
  const stageNum = (id) => id.replace(/^S/, 'Stage ');
  const setup = setupSteps(S, S.ctx, S.inst);
  const setupDone = setup.steps.filter((s) => s[1]).length;
  const toggle = (sid) => setOpenStages((prev) => { const n = new Set(prev); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  const open = (key) => ui.openModal(<RecordDrawer refKey={key} />);
  const project = S.ctx.projectId && S.projects[S.ctx.projectId];

  return (
    <>
      <div className="filters">
        {sel('dept', 'Department', pick((i) => i.item.department))}
        {sel('level', 'Compliance level', pick((i) => i.item.compliance_level))}
        {sel('owner', 'Owner', pick((i) => i.item.owner))}
        {sel('status', 'Status', STATUS_LIST)}
        {filtering && <button className="btn" type="button" onClick={() => setSF(NO_FILTERS)}>Clear filters</button>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>Showing: <b style={{ color: 'var(--text)' }}>{ctxName(S, S.ctx)}</b> — change it with the selector at the top</span>
      </div>
      <StatusLegend />
      {ordered.map((g) => {
        const sid = g.stage.id, c = stageStats(g.items), lab = stageStatusLabel(c), isSetup = sid === 'S0';
        const pct = isSetup ? (setup.steps.length ? Math.round(setupDone / setup.steps.length * 100) : 0) : c.pct;
        const prereq = (g.stage.prerequisites || []).map(stageNum).join(', ');
        return (
          <div key={sid} className={'stage-block' + (openStages.has(sid) ? ' open' : '')}>
            <div className="stage-head" onClick={() => toggle(sid)}>
              <svg className="stage-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
              <div className="stage-title"><h3>{g.stage.name}</h3></div>
              <div className="stage-progress"><div className="bar-track"><div className="bar-seg" style={{ width: pct + '%', background: 'var(--grad)' }} /></div></div>
              <div className="stage-count">{isSetup ? setupDone + '/' + setup.steps.length : `${c.pct}% · ${c.done}/${c.applicable}`}</div>
            </div>
            <div className="stage-items">
              <div className="stage-intro">
                {g.stage.description && <div className="stage-desc stage-desc-open">{g.stage.description}</div>}
                <div className="stage-chips">
                  {isSetup
                    ? <Chip cls={setupDone === setup.steps.length && setup.steps.length ? 'ok' : 'warn'}>{setupDone} of {setup.steps.length} set-up steps done</Chip>
                    : <>
                      <Chip cls={lab.cls}>{lab.txt}</Chip> <Chip>{c.applicable} applicable</Chip> <Chip cls="ok">{c.done} completed</Chip> <Chip cls="warn">{c.pending} pending</Chip>{' '}
                      <Chip cls={c.overdue ? 'bad' : ''}>{c.overdue} overdue</Chip> <Chip cls={c.blocked ? 'hold' : ''} title="Waiting for an earlier record to be completed">{c.blocked} blocked</Chip>{' '}
                      {c.review > 0 && <><Chip cls="hold" title="Applicability not confirmed yet">{c.review} to review</Chip> </>}<Chip>{c.na} not applicable</Chip>
                    </>}
                  {prereq && !isSetup && <> <Chip cls="hold" title="Proposed sequence, not yet legally validated">Usually after {prereq}</Chip></>}
                </div>
              </div>
              {isSetup ? (
                <div className="stage-note">
                  {setup.steps.length ? setup.steps.map((s) => <div key={s[0]} className={'doc-check ' + (s[1] ? 'done' : 'pending')}><span className="st">{s[1] ? '✓' : '○'}</span><span style={{ flex: 1 }}>{s[0]}</span></div>) : 'Select a company or project at the top.'}
                  <div style={{ marginTop: 10 }}><button className="btn primary" type="button" disabled={!setup.id} onClick={() => openSetup(ui, setup.kind, setup.id)}>Open {setup.kind} set-up</button></div>
                </div>
              ) : g.items.length ? <>
                <div className="item-row-header"><div>ID</div><div>What to do</div><div>Owner</div><div>Next due</div><div>Status</div></div>
                {g.items.map((i) => {
                  const it = i.item, sdef = statusDef(i.status);
                  return (
                    <div key={i.key} className="item-row" onClick={() => open(i.key)}>
                      <div className="idcell" data-lbl="ID">{it.compliance_id}</div>
                      <div className="desc" data-lbl="What to do" title={it.brief_description}>
                        <div className="d1">{it.brief_description || ''}</div>
                        <div className="d2">{[it.authority_norm, i.scopeShort || it.compliance_level].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="ownercell" data-lbl="Owner">{it.owner || '—'}</div>
                      <div className="muted mono" data-lbl="Next due">{i.tr.next_due_date ? fmtDate(i.tr.next_due_date) : '—'}</div>
                      <div className="stcell" data-lbl="Status">{i.state === 'review' ? <Badge cls="hold">Needs review</Badge> : <Badge cls={sdef.cls}><span className="ic">{sdef.ic}</span>{i.status}</Badge>}<FlagChips i={i} /></div>
                    </div>
                  );
                })}
              </> : <div className="stage-note">{filtering ? 'No records in this stage match the filters.' : 'No records in this stage for this view.'}</div>}
            </div>
          </div>
        );
      })}
      {project && categoryOf(project) !== 'epc' && Object.values(S.buildings).every((b) => b.project_id !== S.ctx.projectId) &&
        <div className="stage-note card" style={{ marginTop: 12 }}>No buildings are added to this project yet, so building-level requirements (lift licence, occupancy certificate, fire NOC, plinth checking…) are not listed. Add buildings in the project set-up.</div>}
      {S.ctx.projectId && <div className="stage-note" style={{ marginTop: 6 }}>Company-wide obligations (tax, labour, corporate, data protection) are tracked once for the company, not per project. Switch the selector to “Company-wide” to see them.</div>}
    </>
  );
}
