import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * GET a URL now and again every `ms` (when given) while the component is shown. Returns [data, error, reload].
 * `url` null = nothing to load. Repeated identical answers do not re-render.
 */
export function useRemote(url, ms) {
  const [state, setState] = useState({ data: null, error: null, url: null });
  const last = useRef(null), alive = useRef(true), urlRef = useRef(url);
  urlRef.current = url;
  const load = useRef(null);
  load.current = async () => {
    const u = urlRef.current; if (!u) return;
    try {
      const data = await api('GET', u);
      const sig = JSON.stringify(data);
      if (!alive.current || urlRef.current !== u) return;
      if (sig === last.current) return;
      last.current = sig;
      setState({ data, error: null, url: u });
    } catch (e) { if (alive.current && urlRef.current === u) setState((p) => ({ ...p, error: e.message, url: u })); }
  };
  useEffect(() => {
    alive.current = true; last.current = null;
    load.current();
    const t = ms ? setInterval(() => load.current(), ms) : null;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [url, ms]);
  const fresh = state.url === url;
  return [fresh ? state.data : null, fresh ? state.error : null, () => { last.current = null; return load.current(); }];
}
