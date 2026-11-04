import { useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useUi } from '../ui/ui.jsx';
import { api } from '../lib/api.js';
import { DEDUCT_TXT, DEFAULT_HEALTH_UI, DEFAULT_REMINDERS, FACTOR_TXT, LEVELS, LEVEL_TXT } from '../lib/constants.js';
import { RegSources } from './Regulatory.jsx';

/** The saved score settings with every missing value filled from the suggested defaults. */
function healthSettings(settingsMap) {
  const s = (settingsMap || {}).health || {}, d = DEFAULT_HEALTH_UI;
  const m = (k) => ({ ...d[k], ...(s[k] || {}) });
  return { ...d, ...s, weights: m('weights'), factors: m('factors'), deductions: m('deductions'), deduction_caps: m('deduction_caps'), bands: m('bands') };
}

export default function Settings() {
  const S = useStore();
  return (
    <>
      <div className="section-title">Settings</div>
      <Reminders />
      <RiskClassification />
      <HealthSettings key={JSON.stringify((S.settingsMap || {}).health || null)} />
      <RegSources />
      <Password />
    </>
  );
}

function Reminders() {
  const S = useStore();
  const { toast } = useUi();
  const r = { ...DEFAULT_REMINDERS, ...((S.settingsMap || {}).reminders || {}) }, canSet = S.can('manage_settings');
  const [on, setOn] = useState(r.enabled);
  const [days, setDays] = useState(r.days.join(', '));
  const [over, setOver] = useState(r.overdue_days.join(', '));
  const list = (v) => v.split(/[,\s]+/).filter(Boolean).map(Number);
  const save = async () => {
    const d = list(days), o = list(over);
    if ([...d, ...o].some((n) => !Number.isInteger(n))) { toast('Use whole numbers separated by commas.'); return; }
    try { await S.putDoc('settings', 'reminders', { enabled: on, days: d, overdue_days: o }); toast('Reminder rules saved.'); } catch (e) { toast(e.message); }
  };
  const run = async () => {
    try {
      const res = await api('POST', '/api/notifications/run', {}), m = res.made || {};
      toast(`Checked ${res.checked || 0} records. New notices: ${m.due || 0} due, ${m.overdue || 0} overdue, ${(m.doc_expiring || 0) + (m.doc_expired || 0)} document.`, 5000);
      S.loadNotes();
    } catch (e) { toast(e.message); }
  };
  return (
    <div className="card" style={{ maxWidth: 640, marginBottom: 18 }}>
      <h3 style={{ marginBottom: 4 }}>Reminders</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 12 }}>A notice appears in the bell (top right) for people who can act on a record. Each notice is created once. Email is not set up.</div>
      {!canSet && <div className="readonly-note">Only a Company Admin or Master Admin can change these rules.</div>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}><input type="checkbox" checked={on} disabled={!canSet} onChange={(e) => setOn(e.target.checked)} /> Send reminders</label>
      <div className="field"><label>Remind this many days before a due date or document expiry</label><input value={days} disabled={!canSet} onChange={(e) => setDays(e.target.value)} /><div className="fact-sub">Separate with commas. 0 means on the day.</div></div>
      <div className="field"><label>After a due date has passed, remind again after this many days</label><input value={over} disabled={!canSet} onChange={(e) => setOver(e.target.value)} /><div className="fact-sub">For example 1, 7, 14, 30.</div></div>
      {canSet && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="btn primary" type="button" onClick={save}>Save reminder rules</button><button className="btn" type="button" onClick={run}>Check now</button></div>}
    </div>
  );
}

