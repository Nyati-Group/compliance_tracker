// Company and project set-up: the answers that decide which compliance records apply.
import { useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useUi, ModalHead, Badge, Chip, ActionLink } from '../ui/ui.jsx';
import { api } from '../lib/api.js';
import { Core } from '../lib/core.js';
import { numOrNull, slug, uid } from '../lib/format.js';
import { GROUP_ORDER, PROJECT_TYPES } from '../lib/constants.js';
import { buildInstances, categoryOf, summaryText, theCompanyId, unansweredCompany, unansweredFor, worldData } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';

export function openSetup(ui, kind, id) {
  if (!id) return;
  ui.openModal(kind === 'company' ? <CompanySetup id={id} /> : <ProjectSetup id={id} />);
}

/* ---------- small building blocks ---------- */
const factVal = (facts, key) => (facts && typeof facts[key] === 'boolean' ? String(facts[key]) : '');
const SEG_CLS = { true: 'yes', false: 'no', '': 'unk' };

/** Yes / No / Not sure. `value` is 'true', 'false' or ''. */
export function Seg({ value, onChange, options = [['true', 'Yes'], ['false', 'No'], ['', 'Not sure']], disabled }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={'seg-btn' + (value === v ? ' on ' + (SEG_CLS[v] || 'yes') : '')} onClick={() => !disabled && onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function Question({ k, value, onChange, ent, affects, readonly }) {
  const S = useStore();
  const def = S.cat.flags[k];
  const st = Core.flagState(S.cat, k, ent);
  return (
    <div className={'q' + (readonly ? ' ro' : '')}>
      <div className="q-text">{def.question}<div className="q-sub">{value === '' && st.how === 'derived' ? <>Worked out from your numbers: <b>{st.value ? 'Yes' : 'No'}</b></> : `Decides ${affects} record${affects === 1 ? '' : 's'}`}</div></div>
      <Seg value={value} onChange={onChange} disabled={readonly} />
    </div>
  );
}

/** The questions of one scope (company / project), grouped by topic. `answers` holds 'true' | 'false' | '' per question. */
function QuestionGroups({ keys, rel, answers, setAnswer, ent, readonly }) {
  const S = useStore();
  if (!keys.length) return <div className="muted" style={{ fontSize: 12.5 }}>No questions here — everything in this section applies automatically.</div>;
  const groups = {};
  for (const k of keys) (groups[S.cat.flags[k].group] = groups[S.cat.flags[k].group] || []).push(k);
  return Object.keys(groups).sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)).map((g) => (
    <div className="q-group" key={g}><h5>{g}</h5>{groups[g].map((k) => <Question key={k} k={k} value={answers[k]} onChange={(v) => setAnswer(k, v)} ent={ent} affects={rel[k]} readonly={readonly} />)}</div>
  ));
}
const scopeKeys = (S, rel, scope) => Object.keys(rel).filter((k) => S.cat.flags[k].scope === scope);
const answersFrom = (keys, facts) => Object.fromEntries(keys.map((k) => [k, factVal(facts, k)]));
const factsFrom = (answers) => Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '').map(([k, v]) => [k, v === 'true']));

const StepHead = ({ n, title, done, children }) => <>
  <div className="step-head"><span className={'step-num' + (done ? ' done' : '')}>{done ? '✓' : n}</span><h4>{title}</h4></div>
  {children && <p className="step-desc">{children}</p>}
</>;
function ProgressBar({ done, total, waiting }) {
  const pct = total ? Math.round(done / total * 100) : 0;
  return (
    <div className="setup-progress">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}><b>Set-up {done} of {total} steps done</b>
        <span style={{ color: 'var(--text-muted)' }}>{waiting ? `${waiting} record${waiting > 1 ? 's' : ''} waiting for your answers` : 'Nothing waiting — all applicability is confirmed'}</span></div>
      <div className="bar-track"><div className="bar-seg" style={{ width: pct + '%', background: 'var(--grad)' }} /></div>
    </div>
  );
}

