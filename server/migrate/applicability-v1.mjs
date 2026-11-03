// Builds app/applicability.json: the setup questions ("flags") and which flags decide each conditional compliance record.
//   node migrate/applicability-v1.mjs            validate only
//   node migrate/applicability-v1.mjs --apply    validate, then write app/applicability.json
// Every flag is a plain yes/no fact about the company, the project or one building, taken from the wording of the master's
// own applicability condition. Nothing here is a new legal rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CHK_FLAGS, CHK_GROUP, chkFlags } from './checklist-rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', '..', 'app');
const Core = createRequire(import.meta.url)(path.join(appDir, 'core.js'));

const emp = (n) => [{ scope: 'company', field: 'employee_count', gte: n }];
export const FLAGS = {
  // ----- company -----
  owns_vehicles: ['company', 'Owns/operates motor vehicles', 'Does the company own or operate motor vehicles?'],
  intl_travel: ['company', 'Employees travel abroad on duty', 'Do employees undertake official international travel?'],
  workers_500plus: ['company', '500+ building workers', 'Are 500 or more building workers employed at the establishment?'],
  child_data: ['company', 'Processes children\'s personal data', 'Does the company process personal data of children (under 18)?'],
  processes_spdi: ['company', 'Collects/processes SPDI', 'Does the company collect or process sensitive personal data (SPDI)?'],
  discloses_spdi: ['company', 'Discloses SPDI to third parties', 'Does the company disclose SPDI to third parties?'],
  govt_requests_spdi: ['company', 'Government agencies request SPDI', 'Does a Government agency legally request SPDI from the company?'],
  transfers_spdi: ['company', 'Transfers SPDI to another party', 'Is SPDI transferred to another body corporate or person?'],
  employs_5plus: ['company', '5+ persons employed', 'Does the establishment employ 5 or more persons? (or enter the employee count)', emp(5)],
  employs_10plus: ['company', '10+ persons employed', 'Does the establishment employ 10 or more persons? (or enter the employee count)', emp(10)],
  employs_20plus: ['company', '20+ persons employed', 'Does the establishment employ 20 or more persons? (or enter the employee count)', emp(20)],
  employs_50plus: ['company', 'More than 50 workers', 'Does the establishment employ more than 50 workers? (or enter the employee count)', emp(51)],
  covered_epf: ['company', 'Covered under EPF', 'Is the establishment covered under the Employees\' Provident Fund?'],
  covered_esi: ['company', 'Covered under ESI', 'Is the establishment covered under the Employees\' State Insurance Act?'],
  covered_lwf: ['company', 'Covered under Maharashtra LWF Act', 'Is the establishment covered under the Maharashtra Labour Welfare Fund Act?'],
  tax_audit: ['company', 'Tax audit threshold met', 'Does turnover exceed the tax-audit limit (Rs.1 crore, or Rs.10 crore with cash transactions within 5%)?'],
  gstr9_threshold: ['company', 'GSTR-9 threshold met', 'Does aggregate turnover exceed Rs.2 crore (GSTR-9) or Rs.5 crore (GSTR-9C)?'],
  msme_vendors: ['company', 'Pays registered MSME vendors', 'Are any vendors/payees registered Micro or Small enterprises?'],
  audit_committee: ['company', 'Audit Committee required', 'Is the company required to constitute an Audit Committee (Section 177)?'],
  nrc: ['company', 'Nomination & Remuneration Committee required', 'Is the company required to constitute a Nomination & Remuneration Committee (Section 178)?'],
  secretarial_audit: ['company', 'Secretarial Audit thresholds met', 'Does the company meet the Secretarial Audit thresholds (Section 204)?'],
  csr: ['company', 'CSR thresholds met', 'Does the company meet the CSR thresholds (Section 135)?'],
  sbo: ['company', 'Significant Beneficial Owners exist', 'Do any individuals meet the Significant Beneficial Owner criteria?'],
  fdi_construction: ['company', 'Foreign investment in construction-development', 'Does the company accept/propose FDI in construction-development activity?'],
  epc_abroad: ['company', 'EPC / turnkey projects abroad', 'Does the company undertake EPC/turnkey/civil construction projects abroad?'],
  has_exports: ['company', 'Has export transactions', 'Does the company have export transactions?'],
  export_advances: ['company', 'Receives advance against exports', 'Is advance payment received against exports?'],
  // ----- project -----
  uses_cranes: ['project', 'Cranes / hoists / lifting appliances on site', 'Are cranes, hoists or lifting appliances deployed at this site?'],
  extracts_groundwater: ['project', 'Extracts groundwater', 'Does the project extract groundwater?'],
  cd_waste_high: ['project', 'C&D waste above threshold', 'Will C&D waste exceed 20 tonnes/day or 300 tonnes/project/month?'],
  near_aerodrome_defence: ['project', 'Within aerodrome / defence funnel zone', 'Does the site fall within a notified aerodrome or defence funnel zone needing height clearance?'],
  land_acquisition: ['project', 'Government acquisition of project land', 'Has the Government initiated compulsory acquisition of this project\'s land?'],
  ec_threshold: ['project', 'Environmental Clearance threshold met', 'Is built-up area 20,000 sq m or more, or site area 50 ha or more? (or enter the areas)',
    [{ scope: 'project', field: 'built_up_area_sqm', gte: 20000 }, { scope: 'project', field: 'site_area_ha', gte: 50 }]],
  contract_labour: ['project', 'Contract labour engaged', 'Is contract labour engaged through labour contractors on this project?'],
  contract_workers_20plus: ['project', '20+ contract workers', 'Are 20 or more contract workers engaged on this project? (or enter the count)',
    [{ scope: 'project', field: 'contract_workers_count', gte: 20 }]],
  // ----- building -----
  has_lift: ['building', 'Has a lift / escalator / moving walk', 'Does this building have a lift, escalator or moving walk?'],
};

