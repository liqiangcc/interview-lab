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

function requiredMarker(summary, label, errors) {
  if (!isObject(summary) || !Object.prototype.hasOwnProperty.call(summary, 'count')) {
    errors.push(`${label} marker count is missing`);
    return null;
  }
  if (![0, 1, '>1'].includes(summary.count)) errors.push(`${label} marker count must be 0, 1, or >1`);
  if (summary.count !== 1) errors.push(`${label} marker count must be exactly 1 (got ${summary.count})`);
  if (!Array.isArray(summary.comments) || !Array.isArray(summary.comment_ids)) errors.push(`${label} marker comment evidence is missing`);
  return summary.count === 1 ? summary : null;
}

function optionalMarker(summary, label, errors) {
  if (!isObject(summary) || !Object.prototype.hasOwnProperty.call(summary, 'count')) {
    errors.push(`${label} marker count is missing`);
    return null;
  }
  if (![0, 1, '>1'].includes(summary.count)) errors.push(`${label} marker count must be 0, 1, or >1`);
  if (summary.count === '>1') errors.push(`${label} marker count must not be >1`);
  if (!Array.isArray(summary.comments) || !Array.isArray(summary.comment_ids)) errors.push(`${label} marker comment evidence is missing`);
  return summary.count === 1 ? summary : null;
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
    const boundaryEvidence = liveSource && requiredMarker(liveSource.boundary_evidence, 'live boundary evidence', targetErrors);
    const boundaryApplied = liveSource && requiredMarker(liveSource.boundary_applied_receipt, 'live boundary applied receipt', targetErrors);
    const materializationReceipt = liveSource && requiredMarker(liveSource.materialization_receipt, 'live materialization receipt', targetErrors);
    const ownerSourceEvidence = liveOwner && requiredMarker(liveOwner.source_review_evidence, 'live owner source-review evidence', targetErrors);
    const ownerSourceApplied = liveOwner && requiredMarker(liveOwner.source_review_applied_receipt, 'live owner source-review applied receipt', targetErrors);
    const ownerMaterialization = liveOwner && optionalMarker(liveOwner.materialization_receipt, 'live owner materialization receipt', targetErrors);
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
        boundary_evidence_comment_id: liveSource && liveSource.boundary_evidence ? liveSource.boundary_evidence.comment_id : null,
        boundary_applied_receipt_comment_id: liveSource && liveSource.boundary_applied_receipt ? liveSource.boundary_applied_receipt.comment_id : null,
        materialization_receipt_comment_id: liveSource && liveSource.materialization_receipt ? liveSource.materialization_receipt.comment_id : null,
        owner_comment_ids: liveOwner && Array.isArray(liveOwner.comments) ? liveOwner.comments.map((comment) => comment.id) : [],
        owner_marker_counts: liveOwner ? { source_review_evidence: liveOwner.source_review_evidence && liveOwner.source_review_evidence.count, source_review_applied_receipt: liveOwner.source_review_applied_receipt && liveOwner.source_review_applied_receipt.count, materialization_receipt: liveOwner.materialization_receipt && liveOwner.materialization_receipt.count } : null,
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
  receiptSnapshotDigest,
  liveAuditSnapshotDigest,
  validateInputs,
  planIssue1657BlockerRepair,
};
