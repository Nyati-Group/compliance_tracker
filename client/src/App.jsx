import { useEffect, useState } from 'react';
import { useStore } from './state/store.jsx';
import { ModalHost } from './ui/ui.jsx';
import { logout } from './lib/api.js';
import { ctxValue, projectsIn } from './lib/records.js';
import { PROJECT_CATS } from './lib/constants.js';
import Bell from './components/Notifications.jsx';
import AskAI from './components/AskAI.jsx';
import Dashboard from './views/Dashboard.jsx';
import Stages from './views/Stages.jsx';
import Calendar from './views/Calendar.jsx';
import Register from './views/Register.jsx';
import Projects from './views/Projects.jsx';
import DataQuality from './views/DataQuality.jsx';
import Users from './views/Users.jsx';
import Settings from './views/Settings.jsx';
import Regulatory from './views/Regulatory.jsx';
import Documents from './views/Documents.jsx';
import Vault from './views/Vault.jsx';

const ic = (paths) => <svg className="nav-ic" viewBox="0 0 24 24" aria-hidden="true">{paths}</svg>;
const NAV = [
  ['Overview'],
  ['dashboard', 'Dashboard', ic(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>)],
  ['stages', 'Stages', ic(<><path d="M12 3 2.5 8 12 13l9.5-5L12 3z" /><path d="m2.5 12.5 9.5 5 9.5-5" /><path d="m2.5 17 9.5 5 9.5-5" /></>)],
  ['calendar', 'Calendar', ic(<><rect x="3" y="4.5" width="18" height="16.5" rx="2.5" /><path d="M8 2.5v4M16 2.5v4M3 10h18" /></>)],
  ['register', 'Register', ic(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>)],
  ['documents', 'Documents', ic(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5" /><path d="m9 16.5 1-3 4.6-4.6 2 2L12 15.5l-3 1z" /></>)],
  ['vault', 'Document Vault', ic(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M3 11h18" /></>)],
  ['regulatory', 'Regulatory Updates', ic(<><path d="M4 5.5h13a2 2 0 0 1 2 2V19H6a2 2 0 0 1-2-2V5.5z" /><path d="M19 9h2v8a2 2 0 0 1-2 2M8 10h7M8 13.5h7" /></>)],
  ['Manage'],
  ['projects', 'Projects', ic(<><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7.5h2M13 7.5h2M9 11.5h2M13 11.5h2M9 15.5h2M13 15.5h2M10.5 21v-3h3v3" /></>)],
  ['dq', 'Data Quality', ic(<><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3z" /><path d="m9 12 2.2 2.2L15.5 10" /></>)],
  ['Account'],
  ['users', 'Users', ic(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M17.5 14.2c2.2.2 3.7 1.7 4 4.3" /></>)],
  ['settings', 'Settings', ic(<><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>)]
];
const VIEWS = { dashboard: Dashboard, stages: Stages, calendar: Calendar, register: Register, documents: Documents, vault: Vault, regulatory: Regulatory, projects: Projects, dq: DataQuality, users: Users, settings: Settings };

function ProjectSelect() {
  const S = useStore();
  const co = Object.keys(S.companies)[0];
  const groups = PROJECT_CATS.map(([cat, label]) => [label, projectsIn(S, cat)]).filter(([, ids]) => ids.length);
  return (
    <select className="pill" value={ctxValue(S.ctx)} onChange={(e) => { S.setDashPortfolio(false); S.setCtx(e.target.value); }}>
      {co ? <option value={'c:' + co}>Company-wide · {S.companies[co].name || co}</option> : !groups.length && <option value="">No company set up</option>}
      {groups.map(([label, ids]) => <optgroup key={label} label={label}>{ids.map((id) => <option key={id} value={'p:' + id}>{S.projects[id].name || id}</option>)}</optgroup>)}
    </select>
  );
}

export default function App() {
  const S = useStore();
  const { me } = S;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const unreadRu = (S.ru.rows || []).filter((r) => r.relevant && !r.read && !r.archive).length;
  const View = VIEWS[S.view] || Dashboard;
  useEffect(() => { window.scrollTo(0, 0); }, [S.view]);   // each screen opens at its top
  return (
    <>
      <div id="app">
        <div className={'mobile-overlay' + (mobileNavOpen ? ' show' : '')} onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
        <aside className={'sidebar' + (mobileNavOpen ? ' open' : '')}>
          <div className="brand">
            <img className="logo" src="images/nyati%20logo.avif" alt="Nyati" />
            <span>Compliance Tracker</span>
            <button className="mobile-nav-close" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>✕</button>
          </div>
          <nav className="tabs" aria-label="Main">
            {NAV.map(([view, label, icon]) => (label === undefined
              ? <div className="nav-label" key={view}>{view}</div>
              : (view !== 'users' || S.can('manage_users')) && (
                <button key={view} type="button" className={'tab' + (S.view === view ? ' active' : '')} onClick={() => { S.setView(view); setMobileNavOpen(false); }}>
                  {icon}<span>{label}</span>
                  {view === 'regulatory' && unreadRu > 0 && <span className="nav-count">{unreadRu > 99 ? '99+' : unreadRu}</span>}
                </button>
              )))}
          </nav>
          <div className="side-user">
            <div className="side-avatar">{(me.name || '?').trim().charAt(0).toUpperCase()}</div>
            <div><div className="nm">{me.name}</div><div className="rl">{me.role_label || me.role}</div></div>
          </div>
        </aside>
        <div className="content">
          <div className="topbar">
            <div className="topbar-left">
              <button className="menu-toggle-btn" type="button" aria-label="Toggle navigation menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(!mobileNavOpen)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <div className="mobile-brand-title">Compliance Tracker</div>
            </div>
            <div className="topbar-right">
              <ProjectSelect />
              <span className="pill" style={{ cursor: 'default' }}>{me.name} · {me.role_label || me.role}</span>
              <Bell />
              <button className="pill" type="button" onClick={logout}>Sign out</button>
            </div>
          </div>
          <main id="main">{S.loaded ? <View /> : <div className="empty-state">Loading compliance data…</div>}</main>
        </div>
      </div>
      <ModalHost />
      <AskAI />
    </>
  );
}
