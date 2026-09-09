'use strict';

const { canonicalDigest, sha256Text } = require('./aggregate-downstream-pipeline');
const { issueSourceRecord } = require('./interview-note-materialization-batch');
const { sourceSnapshotDigest } = require('../plan-issue-1611-live-materialization');

const SCHEMA_VERSION = 'issue-1657-blocker-repair-plan.v2';
const LIVE_AUDIT_SCHEMA_VERSION = 'issue-1657-live-reaudit-snapshot.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const TARGETS = Object.freeze([
  { source_note_issue_number: 904, interview_note_id: 'xhs:63ecd286000000001303fd16', owner_issue_number: 2 },
  { source_note_issue_number: 907, interview_note_id: 'xhs:656861da000000000f024258', owner_issue_number: 4 },
  { source_note_issue_number: 910, interview_note_id: 'xhs:6a8abe2d000000001602b26e', owner_issue_number: 915 },
]);
const MARKER_EXPECTATIONS = Object.freeze({
  904: Object.freeze({
    source: Object.freeze({ boundary_evidence: 1, boundary_applied_receipt: 1, materialization_receipt: 0 }),
    owner: Object.freeze({ source_review_evidence: 0, source_review_applied_receipt: 0, materialization_receipt: 0 }),
  }),
  907: Object.freeze({
    source: Object.freeze({ boundary_evidence: 1, boundary_applied_receipt: 1, materialization_receipt: 0 }),
    owner: Object.freeze({ source_review_evidence: 0, source_review_applied_receipt: 0, materialization_receipt: 0 }),
  }),
  910: Object.freeze({
    source: Object.freeze({ boundary_evidence: 0, boundary_applied_receipt: 1, materialization_receipt: 1 }),
    owner: Object.freeze({ source_review_evidence: 0, source_review_applied_receipt: 1, materialization_receipt: 0 }),
  }),
});
const BOUNDARY_PREVIOUS_BODY_SHA256 = Object.freeze({
  904: '7f01c5bd753c6a3938d8da2a501fcdb9503d9ae767d5966112e28e0c70925755',
  907: '69e0dbfd9b86f0a223aa9427c6cb464177c7de1c99d84c8c55eb87489894167c',
  910: 'c3df7ce6bd95de1f23d16bd322d13b5afaa998b4a48f19cdd180053798f6aeb5',
});
const REQUIRED_EVIDENCE_CHECKS = Object.freeze([
  'source_identity', 'source_revision_binding', 'source_content_coverage',
  'event_boundary', 'no_cross_source_mixing', 'no_fabrication',
]);
const REQUIRED_ZERO_WRITES = Object.freeze({ patch: 0, post: 0, label: 0, interview_note: 0, create: 0 });
const HEX64 = /^[0-9a-f]{64}$/;

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter((label) => typeof label === 'string' && label.trim()))].sort();
}

function digestWithoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return canonicalDigest(copy);
}

function receiptSnapshotDigest(snapshot) {
  return digestWithoutField(snapshot, 'canonical_digest');
}

function liveAuditSnapshotDigest(snapshot) {
  return digestWithoutField(snapshot, 'canonical_digest');
}

function findOne(items, predicate, label, errors) {
  const matches = (items || []).filter(predicate);
  if (matches.length !== 1) errors.push(`${label} must resolve to exactly one row (got ${matches.length})`);
  return matches[0] || null;
}

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function markerSummaryConsistency(summary, markerName, label, errors) {
  if (!Array.isArray(summary.comment_ids) || !Array.isArray(summary.comments)) {
    errors.push(`${label} marker comment_ids/comments must both be arrays`);
    return false;
  }
  const ids = summary.comment_ids;
  const comments = summary.comments;
  if (new Set(ids).size !== ids.length) errors.push(`${label} marker comment_ids must be unique`);
  if (comments.some((comment) => !isObject(comment))) errors.push(`${label} marker comments must contain objects`);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) errors.push(`${label} marker comment_ids must contain positive integer IDs`);
  if (comments.length !== ids.length) errors.push(`${label} marker comment_ids/comments length mismatch`);
  if (comments.length === ids.length && comments.some((comment, index) => comment.id !== ids[index])) {
    errors.push(`${label} marker comment_ids do not match comments`);
  }
  if (summary.count === 0) {
    if (summary.match_count !== 0) errors.push(`${label} marker count 0 requires match_count 0`);
    if (ids.length !== 0 || comments.length !== 0) errors.push(`${label} marker count 0 requires empty comment_ids/comments`);
    if (summary.comment_id !== null || summary.body_sha256 !== null || summary.payload !== null) {
      errors.push(`${label} marker count 0 requires null comment_id/body_sha256/payload`);
    }
  } else if (summary.count === 1) {
    if (summary.match_count !== 1) errors.push(`${label} marker count 1 requires match_count 1`);
    if (ids.length !== 1 || comments.length !== 1) errors.push(`${label} marker count 1 requires exactly one comment_id/comment`);
    if (!Number.isInteger(summary.comment_id) || summary.comment_id <= 0) errors.push(`${label} marker count 1 requires a non-empty comment_id`);
    if (!HEX64.test(String(summary.body_sha256 || ''))) errors.push(`${label} marker count 1 requires a non-empty body_sha256`);
    if (!isObject(summary.payload) || Object.keys(summary.payload).length === 0) errors.push(`${label} marker count 1 requires a non-empty payload`);
    if (comments.length === 1 && ids.length === 1 && isObject(comments[0])) {
      if (summary.comment_id !== comments[0].id || summary.comment_id !== ids[0]) errors.push(`${label} marker count 1 comment_id must match comments[0].id and comment_ids[0]`);
      if (summary.body_sha256 !== comments[0].body_sha256) errors.push(`${label} marker count 1 body_sha256 must match comments[0].body_sha256`);
      const commentPayload = isObject(comments[0].markers) ? comments[0].markers[markerName] : null;
      if (!isObject(commentPayload) || Object.keys(commentPayload).length === 0) {
        errors.push(`${label} marker count 1 comment marker payload is missing or empty`);
      } else if (isObject(summary.payload) && canonicalDigest(summary.payload) !== canonicalDigest(commentPayload)) {
        errors.push(`${label} marker count 1 payload does not match comment marker ${markerName}`);
      }
    }
  } else if (summary.count === '>1') {
    if (!Number.isInteger(summary.match_count) || summary.match_count <= 1) errors.push(`${label} marker count >1 requires match_count >1`);
    if (Number.isInteger(summary.match_count) && summary.match_count > 1 && (ids.length !== summary.match_count || comments.length !== summary.match_count)) {
      errors.push(`${label} marker count >1 requires arrays matching match_count`);
    }
    if (summary.comment_id !== null || summary.body_sha256 !== null || summary.payload !== null) {
      errors.push(`${label} marker count >1 requires null comment_id/body_sha256/payload`);
    }
  }
  return true;
}

