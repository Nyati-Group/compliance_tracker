/* Shared by the browser (window.Core) and the server (require). One definition of:
   - which entity (company / project / phase / building) a compliance record is tracked against,
   - how the tracking key is built,
   - which compliance instances exist for a company or project view,
   - how a conditional record's applicability is decided from the setup facts. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCOPE_BY_LEVEL = {
    'Company Level': 'company', 'Project Level': 'project', 'Site Level': 'project', 'Activity Level': 'project',
    'Employee / Contractor Level': 'project', 'Phase Level': 'phase', 'Building Level': 'building'
  };
  const scopeTypeFor = (item) => SCOPE_BY_LEVEL[item.compliance_level] || (item.level === 'Project Level' ? 'project' : 'company');
  const keyFor = (item, scopeId) => `${item.compliance_id}__${scopeId}`;
  const parseKey = (key) => { const i = String(key).indexOf('__'); return i < 0 ? null : { compliance_id: key.slice(0, i), scopeId: key.slice(i + 2) }; };

  // Applicability statuses and how each one counts.
  const APPLICABILITY = ['Applicable', 'Not Applicable', 'Conditional', 'Pending Review', 'Legal Validation Required'];
  const stateOf = (status) => status === 'Not Applicable' ? 'na' : (status === 'Applicable' || status === 'Conditional') ? 'active' : 'review';

  const entries = (o) => Object.entries(o || {});

  const categoryOf = (p) => (p && p.category) || 'real_estate';
  /** Does an EPC-type project track this record? (profiles.json lists them; IT records are tracked locally on each EPC project.) */
  function epcIncludes(profiles, item) {
    const prof = ((profiles || {}).categories || {}).epc;
    if (!prof) return false;
    const id = item.compliance_id;
    return (prof.record_ids || []).includes(id) || (prof.record_prefixes || []).some((pre) => id.startsWith(pre + '-'));
  }

  /** Instances for one view. ctx = {projectId} for a project view, or {companyId} for the company-wide view. */
  function enumerate(data, ctx) {
    const { items, companies, projects, phases, buildings, profiles } = data;
    const out = [];
    const mk = (item, type, scopeId, label, extra) => out.push({ key: keyFor(item, scopeId), item, scopeType: type, scopeId, scopeLabel: label, ...extra });
    if (ctx.projectId) {
      const p = (projects || {})[ctx.projectId];
      if (!p) return out;
      const base = { companyId: p.company_id || null, projectId: ctx.projectId };
      if (categoryOf(p) === 'epc') {
        for (const item of items) if (epcIncludes(profiles, item)) mk(item, 'project', ctx.projectId, p.name, base);
        return out;
      }
      const ph = entries(phases).filter(([, x]) => x.project_id === ctx.projectId);
      const bl = entries(buildings).filter(([, x]) => x.project_id === ctx.projectId);
      for (const item of items) {
        const t = scopeTypeFor(item);
        if (t === 'project') mk(item, 'project', ctx.projectId, p.name, base);
        else if (t === 'phase') ph.forEach(([id, x]) => mk(item, 'phase', id, `${p.name} · ${x.name}`, { ...base, phaseId: id, scopeShort: x.name }));
        else if (t === 'building') bl.forEach(([id, x]) => mk(item, 'building', id, `${p.name} · ${x.name}`, { ...base, phaseId: x.phase_id || null, buildingId: id, scopeShort: x.name }));
      }
    } else if (ctx.companyId) {
      const c = (companies || {})[ctx.companyId];
      if (!c) return out;
      for (const item of items) if (scopeTypeFor(item) === 'company') mk(item, 'company', ctx.companyId, c.name, { companyId: ctx.companyId });
    }
    return out;
  }

  function enumerateAll(data) {
    const out = [];
    for (const [id] of entries(data.companies)) out.push(...enumerate(data, { companyId: id }));
    for (const [id] of entries(data.projects)) out.push(...enumerate(data, { projectId: id }));
    return out;
  }

  /* ---------- applicability ---------- */
  // A flag's value: an explicit yes/no answer wins; otherwise it can be derived from numbers on the entity
  // (any rule met -> true; false only when every number it depends on is known and none is met).
  function flagState(cat, flagKey, ent) {
    const def = cat.flags[flagKey];
    if (!def) return { value: null };
    const holder = ent[def.scope];
    const facts = (holder && holder.facts) || {};
    if (typeof facts[flagKey] === 'boolean') return { value: facts[flagKey], how: 'answered' };
    if (def.derive) {
      let allKnown = true;
      for (const r of def.derive) {
        const h = ent[r.scope || def.scope];
        const v = h ? h[r.field] : null;
        if (v === null || v === undefined || v === '' || isNaN(Number(v))) { allKnown = false; continue; }
        if (Number(v) >= r.gte) return { value: true, how: 'derived' };
      }
      if (allKnown) return { value: false, how: 'derived' };
    }
    return { value: null };
  }

  /** Decide a record's applicability for one instance. Returns {status, reason, flags}. */
  function evaluate(cat, item, ent) {
    if (item.applicability_default !== 'Conditional') {
      return { status: 'Applicable', reason: 'Applies generally (master register: applicable to all covered establishments/projects).', flags: {} };
    }
    const cond = item.applicability_condition || item.applicability || '';
    const keys = (cat.item_flags || {})[item.compliance_id] || [];
    if (!keys.length) return { status: 'Pending Review', reason: `This condition has no automatic rule, so it needs a person to decide: ${cond}`, flags: {} };
    // A key written "!flag" means the record applies when that flag is No (for example a new-development record under "Is this a redevelopment?").
    const states = keys.map((k) => { const neg = k[0] === '!', base = neg ? k.slice(1) : k, s = flagState(cat, base, ent); return { k: base, neg, raw: s.value, value: s.value === null ? null : (neg ? !s.value : s.value) }; });
    const flags = Object.fromEntries(states.map((s) => [s.k, s.raw]));
    const no = states.find((s) => s.value === false);
    if (no) return { status: 'Not Applicable', reason: `Condition not met — "${cat.flags[no.k].label}" is ${no.neg ? 'Yes' : 'No'}. Master condition: ${cond}`, flags };
    const unknown = states.filter((s) => s.value === null);
    if (unknown.length) return { status: 'Pending Review', reason: `Waiting for setup answers: ${unknown.map((s) => cat.flags[s.k].question).join(' · ')}`, flags };
    return { status: 'Applicable', reason: `Condition met — ${states.map((s) => (s.neg ? 'not: ' : '') + cat.flags[s.k].label).join(', ')}. Master condition: ${cond}`, flags };
  }

  /** The entities an instance's flags can come from. */
  function entitiesFor(data, inst) {
    return {
      company: (data.companies || {})[inst.companyId] || null,
      project: (data.projects || {})[inst.projectId] || null,
      building: (data.buildings || {})[inst.buildingId] || null
    };
  }

  /**
   * The set-up questions that matter for a view: only flags used by records that actually exist there.
   * For the company view that includes company questions needed by any of the company's projects.
   * Returns {flagKey: number of records it decides}.
   */
  function relevantFlags(data, cat, ctx) {
    const counts = {};
    const insts = [];
    if (ctx.projectId) insts.push(...enumerate(data, { projectId: ctx.projectId }));
    else if (ctx.companyId) {
      insts.push(...enumerate(data, { companyId: ctx.companyId }));
      for (const [pid, p] of entries(data.projects)) if (p.company_id === ctx.companyId) insts.push(...enumerate(data, { projectId: pid }));
    }
    for (const inst of insts) {
      if (inst.item.applicability_default !== 'Conditional') continue;
      for (const k of (cat.item_flags || {})[inst.item.compliance_id] || []) { const b = k[0] === '!' ? k.slice(1) : k; counts[b] = (counts[b] || 0) + 1; }
    }
    return counts;
  }

  /** Questions of one scope ('company' | 'project' | 'building') that are relevant for the view and still unanswered for this entity. */
  function missingFacts(data, cat, scopeType, entity, ent, ctx) {
    const rel = relevantFlags(data, cat, ctx || {});
    // A question that only makes sense under another one ("requires") is not asked once that one is answered No.
    const parentNo = (k) => { const r = cat.flags[k].requires; return !!r && cat.flags[r] && flagState(cat, r, ent).value === false; };
    return Object.keys(rel).filter((k) => cat.flags[k].scope === scopeType && flagState(cat, k, ent).value === null && !parentNo(k));
  }

  /* ---------- status ---------- */
  const daysBetween = (fromIso, toIso) => Math.round((new Date(toIso + 'T00:00:00') - new Date(fromIso + 'T00:00:00')) / 86400000);
  /** A record's status as people see it: a past due date turns anything unfinished into Overdue. */
  function effectiveStatus(tr, today) {
    let status = (tr && tr.status) || 'Not Started';
    if (status !== 'Compliant / Completed' && status !== 'Not Applicable' && status !== 'On Hold' && tr && tr.next_due_date && daysBetween(today, tr.next_due_date) < 0) status = 'Overdue';
    return status;
  }

  /* ---------- documents ---------- */
  /** The documents a record lists in its "Forms / Documents" text, one name each. */
  function requiredDocs(item) {
    const seen = new Set(), out = [];
    String(item.forms_documents || '').split(/[\n;,]+/).forEach((p) => {
      const t = p.replace(/^\s*(and|&)\s+/i, '').replace(/[.\s]+$/, '').trim();
      if (t.length < 3 || t.length > 120 || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase()); out.push(t);
    });
    return out;
  }
  /**
   * Where a document comes from: 'prepared' (the company writes it: letters, applications, declarations, registers, logs, policies,
   * reports, permits it issues itself) or 'received' (issued by an authority or third party: certificates, NOCs, licences, sanctioned
   * plans, extracts, receipts). Only prepared documents get the "prepare from a format" flow; received ones are simply uploaded.
   */
  const PREP_HEAD = /^(application|applications|request|letter|declaration|undertaking|affidavit|intimation|notice|reply|authori[sz]ation|authority letter|nomination|appointment|board resolution|resolution|minutes|meeting minutes|indemnity|covering|self[- ]?declaration|emergency|safety policy|policy|sop|sops|erp)\b/;
  const RECV_STRONG = /\b(certificate|certificates|cert|cetificate|certifiate|noc|licen[cs]e|licen[cs]es|sanction|sanctioned|receipt|receipts|extract|7\/12|challan|challn|passport|invoice|tpi|puc|aadhaar|pan|uan|layout|drawing|drawings|map|survey|elevation|dbr|design|photos?|bank guarantee|bank gaurantee|ec copy|cc copy|cs copy|copy of|copies of|order copy|revocation order|commission order|committee order|purchase order|poa|title|zoning|demarcation|newspaper|ecr|itr-?\d|gstr|itns|mtr-?6|chg-?\d|mgt-?\d+[a-z]?|aoc-?\d+|csr-?\d|adt-?\d|cra-?\d|dir-?\d+|mbp-?\d|mr-?\d|dpt-?\d)\b/;
  const PREP_ANY = /\b(register|registers|log ?book|logbook|logs?|checklists?|policy|policies|procedure|sops?|plan|report|reports|declaration|undertaking|letter|application|request|resolution|minutes|statement|records?|permit|intimation|notice|reply|appointment|nomination|authori[sz]ation|return|forms?|erp|programme|program|matrix|inventory|agreement|agreements|nda|dpa|affidavit|affidavits|slip|correspondence|sign-off|structure|attendance|payroll|file|details|sheet|annexure|proof)\b/;
  function docOrigin(name) {
    const n = String(name || '').toLowerCase().trim().replace(/^\d+[.)]\s*/, '');
    if (!n || n === '-' || n === 'na' || n === 'n/a' || n === 'documents') return 'received';
    if (/\b(copy of|copies of)\b/.test(n)) return 'received';
    if (PREP_HEAD.test(n)) return 'prepared';
    const core = n.replace(/\(.*?\)/g, ' ').replace(/\b(filed|submitted|uploaded|retained|registered|framed)\b.*$/, '').trim();
    if (/\b(application|request|letter|declaration|undertaking|affidavit|notice|intimation|reply|replies|statement)s?$/.test(core)) return 'prepared';
    if (/\binsurance\b/.test(n)) return 'received';
    if (RECV_STRONG.test(n)) return 'received';
    if (PREP_ANY.test(n)) return 'prepared';
    return 'received';
  }
  /** Only the latest version of each named document counts. */
  function currentDocs(docs) {
    const m = new Map();
    for (const d of docs || []) {
      if (d.superseded) continue;
      const k = String(d.doc_name).toLowerCase();
      const prev = m.get(k);
      if (!prev || (d.version || 1) >= (prev.version || 1)) m.set(k, d);
    }
    return m;
  }
  /** What stops a record's documents being complete: missing, rejected, not yet verified, or expired. */
  function docIssues(item, docs, today) {
    const cur = currentDocs(docs);
    const r = { missing: [], rejected: [], unverified: [], expired: [] };
    for (const name of requiredDocs(item)) {
      const d = cur.get(name.toLowerCase());
      if (!d) r.missing.push(name);
      else if (d.status === 'Rejected') r.rejected.push(name);          // a rejection is the thing to act on first
      else if (d.expiry_date && d.expiry_date < today) r.expired.push(name);
      else if (d.status !== 'Verified') r.unverified.push(name);
    }
    r.ok = !r.missing.length && !r.rejected.length && !r.unverified.length && !r.expired.length;
    return r;
  }

  /* ---------- prerequisites ---------- */
  // Is prerequisite instance p relevant to dependent d? Same building / same phase where both have one; project-wide otherwise.
  function related(p, d) {
    if (p.buildingId && d.buildingId) return p.buildingId === d.buildingId;
    if (p.buildingId && d.phaseId) return p.phaseId === d.phaseId;
    if (p.phaseId && d.buildingId) return p.phaseId === d.phaseId;
    if (p.phaseId && d.phaseId) return p.phaseId === d.phaseId;
    return true;
  }
  /**
   * Which instances are blocked by which unfinished prerequisites.
   * deps: {edges:[{from, to}]} (from must be completed before to). cb.state(inst) -> 'active'|'review'|'na'; cb.status(inst) -> status text.
   * Returns {blockedBy: {key: [{key,id,status,scopeShort}]}, unblocks: {key: [dependent key]}, readyToStart: Set(key)}.
   */
  function computeBlocks(insts, deps, cb) {
    const byId = new Map();
    for (const i of insts) { const a = byId.get(i.item.compliance_id) || []; a.push(i); byId.set(i.item.compliance_id, a); }
    const blockedBy = {}, unblocks = {}, readyToStart = new Set();
    for (const e of (deps && deps.edges) || []) {
      for (const d of byId.get(e.to) || []) {
        if (cb.state(d) !== 'active') continue;
        const cands = (byId.get(e.from) || []).filter((p) => related(p, d) && cb.state(p) === 'active');
        if (!cands.length) continue;
        let anyOpen = false;
        for (const p of cands) {
          (unblocks[p.key] = unblocks[p.key] || []).push(d.key);
          const st = cb.status(p);
          if (st !== 'Compliant / Completed') { anyOpen = true; (blockedBy[d.key] = blockedBy[d.key] || []).push({ key: p.key, id: p.item.compliance_id, status: st, scopeShort: p.scopeShort || null, basis: e.basis || '' }); }
        }
        if (!anyOpen && !blockedBy[d.key]) readyToStart.add(d.key);
      }
    }
    for (const k of Object.keys(blockedBy)) readyToStart.delete(k);
    return { blockedBy, unblocks, readyToStart };
  }

  return { scopeTypeFor, keyFor, parseKey, enumerate, enumerateAll, evaluate, entitiesFor, flagState, relevantFlags, missingFacts, categoryOf, epcIncludes, daysBetween, effectiveStatus, requiredDocs, docOrigin, currentDocs, docIssues, computeBlocks, APPLICABILITY, stateOf };
});