/* ---------- company set-up (there is only one company) ---------- */
function CompanySetup({ id }) {
  const S = useStore();
  const { toast } = useUi();
  const c = S.companies[id];
  const rel = c ? Core.relevantFlags(worldData(S), S.cat, { companyId: id }) : {};
  const keys = c ? scopeKeys(S, rel, 'company') : [];
  const [emp, setEmp] = useState(c && c.employee_count != null ? String(c.employee_count) : '');
  const [answers, setAnswers] = useState(() => answersFrom(keys, c && c.facts));
  const [busy, setBusy] = useState(false);
  if (!c) return <ModalHead title="Company not found" />;
  const ro = !S.can('manage_company');
  const un = unansweredCompany(S);
  const waiting = Object.values(S.applic).filter((d) => d.company_id === id && Core.stateOf(d.status) === 'review').length;
  const steps = [['Number of employees entered', c.employee_count != null && c.employee_count !== ''], ['Company questions answered', un.length === 0]];
  const save = async () => {
    setBusy(true);
    try {
      await S.putDoc('companies', id, { ...c, employee_count: numOrNull(emp), facts: factsFrom(answers) });
      const s = await S.regenerate({ companyId: id });
      toast('Saved. ' + summaryText(s));
    } catch (e) { toast('Save failed: ' + e.message); }
    setBusy(false);
  };
  return (
    <>
      <ModalHead kicker="Company set-up" title={`${c.name} — company-wide`} />
      <div className="modal-body">
        <ProgressBar done={steps.filter((s) => s[1]).length} total={steps.length} waiting={waiting} />
        {ro && <div className="readonly-note">You can view these answers but not change them.</div>}
        <section className="step"><StepHead n={1} title="Employees" done={steps[0][1]}>Many labour rules depend on how many people work for the company. Enter the number and the 5 / 10 / 20 / 50-person questions answer themselves.</StepHead>
          <div className="field" style={{ maxWidth: 260, marginLeft: 34 }}><label>Number of employees</label><input type="number" min="0" value={emp} disabled={ro} onChange={(e) => setEmp(e.target.value)} /></div>
        </section>
        <section className="step"><StepHead n={2} title="Company questions" done={steps[1][1]}>These decide which company-wide obligations apply. Pick <b>Not sure</b> if you do not know yet; the record stays in your review list until you answer.</StepHead>
          <div style={{ marginLeft: 34 }}><QuestionGroups keys={keys} rel={rel} answers={answers} setAnswer={(k, v) => setAnswers({ ...answers, [k]: v })} ent={{ company: c }} readonly={ro} /></div>
        </section>
      </div>
      {!ro && <div className="modal-foot"><button className="btn primary" type="button" disabled={busy} onClick={save}>Save &amp; re-check applicability</button><span className="muted" style={{ fontSize: 12 }}>Saving works out which records apply and which still need a decision.</span></div>}
    </>
  );
}

/* ---------- project set-up ---------- */
const PROJECT_FIELDS = ['name', 'location', 'client', 'current_stage', 'project_manager', 'compliance_manager', 'rera_no', 'planning_authority', 'project_type', 'site_area_ha', 'built_up_area_sqm', 'contract_workers_count'];