function expectMarker(summary, expectedCount, label, markerName) {
  const errors = [];
  if (!isObject(summary) || !Object.prototype.hasOwnProperty.call(summary, 'count')) {
    errors.push(`${label} marker count is missing`);
    return { summary: null, errors };
  }
  if (![0, 1, '>1'].includes(summary.count)) errors.push(`${label} marker count must be 0, 1, or >1`);
  if (typeof markerName !== 'string' || !markerName.trim()) errors.push(`${label} marker name is missing`);
  markerSummaryConsistency(summary, markerName, label, errors);
  if (![0, 1].includes(expectedCount)) errors.push(`${label} expected marker count is invalid`);
  if (summary.count !== expectedCount) errors.push(`${label} marker count must equal expected ${expectedCount} (got ${summary.count})`);
  return { summary: summary.count === expectedCount ? summary : null, errors };
}

function requiredMarker(summary, label, errors, expectedCount = 1, markerName) {
  const result = expectMarker(summary, expectedCount, label, markerName);
  errors.push(...result.errors);
  return result.summary;
}

function optionalMarker(summary, label, errors, expectedCount = 0, markerName) {
  const result = expectMarker(summary, expectedCount, label, markerName);
  errors.push(...result.errors);
  return result.summary;
}

function equalPayloadField(payload, field, expected, label, errors) {
  if (payload[field] !== expected) errors.push(`${label} payload ${field} mismatch`);
}

function equalPresentPayloadField(payload, field, expected, label, errors) {
  if (Object.prototype.hasOwnProperty.call(payload, field)) equalPayloadField(payload, field, expected, label, errors);
}

function equalRequiredPayloadField(payload, field, expected, label, errors) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) errors.push(`${label} payload ${field} is missing`);
  else equalPayloadField(payload, field, expected, label, errors);
}

function timestampPayloadField(payload, field, label, errors) {
  if (typeof payload[field] !== 'string' || !payload[field].trim() || Number.isNaN(Date.parse(payload[field]))) {
    errors.push(`${label} payload ${field} is invalid`);
  }
}

function validateEvidencePayload(payload, context, errors) {
  const label = 'live boundary evidence';
  if (!isObject(payload)) {
    errors.push(`${label} payload is missing or invalid`);
    return;
  }
  equalPayloadField(payload, 'schema_version', 'source-note-boundary-review-evidence.v1', label, errors);
  equalPayloadField(payload, 'repository', REPOSITORY, label, errors);
  equalPayloadField(payload, 'parent_issue', 1605, label, errors);
  equalPayloadField(payload, 'issue_number', context.target.source_note_issue_number, label, errors);
  equalPayloadField(payload, 'source_note_id', context.sourceParsed && context.sourceParsed.source_note_id, label, errors);
  equalPayloadField(payload, 'expected_body_sha256', context.boundaryPreviousBodySha, label, errors);
  equalRequiredPayloadField(payload, 'expected_source_revision_id', context.sourceRevision.id || null, label, errors);
  equalRequiredPayloadField(payload, 'expected_source_repository_ref', context.sourceRevision.source_repository_ref ?? null, label, errors);
  equalPayloadField(payload, 'decision', 'single-interview', label, errors);
  equalPayloadField(payload, 'transition_id', context.reportItem && context.reportItem.transition_id || null, label, errors);
  timestampPayloadField(payload, 'reviewed_at', label, errors);
  if (!isObject(payload.source_evidence) || Object.keys(payload.source_evidence).length === 0) errors.push(`${label} payload source_evidence is missing or empty`);
  if (!isObject(payload.source_evidence && payload.source_evidence.artifact) || Object.keys(payload.source_evidence.artifact || {}).length === 0 || !Array.isArray(payload.source_evidence && payload.source_evidence.excerpts) || payload.source_evidence.excerpts.length === 0) {
    errors.push(`${label} payload source_evidence artifact/excerpts are invalid`);
  }
  if (!Array.isArray(payload.checks) || REQUIRED_EVIDENCE_CHECKS.some((checkId) => !payload.checks.some((check) => check && check.check_id === checkId && check.result === 'pass'))) {
    errors.push(`${label} payload checks do not prove all required checks`);
  }
}