// Plain-language headings the set-up forms group the questions under.
const GROUPS = {
  'Employees & labour': ['workers_500plus', 'employs_5plus', 'employs_10plus', 'employs_20plus', 'employs_50plus', 'covered_epf', 'covered_esi', 'covered_lwf', 'intl_travel'],
  'Vehicles': ['owns_vehicles'],
  'Tax & finance': ['tax_audit', 'gstr9_threshold', 'msme_vendors', 'has_exports', 'export_advances'],
  'Company law & governance': ['audit_committee', 'nrc', 'secretarial_audit', 'csr', 'sbo', 'fdi_construction', 'epc_abroad'],
  'Data protection & IT': ['child_data', 'processes_spdi', 'discloses_spdi', 'govt_requests_spdi', 'transfers_spdi'],
  'Site & construction': ['uses_cranes', 'cd_waste_high', 'contract_labour', 'contract_workers_20plus'],
  'Land, environment & approvals': ['ec_threshold', 'extracts_groundwater', 'near_aerodrome_defence', 'land_acquisition'],
  'Building': ['has_lift'],
};

const range = (prefix, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${prefix}-${String(a + i).padStart(3, '0')}`);
const ITEM_FLAGS = {};
const set = (ids, flags) => ids.forEach((id) => { ITEM_FLAGS[id] = flags; });
set(range('MEP', 1, 8), ['has_lift']);
set(range('ADM', 3, 5), ['owns_vehicles']); set(['ADM-006'], ['intl_travel']);
set(['HEA-002'], ['workers_500plus']); set(range('HEA', 13, 17), ['uses_cranes']);
set(['EC-001'], ['ec_threshold']); set(['EC-006'], ['extracts_groundwater']); set(['EC-016', 'EC-017', 'EC-025'], ['cd_waste_high']);
set(['IT-009'], ['child_data']); set(range('IT', 22, 25), ['processes_spdi']); set(['IT-026'], ['discloses_spdi']); set(['IT-027'], ['govt_requests_spdi']); set(['IT-028'], ['transfers_spdi']);
set(['LAB-001'], ['employs_20plus']); set(['LAB-002', 'LAB-003', 'LAB-005'], ['covered_epf']); set(['LAB-004'], ['contract_labour', 'covered_epf']);
set(['LAB-006', 'LAB-015', 'LAB-039'], ['employs_10plus']); set(range('LAB', 7, 10), ['covered_esi']); set(['LAB-017'], ['employs_50plus']); set(['LAB-025'], ['employs_5plus']); set(range('LAB', 26, 28), ['covered_lwf']);
set(['FIN-004'], ['tax_audit']); set(['FIN-009'], ['gstr9_threshold']); set(['FIN-011'], ['msme_vendors']);
set(['SEC-009'], ['audit_committee']); set(['SEC-010'], ['nrc']); set(['SEC-014'], ['secretarial_audit']); set(['SEC-015'], ['csr']); set(['SEC-021'], ['sbo']);
set(['SEC-025', 'SEC-026'], ['fdi_construction']); set(['SEC-027'], ['epc_abroad']); set(['SEC-028'], ['has_exports']); set(['SEC-029'], ['export_advances']);
set(['HRL-029'], ['contract_labour']); set(['HRL-030', 'HRL-031'], ['contract_workers_20plus']);
set(['SAN-003'], ['near_aerodrome_defence']); set(['SAN-070'], ['land_acquisition']);

// Real Estate Compliance checklist (CHK-xxx): new-project records need "not a redevelopment"; redevelopment records need it plus their track.
Object.assign(FLAGS, CHK_FLAGS);
GROUPS[CHK_GROUP[0]] = CHK_GROUP[1];
for (const i of JSON.parse(fs.readFileSync(path.join(appDir, 'items.json'), 'utf8'))) if (/^CHK-/.test(i.compliance_id)) ITEM_FLAGS[i.compliance_id] = chkFlags(i.source_track, i.brief_description);

const catalogue = {
  version: 1,
  note: 'Setup questions and the records they decide. Each flag is a yes/no fact; "derive" lets a number entered in setup answer it automatically.',
  flags: Object.fromEntries(Object.entries(FLAGS).map(([k, [scope, label, question, derive, extra]]) => [k, { scope, label, question, group: Object.keys(GROUPS).find((g) => GROUPS[g].includes(k)), ...(derive ? { derive } : {}), ...(extra || {}) }])),
  item_flags: ITEM_FLAGS
};

/* ---------- validation ---------- */
const items = JSON.parse(fs.readFileSync(path.join(appDir, 'items.json'), 'utf8'));
const byId = Object.fromEntries(items.map((i) => [i.compliance_id, i]));
const problems = [];
const reach = { company: ['company'], project: ['company', 'project'], phase: ['company', 'project'], building: ['company', 'project', 'building'] };
for (const it of items) {
  if (it.applicability_default === 'Conditional' && !ITEM_FLAGS[it.compliance_id]) problems.push(`${it.compliance_id}: conditional record has no flag mapping`);
}
for (const [id, keys] of Object.entries(ITEM_FLAGS)) {
  const it = byId[id];
  if (!it) { problems.push(`${id}: not in the master`); continue; }
  if (it.applicability_default !== 'Conditional') problems.push(`${id}: mapped but the master says it applies generally`);
  const t = Core.scopeTypeFor(it);
  for (const key of keys) {
    const k = key.replace(/^!/, '');                       // "!flag" = applies when the flag is No
    if (!catalogue.flags[k]) problems.push(`${id}: unknown flag ${k}`);
    else if (!reach[t].includes(catalogue.flags[k].scope)) problems.push(`${id}: ${t}-scope record cannot read ${catalogue.flags[k].scope} flag ${k}`);
  }
}
Object.entries(catalogue.flags).forEach(([k, f]) => { if (!f.group) problems.push(`flag ${k} has no group`); });
const unused = Object.keys(catalogue.flags).filter((k) => !Object.values(ITEM_FLAGS).some((l) => l.some((x) => x.replace(/^!/, '') === k)));
unused.forEach((k) => problems.push(`flag ${k} is not used by any record`));

const cond = items.filter((i) => i.applicability_default === 'Conditional').length;
const byScope = Object.values(catalogue.flags).reduce((m, f) => (m[f.scope] = (m[f.scope] || 0) + 1, m), {});
console.log(`Conditional records: ${cond}; mapped: ${Object.keys(ITEM_FLAGS).length}; flags: ${Object.keys(catalogue.flags).length} ${JSON.stringify(byScope)}; problems: ${problems.length}`);
problems.forEach((p) => console.log(' - ' + p));
if (problems.length) process.exit(1);
if (process.argv.includes('--apply')) {
  fs.writeFileSync(path.join(appDir, 'applicability.json'), JSON.stringify(catalogue, null, 1) + '\n');
  console.log('Wrote app/applicability.json');
} else console.log('Validation only. Re-run with --apply to write app/applicability.json.');
