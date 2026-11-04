// Coverage review: does the master register mention each law a real estate developer or an EPC contractor is typically subject to?
//   node migrate/coverage-review.mjs            print the result
//   node migrate/coverage-review.mjs --apply    also write shared/coverage-gaps.json and data-prep/coverage-review.md
//
// HOW TO READ IT. The checklist below is a first pass written by an AI model from general knowledge of Indian real estate and
// construction law. It is NOT legal advice and may miss laws or include ones that do not apply to a given project. For each law the
// script searches the register's own text (regulation, description, action, reference) for the listed terms and shows the matching
// record IDs, so a person can see whether the match is really that law. A "gap" means "no record mentions it", not "the law is violated".
// Every gap must be confirmed by counsel before a record is added to the register. Nothing here edits the register.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const items = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'items.json'), 'utf8'));

const RE = 'real_estate', EPC = 'epc';
// [id, law, what it asks of the company, applies to, when it applies (confidence), search terms (regex source)]
const CHECKLIST = [
  // ---------- Real estate: planning, title, sale ----------
  ['re-rera', 'Real Estate (Regulation and Development) Act, 2016 and MahaRERA rules', 'Project registration, disclosures, escrow, quarterly updates, agreements for sale', [RE], 'All registrable projects', 'Real Estate \\(Regulation|RERA'],
  ['re-mrtp', 'Maharashtra Regional and Town Planning Act, 1966 / UDCPR', 'Development permission, commencement, occupancy', [RE], 'All projects in Maharashtra', 'Regional and Town Planning|MRTP|UDCPR|Development Control'],
  ['re-mofa', 'Maharashtra Ownership Flats (Regulation of the Promotion of Construction, Sale, Management and Transfer) Act, 1963', 'Promoter duties to flat purchasers; society formation and conveyance (partly overlaps RERA)', [RE], 'Residential flats in Maharashtra; check overlap with RERA', 'Ownership Flats|MOFA'],
  ['re-maoa', 'Maharashtra Apartment Ownership Act, 1970', 'Deed of declaration and apartment ownership documents', [RE], 'Where apartments are registered under this Act', 'Apartment Ownership'],
  ['re-landrev', 'Maharashtra Land Revenue Code, 1966 (non-agricultural use permission, land records)', 'NA permission / conversion, 7/12 and property card hygiene, mutation', [RE], 'Where land is or was agricultural', 'Land Revenue|non-agricultural|\\bNA order|7/12|mutation'],
  ['re-stamp', 'Maharashtra Stamp Act, 1958 and Registration Act, 1908', 'Stamp duty and registration of agreements for sale and conveyances', [RE], 'Every sale / conveyance', 'Maharashtra Stamp|Registration Act, 1908|(sale|conveyance|agreement)[^.]{0,40}stamp duty'],
  ['re-deemed', 'Conveyance of title and common areas to the society or allottees (MOFA Section 11 deemed conveyance if the promoter does not)', 'Convey title and common areas to the society within the statutory period', [RE], 'Residential societies', 'deemed conveyance|conveyance'],
  ['re-coop', 'Maharashtra Co-operative Societies Act, 1960', 'Registration of the co-operative housing society', [RE], 'Where a co-operative society is formed', 'Co-operative Societies'],
  ['re-consumer', 'Consumer Protection Act, 2019', 'Handling buyer complaints; unfair trade practice in marketing', [RE], 'All sales to consumers', 'Consumer Protection'],
  // ---------- Real estate: approvals ----------
  ['re-fire', 'Maharashtra Fire Prevention and Life Safety Measures Act, 2006', 'Fire NOC, annual fire-safety certification', [RE], 'Buildings above the notified height / area', 'Fire Prevention|Life Safety|Fire NOC|Chief Fire Officer'],
  ['re-lifts', 'Maharashtra Lifts, Escalators and Moving Walks Act, 2017', 'Lift permission, licence, periodic inspection', [RE], 'Buildings with lifts', 'Lifts, Escalators|Lift'],
  ['re-eia', 'Environment Impact Assessment Notification, 2006', 'Environmental Clearance before construction above the thresholds', [RE], 'Built-up area of 20,000 sq m or more', 'Environment Impact Assessment|EIA|Environmental Clearance|\\bEC\\b'],
  ['re-pollution', 'Water (Prevention and Control of Pollution) Act, 1974 and Air (Prevention and Control of Pollution) Act, 1981', 'Consent to Establish and Consent to Operate from the Pollution Control Board', [RE, EPC], 'Projects needing consent', 'Water \\(Prevention|Air \\(Prevention|Consent to Establish|Consent to Operate|\\bCTE\\b|\\bCTO\\b'],
  ['re-cnd', 'Construction and Demolition Waste Management Rules, 2016', 'Segregation and disposal of C&D waste', [RE, EPC], 'All construction sites', 'Construction and Demolition|C&D'],
  ['re-swm', 'Solid Waste Management Rules, 2016', 'Segregation of wet / dry waste, composting for large complexes', [RE], 'Completed residential / commercial complexes', 'Solid Waste'],
  ['re-noise', 'Noise Pollution (Regulation and Control) Rules, 2000', 'Noise limits on site', [RE, EPC], 'All sites', 'Noise'],
  ['re-trees', 'Maharashtra (Urban Areas) Protection and Preservation of Trees Act, 1975', 'Permission for cutting or transplanting trees; tree plantation', [RE], 'Sites with trees', 'Trees Act|Tree Cutting|Preservation of Trees|tree'],
  ['re-groundwater', 'Maharashtra Ground Water (Development and Management) Act, 2009 / CGWA guidelines', 'NOC for extracting ground water', [RE, EPC], 'Where ground water is extracted', 'Ground Water|CGWA|groundwater'],
  ['re-aai', 'Aircraft (Demolition of Obstructions) Rules / AAI height clearance; defence funnel zones', 'Height clearance near airports and defence installations', [RE], 'Sites near aerodromes', 'aerodrome|Airport|AAI|funnel'],
  ['re-crz', 'Coastal Regulation Zone Notification, 2019', 'CRZ clearance', [RE], 'Sites in the CRZ only', 'Coastal Regulation|\\bCRZ\\b'],
  ['re-stp', 'Sewage treatment and rain-water harvesting conditions (UDCPR / Pollution Control Board consent conditions)', 'Operate STP; harvest rain water; keep consent conditions', [RE], 'Projects with these consent conditions', 'Sewage|\\bSTP\\b|rain.?water'],
  ['re-electrical', 'Electricity Act, 2003 and Central Electricity Authority safety rules (Electrical Inspector approval of substations, DG sets, HT installations)', 'Electrical Inspector approval and periodic testing of electrical installations', [RE, EPC], 'Sites / buildings with transformers, DG sets or HT installations', 'Electricity Act|\\bCEIG\\b|Electrical Safety|substation|transformer|\\bDG set'],
  // ---------- Construction labour (real estate and EPC) ----------
  ['lab-bocw', 'Building and Other Construction Workers (Regulation of Employment and Conditions of Service) Act, 1996 and Maharashtra BOCW Rules', 'Establishment registration, safety officer / committee, safety measures', [RE, EPC], 'All construction establishments', 'Building and Other Construction|BOCW'],
  ['lab-cess', 'Building and Other Construction Workers Welfare Cess Act, 1996', 'Cess on cost of construction paid to the welfare board', [RE, EPC], 'Construction with a cost above the notified limit', 'Welfare Cess|\\bCess Act'],
  ['lab-clra', 'Contract Labour (Regulation and Abolition) Act, 1970', 'Principal employer registration; contractor licence; registers; amenities', [RE, EPC], 'Establishments engaging 20 or more contract workers', 'Contract Labour'],
  ['lab-clra-licence', 'Contract Labour Act: licence held by each labour contractor, and the registers kept on site', 'Check each labour contractor holds a valid licence and keeps the registers', [RE, EPC], 'Where contract labour is engaged', 'Contract Labour[^.]{0,200}licen[cs]e|licen[cs]e[^.]{0,200}Contract Labour|labou?r contractor[^.]{0,60}licen[cs]e'],
  ['lab-ismw', 'Inter-State Migrant Workmen (Regulation of Employment and Conditions of Service) Act, 1979', 'Licence and registers for workers brought from another state', [RE, EPC], 'Where a contractor recruits workers from another state', 'Migrant Workmen|Inter-State'],
  ['lab-ec', 'Employees\' Compensation Act, 1923', 'Compensation for work injury; accident reporting', [RE, EPC], 'All employers', 'Employees. Compensation|Workmen.s Compensation'],
  ['lab-gratuity', 'Payment of Gratuity Act, 1972', 'Gratuity to eligible employees; insurance / trust arrangement', [RE, EPC], 'Establishments with 10 or more employees', 'Gratuity'],
  ['lab-maternity', 'Maternity Benefit Act, 1961', 'Maternity leave and creche rules', [RE, EPC], 'Establishments with 10 or more employees', 'Maternity Benefit'],
  ['lab-pf-esi', 'Employees\' Provident Funds Act, 1952 and Employees\' State Insurance Act, 1948', 'Registration, monthly contributions and returns', [RE, EPC], 'Covered establishments', 'Provident Fund|\\bEPF|\\bESI'],
  ['lab-wages', 'Code on Wages / Minimum Wages and Payment of Wages', 'Statutory minimum wages, timely payment, bonus', [RE, EPC], 'All employers', 'Minimum Wages|Payment of Wages|Code on Wages|Bonus'],
  ['lab-poshl', 'Sexual Harassment of Women at Workplace Act, 2013', 'Internal Committee, annual report', [RE, EPC], 'Offices and sites with 10 or more employees', 'Sexual Harassment'],
  ['lab-state', 'State-specific labour rules for sites outside Maharashtra (Bihar, Rajasthan, etc.): state BOCW Rules, Labour Welfare Fund, Professional Tax, Shops and Establishments, minimum wage notifications', 'Local registrations and returns at each state', [EPC], 'EPC sites in Bihar (Bhojpur, Munger) and Rajasthan (Udaipur)', 'Bihar|Rajasthan'],
  // ---------- Tax and corporate ----------
  ['tax-gst', 'Central / State GST Acts (supply of works contract, reverse charge, input tax credit, GSTR-1, 3B, 9)', 'Monthly and annual returns; GST on construction services and RCM', [RE, EPC], 'All registered taxpayers', 'GSTR-1|GSTR-9|CGST|GST Act'],
  ['tax-gst-3b', 'GSTR-3B (monthly GST payment return) and reconciliation of input tax credit', 'File GSTR-3B monthly; reconcile credit with GSTR-2B', [RE, EPC], 'All GST-registered taxpayers', 'GSTR-3B|GSTR-2B|input tax credit'],
  ['tax-gst-rcm', 'GST reverse charge and works-contract supply rules', 'Pay GST under reverse charge where applicable; correct rate on works contracts', [RE, EPC], 'Construction services', 'reverse charge|works contract'],
  ['tax-gst-tds', 'GST TDS on payments by government entities (Section 51, CGST Act)', 'Reconcile tax deducted by PWD / MIDC / public bodies; claim credit', [EPC], 'EPC contracts with government bodies', 'TDS under GST|Section 51'],
  ['tax-it', 'Income-tax Act, 1961 (TDS on contractor payments, advance tax, returns, tax audit)', 'TDS deduction and quarterly returns; advance tax; return and audit', [RE, EPC], 'All companies', 'TDS|Advance tax|Income.tax|ITR'],
  ['tax-pt', 'Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975', 'Deduct and remit profession tax', [RE, EPC], 'Employers in Maharashtra', 'Profession Tax'],
  ['corp-ca', 'Companies Act, 2013', 'Annual filings, board and general meetings, registers', [RE, EPC], 'All companies', 'Companies Act|\\bROC\\b|\\bAGM\\b'],
  ['corp-fema', 'Foreign Exchange Management Act, 1999', 'Reporting of foreign investment and export receipts', [RE, EPC], 'Where foreign money is involved', 'FEMA|foreign investment|FDI'],
  ['corp-dpdp', 'Digital Personal Data Protection Act, 2023; Information Technology Act, 2000; CERT-In directions, 2022', 'Notices, consent, security, breach reporting', [RE, EPC], 'Anyone processing personal data', 'Digital Personal Data|Information Technology Act|CERT-In'],
  // ---------- EPC contract and site ----------
  ['epc-insurance', 'Contractor\'s All Risk, third-party liability and workmen\'s compensation insurance (usually a contract condition)', 'Keep policies in force for the life of the contract', [EPC], 'Most EPC contracts', 'Contractor.s All Risk|\\bCAR (policy|insurance)|workmen.s compensation (policy|insurance)|third.party liability (policy|insurance)'],
  ['epc-explosives', 'Explosives Act, 1884 and Explosives Rules, 2008', 'Licence for storing or using explosives for blasting', [RE, EPC], 'Only where blasting is done', 'Explosive'],
  ['epc-petroleum', 'Petroleum Act, 1934 and Petroleum Rules, 2002', 'Licence for storing diesel above the exempted quantity', [RE, EPC], 'Sites storing diesel for DG sets / machinery', 'Petroleum Act|Petroleum Rules'],
  ['epc-hazwaste', 'Hazardous and Other Wastes (Management and Transboundary Movement) Rules, 2016', 'Authorisation and returns for used oil, paint waste etc.', [RE, EPC], 'Where such waste is generated', 'Hazardous and Other Wastes|Hazardous Waste'],
  ['epc-mv', 'Motor Vehicles Act, 1988 (site vehicles, cranes on road, PUC, insurance)', 'Valid registration, licences, PUC and insurance for vehicles', [RE, EPC], 'Where the company runs vehicles', 'Motor Vehicle|PUC|driving licen'],
];

