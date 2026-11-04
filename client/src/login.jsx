import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './login.css';

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (r.ok) { location.href = '/'; return; }
      const j = await r.json().catch(() => ({}));
      setErr(j.error || 'Sign-in failed.');
    } catch { setErr('Could not reach the server.'); }
    setBusy(false);
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="brand"><img src="images/nyati%20logo.avif" alt="Nyati" />Compliance Tracker</div>
      <div className="subtitle">Sign in to access real estate compliance &amp; regulatory intelligence</div>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="err" role="alert" style={err ? { display: 'block' } : undefined}>{err}</div>
      <button type="submit" disabled={busy}>Sign in</button>
    </form>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><Login /></StrictMode>);
