'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {
  canonicalDigest,
  sha256Text,
  validateInterviewNoteOwnershipInventory,
} = require('./aggregate-downstream-pipeline');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./interview-note-issue');
const { validateInterviewContext, buildLearningDiscovery } = require('./interview-context');
const { buildLabelProvisioningPlan, normalizeLabels } = require('./issue-label-taxonomy');
const labelConfig = require('../../config/issue-labels.json');

const SCHEMA_VERSION = 'issue-1662-dynamic-context-learning-plan.v1';
const INPUT_SCHEMA_VERSION = 'issue-1662-context-learning-input.v1';
const AUTH_SCHEMA_VERSION = 'issue-1662-context-learning-authorization.v1';
const JOURNAL_SCHEMA_VERSION = 'issue-1662-context-learning-apply-journal.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const PARENT_ISSUE = 1611;
const ISSUE_NUMBER = 1662;
const SOURCE_REVIEW_RECEIPT_SCHEMA = 'interview-note-source-review-applied.v1';
const SOURCE_REVIEW_RECEIPT_SCHEMAS = new Set([
  SOURCE_REVIEW_RECEIPT_SCHEMA,
  'issue-1661-source-review-receipt.v1',
  'issue-1661-source-review-receipts.v1',
]);
const MATERIALIZATION_AUDIT_SCHEMA = 'issue-1658-materialization-post-audit.v1';
const MATERIALIZATION_AUDIT_SCHEMAS = new Set([
  MATERIALIZATION_AUDIT_SCHEMA,
  'issue-1658-materialization-plan.v1',
  'issue-1611-live-materialization-plan.v1',
]);
const OWNERSHIP_INVENTORY_SCHEMA = 'aggregate-interview-note-ownership-inventory.v1';
const CONTEXT_SCHEMA = 'interview-context.v1';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const DISCOVERY_PREFIXES = ['company:', 'role:', 'recruitment:', 'round:', 'source-year:', 'interview-year:'];
const ZERO_WRITES = Object.freeze({ patch: 0, post: 0, create: 0 });
const SPOILER_RE = /(凉经|挂科|挂了|拒绝|未通过|通过|失败|淘汰|录用|入职|offer|rejected|passed|failed|outcome|result)/i;
const REQUIRED_SEQUENCE = Object.freeze(['source-ready', 'reviewed-context', 'learning-discovery']);

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

function isTimestamp(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }

function withoutDigest(value, field = 'canonical_digest') {
  const copy = { ...(value || {}) };
  delete copy[field];
  return copy;
}

function inputDigest(value) { return canonicalDigest(value); }

function labelsOf(issue) { return normalizeLabels(issue && issue.labels || []); }

function terminalStatus(receipt, errors = null) {
  if (!receipt || typeof receipt !== 'object') return null;
  const values = ['final_status', 'status', 'decision']
    .map((field) => receipt[field])
    .filter((value) => nonEmpty(value))
    .map((value) => String(value));
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    if (Array.isArray(errors)) errors.push(`receipt terminal status fields conflict: ${unique.join(', ')}`);
    return null;
  }
  return unique[0] || null;
}

function stripDiscoveryLabels(labels) {
  return normalizeLabels(labels).filter((label) => !DISCOVERY_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

function unknownFacts(context) {
  return [
    ['company', context && context.company && context.company.id == null],
    ['role', context && context.role && context.role.family === 'unknown'],
    ['recruitment_type', context && context.recruitment_type && context.recruitment_type.value === 'unknown'],
    ['round', context && context.round && context.round.value === 'unknown'],
    ['interview_occurred_at', context && context.interview_occurred_at && context.interview_occurred_at.precision === 'unknown'],
  ].filter(([, value]) => value).map(([name]) => name);
}

function candidateEntries(inventory) {
  return Array.isArray(inventory && inventory.entries) ? [...inventory.entries].sort((a, b) => Number(a.issue_number) - Number(b.issue_number)) : [];
}

function validateFreshOwnershipInventory(inventory, options = {}) {
  const errors = [];
  const manifest = { repository: REPOSITORY };
  const base = validateInterviewNoteOwnershipInventory(inventory, manifest);
  errors.push(...base.errors);
  if (inventory && inventory.schema_version !== OWNERSHIP_INVENTORY_SCHEMA) errors.push(`ownership inventory schema must be ${OWNERSHIP_INVENTORY_SCHEMA}`);
  const freshness = inventory && (inventory.fresh === true || inventory.freshness === 'fresh' || inventory.capture_status === 'fresh');
  const capturedAt = inventory && (inventory.captured_at || inventory.generated_at || inventory.observed_at);
  if (!freshness && !options.fresh) errors.push('ownership inventory must explicitly declare fresh=true/freshness=fresh');
  if (!isTimestamp(capturedAt) && !options.capturedAt) errors.push('fresh ownership inventory must include captured_at/generated_at/observed_at');
  if (options.digest && (!inventory || inputDigest(inventory) !== options.digest)) errors.push('ownership inventory artifact digest does not match the requested binding');
  const entries = candidateEntries(inventory);
  const ids = new Set();
  const issues = new Set();
  for (const entry of entries) {
    const id = entry && entry.interview_note_id;
    const number = Number(entry && entry.issue_number);
    if (!nonEmpty(id) || id.indexOf(':') < 1 || ids.has(id)) errors.push(`ownership inventory has duplicate/missing interview_note_id: ${id || 'unknown'}`);
    if (!Number.isInteger(number) || number < 1 || issues.has(number)) errors.push(`ownership inventory has duplicate/invalid issue_number: ${entry && entry.issue_number}`);
    if (!HEX64.test(entry && entry.body_sha256 || '')) errors.push(`ownership inventory ${id || 'unknown'} must bind body_sha256`);
    if (!nonEmpty(entry && entry.source_revision_id)) errors.push(`ownership inventory ${id || 'unknown'} must bind source_revision_id`);
    ids.add(id); issues.add(number);
  }
  return {
    ok: errors.length === 0,
    errors,
    count: entries.length,
    entries,
    canonical_digest: inventory && inventory.canonical_digest || null,
    freshness: { fresh: Boolean(freshness || options.fresh), captured_at: capturedAt || options.capturedAt || null },
    byInterview: new Map(entries.map((entry) => [entry.interview_note_id, entry])),
    byIssue: new Map(entries.map((entry) => [Number(entry.issue_number), entry])),
  };
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.results)) return value.results;
  if (value && Array.isArray(value.receipts)) return value.receipts;
  if (value && Array.isArray(value.entries)) return value.entries;
  return null;
}

