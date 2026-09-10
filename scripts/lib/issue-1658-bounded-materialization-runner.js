'use strict';

const { canonicalDigest } = require('./aggregate-downstream-pipeline');
const {
  sha256Text,
  requestSha256,
  parseMaterializationReceipts,
  planMaterialization,
  validateRequest,
  findOwnershipMatches,
} = require('./source-note-interview-materialization');
const { validateInterviewNoteIssue } = require('./interview-note-issue');

const REPOSITORY = 'liqiangcc/interview-lab';
const PARENT_ISSUE = 1611;
const CONTROLLER_ISSUE = 1658;
const PLAN_SCHEMA = 'issue-1656-materialization-13-plan.v1';
const RUNNER_SCHEMA = 'issue-1658-bounded-interview-note-materialization-runner.v1';
const AUTH_SCHEMA = 'issue-1656-materialization-only-authorization.v1';
const AUTH_MARKER = 'issue-1656-materialization-only-authorization';
const RECEIPT_MARKER = 'source-note-interview-materialized';
const HEX64 = /^[0-9a-f]{64}$/;
const ELIGIBLE_ROWS = Object.freeze([1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458]);
const BLOCKED_ROWS = Object.freeze([972, 1266, 1326, 1349]);
const ZERO_WRITES = Object.freeze({ patch: 0, post: 0, create: 0, label: 0, interview_note: 0 });
const AUTH_REQUIREMENTS = Object.freeze([
  'fresh SourceNote GET/body SHA/revision/boundary CAS immediately before each create',
  'fresh full ownership GET and exact zero-owner check',
  'create only projected InterviewNote with base labels',
  'verify created body/labels/identity and unique owner',
  'post exactly one materialization receipt per SourceNote',
  'journal+lock+unknown reconciliation; stop fail-closed on drift',
]);

function without(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function runnerDigestInput(value) {
  const copy = without(value, 'plan_digest');
  delete copy.generated_at;
  return copy;
}

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter((label) => typeof label === 'string' && label.trim()))].sort();
}

function ownerKey(owner) {
  return `${owner && owner.interview_note_id || ''}\u0000${Number(owner && owner.issue_number)}`;
}

function markerValues(body, marker) {
  const expression = new RegExp(`<!--\\s*${marker}\\n([\\s\\S]*?)\\n-->`, 'g');
  return [...String(body || '').matchAll(expression)].map((match) => {
    try { return JSON.parse(match[1].trim()); }
    catch (error) { throw new Error(`${marker} marker is invalid JSON: ${error.message}`); }
  });
}

function validateBoundedInputPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['bounded input plan must be an object'] };
  if (plan.schema_version !== PLAN_SCHEMA) errors.push(`schema_version must be ${PLAN_SCHEMA}`);
  if (plan.repository !== REPOSITORY) errors.push(`repository must be ${REPOSITORY}`);
  if (plan.parent_issue !== PARENT_ISSUE) errors.push(`parent_issue must be ${PARENT_ISSUE}`);
  if (!HEX64.test(String(plan.plan_digest || '')) || canonicalDigest(without(plan, 'plan_digest')) !== plan.plan_digest) errors.push('bounded input plan_digest is missing or drifted');
  if (!HEX64.test(String(plan.input_plan_digest || ''))) errors.push('bounded input input_plan_digest is missing');
  if (!plan.counts || plan.counts.total !== 13 || plan.counts.create !== 13 || plan.counts.already !== 0) errors.push('bounded input counts must be total=13, create=13, already=0');
  if (!Array.isArray(plan.rows) || plan.rows.length !== 13) errors.push('bounded input must contain exactly 13 rows');
  if (!plan.ownership_inventory || plan.ownership_inventory.schema_version !== 'interview-note-ownership-inventory.v1') errors.push('bounded input ownership inventory schema mismatch');
  const inventory = plan.ownership_inventory;
  if (inventory && (inventory.label_filter !== 'type:interview-note' || inventory.issue_count !== 52 || !Array.isArray(inventory.owners) || inventory.owners.length !== inventory.issue_count || !HEX64.test(String(inventory.inventory_digest || '')))) errors.push('bounded input ownership inventory is not the complete 52-owner snapshot');
  const rowNumbers = new Set();
  const materializationIds = new Set();
  for (const row of plan.rows || []) {
    const request = row && row.request;
    const number = Number(request && request.source_note_issue_number);
    if (!ELIGIBLE_ROWS.includes(number)) errors.push(`bounded input row #${number || 'missing'} is outside the authorized 13-row scope`);
    if (rowNumbers.has(number)) errors.push(`bounded input duplicates SourceNote #${number}`);
    rowNumbers.add(number);
    if (!request) { errors.push(`bounded input row #${number || 'missing'} has no request`); continue; }
    const requestValidation = validateRequest(request);
    errors.push(...requestValidation.errors.map((error) => `#${number}: ${error}`));
    if (materializationIds.has(request.materialization_id)) errors.push(`bounded input duplicates materialization ${request.materialization_id}`);
    materializationIds.add(request.materialization_id);
    if (!row.source_issue || Number(row.source_issue.number) !== number || row.source_issue.body_sha256 !== request.expected_source_note_body_sha256) errors.push(`#${number}: source_issue digest binding drifted`);
    if (!row.plan || row.plan.action !== 'create' || row.plan.ownership_count !== 0 || !row.plan.projection) errors.push(`#${number}: row must be an unowned create plan`);
    if (row.plan && row.plan.projection && row.plan.interview_note_id !== row.plan.projection.interview_note_id) errors.push(`#${number}: projection identity binding drifted`);
  }
  if (rowNumbers.size !== ELIGIBLE_ROWS.length || ELIGIBLE_ROWS.some((number) => !rowNumbers.has(number))) errors.push('bounded input rows do not exactly match the authorized eligible scope');
  const ownerKeys = new Set();
  for (const owner of inventory && inventory.owners || []) {
    if (!owner || typeof owner.interview_note_id !== 'string' || !Number.isInteger(Number(owner.issue_number)) || ownerKeys.has(ownerKey(owner))) errors.push('bounded input ownership inventory has duplicate/invalid owner');
    ownerKeys.add(ownerKey(owner));
  }
  return { ok: errors.length === 0, errors };
}

function validateBoundedAuthorizationComment(comment, inputPlan, options = {}) {
  const errors = [];
  const values = markerValues(comment && comment.body, AUTH_MARKER);
  if (values.length !== 1) errors.push(`authorization comment must contain exactly one ${AUTH_MARKER} marker`);
  const marker = values[0];
  if (!marker) return { ok: false, errors, marker: null };
  const expectedId = Number(options.authorizationCommentId);
  const expectedIssueUrl = `https://api.github.com/repos/${REPOSITORY}/issues/${PARENT_ISSUE}`;
  const expectedCommentUrl = `https://api.github.com/repos/${REPOSITORY}/issues/comments/${expectedId}`;
  if (!Number.isSafeInteger(expectedId) || expectedId < 1) errors.push('authorization comment id must be explicitly supplied');
  if (!comment || Number(comment.id) !== expectedId || marker.comment_id !== expectedId) errors.push('authorization comment id binding mismatch');
  if (!comment || comment.issue_url !== expectedIssueUrl || (comment.issue_number != null && Number(comment.issue_number) !== PARENT_ISSUE)) errors.push('authorization comment must belong to parent Issue #1611');
  if (!comment || comment.url !== expectedCommentUrl) errors.push('authorization comment URL/id mismatch');
  const allowed = new Set(['schema_version', 'repository', 'parent_issue', 'controller_issue', 'upstream_issue', 'action', 'allow_materialization', 'allow_boundary_patch', 'allow_evidence_post', 'allow_learning_labels', 'allow_source_note_label_write', 'plan_digest', 'input_plan_digest', 'ownership_inventory_digest', 'max_create', 'max_receipts', 'comment_id', 'issued_at', 'scope', 'requirements', 'authorization_sha256']);
  for (const key of Object.keys(marker)) if (!allowed.has(key)) errors.push(`authorization marker has unsupported field ${key}`);
  if (marker.schema_version !== AUTH_SCHEMA || marker.repository !== REPOSITORY || marker.parent_issue !== PARENT_ISSUE || marker.controller_issue !== CONTROLLER_ISSUE || marker.upstream_issue !== 1605 || marker.action !== 'authorize-interview-note-materialization-only') errors.push('authorization marker binding/schema mismatch');
  if (marker.allow_materialization !== true || marker.allow_boundary_patch !== false || marker.allow_evidence_post !== false || marker.allow_learning_labels !== false || marker.allow_source_note_label_write !== false) errors.push('authorization grants an unsupported mutation');
  if (JSON.stringify(marker.requirements) !== JSON.stringify(AUTH_REQUIREMENTS)) errors.push('authorization requirements are not the bounded materialization contract');
  if (!inputPlan || marker.plan_digest !== inputPlan.plan_digest || marker.input_plan_digest !== inputPlan.input_plan_digest || marker.ownership_inventory_digest !== inputPlan.ownership_inventory.inventory_digest) errors.push('authorization does not bind the bounded input plan and ownership inventory');
  if (marker.max_create !== 13 || marker.max_receipts !== 13 || Number(options.maxCreate) !== 13 || Number(options.maxReceipts) !== 13) errors.push('authorization ceilings must be exactly 13 creates and 13 receipts');
  if (JSON.stringify(marker.scope && marker.scope.eligible_rows) !== JSON.stringify(ELIGIBLE_ROWS) || JSON.stringify(marker.scope && marker.scope.blocked_rows) !== JSON.stringify(BLOCKED_ROWS)) errors.push('authorization scope is not the exact bounded 13-row scope');
  if (!HEX64.test(String(marker.authorization_sha256 || '')) || canonicalDigest(without(marker, 'authorization_sha256')) !== marker.authorization_sha256) errors.push('authorization_sha256 is missing or drifted');
  return { ok: errors.length === 0, errors, marker };
}