function RiskClassification() {
  const S = useStore();
  const { toast } = useUi();
  if (!S.can('decide_applicability')) return null;
  const total = S.items.length, set = Object.keys(S.risk || {}).length;
  const props = (S.riskProposals || {}).proposals || {}, avail = Object.keys(props).filter((c) => !(S.risk || {})[c]);
  const by = { critical: 0, high: 0, medium: 0 }; for (const c of avail) by[props[c].level]++;
  const accept = async () => {
    if (!window.confirm('Apply the suggested risk levels to every record that has none yet? You can change any of them afterwards.')) return;
    try { const r = await api('POST', '/api/risk/accept-suggestions', {}); toast(`${r.applied} records classified. The project scores will update in a few seconds.`, 5000); await S.reload(['risk_overrides']); }
    catch (e) { toast(e.message, 6000); }
  };
  return (
    <div className="card" style={{ maxWidth: 640, marginBottom: 18 }}>
      <h3 style={{ marginBottom: 4 }}>Risk classification</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 12 }}>The health score weights each record by how serious it is. The register does not carry a risk level, so a person must set one. Until then a record is scored at the “{healthSettings(S.settingsMap).unclassified_level}” weight and flagged <b>Risk classification pending validation</b>.</div>
      <div className="h-tiles" style={{ margin: '0 0 12px' }}><div className="h-tile"><b>{set}</b><span>Classified by a person</span></div><div className="h-tile"><b>{total - set}</b><span>Still pending</span></div><div className="h-tile"><b>{avail.length}</b><span>Have a suggestion</span></div></div>
      <div className="fact-sub" style={{ marginBottom: 10 }}>Suggestions are read from each record’s own penalty wording: <b>{by.critical}</b> critical (prosecution plus stop-work/revocation), <b>{by.high}</b> high (prosecution, imprisonment, stop-work, closure or revocation), <b>{by.medium}</b> medium (fine or penalty only). Records with no penalty text get no suggestion. They are not legal classifications.</div>
      <button className="btn primary" type="button" disabled={!avail.length} onClick={accept}>Accept the {avail.length} suggestions</button>
      <div className="fact-sub" style={{ marginTop: 8 }}>You can still change any record afterwards from its “More details”. A level you set yourself is never overwritten by a suggestion.</div>
    </div>
  );
}

/* Form values are kept as text while editing; `toForm` / `fromForm` convert to and from the stored numbers. */
const GROUPS = { weights: LEVELS, factors: Object.keys(FACTOR_TXT), deductions: Object.keys(DEDUCT_TXT), deduction_caps: Object.keys(DEDUCT_TXT), bands: ['healthy', 'good', 'attention', 'at_risk'] };
const toForm = (s) => ({
  ...Object.fromEntries(Object.entries(GROUPS).map(([g, keys]) => [g, Object.fromEntries(keys.map((k) => [k, String(s[g][k])]))])),
  unclassified_level: s.unclassified_level, due_soon_days: String(s.due_soon_days), ai_auto_refresh: !!s.ai_auto_refresh, ai_refresh_hours: String(s.ai_refresh_hours)
});
const fromForm = (f) => ({
  ...Object.fromEntries(Object.entries(GROUPS).map(([g, keys]) => [g, Object.fromEntries(keys.map((k) => [k, parseFloat(f[g][k])]))])),
  unclassified_level: f.unclassified_level, due_soon_days: parseInt(f.due_soon_days, 10), ai_auto_refresh: f.ai_auto_refresh, ai_refresh_hours: parseInt(f.ai_refresh_hours, 10)
});

