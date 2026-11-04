// The documents on file for the project chosen in the top bar (or, with "Company-wide" chosen, for every project of that
// company, grouped by project). Read-only: upload, prepare and verify happen on the record.
import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useUi, Chip, Empty, ActionLink } from '../ui/ui.jsx';
import { Core } from '../lib/core.js';
import { fmtDate, fmtSize, todayISO } from '../lib/format.js';
import { ctxName } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';

const DownloadIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></svg>;
const scopeIdOf = (d) => String(d.key || '').split('__').slice(1).join('__');
const STATUS_CLS = { Verified: 'ok', 'Awaiting verification': 'warn', Rejected: 'bad', Expired: 'bad' };

function projectOf(S, d) {
  const sid = scopeIdOf(d);
  const pid = d.project_id || (S.projects[sid] && sid) || (S.phases[sid] && S.phases[sid].project_id) || (S.buildings[sid] && S.buildings[sid].project_id) || '';
  if (pid && S.projects[pid]) return { id: pid, name: S.projects[pid].name || pid, company: S.projects[pid].company_id || null };
  if (S.companies[sid]) return { id: 'co:' + sid, name: 'Company-wide · ' + (S.companies[sid].name || sid), company: sid };
  return { id: '', name: 'Other', company: null };
}
function scopeOf(S, d) {
  const inst = S.instByKey[d.key];
  if (inst && inst.scopeLabel) return inst.scopeLabel;
  const sid = scopeIdOf(d);
  if (S.phases[sid]) return S.phases[sid].name || 'Phase';
  if (S.buildings[sid]) return S.buildings[sid].name || 'Building';
  return S.companies[sid] ? 'Company-wide' : 'Entire project';
}
function statusOf(d) {
  if (d.status === 'Rejected') return 'Rejected';
  if (d.expiry_date && d.expiry_date < todayISO()) return 'Expired';
  return d.status === 'Verified' ? 'Verified' : 'Awaiting verification';
}

export default function Vault() {
  const S = useStore();
  const ui = useUi();
  const [f, setF] = useSticky('vault.filters', { q: '', status: '', origin: '', old: false });
  const all = Object.values(S.docsByKey).flat().sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
  /** Is this document in the project / company chosen at the top? */
  const inContext = (d) => { const p = projectOf(S, d); return S.ctx.projectId ? p.id === S.ctx.projectId : S.ctx.companyId ? p.company === S.ctx.companyId : true; };
  const q = f.q.trim().toLowerCase();
  const rows = all.filter((d) => {
    if (!f.old && d.superseded) return false;
    if (!inContext(d)) return false;
    if (f.status && statusOf(d) !== f.status) return false;
    if (f.origin && Core.docOrigin(d.doc_name) !== f.origin) return false;
    if (q) { const it = S.itemById[d.compliance_id] || {}; if (!`${d.doc_name} ${d.file_name} ${d.compliance_id} ${it.brief_description || ''} ${it.authority_norm || it.authority_raw || ''} ${d.uploaded_by || ''}`.toLowerCase().includes(q)) return false; }
    return true;
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const today = todayISO();

  const row = (d) => {
    const it = S.itemById[d.compliance_id] || {}, st = statusOf(d), prep = Core.docOrigin(d.doc_name) === 'prepared', p = projectOf(S, d);
    const who = d.status === 'Verified' || d.status === 'Rejected' ? (d.verified_by ? `${d.status === 'Rejected' ? 'Rejected' : 'Verified'} by ${d.verified_by}` : '') : `Uploaded by ${d.uploaded_by || ''}`;
    return (
      <tr key={d.id}>
        <td><b>{d.doc_name}</b> <Chip>v{d.version || 1}</Chip>{d.superseded && <> <Chip>Replaced</Chip></>}
          <div className="fact-sub">{d.file_name} · {fmtSize(d.size || 0)} · {prep ? 'Prepared by us' : 'Received'}{d.carried_from_id && ' · carried from ' + d.carried_from_id}</div></td>
        <td><b>{(S.projects[p.id] || {}).name || p.name}</b><div className="fact-sub">{scopeOf(S, d)}</div></td>
        <td><ActionLink className="chip mono" title="Open this record" onClick={() => ui.openModal(<RecordDrawer refKey={d.key} />)}>{d.compliance_id}</ActionLink><div className="fact-sub">{it.authority_norm || it.authority_raw || (it.brief_description || '').slice(0, 60)}</div></td>
        <td>{d.issue_date ? <div>Issued: {fmtDate(d.issue_date)}</div> : <div className="fact-sub">Uploaded: {fmtDate(String(d.uploaded_at || '').slice(0, 10))}</div>}
          {d.expiry_date && <div style={d.expiry_date < today ? { color: 'var(--bad,#b42318)', fontWeight: 600 } : undefined}>Expires: {fmtDate(d.expiry_date)}</div>}</td>
        <td><Chip cls={STATUS_CLS[st]}>{st}</Chip>{who && <div className="fact-sub">{who}</div>}</td>
        <td style={{ textAlign: 'right' }}><a className="btn sm" href={'/files/' + encodeURIComponent(d.file_id)} aria-label={'Download ' + d.doc_name} title="Download"><DownloadIcon /></a></td>
      </tr>
    );
  };
  const table = (list) => (
    <div className="table-wrap"><table className="und-table">
      <thead><tr><th>Document &amp; file</th><th>Project &amp; scope</th><th>Authority &amp; record</th><th>Issue &amp; expiry</th><th>Verification</th><th /></tr></thead>
      <tbody>{list.map(row)}</tbody>
    </table></div>
  );

  let body;
  if (!rows.length) {
    body = <Empty>{all.some(inContext) ? 'No documents match your filters.' : <><b>No documents yet for {ctxName(S, S.ctx)}.</b><div style={{ marginTop: 6 }}>Documents uploaded or prepared on a compliance record appear here.</div></>}</Empty>;
  } else {
    const count = <div className="fact-sub" style={{ marginBottom: 8 }}>{rows.length} document{rows.length === 1 ? '' : 's'}</div>;
    if (S.ctx.projectId) body = <>{count}{table(rows)}</>;
    else {
      // company-wide view: one section per project
      const groups = new Map();
      for (const d of rows) { const p = projectOf(S, d); (groups.get(p.id) || groups.set(p.id, { name: p.name, rows: [] }).get(p.id)).rows.push(d); }
      body = <>{count}{[...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([gid, g]) => (
        <details key={gid} className="panel vlt-group" open style={{ marginBottom: 12 }}><summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>{g.name} <Chip>{g.rows.length}</Chip></summary><div style={{ marginTop: 8 }}>{table(g.rows)}</div></details>
      ))}</>;
    }
  }

  return (
    <>
      <div className="section-title">Document Vault</div>
      <div className="ru-bar"><div className="sub">Documents on file for <b>{ctxName(S, S.ctx)}</b>. Change the project at the top to see another project's documents. Open a record to upload, prepare or verify its documents.</div></div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="grow">Search<input type="search" value={f.q} placeholder="Search by document, file name, record ID, authority or uploader" onChange={set('q')} /></label>
        <label>Verification<select value={f.status} onChange={set('status')}><option value="">All</option>{['Verified', 'Awaiting verification', 'Rejected', 'Expired'].map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Source<select value={f.origin} onChange={set('origin')}><option value="">All</option><option value="prepared">Prepared by us</option><option value="received">Received</option></select></label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={f.old} onChange={set('old')} /> Include earlier versions</label>
      </div>
      <div>{body}</div>
    </>
  );
}