function normalizeFreshSource(issue) {
  const parsed = require('./interview-note-materialization-batch').issueSourceRecord(issue).parsed;
  return {
    number: Number(issue && issue.number),
    body_sha256: sha256Text(issue && issue.body || ''),
    labels: labelsOf(issue),
    source_note_id: parsed && parsed.source_note_id || null,
    source_revision_id: parsed && parsed.source_revision && parsed.source_revision.id || null,
    boundary_status: parsed && parsed.boundary_review && parsed.boundary_review.status || null,
  };
}

function ownershipSummary(issues) {
  return (issues || []).map((issue) => {
    const parsed = require('./interview-note-issue').parseInterviewNoteIssue(issue.body || '');
    return { interview_note_id: parsed.marker && parsed.marker.interview_note_id, issue_number: Number(issue.number) };
  }).sort((a, b) => a.interview_note_id.localeCompare(b.interview_note_id));
}

function resumeOwnershipAllowance(inputPlan, journal) {
  const errors = [];
  const rows = new Map((inputPlan && inputPlan.rows || []).map((row) => [row.request && row.request.materialization_id, row]));
  const owners = [];
  const identities = new Set((inputPlan && inputPlan.ownership_inventory && inputPlan.ownership_inventory.owners || []).map((owner) => owner.interview_note_id));
  const issueNumbers = new Set((inputPlan && inputPlan.ownership_inventory && inputPlan.ownership_inventory.owners || []).map((owner) => Number(owner.issue_number)));
  for (const item of journal && journal.items || []) {
    if (item.phase !== 'complete') continue;
    const beforeErrors = errors.length;
    const row = rows.get(item.materialization_id);
    const intent = journal.intents && journal.intents[item.materialization_id];
    if (!row || !intent) {
      errors.push(`completed journal item ${item.materialization_id} lacks a bounded row or intent`);
      continue;
    }
    if (item.request_sha256 !== requestSha256(row.request)) errors.push(`completed journal request SHA drifted for ${item.materialization_id}`);
    if (intent.request_sha256 !== requestSha256(row.request)) errors.push(`completed journal intent request SHA drifted for ${item.materialization_id}`);
    if (intent.interview_note_id !== row.plan.interview_note_id) errors.push(`completed journal identity drifted for ${item.materialization_id}`);
    const issueNumber = Number(intent.interview_issue_number);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) errors.push(`completed journal owner number is invalid for ${item.materialization_id}`);
    if (identities.has(intent.interview_note_id)) errors.push(`completed journal owner identity duplicates the baseline for ${item.materialization_id}`);
    if (issueNumbers.has(issueNumber)) errors.push(`completed journal owner Issue duplicates the baseline for ${item.materialization_id}`);
    if (owners.some((owner) => owner.interview_note_id === intent.interview_note_id || Number(owner.issue_number) === issueNumber)) errors.push(`completed journal owner duplicates another resumed row for ${item.materialization_id}`);
    if (errors.length === beforeErrors && Number.isInteger(issueNumber) && issueNumber > 0) {
      owners.push({ interview_note_id: intent.interview_note_id, issue_number: issueNumber });
    }
  }
  return { ok: errors.length === 0, errors, owners };
}