const haystack = (it) => [it.regulation, it.reference_section, it.brief_description, it.action_required, it.compliance_type_raw].filter(Boolean).join(' ');
const hay = items.map((it) => [it.compliance_id, haystack(it)]);
const results = CHECKLIST.map(([id, law, ask, appliesTo, when, terms]) => {
  const re = new RegExp(terms, 'i');
  const hits = hay.filter(([, t]) => re.test(t)).map(([cid]) => cid);
  return { id, law, obligation: ask, applies_to: appliesTo, when, matched_records: hits.slice(0, 12), matched_count: hits.length, status: hits.length ? 'mentioned' : 'not found' };
});
const gaps = results.filter((r) => r.status === 'not found');
const mentioned = results.filter((r) => r.status === 'mentioned');

const out = [];
out.push(`Checked ${CHECKLIST.length} laws / obligations against ${items.length} register records.`);
out.push(`  Mentioned in the register: ${mentioned.length}`);
out.push(`  Not found in the register:  ${gaps.length}`);
out.push('');
out.push('NOT FOUND (please confirm each with counsel):');
for (const g of gaps) out.push(`  - [${g.applies_to.join('/')}] ${g.law}\n      asks: ${g.obligation}\n      applies: ${g.when}`);
out.push('');
out.push('MENTIONED (matching records shown so you can confirm it is really that law):');
for (const m of mentioned) out.push(`  - ${m.law}: ${m.matched_count} record(s), e.g. ${m.matched_records.slice(0, 6).join(', ')}`);
console.log(out.join('\n'));