function validateInputDigestBinding(value, binding, name, errors) {
  if (!binding || typeof binding !== 'object') {
    errors.push(`${name} digest binding is required`);
    return null;
  }
  if (!nonEmpty(binding.path)) errors.push(`${name} path is required`);
  if (!HEX64.test(binding.sha256 || '')) errors.push(`${name} sha256 binding is required`);
  if (value != null && HEX64.test(binding.sha256 || '') && inputDigest(value) !== binding.sha256) errors.push(`${name} digest does not match supplied artifact`);
  return { path: binding.path || null, sha256: binding.sha256 || null, present: value != null };
}

function validateMaterializationAudit(audit, inventoryValidation, errors) {
  const rows = rowsFrom(audit);
  if (!audit || typeof audit !== 'object') { errors.push('Issue #1658 materialization/post-audit is required'); return new Map(); }
  if (!MATERIALIZATION_AUDIT_SCHEMAS.has(audit.schema_version)) errors.push(`materialization/post-audit schema must be one of ${[...MATERIALIZATION_AUDIT_SCHEMAS].join(', ')}`);
  const auditScope = Number(audit.issue_number || audit.parent_issue || audit.materialization_issue_number || audit.controller_issue_number);
  if (auditScope !== 1658) errors.push('materialization/post-audit must be scoped to #1658');
  if (audit.post_audit !== true && !['pass', 'passed', 'complete', 'completed', 'converged', 'verified'].includes(String(audit.post_audit_status || audit.audit_status || '').toLowerCase())) errors.push('materialization/post-audit must explicitly pass');
  if (typeof audit.mutation_performed !== 'boolean' && !nonEmpty(audit.mutation_status) && !nonEmpty(audit.mutation_state)) errors.push('materialization/post-audit must declare actual mutation state');
  if (!rows) { errors.push('materialization/post-audit must contain items/results/entries'); return new Map(); }
  const byIssue = new Map();
  for (const row of rows) {
    const number = Number(row && (row.issue_number || row.interview_issue_number || row.owner_issue_number));
    const id = row && (row.interview_note_id || row.derived_interview_note_id);
    if (!Number.isInteger(number) || !nonEmpty(id)) { errors.push('materialization/post-audit row must bind issue_number and interview_note_id'); continue; }
    const rowScope = Number(row.parent_issue || row.materialization_issue_number || row.audit_issue_number || row.controller_issue_number || row.scope_issue_number || (row.scope && row.scope.issue_number));
    if (rowScope !== 1658) errors.push(`materialization/post-audit Issue #${number} row must explicitly bind #1658 scope`);
    if (byIssue.has(number)) errors.push(`duplicate materialization/post-audit row for Issue #${number}`);
    byIssue.set(number, row);
    const owner = inventoryValidation.byIssue.get(number);
    if (!owner) errors.push(`materialization/post-audit Issue #${number} is not in the fresh full owner inventory`);
    else {
      if (owner.interview_note_id !== id) errors.push(`materialization/post-audit Issue #${number} identity differs from ownership inventory`);
      const sourceNoteSha = row.source_note_body_sha256 || row.source_note_body_sha || row.source_body_sha256 || row.source_body_sha;
      const bodySha = row.body_sha256 || row.interview_body_sha256 || row.projected_body_sha256;
      if (!HEX64.test(sourceNoteSha || '')) errors.push(`materialization/post-audit Issue #${number} must bind complete source_note_body_sha256/body_sha`);
      if (!HEX64.test(bodySha || '') || bodySha !== owner.body_sha256) errors.push(`materialization/post-audit Issue #${number} body SHA must be complete and match ownership inventory`);
      if (!nonEmpty(row.source_revision_id)) errors.push(`materialization/post-audit Issue #${number} source_revision_id is required`);
      else if (row.source_revision_id !== owner.source_revision_id) errors.push(`materialization/post-audit Issue #${number} SourceRevision differs from ownership inventory`);
      if (owner.source_note_id && row.source_note_id !== owner.source_note_id) errors.push(`materialization/post-audit Issue #${number} SourceNote identity differs from ownership inventory`);
    }
    const rowPostAudit = String(row.post_audit_status || row.audit_status || row.post_apply_audit_status || '').toLowerCase();
    if (!['pass', 'passed', 'complete', 'completed', 'converged', 'verified'].includes(rowPostAudit)) errors.push(`materialization/post-audit Issue #${number} must declare an actual passing post-audit state`);
    const hasMutationState = typeof row.mutation_performed === 'boolean' || nonEmpty(row.mutation_state) || nonEmpty(row.mutation_status) || nonEmpty(row.materialization_state);
    if (!hasMutationState) errors.push(`materialization/post-audit Issue #${number} must declare actual mutation/materialization state`);
  }
  for (const owner of inventoryValidation.entries) if (!byIssue.has(Number(owner.issue_number))) errors.push(`materialization/post-audit is missing owner Issue #${owner.issue_number}`);
  return byIssue;
}

function receiptBindingObject(receipt, wrapped) {
  if (receipt && receipt.request && typeof receipt.request === 'object') return receipt.request;
  if (receipt && receipt.marker && typeof receipt.marker === 'object') return receipt.marker;
  if (wrapped && wrapped.request && typeof wrapped.request === 'object') return wrapped.request;
  if (wrapped && wrapped.marker && typeof wrapped.marker === 'object') return wrapped.marker;
  return null;
}

