// Everything the screens share: the register data, the stored collections (re-read every few seconds so other
// people's changes appear), the signed-in user, the selected company/project, and the actions that write data.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { buildInstances, ctxFromValue, getTracking, validCtx } from '../lib/records.js';
import { useUi } from '../ui/ui.jsx';

const StoreCtx = createContext(null);
export const useStore = () => useContext(StoreCtx);

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.data]));
// Where each server collection lives in the store, and how its rows are kept.
const COLLECTIONS = {
  tracking: ['tracking', byId],
  projects: ['projects', byId],
  companies: ['companies', byId],
  phases: ['phases', byId],
  buildings: ['buildings', byId],
  applicability: ['applic', byId],
  settings: ['settingsMap', byId],
  risk_overrides: ['risk', byId],
  stage_overrides: ['stageOverrides', (rows) => Object.fromEntries(rows.map((r) => [r.id, r.data.stage_id]))],
  documents: ['docsByKey', (rows) => {
    const m = {};
    for (const r of rows) { const row = { id: r.id, ...r.data }; (m[row.key] = m[row.key] || []).push(row); }
    return m;
  }]
};
const EMPTY = Object.fromEntries(Object.values(COLLECTIONS).map(([field]) => [field, {}]));
const VIEWS = ['dashboard', 'stages', 'calendar', 'register', 'documents', 'vault', 'regulatory', 'projects', 'dq', 'users', 'settings'];

/** The register itself (read-only files shipped with the app). */
export async function loadStatic() {
  const get = (f) => fetch('/data/' + f).then((r) => { if (r.status === 401) { location.href = '/login.html'; } if (!r.ok) throw new Error(f + ': HTTP ' + r.status); return r.json(); });
  const [items, stages, cat, profiles, deps] = await Promise.all(['items.json', 'stages.json', 'applicability.json', 'profiles.json', 'dependencies.json'].map(get));
  const coverage = await get('coverage-gaps.json').catch(() => null);
  const riskProposals = await get('risk-proposals.json').catch(() => ({ proposals: {} }));
  return { items, stages, cat, profiles, deps, coverage, riskProposals, itemById: Object.fromEntries(items.map((i) => [i.compliance_id, i])) };
}