if (process.argv.includes('--apply')) {
  const stamp = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'shared', 'coverage-gaps.json'), JSON.stringify({
    generated_at: stamp, checked_laws: CHECKLIST.length, register_records: items.length,
    note: 'First-pass check by an AI model from general knowledge of Indian real estate and construction law. Not legal advice. "Not found" means no register record mentions the law; it does not mean the law is being breached. Confirm each item with counsel before adding a record.',
    gaps, mentioned
  }, null, 1) + '\n');
  const md = [`# Coverage review — real estate and EPC\n`, `Generated ${stamp}. ${CHECKLIST.length} laws checked against ${items.length} register records.\n`,
    `> First pass by an AI model from general knowledge. **Not legal advice.** "Not found" means no register record mentions the law. Confirm each item with counsel before adding a record to the register.\n`,
    `## Not found in the register (${gaps.length})\n`, ...gaps.map((g) => `- **${g.law}** — _${g.applies_to.map((a) => (a === 'epc' ? 'EPC' : 'Real estate')).join(' & ')}_. ${g.obligation}. Applies: ${g.when}.`),
    `\n## Mentioned in the register (${mentioned.length})\n`, ...mentioned.map((m) => `- **${m.law}** — ${m.matched_count} record(s): ${m.matched_records.join(', ')}`)].join('\n');
  fs.mkdirSync(path.join(root, 'data-prep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data-prep', 'coverage-review.md'), md + '\n');
  console.log('\nWrote shared/coverage-gaps.json and data-prep/coverage-review.md');
}