function validateReceiptBinding(receipt, wrapped, owner, materialized, id, errors) {
  if (!receipt || receipt.repository !== REPOSITORY) errors.push(`#1661 receipt ${id} must bind repository ${REPOSITORY}`);
  const sourceNoteId = receipt && receipt.source_note_id;
  if (!nonEmpty(sourceNoteId)) errors.push(`#1661 receipt ${id} must bind SourceNote identity`);
  if (owner && owner.source_note_id && sourceNoteId !== owner.source_note_id) errors.push(`#1661 receipt ${id} SourceNote identity differs from ownership inventory`);
  if (materialized && materialized.source_note_id && sourceNoteId !== materialized.source_note_id) errors.push(`#1661 receipt ${id} SourceNote identity differs from #1658 post-audit`);
  const binding = receiptBindingObject(receipt, wrapped);
  if (!binding) {
    errors.push(`#1661 receipt ${id} must contain a complete marker/request binding`);
    return;
  }
  if (binding.repository !== REPOSITORY) errors.push(`#1661 receipt ${id} marker/request repository binding is invalid`);
  if (binding.interview_note_id !== id) errors.push(`#1661 receipt ${id} marker/request interview_note_id binding is invalid`);
  if (binding.source_note_id !== sourceNoteId) errors.push(`#1661 receipt ${id} marker/request SourceNote identity binding is invalid`);
  if (binding.source_revision_id !== receipt.source_revision_id) errors.push(`#1661 receipt ${id} marker/request SourceRevision binding is invalid`);
  if (binding.source_note_body_sha256 !== receipt.source_note_body_sha256) errors.push(`#1661 receipt ${id} marker/request SourceNote body SHA binding is invalid`);
  const bindingIssue = Number(binding.interview_issue_number || binding.owner_issue_number || binding.issue_number);
  if (!owner || bindingIssue !== Number(owner.issue_number)) errors.push(`#1661 receipt ${id} marker/request owner Issue binding is invalid`);
  if (binding.source_ref !== SOURCE_REF) errors.push(`#1661 receipt ${id} marker/request source ref binding is invalid`);
  if (!nonEmpty(binding.request_id) && !nonEmpty(binding.request_sha256) && !nonEmpty(binding.evidence_subject_sha256) && !nonEmpty(binding.marker_id)) errors.push(`#1661 receipt ${id} marker/request identifier is required`);
}

function receiptIndex(receipts, inventoryValidation, errors, materialization = new Map()) {
  const rows = rowsFrom(receipts);
  const byInterview = new Map();
  if (!rows) { errors.push('#1661 Source Review receipts must contain an array'); return byInterview; }
  for (const wrapped of rows) {
    const receipt = wrapped && wrapped.receipt && typeof wrapped.receipt === 'object' ? wrapped.receipt : wrapped;
    const id = receipt && receipt.interview_note_id;
    if (!nonEmpty(id)) { errors.push('#1661 receipt is missing interview_note_id'); continue; }
    if (byInterview.has(id)) errors.push(`duplicate #1661 Source Review receipt for ${id}`);
    if (!SOURCE_REVIEW_RECEIPT_SCHEMAS.has(receipt.schema_version)) errors.push(`#1661 receipt ${id} has wrong schema`);
    if (receipt.independent !== true && !(receipt.evidence && receipt.evidence.independent === true)) errors.push(`#1661 receipt ${id} is not independent`);
    if (receipt.boundary_evidence_reuse === true || receipt.reused_boundary_evidence === true) errors.push(`#1661 receipt ${id} reuses boundary evidence`);
    const owner = inventoryValidation.byInterview.get(id);
    if (!owner) errors.push(`#1661 receipt ${id} is not owned by the fresh inventory`);
    if (owner && receipt.interview_issue_number !== undefined && Number(receipt.interview_issue_number) !== Number(owner.issue_number)) errors.push(`#1661 receipt ${id} owner Issue mismatch`);
    if (!HEX64.test(receipt.source_note_body_sha256 || '')) errors.push(`#1661 receipt ${id} must bind source_note_body_sha256`);
    if (!nonEmpty(receipt.source_revision_id)) errors.push(`#1661 receipt ${id} must bind source_revision_id`);
    const materialized = owner && materialization.get(Number(owner.issue_number));
    if (materialized && (materialized.source_note_body_sha256 || materialized.source_note_body_sha || materialized.source_body_sha256)
      && receipt.source_note_body_sha256 !== (materialized.source_note_body_sha256 || materialized.source_note_body_sha || materialized.source_body_sha256)) errors.push(`#1661 receipt ${id} SourceNote body SHA differs from #1658 post-audit`);
    if (owner && (owner.source_note_body_sha256 || owner.source_body_sha256)
      && receipt.source_note_body_sha256 !== owner.source_note_body_sha256
      && receipt.source_note_body_sha256 !== owner.source_body_sha256) errors.push(`#1661 receipt ${id} SourceNote body SHA does not match owner binding`);
    if (owner && receipt.source_revision_id !== owner.source_revision_id) errors.push(`#1661 receipt ${id} SourceRevision does not match owner binding`);
    if (receipt.source_repository_ref !== SOURCE_REF) errors.push(`#1661 receipt ${id} must bind the frozen source ref`);
    if (!HEX64.test(receipt.interview_body_sha256 || '')) errors.push(`#1661 receipt ${id} must bind interview_body_sha256`);
    validateReceiptBinding(receipt, wrapped, owner, materialized, id, errors);
    const status = terminalStatus(receipt, errors);
    if (!['source-ready', 'blocked'].includes(status)) errors.push(`#1661 receipt ${id} has no terminal status`);
    byInterview.set(id, receipt);
  }
  for (const owner of inventoryValidation.entries) if (!byInterview.has(owner.interview_note_id)) errors.push(`#1661 Source Review receipt is missing for ${owner.interview_note_id}`);
  return byInterview;
}

