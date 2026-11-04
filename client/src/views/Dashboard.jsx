// The dashboard: compliance intelligence for the portfolio, the company-wide view or one project.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useUi, ModalHead, Chip, Empty, Spinner, ActionLink, Fold } from '../ui/ui.jsx';
import { api, download } from '../lib/api.js';
import { ago, daysUntil, fmtDate, todayISO } from '../lib/format.js';
import { BAND_COLOR, DEADLINE_BUCKETS, DEDUCTION_TXT, LEVEL_CLS, LEVEL_TXT, LIVE_REC, PRIO_CLS, PRIO_TXT, PROJECT_CATS, REC_STATUS_TXT, RISK_KIND_TXT, STATUS_DEFS, STATUS_LIST } from '../lib/constants.js';
import { ctxName, ctxValue, effectiveStageId, projectsIn } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { NoContext } from './Stages.jsx';
import { openSetup } from './Setup.jsx';

const LvlChip = ({ l }) => <Chip cls={LEVEL_CLS[l]}>{LEVEL_TXT[l] || l}</Chip>;
const PrioChip = ({ p }) => <Chip cls={PRIO_CLS[p]}>{PRIO_TXT[p] || p}</Chip>;
const isLive = (r) => LIVE_REC.includes(r.status);
const bandOf = (n) => (n >= 90 ? 'Healthy' : n >= 75 ? 'Good' : n >= 60 ? 'Attention Required' : n >= 40 ? 'At Risk' : 'Critical Risk');

// The last loaded intelligence, kept between visits so coming back does not start from a spinner.
let cache = { key: null, data: null, recs: [], analysis: null, trend: null, portfolio: null, error: null, sig: '' };

/** Changes when the records behind the score change, so the dashboard refreshes quietly. */
function dataSig(S) {
  let last = ''; for (const t of Object.values(S.tracking)) if (t.updated_at && t.updated_at > last) last = t.updated_at;
  const docs = Object.values(S.docsByKey).reduce((n, a) => n + a.length + a.filter((d) => d.status !== 'Pending Verification').length, 0);
  return [Object.keys(S.tracking).length, last, Object.keys(S.applic).length, docs, Object.keys(S.risk || {}).length].join(':');
}

export default function Dashboard() {
  const S = useStore();
  const ui = useUi();
  const key = S.dashPortfolio ? 'portfolio' : (S.ctx.projectId || S.ctx.companyId || null);
  const [I, setI] = useState(cache);
  const [range, setRange] = useSticky('dash.trend', { days: 30, from: '', to: '' });
  const keyRef = useRef(key); keyRef.current = key;
  const sig = dataSig(S);

  /** Load (or refresh) everything the dashboard needs for the selected view. */
  const load = useCallback(async (k, quiet, r = range) => {
    if (!k) return;
    if (!quiet) setI((p) => ({ ...p, key: k, error: null }));
    const next = { ...cache, key: k, error: null, sig };
    try {
      if (k === 'portfolio') next.portfolio = await api('GET', '/api/intel/portfolio');
      else {
        const base = '/api/projects/' + encodeURIComponent(k);
        const tq = r.from || r.to ? `from=${r.from || ''}&to=${r.to || ''}` : `days=${r.days}`;
        const [data, recs, analysis, trend] = await Promise.all([api('GET', base + '/compliance-health'), api('GET', base + '/ai-recommendations?status=all'), api('GET', base + '/ai-analysis'), api('GET', base + '/compliance-health/trend?' + tq)]);
        Object.assign(next, { data, recs, analysis, trend });
      }
    } catch (e) { next.error = e.message || 'Could not load the project intelligence.'; }
    if (keyRef.current !== k) return;                     // the user switched view while this was loading
    cache = next; setI(next);
  }, [range, sig]);

  useEffect(() => { if (key && cache.key !== key) load(key, false); }, [key]); 
  useEffect(() => {                                       // data changed: refresh quietly
    if (!key || cache.key !== key || cache.sig === sig) return undefined;
    const t = setTimeout(() => load(key, true), 1800);
    return () => clearTimeout(t);
  }, [sig, key]); 

  const pick = (value) => { if (value === 'portfolio') S.setDashPortfolio(true); else { S.setDashPortfolio(false); S.setCtx(value); } };
  const [openFolds, setOpenFolds] = useSticky('dash.folds', () => new Set());
  const fold = (k, defaultOpen = false) => ({
    open: openFolds.has(k) || (defaultOpen && !openFolds.has(k + ':closed')),
    onToggle: (o) => setOpenFolds((prev) => { const n = new Set(prev); if (o) { n.add(k); n.delete(k + ':closed'); } else { n.delete(k); n.add(k + ':closed'); } return n; })
  });

  if (!S.cat) return null;
  const co = Object.keys(S.companies)[0];
  const head = (
    <div className="intel-top">
      <div><div className="section-title" style={{ margin: '0 0 4px' }}>Compliance intelligence</div><div className="muted" style={{ fontSize: 12.5 }}>Pick a view. Everything below updates for it.</div></div>
      <label className="intel-sel"><span>View</span>
        <select value={S.dashPortfolio ? 'portfolio' : ctxValue(S.ctx)} onChange={(e) => pick(e.target.value)}>
          <option value="portfolio">All projects (portfolio)</option>
          {co && <option value={'c:' + co}>Company-wide · {S.companies[co].name}</option>}
          {PROJECT_CATS.map(([cat, label]) => { const ids = projectsIn(S, cat); return ids.length ? <optgroup key={cat} label={label}>{ids.map((id) => <option key={id} value={'p:' + id}>{S.projects[id].name}</option>)}</optgroup> : null; })}
        </select></label>
    </div>
  );
  const loading = (txt) => <div className="card intel-card" style={{ textAlign: 'center', padding: 36, color: 'var(--text-muted)' }}><Spinner /> {txt}</div>;

  if (S.dashPortfolio) {
    return <>{head}{I.error && I.key === 'portfolio' ? <div className="banner bad">{I.error}</div> : !I.portfolio || I.key !== 'portfolio' ? loading('Calculating the portfolio…') : <Portfolio p={I.portfolio} pick={pick} />}</>;
  }
  if (!S.ctx.projectId && !S.ctx.companyId) return <>{head}<NoContext /></>;
  let intel;
  if (I.error && I.key === key) intel = <div className="banner bad">{I.error} <button className="btn sm" type="button" onClick={() => load(key, false)}>Try again</button></div>;
  else if (!I.data || I.key !== key || I.data.health.scope.id !== key) intel = loading('Calculating compliance health…');
  else intel = <Intel I={I} reload={() => load(key, true)} range={range} setRange={(r) => { setRange(r); load(key, true, r); }} fold={fold} />;
  return (
    <>
      {head}{intel}
      <Fold className="fold intel-fold" style={{ marginTop: 18 }} title="Detailed numbers" aside={<span className="muted" style={{ fontSize: 12 }}>status breakdown, stages, departments</span>} {...fold('detail')}>
        <DashboardDetail open={(k) => ui.openModal(<RecordDrawer refKey={k} />)} />
      </Fold>
    </>
  );
}

