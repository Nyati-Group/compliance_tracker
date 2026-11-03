// The v2 stage framework and the rules that place each of the 306 master records in a stage.
// Every placement is a PROPOSAL (legal_validation_status stays "Proposed") with a stated basis, so a reviewer can accept or change it.
// Nothing here changes a compliance ID or any original legal text.

import { CHK_RULES, CHK_DUPLICATES } from './checklist-rules.mjs';

export const STAGES_V2 = [
  { id: 'S0', order: 0, name: 'Stage 0 – Company & Project Applicability Setup',
    description: 'Record the company, project, location, type, phase, buildings and construction status, then decide which compliance requirements apply. Driven by project setup, not by master records.',
    prerequisites: [] },
  { id: 'S1', order: 1, name: 'Stage 1 – Land & Legal Due Diligence',
    description: 'Land title, ownership, development rights, legal agreements, land records, land-use permissions and zoning.',
    prerequisites: ['S0'] },
  { id: 'S2', order: 2, name: 'Stage 2 – Planning & Development Approvals',
    description: 'Master layout, layout approval, development permission, building plan approval, FSI-related planning approvals and applicable development regulations.',
    prerequisites: ['S1'] },
  { id: 'S3', order: 3, name: 'Stage 3 – Statutory NOCs & Infrastructure Permissions',
    description: 'Fire, water, drainage, electricity, infrastructure, garden/amenity and other statutory NOCs.',
    prerequisites: ['S2'] },
  { id: 'S4', order: 4, name: 'Stage 4 – IOD, Sanctions & Commencement',
    description: 'IOD, FSI sanctions, building permissions, Commencement Certificate, approval amendments, authority conditions, and RERA registration (required before any marketing or sale).',
    prerequisites: ['S2'] },
  { id: 'S5', order: 5, name: 'Stage 5 – Pre-Construction & Construction Compliance',
    description: 'Labour, contractor and site safety compliance, inspections, construction permissions and records, TDR-related requirements and activity-based obligations.',
    prerequisites: ['S4'] },
  { id: 'S6', order: 6, name: 'Stage 6 – Environmental & Operational Permissions',
    description: 'Environmental clearance, Consent to Establish and Operate, waste management, water and wastewater permissions, environmental conditions and Swachh-related permissions.',
    prerequisites: ['S2'] },
  { id: 'S7', order: 7, name: 'Stage 7 – Completion, Occupancy & Handover',
    description: 'Completion and occupancy approvals, final inspections, possession, handover, society-related documentation and final certificates.',
    prerequisites: ['S5', 'S6'] },
  { id: 'S8', order: 8, name: 'Stage 8 – RERA & Ongoing Obligations',
    description: 'Continuing statutory compliance: RERA reporting and disclosures, project amendments, renewals, post-completion duties, and recurring company-wide obligations (labour, tax, corporate, data protection).',
    prerequisites: [] },
  { id: 'UNMAPPED', order: 99, name: 'Unmapped to Stage', description: 'Needs a reviewer to assign a stage.', prerequisites: [] },
];