function contextIndex(contextArtifacts, inventoryValidation, errors, receipts = new Map()) {
  const rows = rowsFrom(contextArtifacts);
  const byIssue = new Map();
  if (!rows) { errors.push('Context artifacts must contain an array'); return byIssue; }
  for (const wrapped of rows) {
    const item = wrapped && wrapped.context ? wrapped : { context: wrapped, artifact: wrapped && wrapped.artifact };
    const context = item.context;
    const id = context && context.interview_note_id;
    const owner = inventoryValidation.byInterview.get(id);
    const issueNumber = Number(item.issue_number || item.interview_issue_number || (owner && owner.issue_number));
    if (!context || !nonEmpty(id) || !Number.isInteger(issueNumber)) { errors.push('Context artifact row must bind context.interview_note_id and owner issue_number'); continue; }
    if (byIssue.has(issueNumber)) errors.push(`duplicate Context artifact for Issue #${issueNumber}`);
    byIssue.set(issueNumber, item);
    if (!owner) errors.push(`Context ${id} is not owned by the fresh inventory`);
    else if (Number(owner.issue_number) !== issueNumber) errors.push(`Context ${id} owner Issue mismatch`);
    const validation = validateInterviewContext(context);
    if (!validation.ok) errors.push(`Context ${id} failed validation: ${validation.errors.join('; ')}`);
    if (hasForbiddenRawFields(item)) errors.push(`Context ${id} contains a Raw body field`);
    if (owner && context.source_revision_id !== owner.source_revision_id) errors.push(`Context ${id} SourceRevision does not match owner binding`);
    const artifact = item.artifact || item.context_artifact;
    if (!artifact || artifact.repository !== REPOSITORY || !/^data\/interview-contexts\/[A-Za-z0-9_-]+\.v1\.json$/.test(artifact.path || '') || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(artifact.ref || '') || !HEX40.test(artifact.commit || '') || !HEX64.test(artifact.sha256 || '')) {
      errors.push(`Context ${id} artifact must bind repository/path/ref/40-char commit/64-char digest`);
    } else if (artifact.sha256 !== canonicalDigest(context)) errors.push(`Context ${id} artifact digest does not match reviewed Context`);
    const artifactContent = item.content !== undefined ? item.content : (item.artifact_content !== undefined ? item.artifact_content : null);
    if (artifactContent !== null && artifactContent !== undefined) {
      try {
        const parsed = typeof artifactContent === 'string' ? JSON.parse(artifactContent) : artifactContent;
        if (canonicalDigest(parsed) !== artifact.sha256) errors.push(`Context ${id} durable artifact content digest mismatch`);
      } catch (error) { errors.push(`Context ${id} durable artifact content is invalid JSON: ${error.message}`); }
    }
  }
  for (const owner of inventoryValidation.entries) {
    const receipt = receipts.get(owner.interview_note_id);
    const sourceReady = terminalStatus(receipt) === 'source-ready';
    if (sourceReady && !byIssue.has(Number(owner.issue_number))) errors.push(`reviewed Context artifact is missing for source-ready Issue #${owner.issue_number}`);
  }
  return byIssue;
}

function hasForbiddenRawFields(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenRawFields);
  return Object.entries(value).some(([key, child]) => ['body', 'next_body', 'raw_body', 'raw_source'].includes(key) || hasForbiddenRawFields(child));
}

function liveIndex(snapshot, inventoryValidation, errors) {
  const rows = rowsFrom(snapshot);
  const byIssue = new Map();
  if (!rows) { errors.push('live InterviewNote snapshot must contain an array'); return byIssue; }
  for (const issue of rows) {
    const number = Number(issue && (issue.number || issue.issue_number));
    const owner = inventoryValidation.byIssue.get(number);
    if (!Number.isInteger(number) || !owner) { errors.push(`live snapshot Issue #${issue && (issue.number || issue.issue_number) || 'unknown'} is not in owner inventory`); continue; }
    if (byIssue.has(number)) errors.push(`duplicate live InterviewNote snapshot for #${number}`);
    byIssue.set(number, issue);
    const bodySha = sha256Text(issue.body || '');
    if (bodySha !== owner.body_sha256) errors.push(`live InterviewNote #${number} body SHA differs from fresh ownership inventory`);
    if (!labelsOf(issue).includes('type:interview-note')) errors.push(`live Issue #${number} lacks type:interview-note`);
  }
  for (const owner of inventoryValidation.entries) if (!byIssue.has(Number(owner.issue_number))) errors.push(`live InterviewNote snapshot is missing Issue #${owner.issue_number}`);
  return byIssue;
}