const viewFromHash = () => { const v = location.hash.replace(/^#\/?/, ''); return VIEWS.includes(v) ? v : 'dashboard'; };

export function StoreProvider({ me, roles, capLabels, statics, children }) {
  const { toast } = useUi();
  const [cols, setCols] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const sigs = useRef({});

  /** Re-read some collections right away (instead of waiting for the next refresh). Only real changes re-render. */
  const reload = useCallback(async (names = Object.keys(COLLECTIONS)) => {
    const results = await Promise.all(names.map((n) => api('GET', '/api/' + n).then((rows) => [n, rows]).catch((e) => { console.warn(n + ' load error', e); return null; })));
    const patch = {};
    for (const r of results) {
      if (!r) continue;
      const [n, rows] = r, sig = JSON.stringify(rows);
      if (sigs.current[n] === sig) continue;
      sigs.current[n] = sig;
      const [field, shape] = COLLECTIONS[n];
      patch[field] = shape(rows);
    }
    if (Object.keys(patch).length) setCols((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    reload().then(() => setLoaded(true));
    const t = setInterval(() => reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);

  const D = useMemo(() => ({ ...statics, ...cols }), [statics, cols]);

  /* ---------- what is being viewed ---------- */
  const [ctx, setCtxState] = useState({ companyId: null, projectId: null });
  const [dashPortfolio, setDashPortfolio] = useState(false);
  useEffect(() => { const v = validCtx(D, ctx); if (v !== ctx) setCtxState(v); }, [D, ctx]);
  const setCtx = useCallback((value) => { const c = ctxFromValue(D, value); if (c) setCtxState(c); }, [D]);
  const { inst, instByKey } = useMemo(() => buildInstances(D, ctx), [D, ctx]);

  const [view, setViewState] = useState(viewFromHash);
  const setView = useCallback((v) => { setViewState(v); if (location.hash !== '#/' + v) history.replaceState(null, '', '#/' + v); }, []);
  useEffect(() => { const on = () => setViewState(viewFromHash()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);

  const can = useCallback((cap) => !!(me && (me.caps || []).includes(cap)), [me]);

  /* ---------- notifications (the bell) ---------- */
  const [notes, setNotes] = useState([]);
  const loadNotes = useCallback(async () => {
    try { setNotes((await api('GET', '/api/notifications')).map((r) => ({ id: r.id, ...r.data }))); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => { loadNotes(); const t = setInterval(loadNotes, 60000); return () => clearInterval(t); }, [loadNotes]);

  /* ---------- regulatory updates (the list, and the unread count in the menu) ---------- */
  const [ru, setRu] = useState({ rows: null, opts: null, err: '' });
  const ruLoading = useRef(false), ruOpts = useRef(null);   // the options (categories, stages, people) are read once
  const loadRegulatory = useCallback(async () => {
    if (ruLoading.current) return; ruLoading.current = true;
    try {
      const [rows, opts] = await Promise.all([api('GET', '/api/regulatory/updates'), ruOpts.current || api('GET', '/api/regulatory/options')]);
      ruOpts.current = opts;
      setRu({ rows, opts, err: '' });
    } catch (e) { setRu((p) => ({ ...p, rows: p.rows || [], err: e.message })); }
    ruLoading.current = false;
  }, []);
  const ensureRuOptions = useCallback(async () => {
    if (ruOpts.current) return ruOpts.current;
    try { const opts = ruOpts.current = await api('GET', '/api/regulatory/options'); setRu((p) => ({ ...p, opts })); return opts; } catch { return null; }
  }, []);
  useEffect(() => { loadRegulatory(); const t = setInterval(loadRegulatory, 120000); return () => clearInterval(t); }, [loadRegulatory]);
  const markRuRead = useCallback((id) => setRu((p) => ({ ...p, rows: p.rows && p.rows.map((r) => (r.id === id ? { ...r, read: true } : r)) })), []);

  /* ---------- writes ---------- */
  /** Save a record's status. The server refuses "completed" while documents are missing/unverified or a prerequisite is open. */
  const saveTracking = useCallback(async (it, patch) => {
    if (!it.key) { toast('Not saved — this record is not part of the current view.'); return { ok: false }; }
    const prev = getTracking(D, it.key, it.item);
    const next = { ...prev, ...patch, last_updated_by: me.name, updated_at: new Date().toISOString() };
    try {
      await api('PUT', '/api/tracking/' + encodeURIComponent(it.key), next);
      if (patch.status && patch.status !== prev.status) {
        await api('POST', '/api/audit', {
          key: it.key, compliance_id: it.item.compliance_id, project_id: it.projectId || null, scope_type: it.scopeType, scope_id: it.scopeId,
          old_status: prev.status || 'Not Started', new_status: patch.status, who: me.name, remark: patch.remarks || '', at: new Date().toISOString()
        });
      }
      await reload(['tracking']);
      toast(patch.override_reason ? 'Saved with an override. It is recorded in the audit trail.' : 'Saved.');
      return { ok: true };
    } catch (e) {
      if (e.status === 409 && e.body && e.body.gate) return { blocked: true, message: e.message, canOverride: !!e.body.can_override };
      console.warn(e);
      toast('Save failed: ' + (e.message || 'error'));
      return { ok: false };
    }
  }, [D, me, reload, toast]);

  /** Create or replace one stored document, then re-read its collection. */
  const putDoc = useCallback(async (col, id, data) => {
    await api('PUT', `/api/${col}/${encodeURIComponent(id)}`, data);
    await reload([col]);
  }, [reload]);

  /** Ask the server to re-decide applicability for a company/project after setup answers change. */
  const regenerate = useCallback(async (scope) => {
    const r = await api('POST', '/api/generate', scope);
    await reload(['applicability']);
    return r.summary;
  }, [reload]);

  const value = {
    ...D, loaded, reload, me, roles, capLabels, can,
    ctx, setCtx, setCtxState, dashPortfolio, setDashPortfolio, inst, instByKey,
    view, setView, notes, setNotes, loadNotes, ru, setRu, loadRegulatory, ensureRuOptions, markRuRead,
    saveTracking, putDoc, regenerate, D
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
