import { useState } from 'react';
import { useStore } from '../state/store.jsx';
import { useRemote } from '../state/hooks.js';
import { useUi, ModalHead, Chip, Empty } from '../ui/ui.jsx';
import { api } from '../lib/api.js';
import { PROJECT_CATS } from '../lib/constants.js';
import { projectsIn } from '../lib/records.js';

const FULL_ACCESS = ['admin', 'company_admin'];
const accessText = (u) => (FULL_ACCESS.includes(u.role) || !u.project_ids ? 'All projects' : `${u.project_ids.length} project${u.project_ids.length === 1 ? '' : 's'}`);

export default function Users() {
  const S = useStore();
  const ui = useUi();
  const [users, err, reload] = useRemote('/auth/users');
  const [nu, setNu] = useState({ name: '', email: '', role: 'readonly', password: '' });
  if (!users) return <Empty>{err || 'Loading users…'}</Empty>;
  const roles = S.roles || [];
  const roleLabel = (key) => (roles.find((r) => r.key === key) || {}).label || key;
  const update = async (email, body, msg) => {
    try { await api('PUT', '/auth/users/' + encodeURIComponent(email), body); ui.toast(msg); } catch (e) { ui.toast(e.message); }
    reload();
  };
  const resetPw = async (email) => {
    const pw = window.prompt('New temporary password for ' + email + ' (min 10 characters):');
    if (!pw) return;
    try { await api('PUT', '/auth/users/' + encodeURIComponent(email), { password: pw }); ui.toast('Password reset. They are signed out everywhere.'); } catch (e) { ui.toast(e.message); }
  };
  const add = async () => {
    try { await api('POST', '/auth/users', nu); ui.toast('User added.'); setNu({ name: '', email: '', role: 'readonly', password: '' }); reload(); }
    catch (e) { ui.toast(e.message); }
  };
  const roleOpts = roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>);
  const set = (k) => (e) => setNu({ ...nu, [k]: e.target.value });

  return (
    <>
      <div className="section-title">Users</div>
      <div className="card" style={{ marginBottom: 18, overflowX: 'auto' }}>
        <table className="simple"><tbody>
          <tr><th>Name</th><th>Email</th><th>Role</th><th>Project access</th><th>Status</th><th /></tr>
          {users.map((u) => (
            <tr key={u.email}>
              <td>{u.name}</td><td className="mono">{u.email}</td>
              <td><select value={u.role} disabled={u.email === S.me.email} onChange={(e) => update(u.email, { role: e.target.value }, 'Role updated.')}>{roleOpts}</select></td>
              <td><button className="btn sm" type="button" disabled={FULL_ACCESS.includes(u.role)} onClick={() => ui.openModal(<AccessModal user={u} roleLabel={roleLabel(u.role)} onSaved={reload} />)}>{accessText(u)}</button></td>
              <td>{u.active ? 'Active' : <span style={{ color: 'var(--bad)' }}>Disabled</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn" type="button" onClick={() => resetPw(u.email)}>Reset password</button>
                {u.email !== S.me.email && <> <button className="btn" type="button" onClick={() => update(u.email, { active: !u.active }, 'Updated.')}>{u.active ? 'Disable' : 'Enable'}</button></>}
              </td>
            </tr>
          ))}
        </tbody></table>
      </div>

      <div className="section-title">What each role can do</div>
      <div className="card" style={{ marginBottom: 18, overflowX: 'auto' }}>
        <table className="simple"><tbody>
          <tr><th>Role</th><th>Purpose</th><th>Can</th></tr>
          {roles.map((r) => (
            <tr key={r.key}><td><b>{r.label}</b></td><td className="muted">{r.description}</td>
              <td>{r.caps.length ? r.caps.map((c) => <span key={c}><Chip>{(S.capLabels || {})[c] || c}</Chip> </span>) : <span className="muted">View only</span>}</td></tr>
          ))}
        </tbody></table>
        <div className="fact-sub" style={{ marginTop: 8 }}>Everyone can read what their project access allows. Project access is checked on the server, not just hidden in the screen.</div>
      </div>

      <div className="section-title">Add user</div>
      <div className="card">
        <div className="setup-grid">
          <div className="field"><label>Name</label><input value={nu.name} onChange={set('name')} /></div>
          <div className="field"><label>Email</label><input type="email" autoComplete="off" value={nu.email} onChange={set('email')} /></div>
          <div className="field"><label>Role</label><select value={nu.role} onChange={set('role')}>{roleOpts}</select></div>
          <div className="field"><label>Temporary password (min 10 characters)</label><input type="text" autoComplete="off" value={nu.password} onChange={set('password')} /></div>
        </div>
        <div className="fact-sub" style={{ marginBottom: 10 }}>New users can see all projects. Use “Project access” in the table to limit them.</div>
        <button className="btn primary" type="button" onClick={add}>Add user</button>
      </div>
    </>
  );
}

function AccessModal({ user, roleLabel, onSaved }) {
  const S = useStore();
  const ui = useUi();
  const [all, setAll] = useState(!user.project_ids);
  const [chosen, setChosen] = useState(() => new Set(user.project_ids || []));
  const toggle = (id, on) => setChosen((prev) => { const n = new Set(prev); on ? n.add(id) : n.delete(id); return n; });
  const save = async () => {
    if (!all && !chosen.size) { ui.toast('Choose at least one project, or allow all.'); return; }
    try {
      await api('PUT', '/auth/users/' + encodeURIComponent(user.email), { project_ids: all ? null : [...chosen] });
      ui.toast('Access saved. They are signed out so it takes effect.'); ui.closeModal(); onSaved();
    } catch (e) { ui.toast(e.message); }
  };
  return (
    <>
      <ModalHead kicker="Project access" title={`${user.name} · ${roleLabel}`} />
      <div className="modal-body">
        <section className="step">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Can see every project</label>
          <p className="step-desc" style={{ marginLeft: 0 }}>Untick to choose the projects this person can see and work on. Company-wide records stay visible to everyone but can only be changed by unrestricted accounts.</p>
          <div style={all ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            {PROJECT_CATS.map(([cat, label]) => {
              const list = projectsIn(S, cat);
              return list.length ? <div className="q-group" key={cat}><h5>{label}</h5>{list.map((id) => (
                <label key={id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 13 }}><input type="checkbox" checked={chosen.has(id)} onChange={(e) => toggle(id, e.target.checked)} /> {S.projects[id].name}</label>
              ))}</div> : null;
            })}
          </div>
        </section>
      </div>
      <div className="modal-foot"><button className="btn primary" type="button" onClick={save}>Save access</button></div>
    </>
  );
}