function projectOne(owner, liveIssue, receipt, contextItem, materialization, errors) {
  const number = Number(owner.issue_number);
  const id = owner.interview_note_id;
  const blocked = (reason, extra = {}) => ({
    issue_number: number, interview_note_id: id, status: 'blocked', reason, raw_body_mutation: false, unknown_facts: [],
    source_review: { stage: 'source-review', status: 'blocked', reason },
    context: { stage: 'context', status: 'blocked', reason: 'requires source-ready independent Source Review' },
    learning: { stage: 'learning-discovery', status: 'blocked', reason: 'requires reviewed Context' },
    ...extra,
  });
  if (!liveIssue) return blocked('live InterviewNote snapshot is missing');
  const body = String(liveIssue.body || '');
  const bodySha = sha256Text(body);
  const parsed = parseInterviewNoteIssue(body);
  const issueValidation = validateInterviewNoteIssue({ body, labels: labelsOf(liveIssue), state: String(liveIssue.state || 'open').toLowerCase() });
  const localErrors = [];
  if (!issueValidation.ok) localErrors.push(...issueValidation.errors);
  if (!parsed.marker || !parsed.record) localErrors.push('InterviewNote marker/record is not parseable');
  if (parsed.marker && parsed.marker.interview_note_id !== id) localErrors.push('InterviewNote marker identity differs from ownership inventory');
  if (parsed.record && parsed.record.interview_note_id !== id) localErrors.push('InterviewNote record identity differs from ownership inventory');
  if (parsed.record && parsed.record.source_revision && parsed.record.source_revision.id !== owner.source_revision_id) localErrors.push('InterviewNote record SourceRevision differs from ownership inventory');
  if (receipt && receipt.interview_body_sha256 !== bodySha) localErrors.push('#1661 Source Review receipt body SHA differs from live CAS');
  if (!receipt || terminalStatus(receipt) !== 'source-ready') localErrors.push('strict source-ready gate is not satisfied');
  if (!contextItem || !contextItem.context) localErrors.push('reviewed Context artifact is missing');
  const context = contextItem && contextItem.context;
  if (context && context.interview_note_id !== id) localErrors.push('Context identity differs from ownership inventory');
  if (context && context.source_revision_id !== owner.source_revision_id) localErrors.push('Context SourceRevision differs from ownership inventory');
  if (localErrors.length) {
    errors.push(...localErrors.map((error) => `Issue #${number}: ${error}`));
    return blocked(localErrors.join('; '), { current_body_sha256: bodySha });
  }
  const discovery = buildLearningDiscovery(context, parsed.record.source_published_at);
  if (!discovery.ok) {
    errors.push(...discovery.errors.map((error) => `Issue #${number}: Context projection invalid: ${error}`));
    return blocked('reviewed Context cannot produce a learning projection', { current_body_sha256: bodySha });
  }
  const proposedTitle = discovery.non_spoiler_title;
  const proposedLabels = [...new Set([...stripDiscoveryLabels(labelsOf(liveIssue)), ...discovery.learning_labels])].sort();
  if (SPOILER_RE.test(proposedTitle) || proposedLabels.some((label) => SPOILER_RE.test(label))) {
    errors.push(`Issue #${number}: title/learning labels contain outcome spoiler wording`);
    return blocked('non-spoiler projection validation failed', { current_body_sha256: bodySha });
  }
  const unknown = unknownFacts(context);
  const learningLabels = proposedLabels.filter((label) => DISCOVERY_PREFIXES.some((prefix) => label.startsWith(prefix)));
  return {
    issue_number: number,
    interview_note_id: id,
    status: 'projectable',
    action: String(liveIssue.title || '') === proposedTitle && JSON.stringify(labelsOf(liveIssue)) === JSON.stringify(proposedLabels) ? 'unchanged' : 'metadata-update',
    current_title: String(liveIssue.title || ''),
    proposed_title: proposedTitle,
    current_labels: labelsOf(liveIssue),
    proposed_labels: proposedLabels,
    learning_labels: learningLabels,
    unknown_facts: unknown,
    current_body_sha256: bodySha,
    source_revision_id: owner.source_revision_id,
    context_sha256: canonicalDigest(context),
    context_artifact: contextItem.artifact || contextItem.context_artifact,
    raw_body_mutation: false,
    outcome_visibility: 'sealed-until-source-reveal',
    materialization_post_audit: { issue_number: number, schema_version: MATERIALIZATION_AUDIT_SCHEMA },
    source_review: { stage: 'source-review', status: 'source-ready', schema_version: SOURCE_REVIEW_RECEIPT_SCHEMA, final_status: 'source-ready', independent: true, interview_body_sha256: bodySha },
    context: { stage: 'context', status: 'reviewed-context', context_sha256: canonicalDigest(context), artifact: contextItem.artifact || contextItem.context_artifact },
    learning: { stage: 'learning-discovery', status: 'projectable', non_spoiler_title: proposedTitle, labels: proposedLabels },
  };
}

function buildPlan(input = {}) {
  const errors = [];
  const blockedPrerequisites = [];
  const inventory = input.ownershipInventory;
  const inventoryValidation = validateFreshOwnershipInventory(inventory, {
    digest: input.bindings && input.bindings.ownership_inventory && input.bindings.ownership_inventory.sha256,
    fresh: input.fresh === true,
    capturedAt: input.capturedAt,
  });
  if (!inventoryValidation.ok) {
    errors.push(...inventoryValidation.errors.map((error) => `ownership inventory: ${error}`));
    blockedPrerequisites.push({ code: 'fresh-full-ownership-inventory-invalid', required_schema: OWNERSHIP_INVENTORY_SCHEMA });
  }
  const bindingValues = [
    ['ownership_inventory', inventory, input.bindings && input.bindings.ownership_inventory],
    ['materialization_post_audit', input.materializationPostAudit, input.bindings && input.bindings.materialization_post_audit],
    ['source_review_receipts', input.sourceReviewReceipts, input.bindings && input.bindings.source_review_receipts],
    ['context_artifacts', input.contextArtifacts, input.bindings && input.bindings.context_artifacts],
    ['live_issue_snapshot', input.liveIssueSnapshot, input.bindings && input.bindings.live_issue_snapshot],
  ];
  const inputEvidence = {};
  for (const [name, value, binding] of bindingValues) {
    inputEvidence[name] = validateInputDigestBinding(value, binding, name, errors);
    if (value == null) blockedPrerequisites.push({ code: `${name}-missing`, path: binding && binding.path || null });
  }
  const materialization = validateMaterializationAudit(input.materializationPostAudit, inventoryValidation, errors);
  const receipts = receiptIndex(input.sourceReviewReceipts, inventoryValidation, errors, materialization);
  const contexts = contextIndex(input.contextArtifacts, inventoryValidation, errors, receipts);
  const live = liveIndex(input.liveIssueSnapshot, inventoryValidation, errors);
  if (input.sourceReviewReceipts == null) blockedPrerequisites.push({ code: 'issue-1661-source-review-receipts-missing' });
  if (input.contextArtifacts == null) blockedPrerequisites.push({ code: 'reviewed-context-artifacts-missing' });
  const candidates = inventoryValidation.entries.map((owner) => {
    const item = projectOne(owner, live.get(Number(owner.issue_number)), receipts.get(owner.interview_note_id), contexts.get(Number(owner.issue_number)), materialization.get(Number(owner.issue_number)), errors);
    return {
      ...item,
      required_sequence: [...REQUIRED_SEQUENCE],
      ownership: { status: 'owner-validated', issue_number: Number(owner.issue_number), interview_note_id: owner.interview_note_id, body_sha256: owner.body_sha256, source_revision_id: owner.source_revision_id },
    };
  });
  const projectable = candidates.filter((item) => item.status === 'projectable');
  const mutations = projectable.filter((item) => item.action !== 'unchanged');
  const labelCatalog = input.labelCatalog || [];
  const labelPreflight = buildLabelProvisioningPlan(labelConfig, mutations.flatMap((item) => item.learning_labels), labelCatalog);
  const unknownLabels = mutations.flatMap((item) => item.learning_labels).filter((label) => labelPreflight.unknown.includes(label));
  if (unknownLabels.length) errors.push(`taxonomy contains unknown learning labels: ${[...new Set(unknownLabels)].sort().join(', ')}`);
  if (input.labelCatalog == null) errors.push('label catalog is required for apply preflight');
  const planWithoutDigest = {
    schema_version: SCHEMA_VERSION,
    input_schema_version: INPUT_SCHEMA_VERSION,
    aggregate_id: 'issue-1662-dynamic-full-owner-context-learning-v1',
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    issue_number: ISSUE_NUMBER,
    mode: 'plan-only',
    mutation_performed: false,
    write_operations: ZERO_WRITES,
    candidate_count: candidates.length,
    candidate_source: 'fresh-full-ownership-inventory.entries',
    legacy_1611_candidate_count_ignored: 350,
    inputs: inputEvidence,
    ownership_inventory: { schema_version: OWNERSHIP_INVENTORY_SCHEMA, complete: inventoryValidation.ok, fresh: inventoryValidation.freshness.fresh, captured_at: inventoryValidation.freshness.captured_at, count: inventoryValidation.count, canonical_digest: inventoryValidation.canonical_digest },
    dependencies: { materialization_post_audit: inventoryValidation.ok && materialization.size === inventoryValidation.count ? 'satisfied' : 'blocked', source_review: receipts.size === inventoryValidation.count ? 'source-ready-or-blocked-receipts-validated' : 'blocked', context: contexts.size === inventoryValidation.entries.filter((owner) => terminalStatus(receipts.get(owner.interview_note_id)) === 'source-ready').length ? 'reviewed-artifacts-validated' : 'blocked', live_snapshot: live.size === inventoryValidation.count ? 'body-cas-validated' : 'blocked' },
    label_preflight: { ...labelPreflight, catalog_required: true },
    summary: { candidate_count: candidates.length, source_ready: candidates.filter((item) => item.source_review && item.source_review.final_status === 'source-ready').length, reviewed_context: contexts.size, projectable: projectable.length, proposed_mutations: mutations.length, blocked: candidates.filter((item) => item.status !== 'projectable').length, mutation_count: 0 },
    blocked_prerequisites: blockedPrerequisites,
    errors,
    candidates,
    apply_gate: { authorization_issue: ISSUE_NUMBER, requires_comment_id: true, requires_allow_live_github: true, requires_exact_digest: true, requires_exact_mutation_ceiling: true, lock_required: true, journal_required: true, unknown_patch_response: 'fail-closed', full_labels_response_required: true },
    post_apply_audit: ['fresh full ownership inventory still matches digest', 'Issue #1658 materialization/post-audit still passes', 'independent #1661 Source Review receipts still match identity/SourceRevision/body SHA', 'reviewed Context artifact ref/commit/digest still matches', 'Raw InterviewNote body SHA unchanged', 'returned labels are complete and exact', 'Outcome remains sealed'],
  };
  const plan = { ...planWithoutDigest, canonical_digest: canonicalDigest(planWithoutDigest) };
  const ok = errors.length === 0 && blockedPrerequisites.length === 0 && candidates.every((item) => item.status === 'projectable') && labelPreflight.ok;
  return { ok, plan, inventoryValidation, materialization, receipts, contexts, live };
}

