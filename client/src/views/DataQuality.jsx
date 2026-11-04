import { useStore } from '../state/store.jsx';
import { useUi } from '../ui/ui.jsx';
import { Core } from '../lib/core.js';
import { categoryOf, effectiveStageId, unansweredCompany } from '../lib/records.js';
import RecordDrawer from '../components/RecordDrawer.jsx';

const Count = ({ n }) => <span className="mono" style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({n})</span>;
const Note = ({ children }) => (children ? <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{children}</div> : null);

export default function DataQuality() {
  const S = useStore();
  const ui = useUi();
  const items = S.items;
  const pName = (id) => (S.projects[id] || {}).name || id;

  // Set-up checks (companies, projects, phases, buildings, applicability decisions)
  const setupIssues = [];
  for (const [id, p] of Object.entries(S.projects)) {
    if (!p.company_id || !S.companies[p.company_id]) setupIssues.push([pName(id), 'No valid company assigned']);
    if (!p.location && !p.planning_authority) setupIssues.push([pName(id), 'Location / planning authority not entered']);
    if (categoryOf(p) === 'epc') continue;      // EPC projects only track contract labour and IT, so the checks below don't apply
    if (!p.project_type) setupIssues.push([pName(id), 'Project type not chosen']);
    if (!p.site_area_ha && !p.built_up_area_sqm) setupIssues.push([pName(id), 'No site or built-up area (needed for the Environmental Clearance threshold)']);
    if (!Object.values(S.buildings).some((b) => b.project_id === id)) setupIssues.push([pName(id), 'No buildings added, so building-level records are not listed']);
  }
  for (const [id, b] of Object.entries(S.buildings)) {
    if (!S.projects[b.project_id]) setupIssues.push([b.name || id, 'Building points to a project that does not exist']);
    if (typeof (b.facts || {}).has_lift !== 'boolean') setupIssues.push([`${pName(b.project_id)} · ${b.name}`, 'Lift question not answered']);
  }
  const coMissing = unansweredCompany(S).length;
  for (const c of Object.values(S.companies)) {
    if (c.employee_count == null || c.employee_count === '') setupIssues.push([c.name, 'Employee count not entered']);
    if (coMissing) setupIssues.push([c.name, `${coMissing} company set-up question(s) unanswered`]);
  }
  const reviewByProject = {};
  for (const d of Object.values(S.applic)) {
    if (Core.stateOf(d.status) !== 'review') continue;
    const k = d.project_id ? pName(d.project_id) : ((S.companies[d.company_id] || {}).name || 'Company-wide');
    reviewByProject[k] = (reviewByProject[k] || 0) + 1;
  }

  const group = (title, list, note) => (
    <div className="dq-group" key={title}><h3>{title} <Count n={list.length} /></h3><Note>{note}</Note>
      <div className="dq-list">
        {list.slice(0, 40).map((it) => <div key={it.compliance_id} className="dq-item" onClick={() => ui.openModal(<RecordDrawer refKey={it.compliance_id} />)}><span className="mono">{it.compliance_id}</span><span>{(it.brief_description || '').slice(0, 70)}</span></div>)}
        {list.length > 40 && <div className="dq-item" style={{ color: 'var(--text-muted)' }}>+{list.length - 40} more — see Master Register.</div>}
      </div></div>
  );
  const plain = (title, rows, note) => (
    <div className="dq-group" key={title}><h3>{title} <Count n={rows.length} /></h3><Note>{note}</Note>
      <div className="dq-list">{rows.slice(0, 40).map((r, i) => <div key={i} className="dq-item" style={{ cursor: 'default' }}><span>{r[0]}</span><span>{r[1]}</span></div>)}</div></div>
  );
  const legalPending = items.filter((i) => i.legal_validation_status && i.legal_validation_status !== 'Validated').length;

  return (
    <>
      {group('Compliance ID / Sr No formula broken in source (recomputed)', items.filter((i) => i.compliance_id_source_formula_broken), 'The Excel\'s own Sr No formula breaks from row 19 onward (a `=#REF!+1` chain). IDs shown throughout this app are recomputed, not guessed — same logic as the sheet\'s formula, applied per department.')}
      {group('Due date unparsed (free text, not auto-converted)', items.filter((i) => i.due_date_parse_status === 'unparsed'), 'Open the item and set a concrete next due date manually.')}
      {group('Due date to be set (blank in source)', items.filter((i) => i.due_date_parse_status === 'due_date_to_be_set'))}
      {group('Owner unassigned', items.filter((i) => i.owner === 'Unassigned'))}
      {group('Approver unassigned', items.filter((i) => i.approver === 'Unassigned'))}
      {group('Unmapped to a process stage', items.filter((i) => effectiveStageId(S, i) === 'UNMAPPED'), 'Needs a reviewer to assign a stage.')}
      {group('Stage placement is low-confidence', items.filter((i) => i.stage_confidence === 'low'), 'The stage was proposed by rule from the item text; the source was unclear. Review the "Why this stage" note in each item.')}
      {group('Possible duplicate obligations', items.filter((i) => i.duplicate_group), 'These records restate the same obligation under different departments. They are kept separate and linked; confirm or consolidate after review.')}
      {group('No deadline information', items.filter((i) => i.deadline_rule && i.deadline_rule.type === 'unknown'), 'Frequency and due date are both unspecified. Shown as "Deadline Pending Validation"; no date has been invented.')}
      {group('Event-based but no trigger recorded', items.filter((i) => i.frequency_norm === 'Event Based' && !i.trigger))}
      {group('No forms / documents listed', items.filter((i) => !String(i.forms_documents || '').trim()), 'The document checklist for these items is empty; use "Other document" when uploading.')}
      {group('No regulation / legal reference', items.filter((i) => !String(i.regulation || '').trim()))}
      {group('Text with broken characters (encoding)', items.filter((i) => /â€|â‚|Ã/.test(JSON.stringify([i.brief_description, i.action_required, i.penalty, i.applicability]))), 'Characters such as "₹" are an encoding fault in the source import (₹ saved incorrectly). The legal text was left unchanged.')}
      {plain('Set-up gaps (companies, projects, buildings)', setupIssues, 'Complete these in Projects → Set up so the right records apply.')}
      {plain('Applicability waiting for a decision', Object.entries(reviewByProject), 'Records whose applicability is not confirmed yet. The second column is how many.')}
      {S.coverage && plain('Laws the register does not mention (coverage review)', S.coverage.gaps.map((g) => [g.law, `${g.applies_to.map((a) => (a === 'epc' ? 'EPC' : 'Real estate')).join(' & ')} · ${g.when}`]),
        'A first-pass AI check of the register against laws that typically apply to real estate developers and EPC contractors. It is not legal advice. “Not found” means no register record names the law, not that the law is being breached. Ask counsel to confirm each one before a record is added. Full list: data-prep/coverage-review.md.')}
      <div className="dq-group"><h3>Legal validation <span className="mono" style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({legalPending} of {items.length})</span></h3>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Stage, level and applicability placements are proposals. None has been validated by legal/compliance yet.</div></div>
      {group('Frequency text not recognized by the normalizer', items.filter((i) => i.frequency_norm === 'Other / Unparsed'))}
    </>
  );
}
