import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api } from './lib/api.js';
import { UiProvider } from './ui/ui.jsx';
import { StoreProvider, loadStatic } from './state/store.jsx';
import App from './App.jsx';

function Boot() {
  const [boot, setBoot] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      const me = await api('GET', '/auth/me');      // a 401 goes to the sign-in page
      let roles = [], capLabels = {};
      try { const r = await api('GET', '/auth/roles'); roles = r.roles; capLabels = r.caps; } catch { /* the role table is optional */ }
      setBoot({ me, roles, capLabels, statics: await loadStatic() });
    })().catch((e) => { if (e.message !== 'not signed in') setErr(e.message); });
  }, []);
  if (err) return <div className="empty-state">Could not load the app: {err}</div>;
  if (!boot) return <div className="empty-state">Loading compliance data…</div>;
  return <StoreProvider {...boot}><App /></StoreProvider>;
}

createRoot(document.getElementById('root')).render(<StrictMode><UiProvider><Boot /></UiProvider></StrictMode>);
