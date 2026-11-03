// Rules for the Real Estate Compliance checklist records (CHK-001..CHK-209): where each sits in the stage framework,
// which setup questions decide it, and which existing records it restates. Used by stage-rules.mjs and applicability-v1.mjs.
// Every placement is a proposal for a reviewer to confirm (legal_validation_status stays "Legal Validation Required").

// [prefix, from, to, stage, confidence, basis, compliance_level?]  (same shape as the rules in stage-rules.mjs)
// CHK-001..095 are the "New Project" checklist, CHK-096..209 the "Redevelopment" checklist (which repeats many of the same steps).
export const CHK_RULES = [
  // ---- New project ----
  ['CHK', 1, 21, 'S1', 'high', 'Title, land records, tenure, zoning, litigation, seller capacity and the land agreements'],
  ['CHK', 22, 25, 'S1', 'low', 'Entity formation and registrations (PAN/GST, professional tax, shops and establishments) done before the project starts'],
  ['CHK', 26, 26, 'S5', 'medium', 'Labour registrations for the construction site'],
  ['CHK', 27, 27, 'S2', 'medium', 'Appointment and licensing of the design professionals'],
  ['CHK', 28, 31, 'S2', 'high', 'Land-use change, layout, inclusive housing and TDR/FSI purchase are planning approvals'],
  ['CHK', 32, 32, 'S5', 'medium', 'Demolition permission is a pre-construction step'],
  ['CHK', 33, 33, 'S4', 'high', 'Building plan sanction (IOD)'],
  ['CHK', 34, 34, 'S2', 'medium', 'Accessibility is checked at design stage'],
  ['CHK', 35, 35, 'S4', 'high', 'Commencement Certificate and related payments'],
  ['CHK', 36, 36, 'S5', 'high', 'Plinth certificate is a construction-stage inspection', 'Building Level'],
  ['CHK', 37, 37, 'S4', 'medium', 'CC revalidation or extension'],
  ['CHK', 38, 38, 'S2', 'medium', 'Structural design compliance'],
  ['CHK', 39, 43, 'S6', 'high', 'Environmental clearance, green provisions, MPCB consent, C&D waste and groundwater'],
  ['CHK', 44, 44, 'S4', 'medium', 'Minor-mineral royalty for excavation (like the royalty order in the Sanctioning sheet)'],
  ['CHK', 45, 59, 'S3', 'high', 'Tree, aerodrome, defence, railway/metro, highway, heritage, CRZ, forest, flood-line, water/drainage, traffic, fire, electricity, utility and energy approvals'],
  ['CHK', 60, 63, 'S4', 'high', 'MahaRERA registration and its registration-time requirements are needed before marketing or sale', 'Phase Level'],
  ['CHK', 64, 69, 'S8', 'high', 'Marketing and sale conduct once the project is registered'],
  ['CHK', 70, 73, 'S8', 'high', 'Continuing RERA duties: quarterly updates, annual accounts, plan changes, extension', 'Phase Level'],
  ['CHK', 74, 75, 'S5', 'high', 'Site labour, safety and contractor compliance'],
  ['CHK', 76, 76, 'S6', 'high', 'EC, MPCB and planning-authority conditions during construction'],
  ['CHK', 77, 77, 'S5', 'medium', 'Construction and third-party insurance'],
  ['CHK', 78, 80, 'S8', 'high', 'Continuing tax, company-law and refund obligations'],
  ['CHK', 81, 83, 'S7', 'high', 'Occupancy certificate, final fire NOC and lift licence', 'Building Level'],
  ['CHK', 84, 84, 'S6', 'high', 'MPCB Consent to Operate'],
  ['CHK', 85, 86, 'S7', 'high', 'Electrical inspection, permanent connections and property tax for the new building', 'Building Level'],
  ['CHK', 87, 87, 'S7', 'high', 'OC upload and project close-out', 'Phase Level'],
  ['CHK', 88, 94, 'S7', 'high', 'Possession, declaration of ownership, society, conveyance and handover of common areas'],
  ['CHK', 95, 95, 'S8', 'high', 'Five-year defect liability'],
  // ---- Redevelopment ----
  ['CHK', 96, 107, 'S1', 'high', 'Redevelopment eligibility, title, tenure, structural audit, member census, feasibility and lender NOCs'],
  ['CHK', 108, 129, 'S1', 'medium', 'Society approvals, developer selection, due diligence, security and the registered agreements (DA, PAAA, transit rent)'],
  ['CHK', 130, 130, 'S2', 'medium', 'Redevelopment FSI and incentive entitlements'],
  ['CHK', 131, 131, 'S1', 'medium', 'Land-record update for the redevelopment plot'],
  ['CHK', 132, 132, 'S5', 'medium', 'Demolition permission and safe-demolition plan are pre-construction steps'],
  ['CHK', 133, 133, 'S4', 'high', 'Building plan sanction (IOD)'],
  ['CHK', 134, 134, 'S2', 'medium', 'Accessibility is checked at design stage'],
  ['CHK', 135, 135, 'S4', 'high', 'Commencement Certificate and related payments'],
  ['CHK', 136, 136, 'S5', 'high', 'Plinth certificate is a construction-stage inspection', 'Building Level'],
  ['CHK', 137, 137, 'S4', 'medium', 'CC revalidation or extension'],
  ['CHK', 138, 138, 'S2', 'medium', 'Structural design compliance'],
  ['CHK', 139, 143, 'S6', 'high', 'Environmental clearance, green provisions, MPCB consent, C&D waste and groundwater'],
  ['CHK', 144, 144, 'S4', 'medium', 'Minor-mineral royalty for excavation'],
  ['CHK', 145, 159, 'S3', 'high', 'Tree, aerodrome, defence, railway/metro, highway, heritage, CRZ, forest, flood-line, water/drainage, traffic, fire, electricity, utility and energy approvals'],
  ['CHK', 160, 160, 'S5', 'high', 'Neighbour and adjoining-property safeguards during construction'],
  ['CHK', 161, 164, 'S1', 'low', 'Entity formation and registrations done before the project starts'],
  ['CHK', 165, 165, 'S5', 'medium', 'Labour registrations for the construction site'],
  ['CHK', 166, 166, 'S2', 'medium', 'Appointment and licensing of the design professionals'],
  ['CHK', 167, 171, 'S4', 'high', 'MahaRERA registration of the redevelopment project and its registration-time requirements', 'Phase Level'],
  ['CHK', 172, 178, 'S8', 'high', 'Marketing, sale, GST and income-tax conduct for the sale component'],
  ['CHK', 179, 180, 'S5', 'medium', 'Project finance, insurance and demolition execution'],
  ['CHK', 181, 181, 'S8', 'medium', 'Timeline obligations and extensions'],
  ['CHK', 182, 182, 'S5', 'high', 'Progress reporting and PMC supervision during construction'],
  ['CHK', 183, 186, 'S8', 'high', 'Continuing RERA duties: quarterly updates, annual accounts, plan changes, extension', 'Phase Level'],
  ['CHK', 187, 188, 'S5', 'high', 'Site labour, safety and contractor compliance'],
  ['CHK', 189, 189, 'S6', 'high', 'EC, MPCB and planning-authority conditions during construction'],
  ['CHK', 190, 190, 'S5', 'medium', 'Construction and third-party insurance'],
  ['CHK', 191, 193, 'S8', 'high', 'Continuing tax, company-law and refund obligations'],
  ['CHK', 194, 196, 'S7', 'high', 'Occupancy certificate, final fire NOC and lift licence', 'Building Level'],
  ['CHK', 197, 197, 'S6', 'high', 'MPCB Consent to Operate'],
  ['CHK', 198, 199, 'S7', 'high', 'Electrical inspection, permanent connections and property tax for the new building', 'Building Level'],
  ['CHK', 200, 200, 'S7', 'high', 'OC upload and project close-out', 'Phase Level'],
  ['CHK', 201, 208, 'S7', 'high', 'Possession to members, society reconstitution, conveyance, handover and track-specific completion'],
  ['CHK', 209, 209, 'S8', 'high', 'Five-year defect liability'],
];