function compareOwnershipToBoundedSnapshot(inputPlan, freshIssues, options = {}) {
  const allowance = options.journal ? resumeOwnershipAllowance(inputPlan, options.journal) : { ok: true, errors: [], owners: [] };
  const expectedOwners = [...(inputPlan.ownership_inventory.owners || []), ...allowance.owners];
  const expected = new Set(expectedOwners.map(ownerKey));
  const actual = ownershipSummary(freshIssues);
  const seen = new Set();
  const expectedIdentities = new Set();
  const errors = [];
  errors.push(...allowance.errors);
  for (const owner of expectedOwners) {
    if (expectedIdentities.has(owner.interview_note_id)) errors.push(`bounded ownership allowance duplicates InterviewNote identity ${owner.interview_note_id}`);
    expectedIdentities.add(owner.interview_note_id);
  }
  const actualIdentities = new Set();
  for (const owner of actual) {
    if (!owner.interview_note_id || !Number.isInteger(owner.issue_number)) errors.push('fresh ownership inventory contains an invalid owner');
    if (seen.has(ownerKey(owner))) errors.push(`fresh ownership inventory duplicates ${owner.interview_note_id}`);
    if (actualIdentities.has(owner.interview_note_id)) errors.push(`fresh ownership inventory duplicates InterviewNote identity ${owner.interview_note_id}`);
    seen.add(ownerKey(owner));
    actualIdentities.add(owner.interview_note_id);
  }
  if (expected.size !== actual.length || expected.size !== seen.size || [...expected].some((key) => !seen.has(key)) || [...seen].some((key) => !expected.has(key))) errors.push(`fresh full ownership inventory differs from the authorized baseline plus ${allowance.owners.length} completed bounded owner(s)`);
  return { ok: errors.length === 0, errors, owners: actual, resumed_owners: allowance.owners };
}