function ProjectSetup({ id }) {
  const S = useStore();
  const ui = useUi();
  const { toast } = ui;
  const p = S.projects[id];
  const rel = p ? Core.relevantFlags(worldData(S), S.cat, { projectId: id }) : {};
  const keys = p ? scopeKeys(S, rel, 'project') : [];
  const [form, setForm] = useState(() => Object.fromEntries(PROJECT_FIELDS.map((k) => [k, p && p[k] != null ? String(p[k]) : ''])));
  const [answers, setAnswers] = useState(() => answersFrom(keys, p && p.facts));
  const [lifts, setLifts] = useState({});          // building id -> 'true' | 'false' | '' (only the ones changed here)
  const [ph, setPh] = useState({ name: '', rera: '' });
  const [bld, setBld] = useState({ name: '', phase: '', lift: '' });
  const [busy, setBusy] = useState(false);
  if (!p) return <ModalHead title="Project not found" />;

  const epc = categoryOf(p) === 'epc';
  const can = S.can('manage_setup'), ro = !can;
  const co = S.companies[p.company_id];
  const phases = Object.entries(S.phases).filter(([, x]) => x.project_id === id);
  const blds = Object.entries(S.buildings).filter(([, x]) => x.project_id === id);
  const un = unansweredFor(S, id);
  const review = buildInstances(S, { projectId: id }).inst.filter((i) => i.state === 'review');
  const coFlagsNeeded = Object.keys(rel).some((k) => S.cat.flags[k].scope === 'company');
  const steps = epc ? [
    ['Where the site is', !!p.location],
    ['Contract workers', p.contract_workers_count != null || un.proj.length === 0],
    ['Project questions', un.proj.length === 0],
    ['Company answers it depends on', !coFlagsNeeded || un.comp.length === 0],
    ['Nothing left to review', review.length === 0]
  ] : [
    ['Basics', !!(p.location || p.planning_authority) && !!p.project_type],
    ['Size', !!(p.site_area_ha || p.built_up_area_sqm)],
    ['Project questions', un.proj.length === 0],
    ['Phases', phases.length > 0],
    ['Buildings', blds.length > 0 && un.blds.length === 0],
    ['Company answers it depends on', !coFlagsNeeded || un.comp.length === 0],
    ['Nothing left to review', review.length === 0]
  ];
  let n = 0;
  const field = (label, k, extra = {}, hint) => (
    <div className="field"><label>{label}</label><input value={form[k]} disabled={ro} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} />{hint && <div className="fact-sub">{hint}</div>}</div>
  );
  const num = { type: 'number', min: '0' }, dec = { type: 'number', min: '0', step: 'any' };

  /** After a change: re-read the set-up, re-decide applicability, and say what came out. */
  const after = async (msg) => {
    await S.reload(['projects', 'phases', 'buildings']);
    const s = await S.regenerate({ projectId: id });
    toast((msg ? msg + ' ' : '') + summaryText(s));
  };
  const guard = (fn) => async () => { setBusy(true); try { await fn(); } catch (e) { toast('Failed: ' + e.message); } setBusy(false); };
  const v = (k) => form[k].trim();

  const save = guard(async () => {
    const next = { ...p, name: v('name') || p.name, location: v('location'), current_stage: v('current_stage'), project_manager: v('project_manager'), compliance_manager: v('compliance_manager'), facts: factsFrom(answers) };
    if (epc) { next.client = v('client'); next.contract_workers_count = numOrNull(v('contract_workers_count')); }
    else Object.assign(next, { rera_no: v('rera_no'), planning_authority: v('planning_authority'), project_type: v('project_type'), site_area_ha: numOrNull(v('site_area_ha')), built_up_area_sqm: numOrNull(v('built_up_area_sqm')), contract_workers_count: numOrNull(v('contract_workers_count')) });
    await api('PUT', '/api/projects/' + encodeURIComponent(id), next);
    for (const [bid, val] of Object.entries(lifts)) {          // building lift answers
      const b = S.buildings[bid]; if (!b) continue;
      if (val !== factVal(b.facts, 'has_lift')) { const facts = { ...(b.facts || {}) }; delete facts.has_lift; if (val !== '') facts.has_lift = val === 'true'; await api('PUT', '/api/buildings/' + encodeURIComponent(bid), { ...b, facts }); }
    }
    setLifts({});
    await after('Saved.');
  });
  const addPhase = guard(async () => {
    const name = ph.name.trim(); if (!name) { toast('Enter a phase name.'); return; }
    await api('PUT', '/api/phases/' + encodeURIComponent('ph_' + slug(name) + '_' + uid()), { project_id: id, name, rera_no: ph.rera.trim(), created_at: new Date().toISOString() });
    setPh({ name: '', rera: '' });
    await after('Phase added.');
  });
  const addBuilding = guard(async () => {
    const name = bld.name.trim(); if (!name) { toast('Enter a building name.'); return; }
    await api('PUT', '/api/buildings/' + encodeURIComponent('bld_' + slug(name) + '_' + uid()), { project_id: id, phase_id: bld.phase || (phases[0] && phases[0][0]) || null, name, facts: bld.lift === '' ? {} : { has_lift: bld.lift === 'true' }, created_at: new Date().toISOString() });
    setBld({ name: '', phase: bld.phase, lift: '' });
    await after('Building added.');
  });
  const remove = (col, label, rid) => guard(async () => {
    if (!window.confirm(`Remove this ${label}?`)) return;
    await api('DELETE', `/api/${col}/${encodeURIComponent(rid)}`);
    await after(label[0].toUpperCase() + label.slice(1) + ' removed.');
  });

  return (
    <>
      <ModalHead kicker="Project set-up" title={p.name} badges={<Badge cls="neutral">{epc ? 'EPC project' : 'Real estate project'}</Badge>} />
      <div className="modal-body">
        <ProgressBar done={steps.filter((s) => s[1]).length} total={steps.length} waiting={review.length} />
        {ro && <div className="readonly-note">Your role can view this set-up but not change it.</div>}
        {p.notes && <div className="readonly-note" style={{ borderLeft: '3px solid var(--warn)' }}>{p.notes}</div>}
        {epc && <div className="readonly-note">EPC projects track local-level <b>contract labour</b> and <b>IT</b> compliance only. That is why there are no phases, buildings or RERA questions here.</div>}

        <section className="step">{epc ? <>
          <StepHead n={++n} title="Where the site is" done={steps[0][1]}>Enter the site so the project can be told apart from others with a similar name.</StepHead>
          <div className="step-body setup-grid">
            {field('Project name', 'name')}
            {field('Site (city, state)', 'location', { placeholder: 'e.g. Satara, Maharashtra' })}
            {field('Client / owner (optional)', 'client', { placeholder: 'e.g. PWD' })}
            {field('Current work stage (optional)', 'current_stage')}
            {field('Project manager (optional)', 'project_manager')}
            {field('Compliance manager (optional)', 'compliance_manager')}
          </div>
        </> : <>
          <StepHead n={++n} title="Basics" done={steps[0][1]}>The essentials about the project.</StepHead>
          <div className="step-body setup-grid">
            {field('Project name', 'name')}
            {field('MahaRERA registration no.', 'rera_no', { placeholder: 'P5XXXX000XXXX' })}
            {field('Location (city, state)', 'location', { placeholder: 'e.g. Pune, Maharashtra' })}
            {field('Planning authority', 'planning_authority', { placeholder: 'e.g. Pune Municipal Corporation' })}
            <div className="field"><label>Project type</label><select value={form.project_type} disabled={ro} onChange={(e) => setForm({ ...form, project_type: e.target.value })}><option value="">Choose…</option>{PROJECT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
            {field('Current construction stage (optional)', 'current_stage')}
            {field('Project manager (optional)', 'project_manager')}
            {field('Compliance manager (optional)', 'compliance_manager')}
          </div>
        </>}</section>

        <section className="step">{epc ? <>
          <StepHead n={++n} title="Contract workers" done={steps[1][1]}>How many contract workers are engaged on this site? 20 or more triggers the principal-employer registration rules.</StepHead>
          <div className="step-body setup-grid">{field('Contract workers on site', 'contract_workers_count', num, 'You can leave this blank and answer the Yes / No question below instead.')}</div>
        </> : <>
          <StepHead n={++n} title="Size" done={steps[1][1]}>Areas are used to work out whether an Environmental Clearance is needed (20,000 sq m built-up or 50 ha site). Contract workers decide the labour-contractor rules.</StepHead>
          <div className="step-body setup-grid">
            {field('Site area (hectares)', 'site_area_ha', dec)}
            {field('Built-up area (sq m)', 'built_up_area_sqm', dec)}
            {field('Contract workers on site', 'contract_workers_count', num)}
          </div>
        </>}</section>

        <section className="step">
          <StepHead n={++n} title="Project questions" done={steps[2][1]}>Answer Yes or No. Each answer switches the related records on or off. <b>Not sure</b> keeps them in your review list.</StepHead>
          <div className="step-body"><QuestionGroups keys={keys} rel={rel} answers={answers} setAnswer={(k, val) => setAnswers({ ...answers, [k]: val })} ent={{ company: co, project: p }} readonly={ro} /></div>
        </section>

        {!epc && <section className="step">
          <StepHead n={++n} title="Phases" done={steps[3][1]}>Each phase is registered with RERA separately, so phase-level records are tracked once per phase.</StepHead>
          <div className="step-body">
            {phases.length ? phases.map(([pid, x]) => <div key={pid} className="setup-row"><span style={{ flex: 1 }}><b>{x.name}</b>{x.rera_no && <> <span className="mono muted">{x.rera_no}</span></>}</span>{can && <button className="btn sm" type="button" disabled={busy} onClick={remove('phases', 'phase', pid)}>Remove</button>}</div>)
              : <div className="muted">No phases yet.</div>}
            {can && <div className="setup-add">
              <input placeholder="Add a phase, e.g. Phase 2" value={ph.name} onChange={(e) => setPh({ ...ph, name: e.target.value })} />
              <input placeholder="RERA no. (optional)" value={ph.rera} onChange={(e) => setPh({ ...ph, rera: e.target.value })} />
              <button className="btn" type="button" disabled={busy} onClick={addPhase}>Add phase</button>
            </div>}
          </div>
        </section>}

        {!epc && <section className="step">
          <StepHead n={++n} title="Buildings" done={steps[4][1]}>Add each building or tower. Lift licences, fire NOC, plinth checking and occupancy certificate are tracked separately for every building.</StepHead>
          <div className="step-body">
            {blds.length ? blds.map(([bid, b]) => (
              <div key={bid} className="setup-row"><span style={{ flex: 1, minWidth: 120 }}><b>{b.name}</b> <span className="muted">· {(S.phases[b.phase_id] || {}).name || 'no phase'}</span></span>
                <span className="muted" style={{ fontSize: 12 }}>Has a lift?</span>
                <Seg value={lifts[bid] ?? factVal(b.facts, 'has_lift')} onChange={(val) => setLifts({ ...lifts, [bid]: val })} disabled={ro} />
                {can && <button className="btn sm" type="button" disabled={busy} onClick={remove('buildings', 'building', bid)}>Remove</button>}
              </div>
            )) : <div className="muted">No buildings yet. Until you add one, building-level records are not listed.</div>}
            {can && <div className="setup-add">
              <input placeholder="Building name, e.g. Tower A" value={bld.name} onChange={(e) => setBld({ ...bld, name: e.target.value })} />
              <select value={bld.phase || (phases[0] && phases[0][0]) || ''} onChange={(e) => setBld({ ...bld, phase: e.target.value })}>{phases.map(([pid, x]) => <option key={pid} value={pid}>{x.name}</option>)}</select>
              <Seg value={bld.lift} onChange={(val) => setBld({ ...bld, lift: val })} options={[['true', 'Lift'], ['false', 'No lift'], ['', 'Not sure']]} />
              <button className="btn" type="button" disabled={busy} onClick={addBuilding}>Add building</button>
            </div>}
          </div>
        </section>}

        <section className="step">
          <StepHead n={++n} title="Company answers it depends on" done={steps[epc ? 3 : 5][1]}>{coFlagsNeeded ? `Some records here also depend on company-wide answers (for example whether the company is covered by EPF${epc ? ' or processes personal data' : ''}).` : 'Nothing here depends on company-wide answers.'}</StepHead>
          {coFlagsNeeded && <div className="step-body">{un.comp.length ? <Chip cls="warn">{un.comp.length} company question{un.comp.length > 1 ? 's' : ''} open</Chip> : <Chip cls="ok">All answered</Chip>}{' '}
            <ActionLink onClick={() => openSetup(ui, 'company', theCompanyId(S))}>Open company set-up</ActionLink></div>}
        </section>

        <section className="step">
          <StepHead n={++n} title={`Waiting for review (${review.length})`} done={steps[steps.length - 1][1]}>{review.length ? 'These records are not confirmed as applicable yet. Answering the questions above settles most of them. You can also open one and decide it yourself.' : 'Every record for this project has a confirmed applicability.'}</StepHead>
          {review.length > 0 && <div className="step-body">
            {review.slice(0, 10).map((i) => <div key={i.key} className="setup-row clickable" onClick={() => ui.openModal(<RecordDrawer refKey={i.key} />)}><span className="mono" style={{ minWidth: 76 }}>{i.item.compliance_id}</span><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(i.item.brief_description || '').slice(0, 70)}{i.scopeShort && ' · ' + i.scopeShort}</span></div>)}
            {review.length > 10 && <div className="fact-sub">+{review.length - 10} more</div>}
          </div>}
        </section>
      </div>
      {can && <div className="modal-foot"><button className="btn primary" type="button" disabled={busy} onClick={save}>Save &amp; re-check applicability</button><span className="muted" style={{ fontSize: 12 }}>Saves every answer on this page, then works out which records apply.</span></div>}
    </>
  );
}
