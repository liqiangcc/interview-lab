'use strict';

const { canonicalDigest, sha256Text } = require('./aggregate-downstream-pipeline');
const { issueSourceRecord } = require('./interview-note-materialization-batch');
const { sourceSnapshotDigest } = require('../plan-issue-1611-live-materialization');

const SCHEMA_VERSION = 'issue-1657-blocker-repair-plan.v1';
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

function findOne(items, predicate, label, errors) {
  const matches = (items || []).filter(predicate);
  if (matches.length !== 1) errors.push(`${label} must resolve to exactly one row (got ${matches.length})`);
  return matches[0] || null;
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

function validateInputs({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot }) {
  const errors = [];
  if (!sourceSnapshot || sourceSnapshot.schema_version !== 'issue-1611-live-source-note-snapshot.v1') errors.push('source snapshot schema is invalid');
  if (!ownershipInventory || ownershipInventory.schema_version !== 'aggregate-interview-note-ownership-inventory.v1') errors.push('ownership inventory schema is invalid');
  if (!materializationPlan || materializationPlan.schema_version !== 'issue-1605-interview-note-materialization-plan.v1') errors.push('materialization plan schema is invalid');
  if (!receiptSnapshot || receiptSnapshot.schema_version !== 'issue-1657-owner-receipt-audit-snapshot.v1') errors.push('owner/receipt snapshot schema is invalid');
  if (sourceSnapshot && sourceSnapshot.repository !== REPOSITORY) errors.push('source snapshot repository mismatch');
  if (sourceSnapshot && sourceSnapshot.source_repository !== SOURCE_REPOSITORY) errors.push('source snapshot source repository mismatch');
  if (sourceSnapshot && sourceSnapshot.source_ref !== SOURCE_REF) errors.push('source snapshot source ref mismatch');
  if (ownershipInventory && (ownershipInventory.repository !== REPOSITORY || ownershipInventory.coverage !== 'all-repository-interview-note-issues' || ownershipInventory.complete !== true)) errors.push('ownership inventory is not complete repository-wide coverage');
  if (materializationPlan && materializationPlan.repository !== REPOSITORY) errors.push('materialization plan repository mismatch');
  if (receiptSnapshot && receiptSnapshot.repository !== REPOSITORY) errors.push('owner/receipt snapshot repository mismatch');
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
  if (!receiptSnapshot || !Array.isArray(receiptSnapshot.entries) || receiptSnapshot.entries.length !== TARGETS.length) errors.push(`owner/receipt snapshot must contain exactly ${TARGETS.length} target entries`);
  return errors;
}

function planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot }) {
  const errors = validateInputs({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot });
  const sourceIssues = sourceSnapshot && Array.isArray(sourceSnapshot.issues) ? sourceSnapshot.issues : [];
  const owners = ownershipInventory && Array.isArray(ownershipInventory.entries) ? ownershipInventory.entries : [];
  const receipts = receiptSnapshot && Array.isArray(receiptSnapshot.entries) ? receiptSnapshot.entries : [];
  const results = [];

  for (const target of TARGETS) {
    const sourceIssue = findOne(sourceIssues, (issue) => Number(issue.number) === target.source_note_issue_number, `SourceNote #${target.source_note_issue_number}`, errors);
    const owner = findOne(owners, (entry) => Number(entry.issue_number) === target.owner_issue_number && entry.interview_note_id === target.interview_note_id, `InterviewNote owner #${target.owner_issue_number}`, errors);
    const receiptEntry = findOne(receipts, (entry) => Number(entry.source_note_issue_number) === target.source_note_issue_number, `#${target.source_note_issue_number} receipt audit entry`, errors);
    const reportItem = findOne(materializationPlan && materializationPlan.results, (entry) => Number(entry.source_note_issue_number) === target.source_note_issue_number, `#${target.source_note_issue_number} materialization result`, errors);
    const sourceParsedResult = sourceIssue ? issueSourceRecord(sourceIssue) : { parsed: null, validation: { errors: [] } };
    // issueSourceRecord() already unwraps validateSourceNoteIssue().parsed.record.
    // Do not read .record again: that would erase every SourceNote identity.
    const sourceParsed = sourceParsedResult.parsed;
    const sourceBodySha = sourceIssue ? sha256Text(sourceIssue.body || '') : null;
    const sourceRevision = sourceParsed && sourceParsed.source_revision || {};
    const targetErrors = [];
    if (!sourceParsedResult.validation.ok) targetErrors.push(...(sourceParsedResult.validation.errors || []).map((error) => `SourceNote invalid: ${error}`));
    if (!sourceParsed) targetErrors.push('SourceNote record is missing');
    if (sourceParsed && sourceParsed.source_note_id !== `xhs-note:${target.interview_note_id.slice(4)}`) targetErrors.push('SourceNote identity mismatch');
    if (sourceParsed && sourceParsed.boundary_review?.status !== 'single-interview') targetErrors.push('SourceNote is not currently single-interview');
    if (sourceParsed && !(sourceParsed.boundary_review?.interview_note_ids || []).includes(target.interview_note_id)) targetErrors.push('SourceNote does not declare the exact InterviewNote identity');
    if (sourceIssue && !labelsOf(sourceIssue).includes('boundary:single-interview')) targetErrors.push('SourceNote lacks boundary:single-interview label');
    if (owner && owner.interview_note_id !== target.interview_note_id) targetErrors.push('owner identity mismatch');
    if (owner && receiptEntry && Number(receiptEntry.owner_issue_number) !== Number(owner.issue_number)) targetErrors.push('receipt audit owner mismatch');
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
    if (target.source_note_issue_number === 910) {
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
      reason_codes,
      errors: targetErrors,
      source_note_body_sha256: sourceBodySha,
      source_revision_id: sourceRevision.id || null,
      source_repository_ref: sourceRevision.source_repository_ref ?? null,
      owner_source_revision_id: owner && owner.source_revision_id || null,
      owner_source_repository_ref: receiptEntry && receiptEntry.owner_source_repository_ref || null,
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
  REPOSITORY,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  TARGETS,
  REQUIRED_ZERO_WRITES,
  validateInputs,
  planIssue1657BlockerRepair,
};