/* ---------- portfolio ---------- */
function Portfolio({ p, pick }) {
  const s = p.summary;
  const rows = p.rows.slice().sort((a, b) => (a.score == null ? 999 : a.score) - (b.score == null ? 999 : b.score));
  return (
    <>
      <div className="grid grid-stats" style={{ marginBottom: 16 }}>
        <div className="stat-tile"><div className="num">{s.projects}</div><div className="label">Projects</div></div>
        <div className="stat-tile"><div className="num" style={{ color: BAND_COLOR[s.average == null ? 'Not enough information' : bandOf(s.average)] }}>{s.average == null ? '—' : s.average}</div><div className="label">Average health score</div></div>
        <div className="stat-tile"><div className="num" style={{ color: 'var(--bad)' }}>{s.overdue}</div><div className="label">Overdue obligations</div></div>
        <div className="stat-tile"><div className="num" style={{ color: 'var(--bad)' }}>{s.critical}</div><div className="label">Critical issues</div></div>
        <div className="stat-tile"><div className="num" style={{ color: 'var(--hold)' }}>{s.blocked}</div><div className="label">Blocked records</div></div>
      </div>
      <div className="card intel-card" style={{ marginBottom: 14 }}><div className="h-dead"><b>Health bands:</b> {['Healthy', 'Good', 'Attention Required', 'At Risk', 'Critical Risk'].map((b) => <span key={b}><Chip style={{ border: `1px solid ${BAND_COLOR[b]}`, color: BAND_COLOR[b] }}>{b}: {s.bands[b] || 0}</Chip> </span>)}</div></div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}><table className="simple proj-table"><tbody>
        <tr><th>Project</th><th>Health</th><th>Overdue</th><th>Critical</th><th>Blocked</th><th>Current stage</th><th>Biggest issue</th><th>Open P1 / P2</th></tr>
        {rows.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => pick(r.type === 'project' ? 'p:' + r.id : 'c:' + r.id)}>
            <td><b>{r.name}</b><div className="fact-sub">{r.type === 'company' ? 'Company-wide' : (r.category === 'epc' ? 'EPC' : 'Real estate') + (r.location ? ' · ' + r.location : '')}</div></td>
            <td>{r.score == null ? <span className="muted">No data</span> : <><span className="score-pill" style={{ background: BAND_COLOR[r.band] }}>{r.score}</span> <span className="muted" style={{ fontSize: 11.5 }}>{r.band}</span></>}</td>
            <td className="mono" style={r.counts.overdue ? { color: 'var(--bad)' } : undefined}>{r.counts.overdue}</td><td className="mono" style={r.counts.critical ? { color: 'var(--bad)' } : undefined}>{r.counts.critical}</td><td className="mono">{r.counts.blocked}</td>
            <td className="muted">{r.currentStage ? r.currentStage.name.replace(/^Stage (\d+) – /, 'S$1 · ') : '—'}</td>
            <td className="muted" style={{ maxWidth: 260 }}>{r.topIssue ? <><span className="mono">{r.topIssue.complianceId}</span> {r.topIssue.reason.slice(0, 70)}</> : '—'}</td>
            <td className="mono">{r.openActions.P1 || 0} / {r.openActions.P2 || 0}</td>
          </tr>
        ))}
      </tbody></table></div>
      <div className="fact-sub" style={{ marginTop: 8 }}>Sorted with the lowest score first. Click a row to open that project. Scores are operational indicators calculated from each project’s own records; company-wide obligations are scored separately.</div>
    </>
  );
}

/* ---------- one project / company ---------- */
function autoSummary(d, recs) {
  const h = d.health, c = h.counts;
  if (h.score == null) return [['Insufficient information for reliable analysis.', 'No applicable compliance records are available for this view yet, so no health score can be calculated. Complete the project set-up so applicability can be decided.']];
  const top = h.cards[0], cs = h.currentStage;
  const act = (recs || []).filter(isLive).sort((a, b) => a.priority.localeCompare(b.priority))[0];
  const blocker = cs && cs.blockers && cs.blockers[0];
  return [
    ['Current health', `${h.category} (${h.score}/100).`],
    ['Key observation', c.overdue ? `${c.overdue} obligation${c.overdue > 1 ? 's are' : ' is'} overdue and ${c.completed} of ${c.applicable} applicable obligations are complete.` : `${c.completed} of ${c.applicable} applicable obligations are complete and none is overdue.`],
    ['Primary risk', top ? `${top.complianceId}${top.scopeShort ? ' (' + top.scopeShort + ')' : ''}: ${top.reason}` : 'No active risk was detected from the current data.'],
    ['Biggest blocker', blocker ? `${blocker.complianceId} — ${blocker.why}.` : 'No blocker detected.'],
    ['Stage needing attention', cs ? `${cs.name} (${cs.status}).` : 'All progression stages are complete.'],
    ['Recommended action', act ? act.recommended_action : 'No urgent action is needed right now.']
  ];
}