function HealthSettings() {
  const S = useStore();
  const { toast } = useUi();
  const can = S.can('manage_settings');
  const [f, setF] = useState(() => toForm(healthSettings(S.settingsMap)));
  const setG = (g, k) => (e) => setF({ ...f, [g]: { ...f[g], [k]: e.target.value } });
  const num = (g, k, step = 'any') => <input type="number" step={step} value={f[g][k]} disabled={!can} onChange={setG(g, k)} />;
  const lbl = { textTransform: 'none', letterSpacing: 0, fontSize: 12, color: 'var(--text)' };
  const fld = (label, ctl, key) => <div className="field" key={key || label}><label style={lbl}>{label}</label>{ctl}</div>;
  const group = (title, desc, rows) => <div style={{ marginTop: 14 }}><div className="ai-l">{title}</div>{desc && <div className="fact-sub" style={{ margin: '2px 0 6px' }}>{desc}</div>}<div className="setup-grid">{rows}</div></div>;
  const put = async (o, msg) => { try { await S.putDoc('settings', 'health', o); toast(msg, 4500); } catch (e) { toast(e.message, 6000); } };
  return (
    <div className="card" style={{ maxWidth: 760, marginBottom: 18 }}>
      <h3 style={{ marginBottom: 4 }}>Compliance health score</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>These starting values are suggestions, not legal classifications. Change them to match how your team judges risk. The score is recalculated for every project afterwards.</div>
      {!can && <div className="readonly-note" style={{ marginTop: 8 }}>Only a Company Admin or Master Admin can change these.</div>}
      {group('Risk weights', 'Points per record, by risk level.', <>
        {LEVELS.map((k) => fld(LEVEL_TXT[k], num('weights', k)))}
        {fld('Weight for records nobody has classified', <select value={f.unclassified_level} disabled={!can} onChange={(e) => setF({ ...f, unclassified_level: e.target.value })}>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_TXT[l]}</option>)}</select>)}
      </>)}
      {group('Outstanding-risk factor', 'How much of a record’s weight still counts as outstanding, by status (0 = nothing, 1 = all of it). In progress is not treated as half done unless you set it that way.',
        Object.keys(FACTOR_TXT).map((k) => fld(FACTOR_TXT[k], num('factors', k))))}
      {group('Extra deductions', 'Points taken off the score for serious problems. One record can cause at most one deduction; each kind has a cap.',
        Object.keys(DEDUCT_TXT).flatMap((k) => [fld(DEDUCT_TXT[k] + ' — points each', num('deductions', k)), fld(DEDUCT_TXT[k] + ' — cap', num('deduction_caps', k))]))}
      {group('Score bands', 'Lowest score for each band.', <>
        {[['healthy', 'Healthy from'], ['good', 'Good from'], ['attention', 'Attention Required from'], ['at_risk', 'At Risk from']].map(([k, l]) => fld(l, num('bands', k)))}
        {fld('“Due soon” means within (days)', <input type="number" step="1" value={f.due_soon_days} disabled={!can} onChange={(e) => setF({ ...f, due_soon_days: e.target.value })} />)}
      </>)}
      <div style={{ marginTop: 14 }}><div className="ai-l">AI analysis refresh</div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '6px 0 4px' }}><input type="checkbox" checked={f.ai_auto_refresh} disabled={!can} onChange={(e) => setF({ ...f, ai_auto_refresh: e.target.checked })} /> Refresh the AI analysis automatically for projects that need attention</label>
        <div className="fact-sub">Off by default because it uses your AI quota. When on, it refreshes at most 3 projects per run, only where data changed and something is overdue, critical or high. The score itself always updates on its own; this only affects the written analysis.</div>
        <div className="field" style={{ maxWidth: 260, marginTop: 6 }}><label style={lbl}>Wait at least this many hours between automatic analyses</label><input type="number" min="1" max="168" step="1" value={f.ai_refresh_hours} disabled={!can} onChange={(e) => setF({ ...f, ai_refresh_hours: e.target.value })} /></div>
      </div>
      {can && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        <button className="btn primary" type="button" onClick={() => put(fromForm(f), 'Saved. Every project score is being recalculated.')}>Save score settings</button>
        <button className="btn" type="button" onClick={() => { if (window.confirm('Put every score setting back to the suggested values?')) put(JSON.parse(JSON.stringify(DEFAULT_HEALTH_UI)), 'Reset to the suggested values.'); }}>Reset to the suggested values</button>
      </div>}
    </div>
  );
}

function Password() {
  const S = useStore();
  const { toast } = useUi();
  const [cur, setCur] = useState(''), [next, setNext] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/auth/password', { current: cur, next }); setCur(''); setNext(''); toast('Password changed.'); } catch (err) { toast(err.message); }
  };
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h3 style={{ marginBottom: 4 }}>Change password</h3>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>Signed in as {S.me.name} ({S.me.email}) · {S.me.role_label || S.me.role}</div>
      <form onSubmit={submit}>
        <div className="field"><label>Current password</label><input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div className="field"><label>New password (min 10 characters)</label><input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <button className="btn primary" type="submit" style={{ marginTop: 12 }}>Change password</button>
      </form>
    </div>
  );
}
