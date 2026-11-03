// Roles, what each may do, and which projects a user may see. Enforced on every request; the browser only mirrors it.

export const CAPS = {
  edit_tracking: 'Update status, remarks and due dates',
  upload_docs: 'Upload documents',
  verify_docs: 'Verify or reject documents',
  decide_applicability: 'Decide whether a record applies',
  manage_setup: 'Add and edit projects, phases and buildings',
  manage_company: 'Edit company details and answers',
  override_completion: 'Mark a record complete despite missing documents or prerequisites (with a reason)',
  manage_settings: 'Change reminder rules and the health-score settings',
  manage_actions: 'Accept, reject, assign and complete AI recommended actions',
  manage_users: 'Add users and change roles and project access',
  review_regulatory: 'Review regulatory updates: confirm applicability, assign, create tasks, close',
};
const ALL = Object.keys(CAPS);

export const ROLE_INFO = {
  admin: { label: 'Master Admin', description: 'Everything, including users.', caps: ALL },
  company_admin: { label: 'Company Admin', description: 'Everything except managing users.', caps: ALL.filter((c) => c !== 'manage_users') },
  head: { label: 'Compliance Manager', description: 'Runs the register: decides applicability, sets up projects, verifies documents, acts on AI recommendations.', caps: ['edit_tracking', 'upload_docs', 'verify_docs', 'decide_applicability', 'manage_setup', 'override_completion', 'manage_actions', 'review_regulatory'] },
  dept_head: { label: 'Department Head', description: 'Updates status and verifies documents.', caps: ['edit_tracking', 'upload_docs', 'verify_docs'] },
  owner: { label: 'Compliance Owner', description: 'Updates status and uploads documents.', caps: ['edit_tracking', 'upload_docs'] },
  approver: { label: 'Approver', description: 'Updates status and verifies documents.', caps: ['edit_tracking', 'upload_docs', 'verify_docs'] },
  project_manager: { label: 'Project Manager', description: 'Sets up projects and updates status for their projects.', caps: ['edit_tracking', 'upload_docs', 'manage_setup'] },
  readonly: { label: 'Auditor', description: 'Read-only access.', caps: [] },
};
export const ROLES = Object.keys(ROLE_INFO);
export const capsOf = (role) => (ROLE_INFO[role] || ROLE_INFO.readonly).caps;
export const hasCap = (user, cap) => !!user && capsOf(user.role).includes(cap);

/** Admins and company admins always see everything; anyone else with a project list is limited to it. */
export const isRestricted = (user) => !['admin', 'company_admin'].includes(user.role) && Array.isArray(user.project_ids);

// The scope id is whatever follows the last "__" in a tracking/audit/document/applicability key.
export const scopeOfKey = (key) => { const i = String(key).lastIndexOf('__'); return i < 0 ? null : String(key).slice(i + 2); };

/**
 * Scope ids the user may touch: assigned projects, those projects' phases and buildings, and every company id
 * (company-wide records are shared; writing them still needs an unrestricted account).
 */
export async function allowedScopes(db, user) {
  const companies = (await db.collection('companies').find({}, { projection: { _id: 1 } }).toArray()).map((c) => String(c._id));
  if (!isRestricted(user)) return { all: true, ids: null, companies: new Set(companies), projects: null };
  const projects = new Set(user.project_ids.map(String));
  const ids = new Set([...projects, ...companies]);
  const q = { project_id: { $in: [...projects] } };
  for (const col of ['phases', 'buildings']) for (const d of await db.collection(col).find(q, { projection: { _id: 1 } }).toArray()) ids.add(String(d._id));
  return { all: false, ids, companies: new Set(companies), projects };
}
export const canSee = (allowed, scopeId) => allowed.all || (scopeId != null && allowed.ids.has(String(scopeId)));
/** Writes: like canSee, but a restricted user may not write company-wide records. */
export const canWriteScope = (allowed, scopeId) => allowed.all || (scopeId != null && allowed.ids.has(String(scopeId)) && !allowed.companies.has(String(scopeId)));
