export function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function daysUntil(iso) { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 86400000); }
export function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
export const docWhen = (iso) => (iso ? fmtDate(String(iso).slice(0, 10)) : '');
export const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
};
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'x';
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
export const numOrNull = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; };
export const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
