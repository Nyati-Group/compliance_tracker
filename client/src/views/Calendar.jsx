import { useStore } from '../state/store.jsx';
import { useSticky } from '../state/sticky.js';
import { useUi, Badge, Empty } from '../ui/ui.jsx';
import { download } from '../lib/api.js';
import { todayISO } from '../lib/format.js';
import { statusDef } from '../lib/constants.js';
import { ctxName } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { StatusLegend } from './Stages.jsx';

function monthMatrix(year, month) {
  const startDow = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate(), cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
/** Records by due date; not-applicable and unreviewed records stay off the calendar. */
function itemsByDueDate(inst) {
  const map = {}, undated = [];
  for (const i of inst) {
    if (i.state !== 'active' || i.status === 'Not Applicable') continue;
    const it = i.item, due = i.tr.next_due_date;
    if (due) (map[due] = map[due] || []).push(i);
    else if (['undated_by_nature', 'due_date_to_be_set', 'unparsed'].includes(it.due_date_parse_status)) undated.push(i);
  }
  return { map, undated };
}
function buildICS(map) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Compliance Tracker//EN'];
  for (const [dateStr, list] of Object.entries(map)) {
    for (const i of list) {
      const it = i.item;
      lines.push('BEGIN:VEVENT', 'UID:' + i.key + '-' + dateStr + '@compliance-tracker', 'DTSTART;VALUE=DATE:' + dateStr.replace(/-/g, ''),
        'SUMMARY:' + it.compliance_id + (i.scopeShort ? ' (' + i.scopeShort + ')' : '') + ' — ' + (it.brief_description || '').replace(/\n/g, ' ').slice(0, 120),
        'DESCRIPTION:' + (it.action_required || '').replace(/\n/g, ' ').slice(0, 500).replace(/,/g, '\\,'), 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export default function Calendar() {
  const S = useStore();
  const ui = useUi();
  const [month, setMonth] = useSticky('calendar.month', () => new Date());
  const [und, setUnd] = useSticky('calendar.undated', { q: '', n: 50 });
  const y = month.getFullYear(), m = month.getMonth();
  const { map, undated } = itemsByDueDate(S.inst);
  const today = todayISO();
  const open = (key) => ui.openModal(<RecordDrawer refKey={key} />);

  const q = und.q.trim().toLowerCase();
  const rows = undated.filter((i) => !q || [i.item.compliance_id, i.item.brief_description, i.item.department, i.scopeShort, i.status].join(' ').toLowerCase().includes(q));
  const shown = rows.slice(0, und.n);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="btn sm" type="button" aria-label="Previous month" onClick={() => setMonth(new Date(y, m - 1, 1))}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <h3 style={{ minWidth: 170, fontWeight: 700 }}>{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h3>
        <button className="btn sm" type="button" aria-label="Next month" onClick={() => setMonth(new Date(y, m + 1, 1))}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <button className="btn sm" type="button" onClick={() => setMonth(new Date())}>Today</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ctxName(S, S.ctx)}</span>
        <button className="btn primary sm" type="button" style={{ marginLeft: 'auto' }} onClick={() => download('compliance-calendar.ics', buildICS(map), 'text/calendar')}>Export .ics</button>
      </div>
      <StatusLegend />
      <div className="cal-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {monthMatrix(y, m).map((d, idx) => {
          if (d === null) return <div key={'x' + idx} className="cal-cell off" />;
          const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, entries = map[dateStr] || [];
          return (
            <div key={dateStr} className={'cal-cell' + (dateStr === today ? ' today' : '')}>
              <div className="dnum">{d}</div>
              {entries.slice(0, 3).map((i) => (
                <div key={i.key} className={'cal-chip badge ' + statusDef(i.status).cls} onClick={() => open(i.key)}
                  title={i.item.compliance_id + ' — ' + i.item.brief_description + (i.scopeShort ? ' (' + i.scopeShort + ')' : '')}>{i.item.compliance_id}</div>
              ))}
              {entries.length > 3 && <div className="cal-more">+{entries.length - 3} more</div>}
            </div>
          );
        })}
      </div>
      <div className="undated-panel card">
        <div className="und-head">
          <div><h3>Event-based / Ongoing</h3><div className="fact-sub">Compliances with no fixed due date. Click a row to open it.</div></div>
          <input type="search" className="und-search" placeholder="Search by ID, description, department or status" aria-label="Search event-based compliances"
            value={und.q} onChange={(e) => setUnd({ q: e.target.value, n: 50 })} />
        </div>
        {!rows.length ? <Empty>{undated.length ? 'No compliances match your search.' : 'No event-based compliances.'}</Empty> : <>
          <div className="und-count">{q ? `${rows.length} of ${undated.length}` : undated.length} compliance{rows.length === 1 ? '' : 's'}</div>
          <div className="table-wrap"><table className="und-table"><thead><tr><th>ID</th><th>Compliance</th><th>Department</th><th>Applies to</th><th>Status</th></tr></thead><tbody>
            {shown.map((i) => (
              <tr key={i.key} onClick={() => open(i.key)}>
                <td className="mono">{i.item.compliance_id}</td><td><div className="und-desc">{i.item.brief_description || ''}</div></td><td>{i.item.department || ''}</td>
                <td>{i.scopeShort || 'Entity'}</td><td><Badge cls={statusDef(i.status).cls}>{i.status}</Badge></td>
              </tr>
            ))}
          </tbody></table></div>
          {rows.length > shown.length && <div style={{ textAlign: 'center', marginTop: 10 }}><button className="btn sm" type="button" onClick={() => setUnd({ ...und, n: und.n + 50 })}>Show {Math.min(50, rows.length - shown.length)} more ({rows.length - shown.length} remaining)</button></div>}
        </>}
      </div>
    </>
  );
}
