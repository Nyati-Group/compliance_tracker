// Suggested risk levels, read only from the penalty wording already in the register. They are SUGGESTIONS for a reviewer.
//   node migrate/risk-proposals-v1.mjs            show the split
//   node migrate/risk-proposals-v1.mjs --apply    write shared/risk-proposals.json
// The health score never uses these until somebody accepts them (per record in the popup, or in bulk under Settings), because a
// risk level is a judgement about legal importance and the register does not carry one. Records with no penalty text get no
// suggestion at all and stay "Risk classification pending validation".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const items = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'items.json'), 'utf8'));
const CUSTODIAL = /imprison|prosecut|criminal|\bjail\b/i;
const SEVERE = /cancel|revoc|suspen|stop.?work|closure|sealing|demolition|debar|black.?list/i;
const MONETARY = /fine|penalt|interest|compensat|damages|charges/i;

const proposals = {};
const count = { critical: 0, high: 0, medium: 0, none: 0 };
for (const it of items) {
  const p = String(it.penalty || '').replace(/\s+/g, ' ').trim();
  if (!p) { count.none++; continue; }
  const cust = CUSTODIAL.test(p), sev = SEVERE.test(p);
  let level = null, basis = '';
  if (cust && sev) { level = 'critical'; basis = 'The penalty wording mentions both prosecution/imprisonment and stop-work, closure or revocation.'; }
  else if (cust) { level = 'high'; basis = 'The penalty wording mentions prosecution or imprisonment.'; }
  else if (sev) { level = 'high'; basis = 'The penalty wording mentions stop-work, closure, revocation or cancellation.'; }
  else if (MONETARY.test(p)) { level = 'medium'; basis = 'The penalty wording mentions a fine, penalty, interest or compensation only.'; }
  if (level) { proposals[it.compliance_id] = { level, basis }; count[level]++; } else count.none++;
}
console.log(`Suggestions: critical ${count.critical}, high ${count.high}, medium ${count.medium}; no suggestion ${count.none} (of ${items.length}).`);
if (process.argv.includes('--apply')) {
  fs.writeFileSync(path.join(root, 'shared', 'risk-proposals.json'), JSON.stringify({
    note: 'Suggested risk levels read from the register\'s own penalty wording. Not a legal classification and never used in scoring until a person accepts them.',
    generated_at: new Date().toISOString(), proposals
  }, null, 1) + '\n');
  console.log('Wrote shared/risk-proposals.json');
}
