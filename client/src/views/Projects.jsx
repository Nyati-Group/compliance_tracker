import { useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useUi, Chip, Empty } from '../ui/ui.jsx';
import { api } from '../lib/api.js';
import { slug, uid } from '../lib/format.js';
import { PROJECT_TYPES } from '../lib/constants.js';
import { projectsIn, summaryText, tallies, tallyText, theCompanyId, unansweredCompany, unansweredFor } from '../lib/records.js';
import { Seg, openSetup } from './Setup.jsx';

const NO_TALLY = { active: 0, review: 0, na: 0 };

export default function Projects() {
  const S = useStore();
  const ui = useUi();
  const [find, setFind] = useState('');
  const [adding, setAdding] = useState(false);
  const [np, setNp] = useState({ cat: 'real_estate', name: '', location: '', rera: '', type: '' });
  const [busy, setBusy] = useState(false);
  const coId = theCompanyId(S), co = S.companies[coId];
  const t = tallies(S);
  const coOpen = unansweredCompany(S).length;
  const q = find.toLowerCase().trim();

  const add = async () => {
    const name = np.name.trim();
    if (!name) { ui.toast('Enter a project name.'); return; }
    if (!coId) { ui.toast('No company is set up.'); return; }
    if (Object.values(S.projects).some((p) => p.name.toLowerCase().trim() === name.toLowerCase())) { ui.toast('A project with this name already exists.'); return; }
    setBusy(true);
    try {
      const id = 'proj_' + slug(name) + '_' + uid(), now = new Date().toISOString(), cat = np.cat;
      const doc = { name, company_id: coId, category: cat, location: np.location.trim(), facts: {}, created_at: now };
      if (cat === 'real_estate') Object.assign(doc, { rera_no: np.rera.trim(), project_type: np.type, current_stage: '' });
      await api('PUT', '/api/projects/' + encodeURIComponent(id), doc);
      if (cat === 'real_estate') await api('PUT', '/api/phases/' + encodeURIComponent('ph_' + id.replace(/^proj_/, '') + '_1'), { project_id: id, name: 'Phase 1', rera_no: doc.rera_no || '', created_at: now });
      await S.reload(['projects', 'phases']);
      const s = await S.regenerate({ projectId: id });
      S.setCtxState({ companyId: coId, projectId: id });
      ui.toast('Project added. ' + summaryText(s));
      setNp({ cat: 'real_estate', name: '', location: '', rera: '', type: '' }); setAdding(false);
      openSetup(ui, 'project', id);
    } catch (e) { ui.toast('Could not add the project: ' + e.message); }
    setBusy(false);
  };
  const viewProject = (id) => { S.setCtx('p:' + id); S.setView('stages'); };
  const set = (k) => (e) => setNp({ ...np, [k]: e.target.value });
  const re = np.cat === 'real_estate';

  return (
    <>
      {co ? (
        <div className="card setup-card" style={{ marginBottom: 18 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <strong>{co.name} — company-wide</strong><br />
            <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Tax, labour, corporate and data-protection obligations are tracked once for the company. {coOpen ? <span style={{ color: 'var(--warn)' }}>{coOpen} company question{coOpen > 1 ? 's' : ''} still to answer.</span> : 'All company questions answered.'}</span><br />
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tallyText(t._company || NO_TALLY)}</span>
          </div>
          <button className="btn primary" type="button" onClick={() => openSetup(ui, 'company', coId)}>Company set-up</button>
        </div>
      ) : <Empty>No company is set up. Run the setup migration.</Empty>}

      <div className="filters" style={{ marginBottom: 10 }}>
        <label style={{ flex: 1, maxWidth: 340 }}>Find a project<input placeholder="Type a name or place…" value={find} onChange={(e) => setFind(e.target.value)} style={{ padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} /></label>
        <button className="btn primary" type="button" disabled={!S.can('manage_setup')} onClick={() => setAdding(!adding)}>+ Add a project</button>
      </div>

      {adding && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3 style={{ marginBottom: 4 }}>Add a project</h3>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>The register for the project is generated for you. You then answer a short set-up form.</div>
          <div className="field"><label>What kind of project is it?</label>
            <Seg value={np.cat} onChange={(v) => setNp({ ...np, cat: v })} options={[['real_estate', 'Real estate'], ['epc', 'EPC (contract works)']]} /></div>
          <div className="setup-grid">
            <div className="field"><label>Project name</label><input autoFocus placeholder="e.g. Nyati Evoque" value={np.name} onChange={set('name')} /></div>
            <div className="field"><label>Location (city, state)</label><input placeholder="e.g. Pune, Maharashtra" value={np.location} onChange={set('location')} /></div>
            {re && <div className="field"><label>MahaRERA registration no.</label><input placeholder="P5XXXX000XXXX" value={np.rera} onChange={set('rera')} /></div>}
            {re && <div className="field"><label>Project type</label><select value={np.type} onChange={set('type')}><option value="">Choose later</option>{PROJECT_TYPES.map((x) => <option key={x}>{x}</option>)}</select></div>}
          </div>
          <button className="btn primary" type="button" disabled={busy} onClick={add}>Add project</button>
        </div>
      )}

      {['real_estate', 'epc'].map((cat) => {
        const ids = projectsIn(S, cat);
        return (
          <div key={cat}>
            <div className="section-title">{cat === 'epc' ? 'EPC projects — contract labour & IT' : 'Real estate projects'} ({ids.length})</div>
            {ids.length ? (
              <div className="card" style={{ padding: 0, overflowX: 'auto' }}><table className="simple proj-table"><tbody>
                <tr><th>Project</th><th>Location</th><th>Records</th><th>Set-up</th><th /></tr>
                {ids.map((id) => {
                  const p = S.projects[id], c = t[id] || NO_TALLY, un = unansweredFor(S, id), open = un.proj.length + un.blds.length;
                  if (q && !(p.name + ' ' + (p.location || '')).toLowerCase().includes(q)) return null;
                  return (
                    <tr key={id} className="prow">
                      <td><b>{p.name}</b>{p.notes && <div className="fact-sub">{p.notes}</div>}</td>
                      <td className="muted">{p.location || '—'}</td>
                      <td className="nowrap"><Chip cls="ok">{c.active} applicable</Chip> {c.review > 0 && <Chip cls="hold">{c.review} to review</Chip>} <Chip>{c.na} n/a</Chip></td>
                      <td className="nowrap">{open ? <Chip cls="warn">{open} question{open > 1 ? 's' : ''} open</Chip> : <Chip cls="ok">Answered</Chip>}</td>
                      <td className="nowrap" style={{ textAlign: 'right' }}><button className="btn sm" type="button" onClick={() => viewProject(id)}>View</button> <button className="btn sm primary" type="button" onClick={() => openSetup(ui, 'project', id)}>Set up</button></td>
                    </tr>
                  );
                })}
              </tbody></table></div>
            ) : <Empty>None yet.</Empty>}
          </div>
        );
      })}
    </>
  );
}