// A New Project record applies only when the project is NOT a redevelopment; a Redevelopment record only when it is.
// Redevelopment records tagged [CHS], [MHADA], [SRA], [TENANTED] or [CLUSTER] also need that track. [ALL] and [MHADA/SRA] need only "redevelopment".
export const TRACK_FLAGS = {
  CHS: 'redev_chs', MHADA: 'redev_mhada', SRA: 'redev_sra', TENANTED: 'redev_tenanted', CLUSTER: 'redev_cluster',
};
export const chkFlags = (track, description) => {
  if (track !== 'Redevelopment') return ['!redevelopment_project'];
  const tag = /^\s*\[([A-Z/]+)\]/.exec(description || '');
  const t = tag ? tag[1] : null;
  return t && TRACK_FLAGS[t] ? ['redevelopment_project', TRACK_FLAGS[t]] : ['redevelopment_project'];
};
export const chkCondition = (track, description) => {
  if (track !== 'Redevelopment') return 'New development project (not a redevelopment)';
  const tag = /^\s*\[([A-Z/]+)\]/.exec(description || '');
  const t = tag ? tag[1] : null;
  return ({
    CHS: 'Redevelopment project led by a co-operative housing society',
    MHADA: 'Redevelopment of a MHADA cessed building or a society in a MHADA layout',
    SRA: 'Slum rehabilitation (SRA) redevelopment scheme',
    TENANTED: 'Redevelopment of a privately owned tenanted / pagdi property',
    CLUSTER: 'Cluster / group redevelopment of several buildings or societies',
    'MHADA/SRA': 'Redevelopment under a MHADA or SRA scheme',
  })[t] || 'Redevelopment project';
};