function Intel({ I, reload, range, setRange, fold }) {
  const S = useStore();
  const ui = useUi();
  const d = I.data, h = d.health;
  const open = (k) => ui.openModal(<RecordDrawer refKey={k} />);
  const riskKey = (cid) => { const r = h.included.find((x) => x.cid === cid); return r ? r.key : cid; };
  return (
    <>
      <ProjectInfo h={h} />
      <Health d={d} />
      <AiCard I={I} reload={reload} open={open} riskKey={riskKey} />
      <div className="intel-actions"><button className="btn" type="button" onClick={() => ui.openModal(<ReportModal I={I} />)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        Generate AI Project Health Report
      </button></div>
      <Risks h={h} recs={I.recs} open={open} fold={fold} />
      <Actions recs={I.recs} reload={reload} open={open} fold={fold} />
      <StageReadiness h={h} open={open} fold={fold} />
      <DocHealth h={h} open={open} fold={fold} />
      <Trend trend={I.trend} range={range} setRange={setRange} fold={fold} />
    </>
  );
}

function ProjectInfo({ h }) {
  const S = useStore();
  const ui = useUi();
  const s = h.scope;
  const f = (l, v) => <div className="pi" key={l}><div className="pi-l">{l}</div><div className="pi-v">{v || <span className="muted">Not set</span>}</div></div>;
  if (s.type === 'company') return <div className="card intel-card"><div className="pi-grid">{f('Company', s.companyName)}{f('Scope', 'Company-wide obligations (tracked once for the company)')}</div></div>;
  const cs = h.currentStage;
  return (
    <div className="card intel-card"><div className="pi-grid">
      {f('Company', s.companyName)}{f('Project', s.name)}{f('Location', s.location)}{f('Project type', s.category === 'epc' ? 'EPC project' : (s.projectType || ''))}
      {f('Phase', (s.phases || []).join(', '))}{f('Construction stage', s.constructionStage)}{f('Working compliance stage', cs ? cs.name : 'All stages completed')}
      {f('Project manager', s.projectManager)}{f('Compliance manager', s.complianceManager)}</div>
      {S.can('manage_setup') && <div className="fact-sub" style={{ marginTop: 6 }}><ActionLink onClick={() => openSetup(ui, 'project', s.id)}>Edit</ActionLink> the project details in set-up.</div>}
    </div>
  );
}

function Gauge({ score, cat }) {
  const r = 52, c = 2 * Math.PI * r, col = BAND_COLOR[cat] || 'var(--accent)', v = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <svg viewBox="0 0 130 130" className="gauge" role="img" aria-label={`Health score ${score == null ? 'not available' : score + ' out of 100'}`}>
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="13" />
      <circle cx="65" cy="65" r={r} fill="none" stroke={col} strokeWidth="13" strokeLinecap="round" strokeDasharray={`${(v / 100 * c).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 65 65)" />
      <text x="65" y="63" textAnchor="middle" className="g-num">{score == null ? '—' : score}</text><text x="65" y="84" textAnchor="middle" className="g-sub">out of 100</text>
    </svg>
  );
}

function Health({ d }) {
  const S = useStore();
  const ui = useUi();
  const h = d.health, c = h.counts, col = BAND_COLOR[h.category] || 'var(--text)', ch = d.change;
  const calc = () => ui.openModal(<CalcModal d={d} />);
  return (
    <div className="card intel-card health-card">
      <div className="health-main">
        <button className="gauge-btn" type="button" title="Click to see how this score is calculated" onClick={calc}><Gauge score={h.score} cat={h.category} /></button>
        <div className="health-txt">
          <div className="h-cat" style={{ color: col }}>{h.category}</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Compliance health score · an operational indicator, not a legal finding</div>
          <div style={{ fontSize: 13 }}>Previous score: <b>{d.previous ? d.previous.score : '—'}</b> · Change: {ch == null ? <span className="muted">No earlier score yet</span>
            : <><b style={{ color: ch > 0 ? 'var(--ok)' : ch < 0 ? 'var(--bad)' : 'var(--text-muted)' }}>{ch > 0 ? '▲ +' : ch < 0 ? '▼ ' : '● '}{ch}</b> since {fmtDate(d.previous.date)}</>}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>Last calculated {new Date(d.calculatedAt).toLocaleString()} · {c.applicable} applicable records</div>
          <button className="btn sm" type="button" style={{ marginTop: 8 }} onClick={calc}>How is this calculated?</button>
        </div>
      </div>
      <div className="h-tiles">
        <div className="h-tile"><b style={{ color: 'var(--bad)' }}>{c.critical}</b><span>Critical issues</span></div>
        <div className="h-tile"><b style={{ color: 'var(--warn)' }}>{c.high}</b><span>High-risk issues</span></div>
        <div className="h-tile"><b style={{ color: 'var(--bad)' }}>{c.overdue}</b><span>Overdue</span></div>
        <div className="h-tile"><b style={{ color: 'var(--ok)' }}>{c.completed}</b><span>Completed</span></div>
        <div className="h-tile"><b>{c.pending}</b><span>Pending</span></div>
        <div className="h-tile"><b style={{ color: 'var(--hold)' }}>{c.blocked}</b><span>Blocked</span></div>
      </div>
      <div className="h-dead"><b>Deadlines:</b> {DEADLINE_BUCKETS.map(([k, l]) => <span key={k}><Chip cls={h.buckets[k] ? 'warn' : ''}>{h.buckets[k]} in {l}</Chip> </span>)}</div>
      {h.scoreNote && <div className="readonly-note" style={{ marginTop: 10 }}>{h.scoreNote}</div>}
      {c.unclassifiedRisk > 0 && <div className="banner hold" style={{ marginTop: 10 }}><b>Risk classification pending validation</b> for {h.included.filter((r) => !r.classified).length} of {h.included.length} applicable records. They are scored at the “{h.settingsUsed.unclassified_level}” weight and are not counted as critical or high risks.{' '}
        {S.can('decide_applicability') ? <><ActionLink onClick={() => S.setView('settings')}>Review the suggested classifications</ActionLink>.</> : 'Ask a Compliance Manager to classify them.'}</div>}
    </div>
  );
}

function AiCard({ I, reload, open, riskKey }) {
  const S = useStore();
  const [analyzing, setAnalyzing] = useState(false);
  const [msg, setMsg] = useState(null);
  const d = I.data, a = I.analysis || {}, h = d.health, an = d.analysis || {}, res = a.latest && a.latest.result;
  const last = an.lastAttempt;
  const status = analyzing ? 'Analyzing…' : last ? (last.status === 'ok' ? 'Completed' : last.status === 'ai_unavailable' ? 'AI unavailable' : 'Answer discarded') : 'Not run yet';
  const activeRecs = I.recs.filter(isLive).length;
  const run = async () => {
    if (analyzing) return; setAnalyzing(true); setMsg(null);
    try {
      const r = await api('POST', '/api/projects/' + encodeURIComponent(I.key) + '/ai-analysis/refresh', {});
      setMsg(r.cached ? { cls: 'muted', text: r.message } : r.aiError ? { cls: 'hold', text: r.aiError }
        : { cls: 'ok', text: `Analysis complete. ${r.analysis.result ? r.analysis.result.recommendations.length + ' extra AI suggestion(s) added.' : ''} ${(r.validation || []).length ? (r.validation.length + ' AI item(s) were set aside because they did not match your records.') : ''}`.trim() });
    } catch (e) { setMsg({ cls: 'bad', text: e.message }); }
    setAnalyzing(false); await reload();
  };
  return (
    <div className="card intel-card">
      <div className="ai-head"><h3>AI Project Health Analysis</h3>
        <button className="btn primary" type="button" disabled={!S.can('edit_tracking') || analyzing} onClick={run}>{analyzing ? <><Spinner /> Analyzing…</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: -1 }}><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg> Analyze Project with AI</>}</button></div>
      <div className="ai-meta">
        <span><b>Last analysis:</b> {a.latest ? ago(a.latest.analysed_at) : '—'}</span><span><b>Status:</b> {status}</span>
        <span><b>Risks identified:</b> {h.counts.critical + h.counts.high + h.counts.medium + h.counts.low + h.counts.unclassifiedRisk} ({h.counts.critical} critical, {h.counts.high} high)</span><span><b>Recommendations:</b> {activeRecs}</span>
        <span><b>Data:</b> {a.latest ? (an.lastOk && an.lastOk.fresh ? <span style={{ color: 'var(--ok)' }}>Up to date</span> : <span style={{ color: 'var(--warn)' }}>Changed since the analysis</span>) : '—'}</span>
      </div>
      {msg && <div className={'banner ' + msg.cls} style={{ margin: '8px 0' }}>{msg.text}</div>}
      {last && last.status !== 'ok' && !msg && <div className="banner muted" style={{ margin: '8px 0' }}>{last.error || 'The last AI analysis did not complete.'} The score and recommendations below come from your records and are still current.</div>}
      {res ? <>
        <div className="ai-sec"><div className="ai-l">Summary</div><p>{res.projectSummary}</p></div>
        {res.healthExplanation && <div className="ai-sec"><div className="ai-l">Why this score</div><p>{res.healthExplanation}</p></div>}
        {(res.criticalRisks.length > 0 || res.highRisks.length > 0) && <div className="ai-sec"><div className="ai-l">Main risks (AI view, checked against the data)</div><ul>
          {[...res.criticalRisks.map((x) => ['Critical', x]), ...res.highRisks.map((x) => ['High', x])].map(([l, x], i) => <li key={i}><b>{l}:</b> {x.complianceId && <><ActionLink className="mono" onClick={() => open(riskKey(x.complianceId))}>{x.complianceId}</ActionLink> — </>}{x.title}{x.reason && '. ' + x.reason}</li>)}</ul></div>}
        {res.stageReadiness.length > 0 && <div className="ai-sec"><div className="ai-l">Stage comments</div><ul>{res.stageReadiness.map((x, i) => <li key={i}><b>{x.stage || ''}</b>{x.status && ' — ' + x.status}{x.comment && ': ' + x.comment}</li>)}</ul></div>}
        {res.dataLimitations.length > 0 && <div className="ai-sec"><div className="ai-l">Data limitations</div><ul>{res.dataLimitations.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        <div className="fact-sub">Written by {a.latest.model || 'the AI'} from this project's records only. Treat it as guidance: legal validation is still required.</div>
      </> : (
        <div className="ai-sec"><div className="ai-l">Automatic summary <Chip>from your records, no AI run yet</Chip></div>
          <dl className="glance">{autoSummary(d, I.recs).map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{v}</dd></div>)}</dl>
          <div className="fact-sub" style={{ marginTop: 8 }}>{an.aiConfigured ? 'Click “Analyze Project with AI” for a written analysis.' : 'The AI is not set up on the server, so only this automatic summary is available.'}</div></div>
      )}
    </div>
  );
}

const RISK_TABS = ['critical', 'high', 'medium', 'low', 'pending'];
function Risks({ h, recs, open, fold }) {
  const [tab, setTab] = useSticky('dash.riskTab', 'critical');
  const [more, setMore] = useState(false);
  const cards = h.cards;
  const counts = Object.fromEntries(RISK_TABS.map((t) => [t, cards.filter((c) => c.level === t).length]));
  const cur = !counts[tab] && RISK_TABS.some((t) => counts[t]) ? RISK_TABS.find((t) => counts[t]) : tab;
  const list = cards.filter((c) => c.level === cur), shown = more ? list : list.slice(0, 6);
  return (
    <Fold className="fold intel-fold" title="AI Compliance Risk Analysis" aside={<Chip cls={counts.critical ? 'bad' : ''}>{cards.length} risk{cards.length === 1 ? '' : 's'}</Chip>} {...fold('risks', !!(counts.critical || counts.high))}>
      <div className="tabs-row">{RISK_TABS.map((t) => <button key={t} className={'tabbtn' + (cur === t ? ' on' : '')} type="button" onClick={() => { setTab(t); setMore(false); }}>{LEVEL_TXT[t]} <b>{counts[t]}</b></button>)}</div>
      {list.length ? <>
        <div className="risk-grid">{shown.map((c) => {
          const rec = recs.find((r) => r.compliance_key === c.key && r.source === 'rules');
          return (
            <div key={c.key + c.kind} className={'risk-card ' + c.level} onClick={() => open(c.key)}>
              <div className="rc-top"><span className="mono rc-id">{c.complianceId}</span><LvlChip l={c.level} /><Chip>{RISK_KIND_TXT[c.kind] || c.kind}</Chip>
                {rec && <Chip cls={rec.status === 'accepted' ? 'ok' : ''}>Action: {REC_STATUS_TXT[rec.status] || rec.status}</Chip>}</div>
              <div className="rc-title">{c.title}</div>
              <div className="rc-reason">{c.reason}</div>
              <div className="rc-meta"><span>{c.scope}</span><span>Stage {(c.stage || '').replace('S', '')}</span><span>Due {c.dueDate ? fmtDate(c.dueDate) : '—'}</span><span>Owner {c.owner || 'Unassigned'}</span></div>
              {rec && <div className="rc-act"><b>Do next:</b> {rec.recommended_action}</div>}
              <details className="rc-ev" onClick={(e) => e.stopPropagation()}><summary>Supporting evidence</summary><ul>{c.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
              {c.level === 'pending' && <div className="fact-sub">Risk Classification Pending Validation — set a level in the record’s “More details”.</div>}
            </div>
          );
        })}</div>
        {list.length > 6 && <button className="btn sm" type="button" style={{ marginTop: 10 }} onClick={() => setMore(!more)}>{more ? 'Show fewer' : 'Show all ' + list.length}</button>}
      </> : <Empty style={{ padding: 22 }}>{cards.length ? 'No risks at this level.' : 'No risks were detected from the current records.'}</Empty>}
      <div className="fact-sub" style={{ marginTop: 8 }}>Risk levels come from the classification set for each record, not from its description. A record without a classification shows “Classification pending” and is never called critical or high.</div>
    </Fold>
  );
}

/* ---------- recommended actions (action center) ---------- */
function Actions({ recs, reload, open, fold }) {
  const S = useStore();
  const ui = useUi();
  const [f, setF] = useSticky('dash.recFilter', { status: 'active', priority: '', category: '' });
  const [expanded, setExpanded] = useState(() => new Set());
  const [more, setMore] = useState(false);
  const list = recs.filter((r) => (f.status === 'active' ? isLive(r) : f.status === 'all' ? true : r.status === f.status) && (!f.priority || r.priority === f.priority) && (!f.category || r.category === f.category));
  const cats = [...new Set(recs.map((r) => r.category))];
  const shown = more ? list : list.slice(0, 10);
  const live = recs.filter(isLive), p = (n) => live.filter((r) => r.priority === n).length;
  const mg = S.can('manage_actions');

  const act = async (id, body) => {
    try {
      await api('PATCH', '/api/ai-recommendations/' + encodeURIComponent(id), body);
      ui.toast(({ accept: 'Accepted and attached to the record.', assign: 'Assigned.', reject: 'Dismissed.', snooze: 'Snoozed.', complete: 'Marked completed. If the issue is still detected it will reopen.', request_review: 'Review requested.', reopen: 'Reopened.' })[body.action] || 'Saved.');
      await reload();
    } catch (e) { ui.toast(e.message, 6000); }
  };
  const onAct = (rec, a) => {
    if (a === 'accept' || a === 'assign') return ui.openModal(<RecDialog rec={rec} mode={a} act={act} />);
    if (a === 'reject') { const why = window.prompt('Why are you dismissing this recommendation? (required)'); if (!why || !why.trim()) return; return act(rec.id, { action: 'reject', note: why.trim() }); }
    if (a === 'snooze') { const n = window.prompt('Snooze for how many days? (1 to 90)', '7'); if (!n) return; return act(rec.id, { action: 'snooze', days: n }); }
    if (a === 'request_review') { const n = window.prompt('Anything the reviewer should know? (optional)', ''); if (n === null) return; return act(rec.id, { action: 'request_review', note: n }); }
    if (a === 'complete' && !window.confirm('Mark this action as completed? If the issue is still detected it will reopen.')) return;
    return act(rec.id, { action: a });
  };
  const sel = (k, label, opts) => <label>{label}<select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;

  return (
    <Fold className="fold intel-fold" title="AI Compliance Action Center" aside={<span>{['P1', 'P2', 'P3', 'P4'].map((k) => <span key={k}><Chip cls={p(k) ? PRIO_CLS[k] : ''}>{k} {p(k)}</Chip> </span>)}</span>} {...fold('actions', true)}>
      <div className="filters" style={{ marginBottom: 10 }}>
        {sel('status', 'Show', [['active', 'Active'], ['snoozed', 'Snoozed'], ['rejected', 'Dismissed'], ['completed', 'Completed'], ['resolved', 'Resolved automatically'], ['all', 'Everything']])}
        {sel('priority', 'Priority', [['', 'All'], ...['P1', 'P2', 'P3', 'P4'].map((v) => [v, v])])}
        {sel('category', 'Category', [['', 'All'], ...cats.map((v) => [v, v])])}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12, alignSelf: 'center' }}>{list.length} shown</span>
      </div>
      {list.length ? <>
        <div className="rec-list">{shown.map((r) => {
          const ex = expanded.has(r.id), lv = isLive(r), key = r.compliance_key;
          const btn = (a, label, cls = '') => <button className={'btn sm ' + cls} type="button" onClick={() => onAct(r, a)}>{label}</button>;
          return (
            <div key={r.id} className={'rec-row' + (ex ? ' open' : '')}>
              <div className="rec-main">
                <div className="rec-pri"><PrioChip p={r.priority} />{r.source === 'ai' && <div className="fact-sub">AI-suggested</div>}</div>
                <div className="rec-body"><div className="rec-title">{r.title}</div>
                  <div className="rec-sub">{r.reason || r.explanation || ''}</div>
                  <div className="rec-meta"><span>{r.category}</span>{r.compliance_id && <span className="mono">{r.compliance_id}</span>}<span>Owner: {r.assigned_owner || r.suggested_owner || '—'}</span><span>Due: {r.assigned_due || r.due_date ? fmtDate(r.assigned_due || r.due_date) : '—'}</span></div></div>
                <div className="rec-st"><Chip cls={r.status === 'accepted' ? 'ok' : r.status === 'open' ? 'warn' : ''}>{REC_STATUS_TXT[r.status] || r.status}</Chip>{r.snooze_until && r.status === 'snoozed' && <div className="fact-sub">until {fmtDate(r.snooze_until)}</div>}</div>
              </div>
              <div className="rec-actions">
                <button className="btn sm" type="button" onClick={() => setExpanded((prev) => { const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}>{ex ? 'Hide details' : 'Details'}</button>
                {key && <button className="btn sm" type="button" onClick={() => open(key)}>Open compliance</button>}
                {mg && lv && r.status !== 'accepted' && btn('accept', 'Accept', 'primary')}
                {mg && lv && btn('assign', 'Assign')}
                {mg && r.status === 'accepted' && btn('complete', 'Mark completed')}
                {mg && lv && btn('snooze', 'Snooze')}
                {mg && lv && btn('reject', 'Dismiss')}
                {S.can('edit_tracking') && lv && r.status !== 'review_requested' && btn('request_review', 'Request review')}
                {mg && ['rejected', 'snoozed', 'completed', 'resolved'].includes(r.status) && btn('reopen', 'Reopen')}
              </div>
              {ex && <div className="rec-detail"><dl className="glance">
                {r.priority_reason && <div><dt>Why this priority</dt><dd>{r.priority_reason}</dd></div>}
                <div><dt>Recommended action</dt><dd>{r.recommended_action || '—'}</dd></div>
                <div><dt>Responsible department</dt><dd>{r.responsible_department || '—'}</dd></div>
                {r.stage_name && <div><dt>Stage</dt><dd>{r.stage_name}</dd></div>}
                {(r.required_documents || []).length > 0 && <div><dt>Documents</dt><dd>{r.required_documents.join(', ')}</dd></div>}
                <div><dt>Expected outcome</dt><dd>{r.expected_outcome || '—'}</dd></div>
                {(r.evidence || []).length > 0 && <div><dt>Evidence</dt><dd>{r.evidence.join(' · ')}</dd></div>}
                <div><dt>Source</dt><dd>{(r.source_refs || []).filter((s) => s.id).map((s) => s.id).join(', ') || '—'} · recommendation {r.id}</dd></div>
                {r.reject_reason && <div><dt>Dismissed because</dt><dd>{r.reject_reason}</dd></div>}
                {r.task && r.task.key && <div><dt>Linked task</dt><dd>Attached to the compliance record (open it to see the action).</dd></div>}
              </dl></div>}
            </div>
          );
        })}</div>
        {list.length > 10 && <button className="btn sm" type="button" style={{ marginTop: 10 }} onClick={() => setMore(!more)}>{more ? 'Show fewer' : 'Show all ' + list.length}</button>}
      </> : <Empty style={{ padding: 22 }}>{recs.length ? 'Nothing matches these filters.' : 'No actions are recommended. Nothing in the current records needs attention.'}</Empty>}
      <div className="fact-sub" style={{ marginTop: 8 }}>Accepting an action attaches it to the compliance record. It does not change the record’s status or approve anything. Priorities are explained under “Details”.</div>
    </Fold>
  );
}

function RecDialog({ rec, mode, act }) {
  const ui = useUi();
  const [owner, setOwner] = useState(rec.assigned_owner || (/^Unassigned|^Approver:/.test(rec.suggested_owner || '') ? '' : rec.suggested_owner || ''));
  const [due, setDue] = useState(rec.assigned_due || rec.due_date || '');
  const go = async () => {
    if (mode === 'assign' && !owner.trim()) { ui.toast('Enter who it is assigned to.'); return; }
    ui.closeModal(); await act(rec.id, { action: mode === 'assign' ? 'assign' : 'accept', owner: owner.trim(), due_date: due || undefined });
  };
  return (
    <>
      <ModalHead kicker={mode === 'assign' ? 'Assign action' : 'Accept action'} title={rec.title} badges={<PrioChip p={rec.priority} />} />
      <div className="modal-body modal-stack"><section className="panel"><div className="prose" style={{ fontSize: 13.5 }}>{rec.recommended_action || ''}</div></section>
        <section className="panel"><div className="setup-grid">
          <div className="field"><label>Assign to</label><input value={owner} placeholder="Person or team" onChange={(e) => setOwner(e.target.value)} /></div>
          <div className="field"><label>Do it by</label><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div></div>
          {mode !== 'assign' && rec.compliance_key && <div className="fact-sub">Accepting attaches this action to the compliance record. The record’s status is not changed.</div>}</section></div>
      <div className="modal-foot"><button className="btn primary" type="button" onClick={go}>{mode === 'assign' ? 'Save assignment' : 'Accept'}</button></div>
    </>
  );
}

/* ---------- stage readiness ---------- */
const STAGE_CLS = { Completed: 'ok', 'Ready': 'ok', 'Ready with Attention': 'warn', 'In Progress': 'warn', Blocked: 'bad', 'Not Started': '', 'Not Applicable': '' };
function StageReadiness({ h, open, fold }) {
  const st = h.stages.filter((s) => s.id !== 'S0' && s.status !== 'Not Applicable');
  const cur = h.currentStage, nxt = h.nextStage, short = (n) => n.replace(/ – .*/, '');
  return (
    <Fold className="fold intel-fold" title="Stage readiness" aside={<Chip cls={cur && cur.status === 'Blocked' ? 'bad' : ''}>{cur ? short(cur.name) + ' · ' + cur.status : 'All stages complete'}</Chip>} {...fold('stages')}>
      <div className="stage-flow"><div><div className="pi-l">Current stage</div><div className="pi-v">{cur ? cur.name : 'All progression stages completed'}</div></div>
        <div><div className="pi-l">Next stage</div><div className="pi-v">{nxt ? nxt.name + ' — ' + nxt.status : '—'}</div></div></div>
      {cur && cur.status !== 'Completed' && <div className={'banner ' + (cur.status === 'Blocked' ? 'bad' : 'hold')} style={{ margin: '8px 0' }}><b>{short(cur.name)} is not ready to move on.</b>{' '}
        {cur.blockers.length ? <>Clear: {cur.blockers.slice(0, 4).map((b, i) => <span key={b.key}>{i > 0 && ', '}<ActionLink className="mono" onClick={() => open(b.key)}>{b.complianceId}</ActionLink> ({b.why})</span>)}.</> : 'Complete the remaining mandatory records.'} A person must confirm before the stage changes; the system never moves it on by itself.</div>}
      <div style={{ overflowX: 'auto' }}><table className="simple stg-table"><tbody>
        <tr><th>Stage</th><th>Status</th><th>Readiness</th><th>Mandatory</th><th>Done</th><th>Overdue</th><th>Blocked</th><th>Docs missing</th><th>N/A</th></tr>
        {st.map((s) => (
          <tr key={s.id} className={s.id === (cur && cur.id) ? 'cur' : ''}>
            <td><b>{s.name.replace(/^Stage \d+ – /, '')}</b><div className="fact-sub">Stage {s.order}{s.id === (cur && cur.id) && ' · current'}</div></td>
            <td><Chip cls={STAGE_CLS[s.status] || ''}>{s.status}</Chip></td>
            <td style={{ minWidth: 110 }}>{s.readinessPct == null ? '—' : <><div className="bar-track"><div className="bar-seg" style={{ width: s.readinessPct + '%', background: 'var(--grad)' }} /></div><span className="mono" style={{ fontSize: 11 }}>{s.readinessPct}%</span></>}</td>
            <td className="mono">{s.mandatory}</td><td className="mono">{s.completed}</td><td className="mono" style={s.overdue ? { color: 'var(--bad)' } : undefined}>{s.overdue}</td><td className="mono" style={s.blocked ? { color: 'var(--hold)' } : undefined}>{s.blocked}</td><td className="mono">{s.docsMissing}</td><td className="mono">{s.notApplicable}</td>
          </tr>
        ))}
      </tbody></table></div>
      <div className="fact-sub" style={{ marginTop: 6 }}>Only mandatory records count (anything classified Low is treated as optional). Not Applicable records are left out. “Ready” means the earlier stages are complete and nothing is wrong, so work can start.</div>
    </Fold>
  );
}

/* ---------- documents ---------- */
function DocHealth({ h, open, fold }) {
  const [more, setMore] = useState(false);
  const x = h.documents, issues = x.issues, shown = more ? issues : issues.slice(0, 12);
  const tile = (n, l, c) => <div className="h-tile" key={l}><b style={c ? { color: c } : undefined}>{n}</b><span>{l}</span></div>;
  return (
    <Fold className="fold intel-fold" title="Document health" aside={<Chip cls={x.missing + x.expired + x.rejected ? 'warn' : ''}>{x.missing} missing · {x.expired} expired · {x.rejected} rejected</Chip>} {...fold('docs')}>
      <div className="h-tiles">{tile(x.required, 'Required')}{tile(x.uploaded, 'Uploaded')}{tile(x.verified, 'Verified', 'var(--ok)')}{tile(x.missing, 'Missing', 'var(--warn)')}{tile(x.pending, 'Awaiting verification', 'var(--warn)')}{tile(x.rejected, 'Rejected', 'var(--bad)')}{tile(x.expired, 'Expired', 'var(--bad)')}{tile(x.expiring, 'Expiring in 30 days', 'var(--warn)')}</div>
      {issues.length ? <>
        <div style={{ overflowX: 'auto', marginTop: 10 }}><table className="simple"><tbody><tr><th>Record</th><th>Document</th><th>Issue</th><th /></tr>
          {shown.map((i, n) => <tr key={n} className="clickable" onClick={() => open(i.key)}><td className="mono">{i.complianceId}{i.scope && ' · ' + i.scope}</td><td>{i.document}</td><td><Chip cls={['Rejected', 'Expired'].includes(i.issue) ? 'bad' : 'warn'}>{i.issue}{i.date && ' ' + fmtDate(i.date)}</Chip></td><td className="muted">{i.note || ''}</td></tr>)}
        </tbody></table></div>
        {issues.length > 12 && <button className="btn sm" type="button" style={{ marginTop: 8 }} onClick={() => setMore(!more)}>{more ? 'Show fewer' : 'Show all ' + issues.length}</button>}
      </> : <Empty style={{ padding: 18 }}>No document issues.</Empty>}
      <div className="fact-sub" style={{ marginTop: 6 }}>A document is only “missing” here once work has started or a deadline is near. Document contents are never sent to the AI; it sees only counts and names.</div>
    </Fold>
  );
}

/* ---------- trend ---------- */
function LineChart({ points, series, min: minIn, max: maxIn }) {
  const W = 360, H = 120, pad = { l: 30, r: 8, t: 8, b: 20 };
  if (points.length < 2) return null;
  const xs = (i) => pad.l + (W - pad.l - pad.r) * (i / (points.length - 1));
  const all = series.flatMap((s) => points.map((p) => s.f(p)));
  const min = minIn != null ? minIn : Math.min(0, ...all), max = maxIn != null ? maxIn : Math.max(1, ...all);
  const ys = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / ((max - min) || 1));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      <line x1={pad.l} y1={ys(min)} x2={W - pad.r} y2={ys(min)} stroke="var(--border)" />
      <line x1={pad.l} y1={ys(max)} x2={W - pad.r} y2={ys(max)} stroke="var(--border)" strokeDasharray="3 3" />
      <text x="2" y={ys(max) + 4} className="ax">{max}</text><text x="2" y={ys(min) + 4} className="ax">{min}</text>
      <text x={pad.l} y={H - 5} className="ax">{fmtDate(points[0].date)}</text><text x={W - pad.r} y={H - 5} textAnchor="end" className="ax">{fmtDate(points[points.length - 1].date)}</text>
      {series.map((s, si) => <g key={si}>
        <polyline fill="none" stroke={s.color} strokeWidth="2" points={points.map((p, i) => xs(i).toFixed(1) + ',' + ys(s.f(p)).toFixed(1)).join(' ')} />
        {points.map((p, i) => <circle key={i} cx={xs(i).toFixed(1)} cy={ys(s.f(p)).toFixed(1)} r="2.2" fill={s.color}><title>{p.date}: {s.f(p)}</title></circle>)}
      </g>)}
    </svg>
  );
}
function Trend({ trend, range, setRange, fold }) {
  const { toast } = useUi();
  const [from, setFrom] = useState(range.from), [to, setTo] = useState(range.to);
  const pts = (trend && trend.points) || [];
  return (
    <Fold className="fold intel-fold" title="Compliance health trend" aside={<Chip>{pts.length} snapshot{pts.length === 1 ? '' : 's'}</Chip>} {...fold('trend')}>
      <div className="tabs-row">
        {[7, 30, 90].map((n) => <button key={n} className={'tabbtn' + (!range.from && !range.to && range.days === n ? ' on' : '')} type="button" onClick={() => { setFrom(''); setTo(''); setRange({ days: n, from: '', to: '' }); }}>{n} days</button>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>or</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn sm" type="button" onClick={() => { if (!from && !to) { toast('Choose a start or end date.'); return; } setRange({ ...range, from, to }); }}>Apply dates</button>
      </div>
      {pts.length >= 2 ? <div className="chart-grid">
        <div className="chart-card"><div className="ch-t">Health score</div><LineChart points={pts} series={[{ f: (p) => p.score, color: 'var(--accent)' }]} min={0} max={100} /></div>
        <div className="chart-card"><div className="ch-t">Overdue <span className="dot" style={{ background: 'var(--bad)' }} /> and critical <span className="dot" style={{ background: 'var(--hold)' }} /></div><LineChart points={pts} series={[{ f: (p) => p.counts.overdue, color: 'var(--bad)' }, { f: (p) => p.counts.critical, color: 'var(--hold)' }]} min={0} /></div>
        <div className="chart-card"><div className="ch-t">Completed obligations</div><LineChart points={pts} series={[{ f: (p) => p.counts.completed, color: 'var(--ok)' }]} min={0} /></div>
        <div className="chart-card"><div className="ch-t">Stages completed</div><LineChart points={pts} series={[{ f: (p) => (p.stages || []).filter((s) => s.status === 'Completed').length, color: '#3b9b6e' }]} min={0} /></div>
      </div> : <Empty style={{ padding: 24 }}>{(trend && trend.note) || 'Historical compliance health data is not available yet.'}<div className="fact-sub" style={{ marginTop: 6 }}>Score snapshots are saved automatically from the day this feature was switched on. {pts.length > 0 && `1 snapshot so far (${fmtDate(pts[0].date)}).`}</div></Empty>}
    </Fold>
  );
}

/* ---------- score explanation ---------- */
function CalcModal({ d }) {
  const S = useStore();
  const ui = useUi();
  const h = d.health, u = h.settingsUsed;
  const incl = h.included.slice().sort((a, b) => b.outstanding - a.outstanding);
  const open = (k) => ui.openModal(<RecordDrawer refKey={k} />);
  const row = (a, b) => <tr key={String(a)}><td>{a}</td><td className="mono">{b}</td></tr>;
  return (
    <>
      <ModalHead kicker="Score calculation" title={`${h.scope.name} — ${h.score == null ? 'no score' : h.score + ' / 100 · ' + h.category}`} />
      <div className="modal-body modal-stack">
        <section className="panel"><h4>How the score is worked out</h4>
          <div className="prose" style={{ fontSize: 13.5 }}><ol style={{ margin: '0 0 0 18px', padding: 0, lineHeight: 1.7 }}>
            <li>Every <b>applicable</b> record gets a <b>risk weight</b> from its classification (Critical {u.weights.critical}, High {u.weights.high}, Medium {u.weights.medium}, Low {u.weights.low}). Unclassified records use the “{u.unclassified_level}” weight.</li>
            <li>Each record’s <b>outstanding risk</b> = weight × a factor for its status (below). Completed and verified = 0.</li>
            <li><b>Risk percentage</b> = outstanding risk ÷ total applicable risk × 100. <b>Base health</b> = 100 − risk percentage.</li>
            <li>Then <b>deductions</b> are subtracted for the serious problems listed below. One record can cause at most one deduction, and each kind has a cap.</li>
            <li>The result is kept between 0 and 100.</li></ol></div></section>
        <section className="panel"><h4>This project’s numbers</h4><table className="simple"><tbody>
          {row('Total applicable risk', h.totalRisk)}{row('Outstanding risk', h.outstandingRisk)}{row('Risk percentage', h.riskPct == null ? '—' : h.riskPct + '%')}{row('Base health', h.base == null ? '—' : h.base)}{row('Deductions', '− ' + h.deductionTotal)}
          <tr><td><b>Final score</b></td><td className="mono"><b>{h.score == null ? '—' : h.score}</b></td></tr></tbody></table></section>
        <section className="panel"><h4>Additional deductions</h4>{h.deductions.length ? <table className="simple"><tbody><tr><th>Reason</th><th>Records</th><th>Points</th></tr>
          {h.deductions.map((x) => <tr key={x.kind}><td>{DEDUCTION_TXT[x.kind] || x.kind}<div className="fact-sub">{x.items.slice(0, 4).map((i, n) => <div key={n}>{i.cid}: {i.reason}</div>)}</div></td><td className="mono">{x.count}</td><td className="mono">{x.points}{x.capped && ` (capped at ${x.cap})`}</td></tr>)}
        </tbody></table> : <div className="muted" style={{ fontSize: 13 }}>No additional deductions apply.</div>}</section>
        <Fold title="Weights, factors and bands used">
          <table className="simple"><tbody><tr><th>Status</th><th>Outstanding factor</th></tr>{Object.entries(u.factors).map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td className="mono">{v}</td></tr>)}</tbody></table>
          <table className="simple" style={{ marginTop: 10 }}><tbody><tr><th>Band</th><th>From score</th></tr><tr><td>Healthy</td><td className="mono">{u.bands.healthy}</td></tr><tr><td>Good</td><td className="mono">{u.bands.good}</td></tr><tr><td>Attention Required</td><td className="mono">{u.bands.attention}</td></tr><tr><td>At Risk</td><td className="mono">{u.bands.at_risk}</td></tr><tr><td>Critical Risk</td><td className="mono">below {u.bands.at_risk}</td></tr></tbody></table>
          {S.can('manage_settings') && <div style={{ marginTop: 10 }}><ActionLink onClick={() => { ui.closeModal(); S.setView('settings'); }}>Change these in Settings</ActionLink></div>}
        </Fold>
        <Fold title={`Records included (${incl.length})`} bodyStyle={{ maxHeight: 340, overflow: 'auto' }}><table className="simple"><tbody><tr><th>Record</th><th>Risk level</th><th>Weight</th><th>Status</th><th>Factor</th><th>Outstanding</th></tr>
          {incl.map((r) => <tr key={r.key} className="clickable" onClick={() => open(r.key)}><td className="mono">{r.cid}{r.scope && ' · ' + r.scope}<div className="fact-sub">{r.title}</div></td><td>{r.classified ? LEVEL_TXT[r.level] : <span className="muted">Pending validation</span>}</td><td className="mono">{r.weight}</td><td>{r.status}</td><td className="mono">{r.factor}</td><td className="mono">{r.outstanding}</td></tr>)}
        </tbody></table></Fold>
        <Fold title={`Records left out (${h.excluded.length})`} bodyStyle={{ maxHeight: 300, overflow: 'auto' }}><table className="simple"><tbody><tr><th>Record</th><th>Why it is excluded</th></tr>
          {h.excluded.length ? h.excluded.map((r, i) => <tr key={i}><td className="mono">{r.cid}{r.scope && ' · ' + r.scope}</td><td>{r.reason}<div className="fact-sub">{r.detail}</div></td></tr>) : <tr><td colSpan={2} className="muted">None</td></tr>}
        </tbody></table></Fold>
        <section className="panel"><h4>What this score does not know</h4><ul style={{ margin: '0 0 0 18px', fontSize: 13, lineHeight: 1.6 }}>{h.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul></section>
      </div>
    </>
  );
}

/* ---------- report ---------- */
const REPORT_CSS = 'body{font-family:Arial,Helvetica,sans-serif;color:#192230;margin:24px;font-size:12px;line-height:1.45}h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:20px 0 6px;border-bottom:1px solid #ccd3da;padding-bottom:3px}.sub{color:#5b6676;margin:0 0 10px}table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #ccd3da;padding:4px 7px;text-align:left;vertical-align:top}th{background:#eceff2}.foot{margin-top:22px;color:#5b6676;font-size:11px}';
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function Tbl({ head, rows }) {
  return <table><thead><tr>{head.map((x) => <th key={x}>{x}</th>)}</tr></thead><tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{x}</td>)}</tr>) : <tr><td colSpan={head.length}>None</td></tr>}</tbody></table>;
}
function ReportBody({ I, today }) {
  const d = I.data, h = d.health, s = h.scope;
  const recs = I.recs.filter(isLive).sort((a, b) => a.priority.localeCompare(b.priority));
  const res = I.analysis && I.analysis.latest && I.analysis.latest.result;
  const due = (x) => (x.dueDate ? fmtDate(x.dueDate) : '—');
  const riskRows = (l) => h.cards.filter((x) => x.level === l).map((x) => [x.complianceId, x.title, x.reason, due(x), x.owner || 'Unassigned']);
  const RH = ['Record', 'Obligation', 'Reason', 'Due', 'Owner'];
  return (
    <>
      <h1>AI Project Compliance Health Report</h1><p className="sub">{s.name} · generated {today}{!res && ' · no AI analysis has been run for this project (automatic summary used)'}</p>
      <h2>1. Project information</h2><Tbl head={['Item', 'Detail']} rows={[['Company', s.companyName || '—'], ['Project', s.name], ['Location', s.location || 'Not set'], ['Type', s.category === 'epc' ? 'EPC project' : (s.projectType || 'Not set')], ['Construction stage', s.constructionStage || 'Not set'], ['Project manager', s.projectManager || 'Not set'], ['Compliance manager', s.complianceManager || 'Not set']]} />
      <h2>2–3. Compliance health score and calculation</h2><p><b>{h.score == null ? 'No score' : h.score + ' / 100 — ' + h.category}</b>. Previous score: {d.previous ? `${d.previous.score} (${fmtDate(d.previous.date)})` : 'not available yet'}.</p>
      <Tbl head={['Step', 'Value']} rows={[['Total applicable risk', h.totalRisk], ['Outstanding risk', h.outstandingRisk], ['Risk percentage', h.riskPct == null ? '—' : h.riskPct + '%'], ['Base health', h.base == null ? '—' : h.base], ['Deductions', '− ' + h.deductionTotal], ['Final score', h.score == null ? '—' : h.score]]} />
      {h.deductions.length ? <Tbl head={['Deduction', 'Records', 'Points']} rows={h.deductions.map((x) => [x.kind.replace(/_/g, ' '), x.count, x.points + (x.capped ? ' (capped)' : '')])} /> : <p>No additional deductions.</p>}
      <h2>4–5. Current stage and stage readiness</h2><p>Current stage: <b>{h.currentStage ? h.currentStage.name + ' — ' + h.currentStage.status : 'all progression stages complete'}</b>. Next stage: {h.nextStage ? h.nextStage.name + ' — ' + h.nextStage.status : '—'}.</p>
      <Tbl head={['Stage', 'Status', 'Readiness', 'Mandatory', 'Done', 'Overdue', 'Blocked']} rows={h.stages.filter((x) => x.id !== 'S0' && x.status !== 'Not Applicable').map((x) => [x.name, x.status, x.readinessPct == null ? '—' : x.readinessPct + '%', x.mandatory, x.completed, x.overdue, x.blocked])} />
      <h2>6. Critical risks</h2><Tbl head={RH} rows={riskRows('critical')} />
      <h2>7. High-risk obligations</h2><Tbl head={RH} rows={riskRows('high')} />
      <h2>8. Overdue compliance</h2><Tbl head={RH} rows={h.cards.filter((x) => x.kind === 'overdue').map((x) => [x.complianceId, x.title, x.reason, due(x), x.owner || 'Unassigned'])} />
      <h2>9. Upcoming deadlines</h2><p>{DEADLINE_BUCKETS.map(([k, l]) => h.buckets[k] + ' due within ' + l).join(' · ')}</p>
      <Tbl head={['Record', 'Obligation', 'Due', 'Days left', 'Owner']} rows={h.cards.filter((x) => x.kind === 'deadline_soon').map((x) => [x.complianceId, x.title, fmtDate(x.dueDate), x.daysLeft, x.owner || 'Unassigned'])} />
      <h2>10–11. Missing and expired documents</h2><p>{h.documents.required} required · {h.documents.uploaded} uploaded · {h.documents.verified} verified · {h.documents.missing} missing · {h.documents.pending} awaiting verification · {h.documents.rejected} rejected · {h.documents.expired} expired.</p>
      <Tbl head={['Record', 'Document', 'Issue']} rows={h.documents.issues.filter((i) => ['Not uploaded', 'Expired', 'Rejected'].includes(i.issue)).map((i) => [i.complianceId, i.document, i.issue + (i.date ? ' ' + fmtDate(i.date) : '')])} />
      <h2>12–13. Pending approvals and dependency blockers</h2><Tbl head={['Record', 'Document', 'Issue']} rows={h.documents.issues.filter((i) => i.issue === 'Awaiting verification').map((i) => [i.complianceId, i.document, 'Awaiting verification'])} />
      <Tbl head={['Record', 'Why it is blocked']} rows={h.cards.filter((x) => x.kind === 'blocked').map((x) => [x.complianceId + ' ' + x.title, x.reason])} />
      <h2>14–15. Recommended actions and responsible departments</h2><Tbl head={['Priority', 'Action', 'Record', 'Responsible', 'Owner', 'Due']} rows={recs.map((r) => [r.priority, r.title, r.compliance_id || '—', r.responsible_department || '—', r.assigned_owner || r.suggested_owner || '—', r.assigned_due || r.due_date ? fmtDate(r.assigned_due || r.due_date) : '—'])} />
      <h2>16. Overall assessment</h2>{res ? <><p>{res.projectSummary}</p><p>{res.healthExplanation || ''}</p></> : autoSummary(d, I.recs).map(([l, v]) => <p key={l}><b>{l}:</b> {v}</p>)}
      <h2>17. Data quality limitations</h2><ul>{h.limitations.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <p className="foot">This report is an operational summary generated from the compliance records. It is not legal advice and does not state that the project is legally compliant. Legal validation required.</p>
    </>
  );
}

function ReportModal({ I }) {
  const ref = useRef(null);
  const [today] = useState(() => new Date().toLocaleString());
  const name = I.data.health.scope.name;
  const fname = 'Project-Health-' + name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + '-' + todayISO();
  const print = () => {
    const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'; document.body.appendChild(f);
    f.contentDocument.open(); f.contentDocument.write(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEsc(fname)}</title><style>${REPORT_CSS}</style></head><body>${ref.current.innerHTML}</body></html>`); f.contentDocument.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2000); }, 250);
  };
  const excel = () => download(fname + '.xls', `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><style>${REPORT_CSS}</style></head><body>${ref.current.innerHTML}</body></html>`, 'application/vnd.ms-excel');
  return (
    <>
      <ModalHead kicker="Report preview" title={`AI Project Health Report — ${name}`} />
      <div className="modal-body"><div className="report-preview" ref={ref}><ReportBody I={I} today={today} /></div></div>
      <div className="modal-foot"><button className="btn primary" type="button" onClick={print}>Print</button><button className="btn" type="button" onClick={print}>Download PDF</button><button className="btn" type="button" onClick={excel}>Export Excel</button><span className="muted" style={{ fontSize: 12 }}>“Download PDF” opens your browser’s print window — choose “Save as PDF”.</span></div>
    </>
  );
}