// [prefix, from, to, stage, confidence, basis, compliance_level?]
const R = [
  // ---- Sanctioning: project approvals (SAN-001..028) ----
  ['SAN', 1, 1, 'S1', 'high', 'Inputs/documents from the Land & Legal team'],
  ['SAN', 2, 2, 'S2', 'high', 'Elevation certificate is a planning/design approval'],
  ['SAN', 3, 3, 'S3', 'high', 'Defence (MOD) NOC'],
  ['SAN', 4, 4, 'S2', 'low', 'Source entry is only "Architecture Team"; treated as a design/planning input'],
  ['SAN', 5, 6, 'S3', 'high', 'Fire NOC', 'Building Level'],
  ['SAN', 7, 14, 'S3', 'high', 'Garden, tree, water, drainage and electricity NOCs'],
  ['SAN', 15, 16, 'S4', 'high', 'IOD and basic/ancillary FSI sanction'],
  ['SAN', 17, 17, 'S4', 'low', 'Royalty order (State Govt): timing is not stated in the source'],
  ['SAN', 18, 18, 'S5', 'high', 'Plinth checking is a construction-stage inspection', 'Building Level'],
  ['SAN', 19, 19, 'S5', 'medium', 'Road/amenity handover to the corporation during construction'],
  ['SAN', 20, 20, 'S4', 'medium', 'Sanction of FSI against in-situ road and amenity (an FSI sanction)'],
  ['SAN', 21, 21, 'S5', 'high', 'TDR utilisation (TDR-related requirement)'],
  ['SAN', 22, 22, 'S5', 'medium', 'TDR with premium and ancillary FSI sanction; groups with TDR utilisation'],
  ['SAN', 23, 25, 'S6', 'high', 'CTE, CTO and Swachh NOC are environmental/operational permissions'],
  ['SAN', 26, 26, 'S7', 'high', 'Occupancy Certificate', 'Building Level'],
  ['SAN', 27, 28, 'S7', 'low', 'IOC to Sales and Sales Annexures: handover-to-sales step; meaning of "IOC" to be confirmed'],
  // ---- Sanctioning: RERA promoter obligations (SAN-029..061) ----
  ['SAN', 29, 33, 'S4', 'medium', 'RERA registration and its registration-time requirements are needed before marketing or sale, so they sit with sanctions/commencement, not in the ongoing stage', 'Phase Level'],
  ['SAN', 34, 38, 'S8', 'high', 'Continuing RERA duty: fund withdrawal certification, annual audit, project webpage, quarterly update', 'Phase Level'],
  ['SAN', 39, 41, 'S8', 'medium', 'Continuing marketing/sale rules after registration'],
  ['SAN', 42, 42, 'S5', 'medium', 'Development must follow sanctioned plans during construction'],
  ['SAN', 43, 46, 'S8', 'high', 'Post-registration obligations: plan alteration consent, defect liability, transfer of rights, insurance'],
  ['SAN', 47, 48, 'S7', 'high', 'Completion certificate and occupancy certificate', 'Building Level'],
  ['SAN', 49, 52, 'S7', 'high', 'Association/society formation, common-area possession, conveyance and document handover'],
  ['SAN', 53, 55, 'S8', 'medium', 'Refund and compensation liabilities (continuing)'],
  ['SAN', 56, 56, 'S8', 'low', 'Applies to real estate agents rather than the promoter; confirm applicability'],
  ['SAN', 57, 60, 'S8', 'high', 'Compliance with directions and orders of the Authority/Tribunal'],
  ['SAN', 61, 61, 'S8', 'low', 'Applies to real estate agents (registration renewal); confirm applicability'],
  // ---- Sanctioning: planning-law provisions (SAN-062..070) ----
  ['SAN', 62, 66, 'S2', 'medium', 'Development permission requirements and penalties for development without permission', 'Project Level'],
  ['SAN', 67, 68, 'S1', 'medium', 'Zoning, undeveloped-area and reserved-land restrictions', 'Project Level'],
  ['SAN', 69, 69, 'S2', 'medium', 'Development must follow a sanctioned Town Planning Scheme', 'Project Level'],
  ['SAN', 70, 70, 'S1', 'low', 'Land acquisition for public purpose (land-rights law)', 'Project Level'],
  // ---- MEP (lifts) ----
  ['MEP', 1, 1, 'S5', 'high', 'Permission needed before erecting a lift', 'Building Level'],
  ['MEP', 2, 2, 'S7', 'high', 'Completion notice and lift licence at completion', 'Building Level'],
  ['MEP', 3, 4, 'S8', 'high', 'Licence renewal and alteration permission during use', 'Building Level'],
  ['MEP', 5, 5, 'S5', 'medium', 'BIS standards for installation', 'Building Level'],
  ['MEP', 6, 8, 'S8', 'high', 'Maintenance contract, insurance and log book while in use', 'Building Level'],
  ['MEP', 9, 9, 'S8', 'medium', 'Safe operation and periodic inspection (continuing)', 'Building Level'],
  ['MEP', 10, 11, 'S6', 'medium', 'Waste handling and disposal obligations'],
  ['MEP', 12, 12, 'S8', 'medium', 'Annual fire-prevention certification (continuing)', 'Building Level'],
  // ---- ADM ----
  ['ADM', 1, 1, 'S8', 'low', 'Fire protection and life safety upkeep; confirm whether it is a construction or an operating duty', 'Building Level'],
  ['ADM', 2, 6, 'S8', 'medium', 'Continuing company operational duties (hygiene, vehicles, driving licences, passports)', 'Company Level'],
  // ---- Health & Safety (BOCW etc.) ----
  ['HEA', 1, 7, 'S5', 'high', 'Building-worker safety duties of the establishment (BOCW)', 'Company Level'],
  ['HEA', 8, 12, 'S5', 'high', 'Site safety: excavation, first aid, emergency drills, PPE', 'Site Level'],
  ['HEA', 13, 17, 'S5', 'high', 'Lifting machinery, cranes and equipment used on site', 'Activity Level'],
  ['HEA', 18, 18, 'S5', 'medium', 'General safe plant and system of work'],
  ['HEA', 19, 20, 'S5', 'low', 'Noise standards and zoning (largely the State\'s duty); construction noise context', 'Project Level'],
  ['HEA', 21, 23, 'S5', 'high', 'Construction noise restrictions', 'Activity Level'],
  // ---- EC ----
  ['EC', 1, 2, 'S6', 'high', 'Environmental Clearance and its publication'],
  ['EC', 3, 4, 'S6', 'high', 'CTE before construction and CTO at occupancy'],
  ['EC', 5, 5, 'S6', 'high', 'Annual environment statement'],
  ['EC', 6, 6, 'S6', 'medium', 'Groundwater extraction NOC (CGWA)'],
  ['EC', 7, 13, 'S6', 'high', 'CTE, water-pollution, authorisation and waste returns'],
  ['EC', 14, 26, 'S6', 'medium', 'Construction & demolition waste generator duties', 'Activity Level'],
  // ---- Marketing ----
  ['MAR', 1, 1, 'S4', 'medium', 'No marketing before RERA registration (the registration is the earlier requirement)', 'Phase Level'],
  ['MAR', 2, 14, 'S8', 'medium', 'Advertising and sales conduct once marketing starts'],
  // ---- Legal ----
  ['LEG', 1, 1, 'S4', 'medium', 'RERA registration before advertising or selling', 'Phase Level'],
  ['LEG', 2, 3, 'S8', 'high', 'Registration extension and progress updates', 'Phase Level'],
  ['LEG', 4, 4, 'S4', 'high', 'Carpet area disclosure at registration', 'Phase Level'],
  ['LEG', 5, 5, 'S7', 'high', 'Completion certificate to RERA before handing over', 'Building Level'],
  ['LEG', 6, 7, 'S8', 'medium', 'Defect liability and registered agreements for sale'],
  ['LEG', 8, 9, 'S7', 'high', 'Association formation and transfer of ownership'],
  ['LEG', 10, 10, 'S8', 'high', 'Responding to notices and hearings'],
  // ---- Finance ----
  ['FIN', 1, 2, 'S8', 'high', 'RERA Form 3 (quarterly) and Form 5 (annual) certificates', 'Phase Level'],
  ['FIN', 3, 11, 'S8', 'high', 'Continuing company tax and payment duties', 'Company Level'],
  ['FIN', 12, 12, 'S4', 'medium', '70% RERA escrow account is opened at registration', 'Phase Level'],
  // ---- Company-wide families ----
  ['SEC', 1, 29, 'S8', 'high', 'Continuing corporate (Companies Act / FEMA) duty', 'Company Level'],
  ['IT', 1, 33, 'S8', 'high', 'Continuing data-protection / IT Act duty', 'Company Level'],
  ['LAB', 1, 3, 'S8', 'high', 'Continuing provident fund duty', 'Company Level'],
  ['LAB', 4, 4, 'S5', 'medium', 'Statement to the principal employer about contractor PF recoveries', 'Employee / Contractor Level'],
  ['LAB', 5, 40, 'S8', 'high', 'Continuing labour-law duty', 'Company Level'],
  ['HRL', 1, 28, 'S8', 'high', 'Continuing industrial relations / bonus duty', 'Company Level'],
  ['HRL', 29, 31, 'S5', 'high', 'Contract-labour duties of the principal employer', 'Employee / Contractor Level'],
  // ---- Real Estate Compliance checklist (CHK-001..209) ----
  ...CHK_RULES,
];