function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['plan must be an object'] };
  if (plan.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (plan.mode !== 'plan-only') errors.push('mode must be plan-only');
  if (plan.mutation_performed !== false) errors.push('mutation_performed must be false');
  if (JSON.stringify(plan.write_operations) !== JSON.stringify(ZERO_WRITES)) errors.push('write_operations must be patch=0, post=0, create=0');
  if (plan.candidate_source !== 'fresh-full-ownership-inventory.entries') errors.push('candidate source must be the fresh full ownership inventory');
  if (!Array.isArray(plan.candidates) || plan.candidate_count !== plan.candidates.length) errors.push('candidate_count must equal dynamic candidate array length');
  if (plan.legacy_1611_candidate_count_ignored !== 350) errors.push('plan must record that legacy 350 candidates are ignored, not used as the candidate set');
  if (!plan.ownership_inventory || plan.ownership_inventory.fresh !== true || !HEX64.test(plan.ownership_inventory.canonical_digest || '')) errors.push('plan must bind a fresh full ownership inventory digest');
  const seen = new Set();
  for (const item of plan.candidates || []) {
    if (!nonEmpty(item.interview_note_id) || seen.has(item.interview_note_id)) errors.push(`candidate identity missing or duplicated: ${item.interview_note_id || 'unknown'}`);
    seen.add(item.interview_note_id);
    if (JSON.stringify(item.required_sequence) !== JSON.stringify(REQUIRED_SEQUENCE)) errors.push(`candidate ${item.interview_note_id} has invalid required sequence`);
    if (item.raw_body_mutation !== false) errors.push(`candidate ${item.interview_note_id} may not mutate Raw body`);
    if (hasForbiddenRawFields(item)) errors.push(`candidate ${item.interview_note_id} contains Raw body field`);
    if (item.status === 'projectable' && (SPOILER_RE.test(item.proposed_title || '') || (item.proposed_labels || []).some((label) => SPOILER_RE.test(label)))) errors.push(`candidate ${item.interview_note_id} contains an outcome spoiler`);
  }
  if (hasForbiddenRawFields(plan)) errors.push('plan contains Raw body fields');
  if (plan.canonical_digest !== canonicalDigest(withoutDigest(plan))) errors.push('canonical_digest does not match plan payload');
  return { ok: errors.length === 0, errors };
}

function authorizationMarkerFromComment(body) {
  if (!nonEmpty(body)) return { marker: null, errors: ['fetched authorization comment has no body'] };
  const matches = [...String(body).matchAll(/<!--\s*issue-1662-authorization\s*([\s\S]*?)-->/g)];
  if (matches.length !== 1) return { marker: null, errors: ['fetched authorization comment must contain exactly one issue-1662-authorization marker'] };
  try {
    const marker = JSON.parse(matches[0][1].trim());
    return { marker, errors: marker && typeof marker === 'object' && !Array.isArray(marker) ? [] : ['fetched authorization marker must be a JSON object'] };
  } catch (error) {
    return { marker: null, errors: [`fetched authorization marker JSON is invalid: ${error.message}`] };
  }
}