function validateBoundaryAppliedPayload(payload, context, errors) {
  const label = 'live boundary applied receipt';
  if (!isObject(payload)) {
    errors.push(`${label} payload is missing or invalid`);
    return;
  }
  equalPayloadField(payload, 'schema_version', 'source-note-boundary-review-applied.v1', label, errors);
  equalPayloadField(payload, 'repository', REPOSITORY, label, errors);
  equalPayloadField(payload, 'issue_number', context.target.source_note_issue_number, label, errors);
  equalPayloadField(payload, 'source_note_id', context.sourceParsed && context.sourceParsed.source_note_id, label, errors);
  equalPayloadField(payload, 'transition_id', context.reportItem && context.reportItem.transition_id || null, label, errors);
  equalPayloadField(payload, 'decision', 'single-interview', label, errors);
  equalPayloadField(payload, 'previous_body_sha256', context.boundaryPreviousBodySha, label, errors);
  equalPayloadField(payload, 'new_body_sha256', context.sourceBodySha, label, errors);
  const sourceRef = context.sourceRevision.source_repository_ref ?? null;
  if (sourceRef !== null) {
    equalRequiredPayloadField(payload, 'expected_source_revision_id', context.sourceRevision.id || null, label, errors);
    equalRequiredPayloadField(payload, 'expected_source_repository_ref', sourceRef, label, errors);
  } else {
    equalPresentPayloadField(payload, 'expected_source_revision_id', context.sourceRevision.id || null, label, errors);
    equalPresentPayloadField(payload, 'expected_source_repository_ref', null, label, errors);
  }
  for (const [field, expected] of Object.entries({
    previous_source_revision_id: context.sourceRevision.id || null,
    new_source_revision_id: context.sourceRevision.id || null,
    previous_source_repository_ref: sourceRef,
    new_source_repository_ref: sourceRef,
  })) equalPresentPayloadField(payload, field, expected, label, errors);
  const expectedInterviewNoteIds = context.sourceParsed && context.sourceParsed.boundary_review && context.sourceParsed.boundary_review.interview_note_ids || [context.target.interview_note_id];
  if (canonicalDigest(payload.interview_note_ids || null) !== canonicalDigest(expectedInterviewNoteIds)) errors.push(`${label} payload interview_note_ids mismatch`);
  timestampPayloadField(payload, 'reviewed_at', label, errors);
  timestampPayloadField(payload, 'applied_at', label, errors);
  if (context.reportItem) {
    equalPayloadField(payload, 'transition_id', context.reportItem.transition_id, label, errors);
    equalPayloadField(payload, 'decision', context.reportItem.boundary_decision, label, errors);
    if (context.reportItem.derived_interview_note_id != null && canonicalDigest(payload.interview_note_ids || null) !== canonicalDigest([context.reportItem.derived_interview_note_id])) {
      errors.push(`${label} payload interview_note_ids do not match report`);
    }
  }
}

function validateSourceMaterializationPayload(payload, context, errors) {
  const label = 'live materialization receipt';
  const receipt = context.receiptEntry && context.receiptEntry.materialization_receipt;
  if (!isObject(payload)) {
    errors.push(`${label} payload is missing or invalid`);
    return;
  }
  if (!isObject(receipt)) {
    errors.push(`${label} cannot bind without materialization receipt`);
    return;
  }
  equalPayloadField(payload, 'schema_version', 'source-note-interview-materialized.v1', label, errors);
  equalPayloadField(payload, 'repository', REPOSITORY, label, errors);
  equalPayloadField(payload, 'materialization_id', receipt.materialization_id, label, errors);
  equalPayloadField(payload, 'request_sha256', receipt.request_sha256, label, errors);
  equalPayloadField(payload, 'source_note_issue_number', context.target.source_note_issue_number, label, errors);
  equalPayloadField(payload, 'source_note_id', context.sourceParsed && context.sourceParsed.source_note_id, label, errors);
  equalPayloadField(payload, 'source_note_body_sha256', context.sourceBodySha, label, errors);
  equalPayloadField(payload, 'source_revision_id', context.sourceRevision.id || null, label, errors);
  equalPayloadField(payload, 'source_repository_ref', context.sourceRevision.source_repository_ref ?? null, label, errors);
  equalPayloadField(payload, 'interview_note_id', context.target.interview_note_id, label, errors);
  equalPayloadField(payload, 'interview_issue_number', context.target.owner_issue_number, label, errors);
  equalPayloadField(payload, 'interview_issue_body_sha256', context.owner && context.owner.body_sha256 || null, label, errors);
  equalPayloadField(payload, 'manifest_sha256', context.sourceRevision.manifest_sha256 || null, label, errors);
  equalPayloadField(payload, 'materialization_id', receipt.materialization_id, label, errors);
  equalPayloadField(payload, 'request_sha256', receipt.request_sha256, label, errors);
  if (receipt.source_note_issue_number != null) equalPayloadField(payload, 'source_note_issue_number', Number(receipt.source_note_issue_number), label, errors);
  if (receipt.source_note_id != null) equalPayloadField(payload, 'source_note_id', receipt.source_note_id, label, errors);
  if (receipt.source_note_body_sha256 != null) equalPayloadField(payload, 'source_note_body_sha256', receipt.source_note_body_sha256, label, errors);
  if (receipt.source_revision_id != null) equalPayloadField(payload, 'source_revision_id', receipt.source_revision_id, label, errors);
  if (receipt.source_repository_ref != null) equalPayloadField(payload, 'source_repository_ref', receipt.source_repository_ref, label, errors);
  if (receipt.interview_note_id != null) equalPayloadField(payload, 'interview_note_id', receipt.interview_note_id, label, errors);
  if (receipt.interview_issue_number != null) equalPayloadField(payload, 'interview_issue_number', Number(receipt.interview_issue_number), label, errors);
  if (receipt.interview_note_body_sha256 != null) equalPayloadField(payload, 'interview_issue_body_sha256', receipt.interview_note_body_sha256, label, errors);
  if (receipt.manifest_sha256 != null) equalPayloadField(payload, 'manifest_sha256', receipt.manifest_sha256, label, errors);
  if (context.reportItem) {
    equalPayloadField(payload, 'source_note_issue_number', Number(context.reportItem.source_note_issue_number), label, errors);
    equalPayloadField(payload, 'source_note_id', context.reportItem.source_note_id, label, errors);
    if (context.reportItem.request) {
      const request = context.reportItem.request;
      equalPayloadField(payload, 'source_note_body_sha256', request.expected_source_note_body_sha256, label, errors);
      equalPayloadField(payload, 'source_revision_id', request.expected_source_revision_id, label, errors);
      equalPayloadField(payload, 'source_repository_ref', request.expected_source_repository_ref ?? null, label, errors);
      if (request.expected_manifest_sha256 != null) equalPayloadField(payload, 'manifest_sha256', request.expected_manifest_sha256, label, errors);
      if (request.materialization_id != null) equalPayloadField(payload, 'materialization_id', request.materialization_id, label, errors);
      if (request.request_sha256 != null) equalPayloadField(payload, 'request_sha256', request.request_sha256, label, errors);
    }
  }
  if (context.sourceRevision.source_repository_ref == null && payload.source_repository_ref !== null) errors.push(`${label} payload runtime source_repository_ref must be null`);
}

