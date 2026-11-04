import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useUi } from '../ui/ui.jsx';
import { download } from '../lib/api.js';
import { Core } from '../lib/core.js';
import { ALL_COLS, DEFAULT_REGISTER_COLS } from '../lib/constants.js';
import { ctxName, effectiveStageId } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';

const colLabel = (c) => ALL_COLS.find((x) => x[0] === c)[1];

export default function Register() {
  const S = useStore();
  const ui = useUi();
  const [cols, setCols] = useSticky('register.cols', DEFAULT_REGISTER_COLS);
  const [f, setF] = useSticky('register.filters', { q: '', dept: '', level: '', app: '' });
  const value = (inst, col) => {
    const it = inst.item;
    switch (col) {
      case 'status': return inst.status;
      case 'scope': return inst.scopeLabel;
      case 'applicability': return inst.appStatus;
      case 'stage': { const s = S.stages.find((x) => x.id === effectiveStageId(S, it)); return s ? s.name : 'Unmapped'; }
      default: return it[col];
    }
  };
  const q = f.q.toLowerCase();
  const rows = S.inst.filter((inst) => {
    const it = inst.item;
    if (f.dept && it.department !== f.dept) return false;
    if (f.level && it.compliance_level !== f.level) return false;
    if (f.app && inst.appStatus !== f.app) return false;
    if (q && ![it.compliance_id, it.department, it.brief_description, it.regulation, it.authority_norm, it.owner, inst.scopeLabel].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  const toggleCol = (c, on) => setCols(on ? (cols.includes(c) ? cols : [...cols, c]) : cols.filter((x) => x !== c));
  const exportCsv = () => {
    const csv = [cols.map(colLabel).join(',')].concat(rows.map((inst) => cols.map((c) => `"${String(value(inst, c) || '').replace(/"/g, '""')}"`).join(','))).join('\r\n');
    download('compliance-register.csv', csv, 'text/csv;charset=utf-8');
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <div className="register-toolbar">
        <input type="text" placeholder="Search ID, description, regulation, authority…" value={f.q} onChange={set('q')} />
        <select className="pill" value={f.dept} onChange={set('dept')}><option value="">All departments</option>{[...new Set(S.items.map((i) => i.department))].map((d) => <option key={d}>{d}</option>)}</select>
        <select className="pill" value={f.level} onChange={set('level')}><option value="">All levels</option>{[...new Set(S.items.map((i) => i.compliance_level).filter(Boolean))].sort().map((l) => <option key={l}>{l}</option>)}</select>
        <select className="pill" value={f.app} onChange={set('app')}><option value="">Any applicability</option>{Core.APPLICABILITY.map((a) => <option key={a}>{a}</option>)}</select>
        <button className="btn primary" type="button" onClick={exportCsv}>Export CSV</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-4px 0 8px' }}>Showing: <b style={{ color: 'var(--text)' }}>{ctxName(S, S.ctx)}</b></div>
      <div className="col-chooser">{ALL_COLS.map(([k, label]) => <label key={k}><input type="checkbox" checked={cols.includes(k)} onChange={(e) => toggleCol(k, e.target.checked)} /> {label}</label>)}</div>
      <div className="table-wrap"><table className="register">
        <thead><tr>{cols.map((c) => <th key={c}>{colLabel(c)}</th>)}</tr></thead>
        <tbody>{rows.map((inst) => <tr key={inst.key} onClick={() => ui.openModal(<RecordDrawer refKey={inst.key} />)}>{cols.map((c) => <td key={c} title={value(inst, c) ?? ''}>{value(inst, c)}</td>)}</tr>)}</tbody>
      </table></div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} of {S.inst.length} records in this view</div>
    </>
  );
}