// Items that restate the same obligation. Kept as separate records; linked so reviewers can consolidate or confirm each.
export const DUPLICATE_GROUPS = {
  'RERA registration before marketing': ['SAN-029', 'MAR-001', 'LEG-001'],
  'Consent to Establish (CTE)': ['SAN-023', 'EC-003', 'EC-007'],
  'Consent to Operate (CTO)': ['SAN-024', 'EC-004'],
  '70% separate (escrow) account': ['SAN-033', 'FIN-012'],
  'Structural defect liability (5 years)': ['SAN-044', 'LEG-006'],
  'Association / society formation': ['SAN-049', 'LEG-008'],
  'Conveyance / transfer of ownership': ['SAN-051', 'LEG-009'],
  'Completion certificate': ['SAN-047', 'LEG-005'],
  'Occupancy certificate': ['SAN-026', 'SAN-048'],
  'RERA number in advertisements': ['SAN-039', 'MAR-002'],
  'Ten percent advance limit': ['SAN-041', 'MAR-006'],
  'Project website updates': ['SAN-037', 'SAN-038', 'MAR-007', 'LEG-003'],
  'Annual RERA audit': ['SAN-036', 'FIN-002'],
  'Internal Complaints Committee': ['LAB-039', 'SEC-026'],
  'ICC annual report': ['LAB-040', 'SEC-027'],
};

