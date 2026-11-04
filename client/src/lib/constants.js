export const STATUS_DEFS = {
  'Not Started': { cls: 'neutral', ic: '○' },
  'In Progress': { cls: 'warn', ic: '◐' },
  'Submitted / Under Review': { cls: 'hold', ic: '◑' },
  'Compliant / Completed': { cls: 'ok', ic: '✓' },
  'Overdue': { cls: 'bad', ic: '!' },
  'Not Applicable': { cls: 'neutral', ic: '—' },
  'On Hold': { cls: 'hold', ic: '❙❙' }
};
export const STATUS_LIST = Object.keys(STATUS_DEFS);
export const statusDef = (s) => STATUS_DEFS[s] || STATUS_DEFS['Not Started'];

export const PROJECT_TYPES = ['Residential', 'Commercial', 'Mixed use', 'Township / layout', 'Redevelopment', 'Other'];
export const GROUP_ORDER = ['Site & construction', 'Land, environment & approvals', 'Building', 'Employees & labour', 'Vehicles', 'Tax & finance', 'Company law & governance', 'Data protection & IT'];
export const PROJECT_CATS = [['real_estate', 'Real estate projects'], ['epc', 'EPC projects']];

export const ALL_COLS = [
  ['compliance_id', 'Compliance ID'], ['department', 'Department'], ['compliance_level', 'Compliance level'], ['scope', 'Applies to'],
  ['stage', 'Stage'], ['brief_description', 'Brief Description'], ['regulation', 'Regulation'], ['reference_section', 'Reference'],
  ['authority_norm', 'Authority'], ['frequency_norm', 'Frequency'], ['due_date_raw', 'Due Date (source)'],
  ['owner', 'Owner'], ['approver', 'Approver'], ['status', 'Status'], ['applicability', 'Applicability']
];
export const DEFAULT_REGISTER_COLS = ['compliance_id', 'department', 'compliance_level', 'scope', 'brief_description', 'authority_norm', 'frequency_norm', 'owner', 'status', 'applicability'];

/* ---------- compliance intelligence ---------- */
export const BAND_COLOR = { 'Healthy': 'var(--ok)', 'Good': '#3b9b6e', 'Attention Required': 'var(--warn)', 'At Risk': '#d9622b', 'Critical Risk': 'var(--bad)', 'Not enough information': 'var(--neutral)' };
export const LEVEL_CLS = { critical: 'bad', high: 'warn', medium: 'hold', low: 'neutral', pending: 'neutral' };
export const LEVEL_TXT = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', pending: 'Classification pending' };
export const LEVELS = ['critical', 'high', 'medium', 'low'];
export const PRIO_CLS = { P1: 'bad', P2: 'warn', P3: 'hold', P4: 'neutral' };
export const PRIO_TXT = { P1: 'P1 · Immediate', P2: 'P2 · High', P3: 'P3 · Medium', P4: 'P4 · Low' };
export const REC_STATUS_TXT = { open: 'Open', accepted: 'Accepted', rejected: 'Dismissed', snoozed: 'Snoozed', completed: 'Completed', resolved: 'Resolved', review_requested: 'Review requested' };
export const LIVE_REC = ['open', 'accepted', 'review_requested'];
export const DEDUCTION_TXT = { critical_overdue: 'Critical obligation overdue', expired_document: 'Required document expired', missing_documents: 'Required document missing near a deadline', blocked_statutory: 'Critical/high obligation blocked' };
export const RISK_KIND_TXT = { overdue: 'Overdue', expired_doc: 'Document expired', rejected_doc: 'Document rejected', blocked: 'Blocked', missing_docs: 'Documents missing', deadline_soon: 'Deadline near', awaiting_verification: 'Awaiting verification' };
export const DEADLINE_BUCKETS = [['d1', '1 day'], ['d3', '3 days'], ['d7', '7 days'], ['d15', '15 days'], ['d30', '30 days']];