// Setup questions added for these records (merged into FLAGS in applicability-v1.mjs). [scope, label, question, derive?, extra]
export const CHK_FLAGS = {
  redevelopment_project: ['project', 'Redevelopment project', 'Is this a redevelopment of an existing building or society (rather than a new development on vacant or acquired land)?'],
  redev_chs: ['project', 'Society-led redevelopment', 'Is the redevelopment led by a co-operative housing society?', null, { requires: 'redevelopment_project' }],
  redev_mhada: ['project', 'MHADA redevelopment', 'Is this a MHADA cessed-building or MHADA-layout redevelopment?', null, { requires: 'redevelopment_project' }],
  redev_sra: ['project', 'SRA slum rehabilitation', 'Is this a slum rehabilitation (SRA) scheme?', null, { requires: 'redevelopment_project' }],
  redev_tenanted: ['project', 'Tenanted / pagdi property', 'Is this a redevelopment of privately owned tenanted or pagdi property?', null, { requires: 'redevelopment_project' }],
  redev_cluster: ['project', 'Cluster redevelopment', 'Is this a cluster / group redevelopment of several buildings or societies?', null, { requires: 'redevelopment_project' }],
};
export const CHK_GROUP = ['Project type', ['redevelopment_project', 'redev_chs', 'redev_mhada', 'redev_sra', 'redev_tenanted', 'redev_cluster']];

// Existing records these restate. The same obligations are kept as separate records and linked so a reviewer can confirm or consolidate.
export const CHK_DUPLICATES = {
  'RERA registration before marketing': ['CHK-060', 'CHK-167'],
  'Provisional / final Fire NOC': ['SAN-006', 'CHK-056', 'CHK-156', 'CHK-082', 'CHK-195'],
  'Consent to Establish (CTE)': ['CHK-041', 'CHK-141'],
  'Consent to Operate (CTO)': ['CHK-084', 'CHK-197'],
  '70% separate (escrow) account': ['CHK-062', 'CHK-170'],
  'Structural defect liability (5 years)': ['CHK-095', 'CHK-209'],
  'Association / society formation': ['CHK-090'],
  'Conveyance / transfer of ownership': ['CHK-091', 'CHK-204'],
  'Occupancy certificate': ['CHK-081', 'CHK-194'],
  'RERA number in advertisements': ['CHK-065', 'CHK-173'],
  'Ten percent advance limit': ['CHK-067', 'CHK-175'],
  'Project website updates': ['CHK-063', 'CHK-070', 'CHK-171', 'CHK-183'],
  'Annual RERA audit': ['CHK-071', 'CHK-184'],
  'Lift licence': ['MEP-002', 'CHK-083', 'CHK-196'],
  'Tree-cutting permission': ['SAN-008', 'CHK-045', 'CHK-145'],
  'Plinth certificate': ['SAN-018', 'CHK-036', 'CHK-136'],
};
