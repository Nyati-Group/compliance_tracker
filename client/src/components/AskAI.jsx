// The "Ask AI" button and chat panel. The conversation is kept for this browser tab (sessionStorage).
import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useUi } from '../ui/ui.jsx';

const KEY = 'nyatiAiChat';
const loadChat = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]').filter((m) => m && typeof m.content === 'string'); } catch { return []; } };
const saveChat = (msgs) => { try { sessionStorage.setItem(KEY, JSON.stringify(msgs.slice(-40))); } catch { /* private window */ } };

/* ---------- a small Markdown reader for the assistant's answers: tables, headings, lists, bold, italics, code ---------- */
function Inline({ text }) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(^|[^*])\*([^*\n]+)\*/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    let start = m.index;
    if (m[3] !== undefined) { start += m[3].length; }
    if (start > last) out.push(text.slice(last, start));
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k++}>{m[2]}</strong>);
    else out.push(<em key={k++}>{m[4]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function Markdown({ src }) {
  const isTbl = (l) => /^\s*\|.*\|\s*$/.test(l), isUl = (l) => /^\s*[-*•]\s+/.test(l), isOl = (l) => /^\s*\d+[.)]\s+/.test(l), isH = (l) => /^#{1,4}\s/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const lines = String(src).split('\n'), out = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i], k = out.length;
    if (isTbl(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(ln); i += 2; const body = [];
      while (i < lines.length && isTbl(lines[i])) body.push(cells(lines[i++]));
      out.push(<div className="md-table" key={k}><table><thead><tr>{head.map((h, j) => <th key={j}><Inline text={h} /></th>)}</tr></thead>
        <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}><Inline text={c} /></td>)}</tr>)}</tbody></table></div>);
    } else if (isH(ln)) { out.push(<h5 key={k}><Inline text={ln.replace(/^#{1,4}\s+/, '')} /></h5>); i++; }
    else if (isUl(ln)) { const li = []; while (i < lines.length && isUl(lines[i])) li.push(lines[i++].replace(/^\s*[-*•]\s+/, '')); out.push(<ul key={k}>{li.map((t, j) => <li key={j}><Inline text={t} /></li>)}</ul>); }
    else if (isOl(ln)) { const li = []; while (i < lines.length && isOl(lines[i])) li.push(lines[i++].replace(/^\s*\d+[.)]\s+/, '')); out.push(<ol key={k}>{li.map((t, j) => <li key={j}><Inline text={t} /></li>)}</ol>); }
    else if (!ln.trim()) i++;
    else {
      const p = [ln]; i++;
      while (i < lines.length && lines[i].trim() && !isTbl(lines[i]) && !isUl(lines[i]) && !isOl(lines[i]) && !isH(lines[i])) p.push(lines[i++]);
      out.push(<p key={k}>{p.map((t, j) => <Fragment key={j}>{j > 0 && <br />}<Inline text={t} /></Fragment>)}</p>);
    }
  }
  return out;
}

export default function AskAI() {
  const { toast } = useUi();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState(loadChat);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [input, setInput] = useState('');
  const box = useRef(null), inputRef = useRef(null), fab = useRef(null);

  useEffect(() => { saveChat(msgs); }, [msgs]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [msgs, busy, err, open]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && open) { setOpen(false); fab.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {   // grow the box with its text, up to a limit
    const el = inputRef.current; if (!el) return;
    el.style.height = 'auto'; if (input) el.style.height = Math.min(el.scrollHeight, 110) + 'px';
  }, [input]);

  const ask = async (text) => {
    text = String(text || '').trim();
    if (!text || busy) return;
    setErr(null); setBusy(true);
    const asked = [...msgs, { role: 'user', content: text }];
    setMsgs(asked);
    try {
      const r = await api('POST', '/api/chat', { messages: asked.map((m) => ({ role: m.role, content: m.content })) });
      setMsgs([...asked, { role: 'assistant', content: r.answer, sources: r.sources, id: r.id }]);
    } catch (e) {
      setMsgs(msgs);                                  // drop the unanswered question and hand it back to the input box
      setErr(e.message || 'Something went wrong.');
      setInput((v) => v || text);
    }
    setBusy(false);
    inputRef.current?.focus();
  };
  const feedback = async (i, value) => {
    const m = msgs[i]; if (!m || !m.id) return;
    try { await api('POST', '/api/chat/feedback', { id: m.id, value }); setMsgs((list) => list.map((x, j) => (j === i ? { ...x, fb: value } : x))); }
    catch { toast('Could not save feedback.'); }
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Could not copy.'); } };
  const submit = (e) => { e.preventDefault(); const t = input; setInput(''); ask(t); };

  return (
    <>
      <button ref={fab} className="ai-fab" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="aiPanel" onClick={() => setOpen(!open)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
          <path d="M5 3v4M3 5h4M19 17v4M17 19h4" />
        </svg>
        <span>Ask AI</span>
      </button>
      <section className={'ai-panel' + (open ? ' open' : '')} id="aiPanel" role="dialog" aria-label="Compliance Assistant">
        <div className="ai-head">
          <h3>Compliance Assistant</h3>
          <button type="button" onClick={() => { if (!busy) { setMsgs([]); setErr(null); } }}>New chat</button>
          <button type="button" aria-label="Close assistant" onClick={() => { setOpen(false); fab.current?.focus(); }}>✕</button>
        </div>
        <div className="ai-msgs" ref={box} aria-live="polite">
          {!msgs.length && !busy && <div className="ai-welcome">Hello! I'm the Compliance Assistant. Ask me about UDCPR, RERA/MahaRERA, approvals or any item in the compliance register.</div>}
          {msgs.map((m, i) => (m.role === 'user'
            ? <div key={i} className="ai-msg user">{m.content}</div>
            : <div key={i} className="ai-msg bot"><Markdown src={m.content} />
              {m.sources && m.sources.length > 0 && <div className="ai-src"><b>Sources:</b> {m.sources.join(' · ')}</div>}
              <div className="ai-actions"><button type="button" onClick={() => copy(m.content)}>Copy</button>
                {m.id && <>
                  <button type="button" className={m.fb === 'up' ? 'on' : ''} aria-label="Helpful" onClick={() => feedback(i, 'up')}>👍</button>
                  <button type="button" className={m.fb === 'down' ? 'on' : ''} aria-label="Not helpful" onClick={() => feedback(i, 'down')}>👎</button>
                </>}</div></div>))}
          {busy && <div className="ai-msg bot"><span className="ai-typing" aria-label="Assistant is typing"><i /><i /><i /></span></div>}
          {err && <div className="ai-msg bot err">{err}</div>}
        </div>
        <form className="ai-form" onSubmit={submit}>
          <textarea ref={inputRef} rows={1} placeholder="Ask about UDCPR, RERA or a compliance item…" aria-label="Your question" maxLength={2000} value={input}
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} />
          <button className="btn primary" type="submit" disabled={busy}>Send</button>
        </form>
        <div className="ai-note">AI guidance for internal compliance reference. Verify against the official text before filing.</div>
      </section>
    </>
  );
}