function validateOwnerSourceReviewAppliedPayload(payload, context, errors) {
  const label = 'live owner source-review applied receipt';
  if (!isObject(payload)) {
    errors.push(`${label} payload is missing or invalid`);
    return;
  }
  equalPayloadField(payload, 'schema_version', 'interview-note-source-review-applied.v1', label, errors);
  equalPayloadField(payload, 'repository', REPOSITORY, label, errors);
  equalPayloadField(payload, 'issue_number', context.target.owner_issue_number, label, errors);
  equalPayloadField(payload, 'interview_note_id', context.target.interview_note_id, label, errors);
  equalPayloadField(payload, 'source_note_issue_number', context.target.source_note_issue_number, label, errors);
  equalPayloadField(payload, 'source_note_body_sha256', context.sourceBodySha, label, errors);
  equalPayloadField(payload, 'source_revision_id', context.sourceRevision.id || null, label, errors);
  equalPayloadField(payload, 'manifest_sha256', context.sourceRevision.manifest_sha256 || null, label, errors);
  equalPayloadField(payload, 'decision', 'source-ready', label, errors);
  equalPayloadField(payload, 'final_status', 'source-ready', label, errors);
  timestampPayloadField(payload, 'reviewed_at', label, errors);
  timestampPayloadField(payload, 'applied_at', label, errors);
  if (!HEX64.test(String(payload.request_sha256 || ''))) errors.push(`${label} payload request_sha256 is invalid`);
  const reportRequestSha = context.reportItem && (context.reportItem.request_sha256 || context.reportItem.source_review_request_sha256 || context.reportItem.source_review_request && context.reportItem.source_review_request.request_sha256 || context.reportItem.request && context.reportItem.request.source_review_request_sha256);
  if (reportRequestSha != null) equalPayloadField(payload, 'request_sha256', reportRequestSha, label, errors);
  if ((context.sourceRevision.source_repository_ref ?? null) !== null) errors.push(`${label} runtime/source ref contract mismatch`);
  if (context.reportItem) {
    equalPayloadField(payload, 'source_note_issue_number', Number(context.reportItem.source_note_issue_number), label, errors);
    equalPayloadField(payload, 'source_note_body_sha256', context.reportItem.request && context.reportItem.request.expected_source_note_body_sha256 || context.sourceBodySha, label, errors);
    equalPayloadField(payload, 'source_revision_id', context.reportItem.request && context.reportItem.request.expected_source_revision_id || context.sourceRevision.id, label, errors);
    if (context.reportItem.request && context.reportItem.request.expected_manifest_sha256 != null) equalPayloadField(payload, 'manifest_sha256', context.reportItem.request.expected_manifest_sha256, label, errors);
    if (context.reportItem.request && context.reportItem.request.expected_source_repository_ref !== undefined && context.reportItem.request.expected_source_repository_ref !== null) {
      errors.push(`${label} report unexpectedly claims a non-null runtime source ref`);
    }
  }
}

function validateLiveTargetShape(liveTarget, target, errors) {
  if (!isObject(liveTarget)) {
    errors.push('live re-audit target object is missing');
    return { source: null, owner: null };
  }
  if (Number(liveTarget.source_note_issue_number) !== target.source_note_issue_number) errors.push('live audit target SourceNote Issue mismatch');
  if (liveTarget.interview_note_id !== target.interview_note_id) errors.push('live audit target InterviewNote identity mismatch');
  if (Number(liveTarget.owner_issue_number) !== target.owner_issue_number) errors.push('live audit target owner Issue mismatch');
  const source = liveTarget.source;
  const owner = liveTarget.owner;
  if (!isObject(source)) errors.push('live audit SourceNote object is missing');
  if (!isObject(owner)) errors.push('live audit InterviewNote owner object is missing');
  if (isObject(source)) {
    for (const field of ['source_note_id', 'body_sha256', 'source_revision', 'boundary_review', 'validation', 'comments', 'boundary_evidence', 'boundary_applied_receipt', 'materialization_receipt']) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) errors.push(`live audit SourceNote ${field} is missing`);
    }
    if (typeof source.source_note_id !== 'string' || !source.source_note_id.trim()) errors.push('live audit SourceNote source_note_id is invalid');
    if (!HEX64.test(String(source.body_sha256 || ''))) errors.push('live audit SourceNote body_sha256 is invalid');
    if (!isObject(source.source_revision) || typeof source.source_revision.id !== 'string' || !source.source_revision.id.trim()) errors.push('live audit SourceNote source_revision is invalid');
    if (!isObject(source.boundary_review)) errors.push('live audit SourceNote boundary_review is invalid');
    if (!isObject(source.validation) || typeof source.validation.ok !== 'boolean' || !Array.isArray(source.validation.errors)) errors.push('live audit SourceNote validation is invalid');
    if (!Array.isArray(source.comments)) errors.push('live audit SourceNote comments are invalid');
  }
  if (isObject(owner)) {
    for (const field of ['issue_number', 'interview_note_id', 'body_sha256', 'source_revision', 'validation', 'comments', 'source_review_evidence', 'source_review_applied_receipt', 'materialization_receipt']) {
      if (!Object.prototype.hasOwnProperty.call(owner, field)) errors.push(`live audit InterviewNote owner ${field} is missing`);
    }
    if (Number(owner.issue_number) !== target.owner_issue_number) errors.push('live audit InterviewNote owner Issue is invalid');
    if (owner.interview_note_id !== target.interview_note_id) errors.push('live audit InterviewNote owner identity is invalid');
    if (!HEX64.test(String(owner.body_sha256 || ''))) errors.push('live audit InterviewNote owner body_sha256 is invalid');
    if (!isObject(owner.source_revision) || typeof owner.source_revision.id !== 'string' || !owner.source_revision.id.trim()) errors.push('live audit InterviewNote owner source_revision is invalid');
    if (!isObject(owner.validation) || typeof owner.validation.ok !== 'boolean' || !Array.isArray(owner.validation.errors)) errors.push('live audit InterviewNote owner validation is invalid');
    if (!Array.isArray(owner.comments)) errors.push('live audit InterviewNote owner comments are invalid');
  }
  return { source, owner };
}