function fetchedAuthorizationComment(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  if (value && Array.isArray(value.comments)) return value.comments.length === 1 ? value.comments[0] : null;
  if (value && value.comment && typeof value.comment === 'object') return value.comment;
  return value && typeof value === 'object' ? value : null;
}

function validateFetchedAuthorizationComment(auth, fetchedValue, errors) {
  const fetched = fetchedAuthorizationComment(fetchedValue);
  if (!fetched) { errors.push('authorization comment fetch must resolve to exactly one comment'); return; }
  if (fetched.id !== auth.comment_id) errors.push('authorization marker.comment_id does not exactly match fetched comment.id');
  const issueUrl = `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`;
  if (fetched.issue_url !== issueUrl) errors.push('fetched authorization comment issue_url is not controller Issue #1662');
  if (fetched.issue_number !== undefined && Number(fetched.issue_number) !== ISSUE_NUMBER) errors.push('fetched authorization comment issue_number is not controller Issue #1662');
  const parsed = authorizationMarkerFromComment(fetched.body);
  errors.push(...parsed.errors);
  if (!parsed.marker) return;
  for (const field of ['schema_version', 'issue_number', 'comment_id', 'marker', 'allow_live_github', 'plan_digest', 'mutation_ceiling', 'authorized_by']) {
    if (parsed.marker[field] !== auth[field]) errors.push(`fetched authorization marker ${field} does not match local authorization`);
  }
  if (canonicalDigest(parsed.marker) !== canonicalDigest(auth)) errors.push('fetched authorization marker does not exactly match local authorization');
  if (parsed.marker.comment_id !== fetched.id) errors.push('fetched authorization marker.comment_id does not exactly match fetched comment.id');
}

function validateAuthorization(auth, planDigest, maxMutations, options = {}) {
  const errors = [];
  if (!auth || auth.schema_version !== AUTH_SCHEMA_VERSION) errors.push(`authorization schema must be ${AUTH_SCHEMA_VERSION}`);
  if (!auth || Number(auth.issue_number) !== ISSUE_NUMBER) errors.push('authorization must target Issue #1662');
  if (!auth || !Number.isInteger(auth.comment_id) || auth.comment_id < 1) errors.push('authorization comment_id is required');
  if (!auth || auth.marker !== 'issue-1662-authorization') errors.push('explicit issue-1662-authorization marker is required');
  if (!auth || auth.allow_live_github !== true || options.allowLiveGithub !== true) errors.push('allow_live_github=true must be present in authorization and CLI gate');
  if (!auth || auth.plan_digest !== planDigest) errors.push('authorization plan_digest does not match exact plan digest');
  if (!auth || !Number.isInteger(auth.mutation_ceiling) || auth.mutation_ceiling !== maxMutations) errors.push('authorization mutation ceiling does not match exact CLI ceiling');
  if (!auth || !nonEmpty(auth.authorized_by)) errors.push('authorization authorized_by is required');
  if (typeof options.fetchAuthorizationComment !== 'function') errors.push('authorization requires a fetched GitHub controller comment adapter');
  else if (auth && Number.isInteger(auth.comment_id) && auth.comment_id > 0) {
    try { validateFetchedAuthorizationComment(auth, options.fetchAuthorizationComment(auth.comment_id), errors); }
    catch (error) { errors.push(`authorization comment fetch failed closed: ${error.message}`); }
  }
  return { ok: errors.length === 0, errors };
}

