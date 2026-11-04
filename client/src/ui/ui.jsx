// Page-wide UI pieces: the toast, the one modal/drawer slot, and small shared building blocks.
import { Fragment, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const UiCtx = createContext(null);
export const useUi = () => useContext(UiCtx);

export function UiProvider({ children }) {
  const [toastMsg, setToastMsg] = useState('');
  const [toastOn, setToastOn] = useState(false);
  const timer = useRef(null);
  const toast = useCallback((msg, ms) => {
    setToastMsg(msg); setToastOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToastOn(false), ms || Math.min(9000, Math.max(2400, String(msg).length * 45)));
  }, []);

  const [modal, setModal] = useState(null);
  const seq = useRef(0);
  // A fresh key per opening, so a dialog opened again (e.g. another record) starts with its own state.
  const openModal = useCallback((el) => setModal(<Fragment key={++seq.current}>{el}</Fragment>), []);
  const closeModal = useCallback(() => setModal(null), []);

  return (
    <UiCtx.Provider value={{ toast, modal, openModal, closeModal }}>
      {children}
      <div className={'toast' + (toastOn ? ' show' : '')}>{toastMsg}</div>
    </UiCtx.Provider>
  );
}

/** The overlay and the centred drawer that every dialog opens in. */
export function ModalHost() {
  const { modal, closeModal } = useUi();
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; }, [modal]);
  return (
    <>
      <div className={'overlay' + (modal ? ' show' : '')} onClick={closeModal} />
      <div className={'drawer' + (modal ? ' show' : '')} ref={ref}>{modal}</div>
    </>
  );
}

/** Header of a dialog: small badges, the title, and the close button. */
export function ModalHead({ kicker, badges, title, titleAttr, sub, children }) {
  const { closeModal } = useUi();
  return (
    <div className="modal-head">
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="modal-badges">{kicker != null && <span className="modal-id mono">{kicker}</span>}{badges}</div>
        <h3 className="modal-title" title={titleAttr}>{title}</h3>
        {sub && <div className="fact-sub">{sub}</div>}
        {children}
      </div>
      <button className="drawer-close" type="button" aria-label="Close" onClick={closeModal}>✕</button>
    </div>
  );
}

export const Chip = ({ cls, title, style, children }) => <span className={'chip' + (cls ? ' ' + cls : '')} title={title} style={style}>{children}</span>;
export const Badge = ({ cls, children }) => <span className={'badge' + (cls ? ' ' + cls : '')}>{children}</span>;
export const Empty = ({ style, children }) => <div className="empty-state" style={style}>{children}</div>;
export const Spinner = () => <span className="spin" />;

/** A <details> fold that remembers whether it is open across re-renders and visits. */
export function Fold({ title, aside, open, onToggle, className = 'fold', style, children, bodyStyle }) {
  return (
    <details className={className} open={open} style={style} onToggle={onToggle ? (e) => { if (e.currentTarget.open !== open) onToggle(e.currentTarget.open); } : undefined}>
      <summary><span>{title}</span>{aside}</summary>
      <div className="fold-body" style={bodyStyle}>{children}</div>
    </details>
  );
}

/** A link that runs an action instead of navigating. */
export const ActionLink = ({ onClick, className, children, title }) => (
  <a href="#" className={className} title={title} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}>{children}</a>
);

/** Runs an async action with its button disabled, and reports a failure in the toast. */
export function useBusy() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, prefix = '') => {
    setBusy(true);
    try { return await fn(); }
    catch (e) { toast(prefix + (e?.message || 'error'), 6000); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return [busy, run];
}