for (const [name, ids] of Object.entries(CHK_DUPLICATES)) DUPLICATE_GROUPS[name] = [...new Set([...(DUPLICATE_GROUPS[name] || []), ...ids])];

const idParts = (id) => { const m = /^([A-Z]+)-(\d+)$/.exec(id); return m ? [m[1], Number(m[2])] : [null, 0]; };

export function placeItem(item) {
  const [p, n] = idParts(item.compliance_id);
  const rule = R.find(([pre, a, b]) => pre === p && n >= a && n <= b);
  if (!rule) return { stage_id: 'UNMAPPED', stage_confidence: 'low', stage_basis: 'No rule matched; needs reviewer', compliance_level: null };
  const [, , , stage, conf, basis, level] = rule;
  return { stage_id: stage, stage_confidence: conf, stage_basis: basis, compliance_level: level || (item.level === 'Project Level' ? 'Project Level' : 'Company Level') };
}

// The master's own wording decides: "Applicable to all covered ..." is a general duty; anything else states a condition.
function applicabilityDefault(text) {
  if (!text) return 'Pending Review';
  return /^applicable to all\b/i.test(text) ? 'Applicable' : 'Conditional';
}

export function deadlineRule(it) {
  const f = it.frequency_norm;
  if (it.due_date_parse_type === 'fixed_date') return { type: 'fixed', date: it.due_date_parse_value, text: it.due_date_raw || null, status: 'from_master' };
  if (it.due_date_parse_type === 'rule') return { type: 'rule', text: it.due_date_raw || null, parsed: it.due_date_parse_value ?? null, status: 'from_master' };
  if (['Monthly', 'Quarterly', 'Annual', 'Half-Yearly'].includes(f)) return { type: 'recurring', period: f, text: it.due_date_raw || null, status: 'pending_validation' };
  if (f === 'Ongoing / Continuous') return { type: 'continuous', text: it.due_date_raw || null, status: 'not_applicable' }; // no single due date by nature
  if (f === 'Event Based') return { type: 'event', text: it.due_date_raw || null, status: 'pending_validation' };
  if (f === 'One Time') return { type: 'one_time', text: it.due_date_raw || null, status: 'pending_validation' };
  return { type: 'unknown', text: it.due_date_raw || null, status: 'pending_validation' };
}

export function enrich(item, dupIndex) {
  const placed = placeItem(item);
  const text = String(item.applicability || '').trim();
  const dupGroup = dupIndex.get(item.compliance_id) || null;
  return {
    ...item,
    legacy_stage_id: item.legacy_stage_id ?? item.stage_id ?? null,
    legacy_stage_source: item.legacy_stage_source ?? item.stage_source ?? null,
    stage_id: placed.stage_id,
    stage_source: 'rule_v2',
    stage_confidence: placed.stage_confidence,
    stage_basis: placed.stage_basis,
    compliance_level: placed.compliance_level,
    applicability_default: applicabilityDefault(text),
    applicability_condition: applicabilityDefault(text) === 'Conditional' ? text : null,
    trigger: item.frequency_norm === 'Event Based' ? (text || item.due_date_raw || null) : null,
    deadline_rule: deadlineRule(item),
    duplicate_group: dupGroup,
    legal_validation_status: item.legal_validation_status ?? 'Legal Validation Required' // never overwrite a status a reviewer has set
  };
}

export function duplicateIndex() {
  const m = new Map();
  for (const [name, ids] of Object.entries(DUPLICATE_GROUPS)) for (const id of ids) m.set(id, name);
  return m;
}