function receiptShape(receipt, target, errors) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    errors.push(`InterviewNote #${target.owner_issue_number} materialization receipt is missing`);
    return null;
  }
  for (const field of [
    'schema_version', 'materialization_id', 'request_sha256', 'source_note_id',
    'source_note_body_sha256', 'source_revision_id', 'interview_note_id',
    'interview_issue_number', 'interview_note_body_sha256', 'materialized_at',
  ]) {
    if (receipt[field] == null || (typeof receipt[field] === 'string' && !receipt[field].trim())) {
      errors.push(`InterviewNote #${target.owner_issue_number} receipt is missing ${field}`);
    }
  }
  if (receipt.schema_version !== 'source-note-interview-materialized.v1') errors.push(`InterviewNote #${target.owner_issue_number} receipt schema is not v1`);
  if (receipt.repository !== REPOSITORY) errors.push(`InterviewNote #${target.owner_issue_number} receipt repository mismatch`);
  if (Number(receipt.source_note_issue_number) !== target.source_note_issue_number) errors.push(`InterviewNote #${target.owner_issue_number} receipt SourceNote Issue mismatch`);
  if (!HEX64.test(String(receipt.request_sha256 || ''))) errors.push(`InterviewNote #${target.owner_issue_number} receipt request_sha256 is not lowercase SHA-256`);
  if (!HEX64.test(String(receipt.source_note_body_sha256 || ''))) errors.push(`InterviewNote #${target.owner_issue_number} receipt source_note_body_sha256 is not lowercase SHA-256`);
  if (!HEX64.test(String(receipt.interview_note_body_sha256 || ''))) errors.push(`InterviewNote #${target.owner_issue_number} receipt interview_note_body_sha256 is not lowercase SHA-256`);
  if (receipt.case_key != null) errors.push(`InterviewNote #${target.owner_issue_number} single-case receipt must not contain case_key`);
  return receipt;
}

function validateInputs({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot }) {
  const errors = [];
  if (!sourceSnapshot || sourceSnapshot.schema_version !== 'issue-1611-live-source-note-snapshot.v1') errors.push('source snapshot schema is invalid');
  if (!ownershipInventory || ownershipInventory.schema_version !== 'aggregate-interview-note-ownership-inventory.v1') errors.push('ownership inventory schema is invalid');
  if (!materializationPlan || materializationPlan.schema_version !== 'issue-1605-interview-note-materialization-plan.v1') errors.push('materialization plan schema is invalid');
  if (!receiptSnapshot || receiptSnapshot.schema_version !== 'issue-1657-owner-receipt-audit-snapshot.v1') errors.push('owner/receipt snapshot schema is invalid');
  if (!liveAuditSnapshot || liveAuditSnapshot.schema_version !== LIVE_AUDIT_SCHEMA_VERSION) errors.push('live re-audit snapshot schema is invalid');
  if (sourceSnapshot && sourceSnapshot.repository !== REPOSITORY) errors.push('source snapshot repository mismatch');
  if (sourceSnapshot && sourceSnapshot.source_repository !== SOURCE_REPOSITORY) errors.push('source snapshot source repository mismatch');
  if (sourceSnapshot && sourceSnapshot.source_ref !== SOURCE_REF) errors.push('source snapshot source ref mismatch');
  if (ownershipInventory && (ownershipInventory.repository !== REPOSITORY || ownershipInventory.coverage !== 'all-repository-interview-note-issues' || ownershipInventory.complete !== true)) errors.push('ownership inventory is not complete repository-wide coverage');
  if (materializationPlan && materializationPlan.repository !== REPOSITORY) errors.push('materialization plan repository mismatch');
  if (receiptSnapshot && receiptSnapshot.repository !== REPOSITORY) errors.push('owner/receipt snapshot repository mismatch');
  if (liveAuditSnapshot && liveAuditSnapshot.repository !== REPOSITORY) errors.push('live re-audit snapshot repository mismatch');
  if (sourceSnapshot && HEX64.test(String(sourceSnapshot.canonical_digest || ''))) {
    const actual = sourceSnapshotDigest(sourceSnapshot.issues || []);
    if (actual !== sourceSnapshot.canonical_digest) errors.push(`source snapshot canonical digest drifted: expected ${sourceSnapshot.canonical_digest}, got ${actual}`);
  } else errors.push('source snapshot canonical_digest is required');
  if (ownershipInventory && HEX64.test(String(ownershipInventory.canonical_digest || ''))) {
    if (digestWithoutField(ownershipInventory, 'canonical_digest') !== ownershipInventory.canonical_digest) errors.push('ownership inventory canonical digest drifted');
  } else errors.push('ownership inventory canonical_digest is required');
  if (materializationPlan && HEX64.test(String(materializationPlan.dry_run_sha256 || ''))) {
    if (digestWithoutField(materializationPlan, 'dry_run_sha256') !== materializationPlan.dry_run_sha256) errors.push('materialization plan dry-run digest drifted');
  } else errors.push('materialization plan dry_run_sha256 is required');
  if (!sourceSnapshot || !Array.isArray(sourceSnapshot.issues)) errors.push('source snapshot issues array is required');
  if (!ownershipInventory || !Array.isArray(ownershipInventory.entries)) errors.push('ownership inventory entries array is required');
  if (!liveAuditSnapshot || !Array.isArray(liveAuditSnapshot.targets) || liveAuditSnapshot.targets.length !== TARGETS.length) errors.push(`live re-audit snapshot must contain exactly ${TARGETS.length} target entries`);
  if (!receiptSnapshot || !Array.isArray(receiptSnapshot.entries) || receiptSnapshot.entries.length !== TARGETS.length) {
    errors.push(`owner/receipt snapshot must contain exactly ${TARGETS.length} target entries`);
  } else {
    if (!HEX64.test(String(receiptSnapshot.canonical_digest || ''))) {
      errors.push('owner/receipt snapshot canonical_digest is required');
    } else if (receiptSnapshotDigest(receiptSnapshot) !== receiptSnapshot.canonical_digest) {
      errors.push('owner/receipt snapshot canonical_digest drifted');
    }
    for (const target of TARGETS) {
      const matches = receiptSnapshot.entries.filter((entry) => Number(entry && entry.source_note_issue_number) === target.source_note_issue_number);
      if (matches.length !== 1) {
        errors.push(`#${target.source_note_issue_number} receipt audit entry must resolve to exactly one row (got ${matches.length})`);
        continue;
      }
      const entry = matches[0];
      if (entry.interview_note_id !== target.interview_note_id) errors.push(`#${target.source_note_issue_number} receipt audit InterviewNote identity mismatch`);
      if (Number(entry.owner_issue_number) !== target.owner_issue_number) errors.push(`#${target.source_note_issue_number} receipt audit owner Issue mismatch`);
      if (!HEX64.test(String(entry.owner_body_sha256 || ''))) errors.push(`#${target.source_note_issue_number} receipt audit owner_body_sha256 is required`);
      if (typeof entry.owner_source_revision_id !== 'string' || !entry.owner_source_revision_id.trim()) errors.push(`#${target.source_note_issue_number} receipt audit owner SourceRevision is required`);
      if (entry.owner_source_repository_ref != null && !/^[0-9a-f]{40}$/.test(String(entry.owner_source_repository_ref))) errors.push(`#${target.source_note_issue_number} receipt audit owner source ref is invalid`);
    }
  }
  if (liveAuditSnapshot && HEX64.test(String(liveAuditSnapshot.canonical_digest || ''))) {
    if (liveAuditSnapshotDigest(liveAuditSnapshot) !== liveAuditSnapshot.canonical_digest) errors.push('live re-audit snapshot canonical digest drifted');
  } else errors.push('live re-audit snapshot canonical_digest is required');
  return errors;
}

function planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot }) {
  const errors = validateInputs({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot });
  const sourceIssues = sourceSnapshot && Array.isArray(sourceSnapshot.issues) ? sourceSnapshot.issues : [];
  const owners = ownershipInventory && Array.isArray(ownershipInventory.entries) ? ownershipInventory.entries : [];
  const receipts = receiptSnapshot && Array.isArray(receiptSnapshot.entries) ? receiptSnapshot.entries : [];
  const liveTargets = liveAuditSnapshot && Array.isArray(liveAuditSnapshot.targets) ? liveAuditSnapshot.targets : [];
  const results = [];

  for (const target of TARGETS) {
    const sourceIssue = findOne(sourceIssues, (issue) => Number(issue.number) === target.source_note_issue_number, `SourceNote #${target.source_note_issue_number}`, errors);
    const owner = findOne(owners, (entry) => Number(entry.issue_number) === target.owner_issue_number && entry.interview_note_id === target.interview_note_id, `InterviewNote owner #${target.owner_issue_number}`, errors);
    const receiptEntry = findOne(receipts, (entry) => Number(entry.source_note_issue_number) === target.source_note_issue_number, `#${target.source_note_issue_number} receipt audit entry`, errors);
    const liveTarget = findOne(liveTargets, (entry) => Number(entry.source_note_issue_number) === target.source_note_issue_number, `#${target.source_note_issue_number} live re-audit entry`, errors);
    const reportItem = findOne(materializationPlan && materializationPlan.results, (entry) => Number(entry.source_note_issue_number) === target.source_note_issue_number, `#${target.source_note_issue_number} materialization result`, errors);
    const sourceParsedResult = sourceIssue ? issueSourceRecord(sourceIssue) : { parsed: null, validation: { errors: [] } };
    // issueSourceRecord() already unwraps validateSourceNoteIssue().parsed.record.
    // Do not read .record again: that would erase every SourceNote identity.
    const sourceParsed = sourceParsedResult.parsed;
    const sourceBodySha = sourceIssue ? sha256Text(sourceIssue.body || '') : null;
    const sourceRevision = sourceParsed && sourceParsed.source_revision || {};
    const targetErrors = [];
    const liveShape = validateLiveTargetShape(liveTarget, target, targetErrors);
    const liveSource = liveShape.source;
    const liveOwner = liveShape.owner;
    if (!sourceParsedResult.validation.ok) targetErrors.push(...(sourceParsedResult.validation.errors || []).map((error) => `SourceNote invalid: ${error}`));
    if (!sourceParsed) targetErrors.push('SourceNote record is missing');
    if (sourceParsed && sourceParsed.source_note_id !== `xhs-note:${target.interview_note_id.slice(4)}`) targetErrors.push('SourceNote identity mismatch');
    if (sourceParsed && sourceParsed.boundary_review?.status !== 'single-interview') targetErrors.push('SourceNote is not currently single-interview');
    if (sourceParsed && !(sourceParsed.boundary_review?.interview_note_ids || []).includes(target.interview_note_id)) targetErrors.push('SourceNote does not declare the exact InterviewNote identity');
    if (liveSource) {
      if (liveSource.source_note_id !== (sourceParsed && sourceParsed.source_note_id)) targetErrors.push('live audit SourceNote identity mismatch');
      if (liveSource.body_sha256 !== sourceBodySha) targetErrors.push('live audit SourceNote body digest mismatch');
      if (liveSource.source_revision.id !== (sourceRevision.id || null)) targetErrors.push('live audit SourceRevision mismatch');
      if ((liveSource.source_revision.source_repository_ref ?? null) !== (sourceRevision.source_repository_ref ?? null)) targetErrors.push('live audit source repository ref mismatch');
      if (liveSource.boundary_review.status !== (sourceParsed && sourceParsed.boundary_review?.status)) targetErrors.push('live audit boundary status mismatch');
      if (liveSource.validation.ok !== true) targetErrors.push('live audit SourceNote validation is not passing');
    }
    if (sourceIssue && !labelsOf(sourceIssue).includes('boundary:single-interview')) targetErrors.push('SourceNote lacks boundary:single-interview label');
    if (owner && owner.interview_note_id !== target.interview_note_id) targetErrors.push('owner identity mismatch');
    if (liveOwner) {
      if (liveOwner.interview_note_id !== (owner && owner.interview_note_id)) targetErrors.push('live audit owner identity mismatch');
      if (liveOwner.body_sha256 !== (owner && owner.body_sha256)) targetErrors.push('live audit owner body digest mismatch');
      if (liveOwner.source_revision.id !== (owner && owner.source_revision_id)) targetErrors.push('live audit owner SourceRevision mismatch');
      if ((liveOwner.source_revision.source_repository_ref ?? null) !== (receiptEntry && receiptEntry.owner_source_repository_ref || null)) targetErrors.push('live audit owner source repository ref mismatch');
      if (liveOwner.validation.ok !== true) targetErrors.push('live audit InterviewNote validation is not passing');
    }
    if (owner && receiptEntry && Number(receiptEntry.owner_issue_number) !== Number(owner.issue_number)) targetErrors.push('receipt audit owner mismatch');
    if (owner && receiptEntry && owner.source_revision_id !== receiptEntry.owner_source_revision_id) targetErrors.push('owner SourceRevision disagrees with receipt audit');
    if (owner && receiptEntry && owner.body_sha256 !== receiptEntry.owner_body_sha256) targetErrors.push('owner body digest disagrees with receipt audit');
    if (owner && sourceRevision.id !== owner.source_revision_id) targetErrors.push('existing owner SourceRevision differs from current SourceNote');
    if (receiptEntry && receiptEntry.materialization_receipt) receiptShape(receiptEntry.materialization_receipt, target, targetErrors);
    if (receiptEntry && receiptEntry.materialization_receipt) {
      const receipt = receiptEntry.materialization_receipt;
      if (receipt.source_note_id !== (sourceParsed && sourceParsed.source_note_id)) targetErrors.push('materialization receipt SourceNote mismatch');
      if (receipt.source_note_body_sha256 !== sourceBodySha) targetErrors.push('materialization receipt SourceNote body digest mismatch');
      if (receipt.source_revision_id !== (sourceRevision.id || null)) targetErrors.push('materialization receipt SourceRevision mismatch');
      if (receipt.interview_note_id !== target.interview_note_id) targetErrors.push('materialization receipt InterviewNote identity mismatch');
      if (Number(receipt.interview_issue_number) !== target.owner_issue_number) targetErrors.push('materialization receipt owner Issue mismatch');
      if (receipt.interview_note_body_sha256 !== owner.body_sha256) targetErrors.push('materialization receipt owner body digest mismatch');
      if ((receipt.source_repository_ref ?? null) !== (sourceRevision.source_repository_ref ?? null)) targetErrors.push('materialization receipt source repository ref mismatch');
    }
    const markerExpectations = MARKER_EXPECTATIONS[target.source_note_issue_number];
    const boundaryEvidence = liveSource && requiredMarker(liveSource.boundary_evidence, 'live boundary evidence', targetErrors, markerExpectations.source.boundary_evidence, 'source-note-boundary-review-evidence');
    const boundaryApplied = liveSource && requiredMarker(liveSource.boundary_applied_receipt, 'live boundary applied receipt', targetErrors, markerExpectations.source.boundary_applied_receipt, 'source-note-boundary-review-applied');
    const materializationReceipt = liveSource && requiredMarker(liveSource.materialization_receipt, 'live materialization receipt', targetErrors, markerExpectations.source.materialization_receipt, 'source-note-interview-materialized');
    const ownerSourceEvidence = liveOwner && requiredMarker(liveOwner.source_review_evidence, 'live owner source-review evidence', targetErrors, markerExpectations.owner.source_review_evidence, 'interview-note-source-review-evidence');
    const ownerSourceApplied = liveOwner && requiredMarker(liveOwner.source_review_applied_receipt, 'live owner source-review applied receipt', targetErrors, markerExpectations.owner.source_review_applied_receipt, 'interview-note-source-review-applied');
    const ownerMaterialization = liveOwner && optionalMarker(liveOwner.materialization_receipt, 'live owner materialization receipt', targetErrors, markerExpectations.owner.materialization_receipt, 'source-note-interview-materialized');
    const payloadContext = {
      target,
      sourceParsed,
      sourceRevision,
      sourceBodySha,
      owner,
      reportItem,
      receiptEntry,
      boundaryPreviousBodySha: BOUNDARY_PREVIOUS_BODY_SHA256[target.source_note_issue_number],
    };
    if (boundaryEvidence && boundaryEvidence.count === 1) validateEvidencePayload(boundaryEvidence.payload, payloadContext, targetErrors);
    if (boundaryApplied && boundaryApplied.count === 1) validateBoundaryAppliedPayload(boundaryApplied.payload, payloadContext, targetErrors);
    if (materializationReceipt && materializationReceipt.count === 1) validateSourceMaterializationPayload(materializationReceipt.payload, payloadContext, targetErrors);
    if (ownerSourceApplied && ownerSourceApplied.count === 1) validateOwnerSourceReviewAppliedPayload(ownerSourceApplied.payload, payloadContext, targetErrors);
    if (boundaryEvidence && boundaryEvidence.comment_id !== (reportItem && reportItem.evidence_comment_id)) targetErrors.push('live boundary evidence comment mismatch');
    if (boundaryApplied && boundaryApplied.payload && boundaryApplied.payload.new_body_sha256 !== sourceBodySha) targetErrors.push('live boundary applied receipt body digest mismatch');
    if (materializationReceipt && receiptEntry && materializationReceipt.comment_id !== receiptEntry.materialization_receipt_comment_id) targetErrors.push('live materialization receipt comment mismatch');

    const requestBase = {
      repository: REPOSITORY,
      source_note_issue_number: target.source_note_issue_number,
      source_note_id: sourceParsed && sourceParsed.source_note_id || null,
      interview_note_id: target.interview_note_id,
      owner_issue_number: target.owner_issue_number,
      expected_source_note_body_sha256: sourceBodySha,
      expected_source_revision_id: sourceRevision.id || null,
      expected_source_repository_ref: sourceRevision.source_repository_ref ?? null,
      expected_owner_body_sha256: owner && owner.body_sha256 || null,
      mutation_performed: false,
    };
    let action;
    let reason_codes;
    let request;
    let decision_class;
    if (target.source_note_issue_number === 910) {
      decision_class = 'must-manually-confirm-boundary-evidence-and-runtime-provenance';
      const hasMachineEvidence = Number(reportItem && reportItem.evidence_comment_id) > 0 && reportItem.evidence_schema === 'source-note-boundary-review-evidence.v1';
      if (hasMachineEvidence) targetErrors.push('unexpectedly claims exact machine boundary evidence; re-audit required');
      if (sourceRevision.source_repository_ref != null) targetErrors.push('runtime SourceRevision unexpectedly carries a Git source ref');
      if (!sourceRevision.manifest_sha256 || sourceRevision.storage_kind !== 'runtime-artifact-store') targetErrors.push('runtime SourceRevision lacks its manifest/runtime binding');
      action = 'blocked-boundary-evidence-and-runtime-provenance';
      reason_codes = ['boundary-evidence-missing-or-ambiguous', 'runtime-source-repository-ref-unavailable'];
      request = {
        schema_version: 'issue-1657-boundary-evidence-recovery-request.v1',
        ...requestBase,
        transition_id: reportItem && reportItem.transition_id || null,
        expected_boundary_evidence: {
          comment_id: null,
          schema_version: 'source-note-boundary-review-evidence.v1',
          source_revision_id: sourceRevision.id || null,
          manifest_sha256: sourceRevision.manifest_sha256 || null,
          source_repository_ref: null,
        },
        runtime_ref_policy: 'do-not-invent-a-Git-source-repository-ref; preserve runtime artifact binding or obtain an independently fixed Git snapshot',
        authorized_operations: [],
      };
    } else {
      decision_class = 'repairable-after-independent-owner-review-and-CAS';
      action = 'blocked-owner-source-revision-cas';
      reason_codes = ['materialization-preflight-failed', 'existing-owner-source-revision-mismatch'];
      request = {
        schema_version: 'issue-1657-interview-note-owner-reconcile-request.v1',
        ...requestBase,
        expected_owner_source_revision_id: owner && owner.source_revision_id || null,
        expected_owner_source_repository_ref: receiptEntry && receiptEntry.owner_source_repository_ref || null,
        requested_owner_source_revision_id: sourceRevision.id || null,
        requested_owner_source_repository_ref: sourceRevision.source_repository_ref || null,
        authorized_operations: [],
        preconditions: ['independent owner review', 'owner body CAS', 'SourceNote body/revision/ref CAS', 'exact identity ownership remains unique', 'materialization receipt is absent or exactly reconciled'],
      };
    }
    if (reportItem && reportItem.action !== 'blocked') targetErrors.push(`materialization dry-run unexpectedly reports action=${reportItem.action}`);
    if (reportItem && reportItem.mutation_performed !== false) targetErrors.push('materialization dry-run claims a mutation');
    results.push({
      ...requestBase,
      action,
      decision_class,
      reason_codes,
      errors: targetErrors,
      source_note_body_sha256: sourceBodySha,
      source_revision_id: sourceRevision.id || null,
      source_repository_ref: sourceRevision.source_repository_ref ?? null,
      owner_source_revision_id: owner && owner.source_revision_id || null,
      owner_source_repository_ref: receiptEntry && receiptEntry.owner_source_repository_ref || null,
      live_audit: {
        captured_at: liveAuditSnapshot && liveAuditSnapshot.captured_at || null,
        source_note_comment_ids: liveSource && Array.isArray(liveSource.comments) ? liveSource.comments.map((comment) => comment.id) : [],
        source_marker_counts: liveSource ? { boundary_evidence: liveSource.boundary_evidence && liveSource.boundary_evidence.count, boundary_applied_receipt: liveSource.boundary_applied_receipt && liveSource.boundary_applied_receipt.count, materialization_receipt: liveSource.materialization_receipt && liveSource.materialization_receipt.count } : null,
        expected_source_marker_counts: markerExpectations.source,
        boundary_evidence_comment_id: liveSource && liveSource.boundary_evidence ? liveSource.boundary_evidence.comment_id : null,
        boundary_applied_receipt_comment_id: liveSource && liveSource.boundary_applied_receipt ? liveSource.boundary_applied_receipt.comment_id : null,
        materialization_receipt_comment_id: liveSource && liveSource.materialization_receipt ? liveSource.materialization_receipt.comment_id : null,
        owner_comment_ids: liveOwner && Array.isArray(liveOwner.comments) ? liveOwner.comments.map((comment) => comment.id) : [],
        owner_marker_counts: liveOwner ? { source_review_evidence: liveOwner.source_review_evidence && liveOwner.source_review_evidence.count, source_review_applied_receipt: liveOwner.source_review_applied_receipt && liveOwner.source_review_applied_receipt.count, materialization_receipt: liveOwner.materialization_receipt && liveOwner.materialization_receipt.count } : null,
        expected_owner_marker_counts: markerExpectations.owner,
        owner_source_review_evidence_comment_ids: liveOwner ? liveOwner.source_review_evidence_comment_ids : [],
        owner_source_review_applied_receipt_comment_id: liveOwner && liveOwner.source_review_applied_receipt ? liveOwner.source_review_applied_receipt.comment_id : null,
      },
      receipt_comment_id: receiptEntry && receiptEntry.materialization_receipt_comment_id || null,
      boundary_evidence_comment_id: reportItem && reportItem.evidence_comment_id || null,
      materialization_plan_action: reportItem && reportItem.action || null,
      request,
      mutation_performed: false,
      write_operations: { ...REQUIRED_ZERO_WRITES },
    });
  }

  const output = {
    schema_version: SCHEMA_VERSION,
    repository: REPOSITORY,
    parent_issue: 1657,
    mode: 'read-only-audit-plan',
    source_snapshot_digest: sourceSnapshot && sourceSnapshot.canonical_digest || null,
    ownership_inventory_digest: ownershipInventory && ownershipInventory.canonical_digest || null,
    materialization_plan_digest: materializationPlan && materializationPlan.dry_run_sha256 || null,
    owner_receipt_snapshot_digest: receiptSnapshot && receiptSnapshot.canonical_digest || null,
    live_reaudit_snapshot_digest: liveAuditSnapshot && liveAuditSnapshot.canonical_digest || null,
    target_count: TARGETS.length,
    blocked_count: results.length,
    mutation_performed: false,
    write_operations: { ...REQUIRED_ZERO_WRITES },
    results,
    errors,
  };
  output.ok = errors.length === 0 && results.length === TARGETS.length && results.every((result) => result.errors.length === 0 && result.action.startsWith('blocked-'));
  output.plan_digest = canonicalDigest(output);
  return output;
}

module.exports = {
  SCHEMA_VERSION,
  LIVE_AUDIT_SCHEMA_VERSION,
  REPOSITORY,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  TARGETS,
  REQUIRED_ZERO_WRITES,
  MARKER_EXPECTATIONS,
  receiptSnapshotDigest,
  liveAuditSnapshotDigest,
  validateInputs,
  planIssue1657BlockerRepair,
};