/* ---------- detailed numbers (status, stage, department) ---------- */
function PctBar({ label, done, total, extra, color }) {
  const raw = total ? done / total * 100 : 0;
  const width = done > 0 ? Math.max(raw, 1.5) : 0;    // keep a visible sliver for non-zero counts so a single item doesn't look empty
  return (
    <div className="bar-row"><div className="lbl" title={label}>{label}</div>
      <div className="bar-track"><div className="bar-seg" style={{ width: width + '%', background: color || 'var(--grad)' }} /></div>
      <div className="pct">{raw.toFixed(2)}%{extra && <> <span style={{ color: 'var(--text-muted)' }}>({done})</span></>}</div></div>
  );
}
function DashboardDetail({ open }) {
  const S = useStore();
  if (!S.inst.length) return <NoContext />;
  const insts = S.inst;
  // Not-applicable and still-to-review records are left out of every completion percentage.
  const active = insts.filter((i) => i.state === 'active' && i.status !== 'Not Applicable');
  const review = insts.filter((i) => i.state === 'review').length, na = insts.length - active.length - review;
  const counts = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]));
  let overdue = 0, due7 = 0, due30 = 0;
  for (const i of active) {
    counts[i.status] = (counts[i.status] || 0) + 1;
    if (i.status === 'Overdue') overdue++;
    if (i.tr.next_due_date && i.status !== 'Compliant / Completed' && i.status !== 'On Hold') {
      const d = daysUntil(i.tr.next_due_date);
      if (d !== null && d >= 0 && d <= 7) due7++;
      if (d !== null && d >= 0 && d <= 30) due30++;
    }
  }
  const byDept = {}, byStage = {};
  for (const i of active) { const d = i.item.department; byDept[d] = byDept[d] || { done: 0, total: 0 }; byDept[d].total++; if (i.status === 'Compliant / Completed') byDept[d].done++; }
  for (const s of S.stages) byStage[s.id] = { done: 0, total: 0, name: s.name };
  for (const i of active) {
    const sid = effectiveStageId(S, i.item);
    byStage[sid] = byStage[sid] || { done: 0, total: 0, name: 'Unmapped to Stage' };
    byStage[sid].total++; if (i.status === 'Compliant / Completed') byStage[sid].done++;
  }
  const topOverdue = active.filter((i) => i.status === 'Overdue').map((i) => ({ i, d: i.tr.next_due_date ? daysUntil(i.tr.next_due_date) : null })).sort((a, b) => (a.d ?? 0) - (b.d ?? 0)).slice(0, 8);
  const tile = (n, label, color, title) => <div className="stat-tile" title={title} key={label}><div className="num" style={color ? { color } : undefined}>{n}</div><div className="label">{label}</div></div>;
  const docPending = active.reduce((n, i) => n + (i.docs ? i.docs.pending : 0), 0), docBad = active.reduce((n, i) => n + (i.docs ? i.docs.expired + i.docs.rejected : 0), 0);
  return (
    <>
      <div className="section-title">Overview — {ctxName(S, S.ctx)}</div>
      <div className="grid grid-stats" style={{ marginBottom: 22 }}>
        {tile(active.length, 'Applicable items')}{tile(counts['Compliant / Completed'] || 0, 'Compliant / completed', 'var(--ok)')}{tile(overdue, 'Overdue', 'var(--bad)')}
        {tile(due7, 'Due in 7 days', 'var(--warn)')}{tile(due30, 'Due in 30 days', 'var(--warn)')}{tile(active.filter((i) => i.blocked).length, 'Blocked', 'var(--hold)', 'Waiting for an earlier record to be completed')}
        {tile(docPending, 'Documents awaiting verification', 'var(--warn)', 'Uploaded documents nobody has verified yet')}{tile(docBad, 'Expired / rejected documents', 'var(--bad)', 'A document has passed its expiry date or was rejected')}
        {tile(review, 'Need applicability review', 'var(--hold)', 'Applicability not yet confirmed. Answer the setup questions in Projects.')}{tile(na, 'Not applicable', 'var(--text-muted)')}
      </div>
      <div className="dash-cols">
        <div className="card"><h3 style={{ marginBottom: 10 }}>By status</h3>
          {STATUS_LIST.filter((s) => s !== 'Not Applicable').map((s) => <PctBar key={s} label={s} done={counts[s] || 0} total={active.length} extra color={STATUS_DEFS[s] ? `var(--${STATUS_DEFS[s].cls})` : null} />)}</div>
        <div className="card"><h3 style={{ marginBottom: 10 }}>Top overdue items</h3>
          {topOverdue.length ? <table className="simple"><tbody><tr><th>ID</th><th>Description</th><th>Days overdue</th></tr>
            {topOverdue.map((x) => <tr key={x.i.key} onClick={() => open(x.i.key)}><td className="mono">{x.i.item.compliance_id}</td><td>{(x.i.item.brief_description || '').slice(0, 46)}{x.i.scopeShort && ' · ' + x.i.scopeShort}</td><td className="mono" style={{ color: 'var(--bad)' }}>{Math.abs(x.d)}</td></tr>)}
          </tbody></table> : <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No overdue items right now.</div>}</div>
      </div>
      <div className="section-title">Completion % by stage</div>
      <div className="card">{Object.keys(byStage).map((sid) => <PctBar key={sid} label={byStage[sid].name} done={byStage[sid].done} total={byStage[sid].total} />)}</div>
      <div className="section-title">Completion % by department</div>
      <div className="card">{Object.keys(byDept).map((d) => <PctBar key={d} label={d} done={byDept[d].done} total={byDept[d].total} />)}</div>
    </>
  );
}
