'use strict';

const crypto = require('crypto');
const {
  canonicalJson,
  planSourceNoteBoundaryReviewTransition,
} = require('./source-note-boundary-review-transition');

const BATCH_SCHEMA_VERSION = 'source-note-boundary-review-batch.v1';
const GATE_SCHEMA_VERSION = 'source-note-boundary-review-dependency-gate.v1';

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function validateBatchManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['batch manifest must be an object'] };
  if (manifest.schema_version !== BATCH_SCHEMA_VERSION) errors.push(`schema_version must be ${BATCH_SCHEMA_VERSION}`);
  if (typeof manifest.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(manifest.repository)) errors.push('repository must use owner/repo');
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) errors.push('items must be a non-empty array');
  const transitions = new Set();
  const issues = new Set();
  for (const [index, item] of (manifest.items || []).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`items[${index}] must be an object`);
      continue;
    }
    if (!Number.isInteger(item.issue_number) || item.issue_number < 1) errors.push(`items[${index}].issue_number must be a positive integer`);
    if (typeof item.request_file !== 'string' || !item.request_file) errors.push(`items[${index}].request_file is required`);
    if (issues.has(item.issue_number)) errors.push(`duplicate batch issue_number: ${item.issue_number}`);
    issues.add(item.issue_number);
    if (item.transition_id != null) {
      if (typeof item.transition_id !== 'string' || !item.transition_id) errors.push(`items[${index}].transition_id must be a non-empty string`);
      if (transitions.has(item.transition_id)) errors.push(`duplicate batch transition_id: ${item.transition_id}`);
      transitions.add(item.transition_id);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateDependencyGate(gate, liveDependencies = []) {
  const errors = [];
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return { ok: false, errors: ['dependency gate proof must be an object'] };
  if (gate.schema_version !== GATE_SCHEMA_VERSION) errors.push(`dependency gate schema_version must be ${GATE_SCHEMA_VERSION}`);
  if (gate.parent_issue !== 919) errors.push('dependency gate proof must name parent Epic #919');
  if (!Array.isArray(gate.dependencies)) errors.push('dependency gate dependencies must be an array');
  const required = new Map([ [917, 'Source Review acceptance'], [920, 'SourceNote migration acceptance'] ]);
  const supplied = new Map();
  for (const item of gate.dependencies || []) {
    const issueNumber = Number(item && item.issue_number);
    if (supplied.has(issueNumber)) errors.push(`duplicate dependency gate proof for #${issueNumber}`);
    supplied.set(issueNumber, item);
  }
  for (const [issueNumber, description] of required.entries()) {
    const item = supplied.get(issueNumber);
    if (!item) errors.push(`missing dependency gate proof for #${issueNumber} (${description})`);
    else {
      if (item.acceptance !== 'pass') errors.push(`dependency #${issueNumber} acceptance must be pass`);
      if (typeof item.evidence_url !== 'string' || !item.evidence_url) errors.push(`dependency #${issueNumber} evidence_url is required`);
      const live = liveDependencies.find((candidate) => Number(candidate.number) === issueNumber);
      if (!live) errors.push(`dependency #${issueNumber} live GitHub state is required`);
      else if (String(live.state).toLowerCase() !== 'closed') errors.push(`dependency #${issueNumber} is not closed in live GitHub state`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function pageWiseAggregate(readPage, maxPages = 100) {
  const values = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = readPage(page);
    if (!Array.isArray(result)) throw new Error(`expected paginated response array for page=${page}`);
    values.push(...result);
    if (result.length < 100) return values;
  }
  throw new Error(`pagination exceeded ${maxPages} pages`);
}

function summarizePlans(plans, manifest) {
  const counts = { ready: 0, blocked: 0, already_applied: 0 };
  const decisions = {};
  const blocked = [];
  const items = plans.map((item) => {
    const plan = item.plan;
    let status = 'blocked';
    if (plan && plan.ok) {
      status = plan.already_applied ? 'already_applied' : 'ready';
      counts[status] += 1;
      decisions[plan.decision] = (decisions[plan.decision] || 0) + 1;
    } else {
      counts.blocked += 1;
      blocked.push({ issue_number: item.issue_number, transition_id: item.transition_id || null, errors: plan && plan.errors || item.errors || ['plan unavailable'] });
    }
    return {
      issue_number: item.issue_number,
      transition_id: item.transition_id || plan && plan.request && plan.request.transition_id || null,
      source_note_id: plan && plan.request && plan.request.source_note_id || null,
      decision: plan && plan.decision || null,
      status,
      already_applied: Boolean(plan && plan.already_applied),
      interview_note_ids: plan && plan.interview_note_ids || [],
      current_body_sha256: plan && plan.current_body_sha256 || null,
      next_body_sha256: plan && plan.next_body_sha256 || null,
      errors: plan && plan.errors || item.errors || [],
    };
  });
  const report = {
    schema_version: BATCH_SCHEMA_VERSION,
    repository: manifest.repository,
    total: items.length,
    counts,
    decisions,
    blocked,
    items,
  };
  return { report, items };
}

function planBoundaryReviewBatch(manifest, entries, options = {}) {
  const manifestResult = validateBatchManifest(manifest);
  if (!manifestResult.ok) return { ok: false, errors: manifestResult.errors, report: null, plans: [] };
  const maxItems = options.maxItems == null ? manifest.items.length : options.maxItems;
  if (!Number.isInteger(maxItems) || maxItems < 1) return { ok: false, errors: ['maxItems must be a positive integer'], report: null, plans: [] };
  if (!Array.isArray(entries) || entries.length !== manifest.items.length) return { ok: false, errors: ['entries must align one-to-one with manifest.items'], report: null, plans: [] };

  const plans = entries.map((entry, index) => {
    const item = manifest.items[index];
    if (!entry || !entry.request || !entry.issue) return { issue_number: item.issue_number, transition_id: item.transition_id, plan: { ok: false, errors: ['request and live issue are required'] } };
    if (entry.request.repository !== manifest.repository) return { issue_number: item.issue_number, transition_id: item.transition_id, plan: { ok: false, errors: ['request repository does not match batch repository'] } };
    if (Number(entry.request.issue_number) !== Number(item.issue_number)) return { issue_number: item.issue_number, transition_id: item.transition_id, plan: { ok: false, errors: ['request issue_number does not match batch item'] } };
    if (item.transition_id && entry.request.transition_id !== item.transition_id) return { issue_number: item.issue_number, transition_id: item.transition_id, plan: { ok: false, errors: ['request transition_id does not match batch item'] } };
    return {
      issue_number: item.issue_number,
      transition_id: entry.request.transition_id,
      plan: planSourceNoteBoundaryReviewTransition(entry.request, entry.issue, {
        evidenceComment: entry.evidenceComment,
        receipts: entry.receipts || [],
      }),
    };
  });
  const summarized = summarizePlans(plans, manifest);
  summarized.report.max_items = maxItems;
  summarized.report.dry_run = true;
  summarized.report.dry_run_sha256 = sha256Text(canonicalJson(summarized.report));
  return {
    ok: plans.every((item) => item.plan && item.plan.ok) && summarized.report.counts.ready + summarized.report.counts.already_applied <= maxItems,
    errors: summarized.report.blocked.flatMap((item) => item.errors),
    report: summarized.report,
    plans,
  };
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  GATE_SCHEMA_VERSION,
  sha256Text,
  validateBatchManifest,
  validateDependencyGate,
  pageWiseAggregate,
  planBoundaryReviewBatch,
};