function validateFreshBoundedRows(inputPlan, freshRows, freshOwnershipIssues, options = {}) {
  const errors = [];
  const ownershipCheck = compareOwnershipToBoundedSnapshot(inputPlan, freshOwnershipIssues, options);
  errors.push(...ownershipCheck.errors);
  const results = [];
  for (const row of inputPlan.rows || []) {
    const request = row.request;
    const fresh = freshRows.get(Number(request.source_note_issue_number));
    if (!fresh || !fresh.issue) {
      errors.push(`#${request.source_note_issue_number}: fresh SourceNote GET is missing`);
      results.push({ action: 'blocked', source_note_issue_number: request.source_note_issue_number, request, request_sha256: requestSha256(request), errors: ['fresh SourceNote GET is missing'] });
      continue;
    }
    const boundIdentity = row.plan.interview_note_id;
    let derived;
    try {
      // Derive identity from the fresh SourceNote before consulting the
      // ownership inventory. The bound plan identity is only a value to
      // verify; it must never choose which owner search is performed.
      derived = planMaterialization(request, { repository: REPOSITORY, sourceIssue: fresh.issue, issues: [], receipts: [] });
    } catch (error) {
      derived = { ok: false, errors: [error.message] };
    }
    const rowErrors = [...(derived.errors || [])];
    if (derived.interview_note_id !== boundIdentity) rowErrors.push(`fresh SourceNote identity ${derived.interview_note_id || 'missing'} does not match bound row identity ${boundIdentity || 'missing'}`);
    if (!derived.projection || derived.projection.interview_note_id !== boundIdentity) rowErrors.push('fresh projection identity does not match bound row identity');
    if (rowErrors.length) {
      errors.push(...rowErrors.map((error) => `#${request.source_note_issue_number}: ${error}`));
      results.push({ action: 'blocked', source_note_issue_number: request.source_note_issue_number, request, request_sha256: requestSha256(request), expected_interview_note_id: boundIdentity, errors: rowErrors });
      continue;
    }
    const owners = findOwnershipMatches(freshOwnershipIssues, derived.interview_note_id);
    let checked;
    try {
      checked = planMaterialization(request, { repository: REPOSITORY, sourceIssue: fresh.issue, issues: owners, receipts: parseMaterializationReceipts(fresh.comments || []) });
    } catch (error) {
      checked = { ok: false, errors: [error.message] };
    }
    rowErrors.push(...(checked.errors || []));
    if (checked.interview_note_id !== boundIdentity) rowErrors.push('checked InterviewNote identity does not match bound row identity');
    if (!checked.projection || checked.projection.interview_note_id !== boundIdentity) rowErrors.push('checked projection identity does not match bound row identity');
    const alreadyMaterialized = checked.action === 'existing' && checked.already_materialized && checked.ownership_count === 1;
    if (!alreadyMaterialized && (checked.action !== 'create' || checked.ownership_count !== 0)) rowErrors.push('fresh CAS is not an unowned create or an exact already-materialized owner');
    const projection = row.plan.projection;
    if (checked.projection && (checked.projection.title !== projection.title || sha256Text(checked.projection.body) !== sha256Text(projection.body) || JSON.stringify(labelsOf(checked.projection)) !== JSON.stringify(labelsOf(projection)))) rowErrors.push('fresh projection differs from the bounded plan');
    if (rowErrors.length) {
      errors.push(...rowErrors.map((error) => `#${request.source_note_issue_number}: ${error}`));
      results.push({ action: 'blocked', source_note_issue_number: request.source_note_issue_number, request, request_sha256: requestSha256(request), expected_interview_note_id: row.plan.interview_note_id, errors: rowErrors });
    } else {
      results.push({ action: alreadyMaterialized ? 'already-materialized' : 'would-materialize', source_note_issue_number: request.source_note_issue_number, request, request_sha256: requestSha256(request), derived_interview_note_id: row.plan.interview_note_id, existing_issue_number: alreadyMaterialized ? checked.existing_issue_number : null, projection: { ...projection, projected_body_sha256: sha256Text(projection.body), projected_title: projection.title, projected_labels: projection.labels }, fresh_source: normalizeFreshSource(fresh.issue), fresh_receipt_count: parseMaterializationReceipts(fresh.comments || []).filter((receipt) => receipt.materialization_id === request.materialization_id).length });
    }
  }
  return { ok: errors.length === 0, errors, results, ownership: ownershipCheck.owners };
}

function buildBoundedRunnerPlan({ inputPlan, freshRows, freshOwnershipIssues, journal = null, generatedAt = new Date().toISOString() }) {
  const inputValidation = validateBoundedInputPlan(inputPlan);
  const rowValidation = inputValidation.ok && freshRows instanceof Map && Array.isArray(freshOwnershipIssues)
    ? validateFreshBoundedRows(inputPlan, freshRows, freshOwnershipIssues, { journal })
    : {
      ok: inputValidation.ok,
      errors: [],
      results: (inputPlan && inputPlan.rows || []).map((row) => ({
        action: 'would-materialize',
        source_note_issue_number: row.request.source_note_issue_number,
        request: row.request,
        request_sha256: requestSha256(row.request),
        derived_interview_note_id: row.plan.interview_note_id,
        projection: row.plan.projection,
        fresh_source: null,
        fresh_required_before_apply: true,
      })),
      ownership: [],
    };
  const errors = [...inputValidation.errors, ...rowValidation.errors];
  const results = rowValidation.results;
  const counts = { total: results.length, create: results.filter((result) => result.action === 'would-materialize').length, already: results.filter((result) => result.action === 'already-materialized').length, blocked: results.filter((result) => result.action === 'blocked').length };
  const content = {
    schema_version: RUNNER_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    controller_issue: CONTROLLER_ISSUE,
    mode: freshRows instanceof Map && Array.isArray(freshOwnershipIssues) ? 'bounded-13-fresh-get-only' : 'bounded-13-plan-only-adapter',
    generated_at: generatedAt,
    input_plan_digest: inputPlan && inputPlan.plan_digest,
    input_plan_input_digest: inputPlan && inputPlan.input_plan_digest,
    ownership_inventory_digest: inputPlan && inputPlan.ownership_inventory && inputPlan.ownership_inventory.inventory_digest,
    fresh_get_required_before_apply: !(freshRows instanceof Map && Array.isArray(freshOwnershipIssues)),
    fresh_ownership: { complete: freshRows instanceof Map && Array.isArray(freshOwnershipIssues) && errors.every((error) => !String(error).includes('ownership inventory')), count: rowValidation.ownership.length, owners: rowValidation.ownership },
    counts,
    mutation_performed: false,
    write_operations: { ...ZERO_WRITES },
    results,
    errors,
  };
  content.ok = errors.length === 0 && counts.total === 13 && counts.create + counts.already === 13 && counts.blocked === 0;
  content.ready_for_apply = content.ok && content.fresh_get_required_before_apply !== true;
  return { ...content, plan_digest: canonicalDigest(runnerDigestInput(content)) };
}

