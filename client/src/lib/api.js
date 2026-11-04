// Talks to the server (server/server.js). A 401 means the session ended, so go back to the sign-in page.
const toLogin = () => { location.href = '/login.html'; };

async function handle(r) {
  if (r.status === 401) { toLogin(); throw new Error('not signed in'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
  return j;
}

export function api(method, url, body) {
  return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }).then(handle);
}

/** File routes take a custom header instead of the usual JSON check. */
export function fileApi(method, url, body) {
  return fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) }).then(handle);
}

/** Posts a file as the raw body; its details travel in the query string. */
export function uploadFile(path, file, query, type = 'application/octet-stream') {
  return fetch(path + '?' + new URLSearchParams(query).toString(), { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': type }, body: file }).then(handle);
}

export async function logout() {
  try { await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* signed out anyway */ }
  toLogin();
}

/** Save generated text as a file. */
export function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Start downloading a server file without leaving the page. */
export function downloadUrl(href) {
  const a = document.createElement('a'); a.href = href; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
}