function acquireExclusiveLock(lockPath, metadata = {}, fsImpl = fs) {
  const token = crypto.randomUUID();
  let fd;
  try { fd = fsImpl.openSync(lockPath, 'wx', 0o644); }
  catch (error) { throw new Error(error && error.code === 'EEXIST' ? `exclusive apply lock already exists at ${lockPath}` : `cannot create apply lock: ${error.message}`); }
  try { fsImpl.writeFileSync(fd, `${JSON.stringify({ schema_version: `${SCHEMA_VERSION}-lock.v1`, token, ...metadata }, null, 2)}\n`); fsImpl.fsyncSync(fd); }
  catch (error) { try { fsImpl.closeSync(fd); } finally { try { fsImpl.unlinkSync(lockPath); } catch {} } throw new Error(`cannot persist apply lock: ${error.message}`); }
  fsImpl.closeSync(fd);
  let released = false;
  return { token, release() { if (released) return; const current = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')); if (current.token !== token) throw new Error('apply lock ownership changed; refusing to remove another lock'); fsImpl.unlinkSync(lockPath); released = true; } };
}

function createExclusiveJournal(journalPath, header, fsImpl = fs) {
  let fd;
  try { fd = fsImpl.openSync(journalPath, 'wx', 0o644); }
  catch (error) { throw new Error(error && error.code === 'EEXIST' ? `exclusive apply journal already exists at ${journalPath}` : `cannot create apply journal: ${error.message}`); }
  const record = { schema_version: JOURNAL_SCHEMA_VERSION, ...header, events: [] };
  try { fsImpl.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`); fsImpl.fsyncSync(fd); }
  catch (error) { try { fsImpl.closeSync(fd); } finally { try { fsImpl.unlinkSync(journalPath); } catch {} } throw error; }
  fsImpl.closeSync(fd);
  return record;
}

function appendJournalEvent(journalPath, event, fsImpl = fs) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  const fd = fsImpl.openSync(journalPath, 'a', 0o644);
  try { fsImpl.writeFileSync(fd, line); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
}

function validatePatchResponse(response, item) {
  if (!response || typeof response !== 'object') throw new Error(`Issue #${item.issue_number} PATCH response is unknown`);
  if (Number(response.number) !== Number(item.issue_number)) throw new Error(`Issue #${item.issue_number} PATCH response identity is unknown`);
  if (typeof response.title !== 'string' || response.title !== item.proposed_title) throw new Error(`Issue #${item.issue_number} PATCH response title did not converge`);
  if (!Array.isArray(response.labels)) throw new Error(`Issue #${item.issue_number} PATCH response omitted complete labels; refusing to assume convergence`);
  if (JSON.stringify(normalizeLabels(response.labels)) !== JSON.stringify(normalizeLabels(item.proposed_labels))) throw new Error(`Issue #${item.issue_number} PATCH response labels did not exactly match the requested complete projection`);
  if (response.body !== undefined && sha256Text(response.body || '') !== item.current_body_sha256) throw new Error(`Issue #${item.issue_number} PATCH response body changed Raw content`);
  return true;
}

function applyPlan(plan, options = {}) {
  if (!plan || plan.schema_version !== SCHEMA_VERSION || plan.mode !== 'plan-only' || plan.mutation_performed !== false) throw new Error('malformed or already-mutated #1662 plan cannot be applied');
  const auth = validateAuthorization(options.authorization, plan.canonical_digest, options.maxMutations, { allowLiveGithub: options.allowLiveGithub === true, fetchAuthorizationComment: options.fetchAuthorizationComment });
  if (!auth.ok) throw new Error(auth.errors.join('; '));
  const planValidation = validatePlan(plan);
  if (!planValidation.ok) throw new Error(`plan validation failed: ${planValidation.errors.join('; ')}`);
  if ((plan.errors && plan.errors.length) || (plan.blocked_prerequisites && plan.blocked_prerequisites.length) || Number(plan.summary && plan.summary.blocked) > 0) {
    throw new Error('blocked or incomplete #1662 plan cannot be applied');
  }
  const mutations = plan.candidates.filter((item) => item.status === 'projectable' && item.action !== 'unchanged');
  if (mutations.length > options.maxMutations) throw new Error(`planned mutation count ${mutations.length} exceeds ceiling ${options.maxMutations}`);
  if (!plan.label_preflight || !plan.label_preflight.ok) throw new Error('label preflight is not satisfied; no label creation is implicit');
  if (typeof options.readIssue !== 'function' || typeof options.patchIssue !== 'function' || typeof options.postReceipt !== 'function') throw new Error('controlled apply requires readIssue, patchIssue, and postReceipt adapters');
  if (!nonEmpty(options.lockPath) || !nonEmpty(options.journalPath)) throw new Error('controlled apply requires exclusive lockPath and journalPath');
  const lock = acquireExclusiveLock(options.lockPath, { issue_number: ISSUE_NUMBER, plan_digest: plan.canonical_digest, mutation_ceiling: options.maxMutations }, options.fsImpl || fs);
  try {
    createExclusiveJournal(options.journalPath, { issue_number: ISSUE_NUMBER, plan_digest: plan.canonical_digest, mutation_ceiling: options.maxMutations }, options.fsImpl || fs);
    const results = [];
    for (const item of mutations) {
      const before = options.readIssue(item.issue_number);
      if (!before || Number(before.number) !== Number(item.issue_number) || sha256Text(before.body || '') !== item.current_body_sha256 || JSON.stringify(labelsOf(before)) !== JSON.stringify(item.current_labels) || String(before.title || '') !== item.current_title) {
        appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'cas-failed' });
        throw new Error(`Issue #${item.issue_number} CAS precondition failed; refusing PATCH`);
      }
      appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'patch-intent', body_sha256: item.current_body_sha256, labels: item.proposed_labels });
      let response;
      try {
        response = options.patchIssue(item.issue_number, { title: item.proposed_title, labels: item.proposed_labels });
        validatePatchResponse(response, item);
      } catch (error) {
        appendJournalEvent(options.journalPath, {
          issue_number: item.issue_number,
          state: 'patch-unknown',
          phase: response === undefined ? 'patch-call' : 'patch-response-validation',
          uncertain: true,
          possibly_performed: true,
          error: error.message,
        });
        throw new Error(`Issue #${item.issue_number} PATCH outcome is unknown; fail-closed: ${error.message}`);
      }
      appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'patch-converged' });
      const receipt = { schema_version: 'issue-1662-context-learning-receipt.v1', issue_number: item.issue_number, interview_note_id: item.interview_note_id, expected_body_sha256: item.current_body_sha256, source_revision_id: item.source_revision_id, context_sha256: item.context_sha256, context_artifact: item.context_artifact, title: item.proposed_title, labels: item.proposed_labels, raw_body_mutation: false, outcome_visibility: 'sealed-until-source-reveal' };
      appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'receipt-intent', receipt_sha256: sha256Text(JSON.stringify(receipt)) });
      let receiptResponse;
      try { receiptResponse = options.postReceipt(item.issue_number, receipt); }
      catch (error) { appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'receipt-unknown', error: error.message }); throw new Error(`Issue #${item.issue_number} receipt POST outcome is unknown; fail-closed: ${error.message}`); }
      if (!receiptResponse || !Number.isInteger(Number(receiptResponse.id)) || Number(receiptResponse.id) < 1) { appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'receipt-unknown' }); throw new Error(`Issue #${item.issue_number} receipt response is unknown; fail-closed`); }
      appendJournalEvent(options.journalPath, { issue_number: item.issue_number, state: 'complete', receipt_comment_id: Number(receiptResponse.id) });
      results.push({ issue_number: item.issue_number, receipt_comment_id: Number(receiptResponse.id) });
    }
    return { schema_version: 'issue-1662-context-learning-apply-result.v1', mutation_performed: results.length > 0, results };
  } finally { lock.release(); }
}

module.exports = {
  SCHEMA_VERSION,
  INPUT_SCHEMA_VERSION,
  AUTH_SCHEMA_VERSION,
  JOURNAL_SCHEMA_VERSION,
  REPOSITORY,
  PARENT_ISSUE,
  ISSUE_NUMBER,
  MATERIALIZATION_AUDIT_SCHEMA,
  MATERIALIZATION_AUDIT_SCHEMAS,
  SOURCE_REVIEW_RECEIPT_SCHEMA,
  SOURCE_REVIEW_RECEIPT_SCHEMAS,
  OWNERSHIP_INVENTORY_SCHEMA,
  REQUIRED_SEQUENCE,
  ZERO_WRITES,
  sha256Text,
  canonicalDigest,
  terminalStatus,
  validateFreshOwnershipInventory,
  validateMaterializationAudit,
  receiptIndex,
  contextIndex,
  liveIndex,
  buildPlan,
  validatePlan,
  validateAuthorization,
  acquireExclusiveLock,
  createExclusiveJournal,
  appendJournalEvent,
  validatePatchResponse,
  applyPlan,
};