function validateBoundedRunnerPlan(plan) {
  const errors = [];
  if (!plan || plan.schema_version !== RUNNER_SCHEMA) errors.push('bounded runner schema mismatch');
  if (plan && (plan.repository !== REPOSITORY || plan.parent_issue !== PARENT_ISSUE || plan.controller_issue !== CONTROLLER_ISSUE)) errors.push('bounded runner issue binding mismatch');
  if (plan && (!HEX64.test(String(plan.plan_digest || '')) || canonicalDigest(runnerDigestInput(plan)) !== plan.plan_digest)) errors.push('bounded runner plan digest drifted');
  if (plan && (plan.mutation_performed !== false || canonicalDigest(plan.write_operations || {}) !== canonicalDigest(ZERO_WRITES))) errors.push('bounded runner claims a write');
  if (plan && (!plan.ok || !plan.ready_for_apply || plan.counts?.total !== 13 || plan.counts?.create + plan.counts?.already !== 13 || plan.counts?.blocked !== 0 || !Array.isArray(plan.errors) || plan.errors.length)) errors.push('bounded runner is not apply-ready');
  return { ok: errors.length === 0, errors };
}

function receiptObject(request, projection, issueNumber, now = new Date().toISOString()) {
  return {
    schema_version: 'source-note-interview-materialized.v1',
    materialization_id: request.materialization_id,
    request_sha256: requestSha256(request),
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256 ?? null,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    interview_note_id: projection.interview_note_id,
    interview_issue_number: Number(issueNumber),
    interview_issue_body_sha256: sha256Text(projection.body),
    materialized_at: now,
  };
}

function receiptBody(receipt) {
  return `<!-- ${RECEIPT_MARKER}\n${JSON.stringify(receipt, null, 2)}\n-->\n\nInterviewNote materialization receipt.`;
}

function exactReceipt(receipts, expected) {
  const matching = (receipts || []).filter((receipt) => receipt.materialization_id === expected.materialization_id);
  if (matching.length > 1) throw new Error(`SourceNote #${expected.source_note_issue_number} has duplicate materialization receipts`);
  if (matching.length === 1) {
    const receipt = matching[0];
    const fields = ['request_sha256', 'source_note_id', 'source_note_body_sha256', 'source_revision_id', 'interview_note_id', 'interview_issue_number', 'interview_issue_body_sha256'];
    if (fields.some((field) => String(receipt[field]) !== String(expected[field]))) throw new Error(`SourceNote #${expected.source_note_issue_number} has a conflicting materialization receipt`);
    return receipt;
  }
  return null;
}

module.exports = {
  REPOSITORY, PARENT_ISSUE, CONTROLLER_ISSUE, PLAN_SCHEMA, RUNNER_SCHEMA, AUTH_SCHEMA, AUTH_MARKER, RECEIPT_MARKER,
  ELIGIBLE_ROWS, BLOCKED_ROWS, AUTH_REQUIREMENTS, ZERO_WRITES, labelsOf, markerValues, runnerDigestInput, validateBoundedInputPlan,
  validateBoundedAuthorizationComment, normalizeFreshSource, resumeOwnershipAllowance, compareOwnershipToBoundedSnapshot,
  validateFreshBoundedRows, buildBoundedRunnerPlan, validateBoundedRunnerPlan, receiptObject, receiptBody, exactReceipt,
};