/* ---------- settings ---------- */
export const DEFAULT_REMINDERS = { enabled: true, days: [30, 15, 7, 3, 1, 0], overdue_days: [1, 7, 14, 30] };
export const DEFAULT_HEALTH_UI = {
  weights: { critical: 10, high: 7, medium: 4, low: 1 }, unclassified_level: 'medium',
  factors: { completed_verified: 0, completed_unverified: 0.5, in_progress: 0.5, submitted: 0.5, not_started: 1, overdue: 1, blocked: 1, on_hold: 1 },
  deductions: { critical_overdue: 3, expired_document: 2, missing_documents: 1.5, blocked_statutory: 1.5 }, deduction_caps: { critical_overdue: 15, expired_document: 10, missing_documents: 10, blocked_statutory: 10 },
  bands: { healthy: 90, good: 75, attention: 60, at_risk: 40 }, due_soon_days: 30, ai_auto_refresh: false, ai_refresh_hours: 24
};
export const FACTOR_TXT = { completed_verified: 'Completed and verified', completed_unverified: 'Completed, documents not all verified', in_progress: 'In progress', submitted: 'Submitted / under review', not_started: 'Not started', overdue: 'Overdue', blocked: 'Blocked', on_hold: 'On hold' };
export const DEDUCT_TXT = { critical_overdue: 'Critical obligation overdue', expired_document: 'Required document expired', missing_documents: 'Required document missing near a deadline', blocked_statutory: 'Critical / high obligation blocked' };

/* ---------- regulatory updates ---------- */
export const PRI_CLS = { Critical: 'bad', High: 'warn', Medium: 'hold', Low: '' };
export const APP_CLS = { 'Potentially Applicable': 'warn', 'Confirmed Applicable': 'bad', 'Not Applicable': '', 'Insufficient Information': 'hold', 'Legal Review Required': 'hold' };
export const RU_STAGE_TXT = { new: 'New Update', analysed: 'AI Analysed', in_review: 'Compliance Review', applicable: 'Applicable', not_applicable: 'Not Applicable', legal_review: 'Legal Review', action: 'Action Assigned', implemented: 'Implemented', closed: 'Closed' };
export const RU_STAGE_NEXT = { new: ['in_review'], analysed: ['in_review'], in_review: ['applicable', 'not_applicable', 'legal_review'], applicable: ['action', 'implemented', 'in_review'], legal_review: ['applicable', 'not_applicable', 'action', 'in_review'], action: ['implemented', 'in_review'], implemented: ['closed', 'in_review'], not_applicable: ['closed', 'in_review'], closed: ['in_review'] };
export const LIVE_APP = ['Potentially Applicable', 'Confirmed Applicable', 'Legal Review Required'];
export const OPEN_STAGES_RU = ['new', 'analysed', 'in_review', 'legal_review'];
export const RU_APPLICABILITY = ['Potentially Applicable', 'Confirmed Applicable', 'Not Applicable', 'Insufficient Information', 'Legal Review Required'];

/* ---------- documents ---------- */
export const READY_CLS = { 'Ready to submit': 'ok', 'Needs changes': 'warn', 'Major gaps': 'bad', 'Cannot assess': 'hold' };
export const CHECK_CLS = { Met: 'ok', Missing: 'bad', Unclear: 'hold', 'Not applicable': '' };
export const DOC_PRIO_CLS = { High: 'bad', Medium: 'warn', Low: '' };
export const DOC_TYPES = ['Application for permission / approval', 'Declaration / undertaking', 'Authorisation letter', 'NOC request', 'Reply to notice', 'Agreement for sale', 'Board resolution', 'Other'];
export const SRC_TXT = { 'company.name': 'Company name', 'project.name': 'Project name', 'project.rera_no': 'RERA number', 'project.location': 'Project location', 'project.planning_authority': 'Planning authority', 'today': "Today's date", 'user.name': 'Signed-in user' };
export const VAR_TYPES = { text: 'Short text', multiline: 'Long text', date: 'Date', number: 'Number', email: 'Email', phone: 'Phone' };
export const OTHER_DOC = '__other__';
