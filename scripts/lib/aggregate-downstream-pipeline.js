'use strict';

const crypto = require('crypto');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./interview-note-issue');
const { validateInterviewContext, buildLearningDiscovery } = require('./interview-context');
const { validateSnapshot } = require('./issue-1605-pending-inventory');

const SCHEMA_VERSION = 'aggregate-downstream-pipeline.v1';
const PLAN_SCHEMA_VERSION = 'aggregate-downstream-pipeline-plan.v1';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const BOUNDARY_BATCHES = Object.freeze([
  { issue_number: 1606, first: 20, last: 392, expected_count: 327 },
  { issue_number: 1607, first: 393, last: 765, expected_count: 367 },
  { issue_number: 1608, first: 766, last: 1138, expected_count: 337 },
  { issue_number: 1609, first: 1139, last: 1508, expected_count: 366 },
]);
const REQUIRED_DEPENDENCIES = [1606, 1607, 1608, 1609, 1610];
const EXISTING_SOURCE_READY_ISSUES = Object.freeze([3, 4, 915, ...Array.from({ length: 30 }, (_, index) => 1509 + index), 1558, 1559, ...Array.from({ length: 15 }, (_, index) => 1562 + index)]);
const RECEIPT_SCHEMA_VERSION = 'aggregate-downstream-receipt.v1';
const SOURCE_REVIEW_RECEIPT_SCHEMA = 'interview-note-source-review-applied.v1';
const HEX64 = /^[0-9a-f]{64}$/;
const UPSTREAM_DIGEST_RULES = Object.freeze({
  'source-note-boundary-review-batch.v1': Object.freeze({ field: 'dry_run_sha256', input: (report) => without(report, 'dry_run_sha256') }),
  'source-note-interview-materialization-batch.v1': Object.freeze({ field: 'dry_run_sha256', input: (report) => without(report, 'dry_run_sha256') }),
  'issue-1539-interview-note-materialization-batch.v1': Object.freeze({ field: 'dry_run_sha256', input: (report) => without(report, 'dry_run_sha256') }),
  'issue-1609-boundary-dry-run.v1': Object.freeze({ field: 'dry_run_sha256', input: (report) => without(report, 'dry_run_sha256') }),
  'issue-1610-source-recovery.v1': Object.freeze({ field: 'report_sha256', input: (report) => without(report, 'report_sha256') }),
  'issue-1610-recovery-dry-run.v1': Object.freeze({ field: 'plan_sha256', input: (report) => report.digest_input }),
  'issue-1539-recovery-dry-run.v1': Object.freeze({ field: 'dry_run_sha256', input: (report) => without(report, 'dry_run_sha256') }),
});

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value) { return sha256Text(canonicalize(value)); }

// Kept as a compatibility export for callers that used the old name. All
// upstream report validation uses the canonical recursive key-sort algorithm.
function jsonDigest(value) { return canonicalDigest(value); }

function without(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(nonEmpty))].sort();
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['aggregate manifest must be an object'] };
  const allowed = new Set([
    'schema_version', 'aggregate_id', 'repository', 'source_repository', 'source_ref',
    'parent_issue', 'issue_number', 'dependency_issues', 'boundary_batches',
    'recovery_report', 'materialization_reports', 'source_review_receipts',
    'context_reports', 'existing_context_reports', 'existing_source_ready_issue_numbers',
    'live_issue_snapshot', 'expected_dependency_body_sha256', 'pending_inventory_snapshot',
    'pending_inventory_ownership', 'expected_pending_inventory_digest', 'expected_pending_ownership_digest',
  ]);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) errors.push(`unsupported manifest field: ${key}`);
  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!nonEmpty(manifest.aggregate_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.aggregate_id || '')) errors.push('aggregate_id must be a stable identifier');
  if (manifest.repository !== 'liqiangcc/interview-lab') errors.push('repository must be liqiangcc/interview-lab');
  if (manifest.source_repository !== 'liqiangcc/xhs') errors.push('source_repository must be liqiangcc/xhs');
  if (manifest.source_ref !== SOURCE_REF) errors.push(`source_ref must be the frozen XHS snapshot ${SOURCE_REF}`);
  if (manifest.parent_issue !== 1605) errors.push('parent_issue must be #1605');
  if (manifest.issue_number !== 1611) errors.push('issue_number must be #1611');
  if (JSON.stringify(manifest.dependency_issues || []) !== JSON.stringify(REQUIRED_DEPENDENCIES)) errors.push('dependency_issues must equal [1606,1607,1608,1609,1610] in order');

  if (!Array.isArray(manifest.boundary_batches) || manifest.boundary_batches.length !== BOUNDARY_BATCHES.length) {
    errors.push('boundary_batches must contain exactly four fixed batches');
  } else {
    for (const expected of BOUNDARY_BATCHES) {
      const actual = manifest.boundary_batches.find((entry) => Number(entry && entry.issue_number) === expected.issue_number);
      if (!actual) { errors.push(`boundary batch #${expected.issue_number} is missing`); continue; }
      for (const field of ['first', 'last', 'expected_count']) if (actual[field] !== expected[field]) errors.push(`boundary batch #${expected.issue_number} ${field} is not frozen`);
      if (!nonEmpty(actual.report)) errors.push(`boundary batch #${expected.issue_number} report is required`);
    }
  }
  if (!nonEmpty(manifest.recovery_report)) errors.push('recovery_report is required');
  if (!Array.isArray(manifest.materialization_reports) || manifest.materialization_reports.length === 0 || manifest.materialization_reports.some((file) => !nonEmpty(file))) errors.push('materialization_reports must be a non-empty list of report paths');
  if (!nonEmpty(manifest.source_review_receipts)) errors.push('source_review_receipts is required');
  if (!Array.isArray(manifest.context_reports) || manifest.context_reports.length === 0 || manifest.context_reports.some((file) => !nonEmpty(file))) errors.push('context_reports must be a non-empty list of report paths');
  if (!Array.isArray(manifest.existing_context_reports) || manifest.existing_context_reports.length === 0 || manifest.existing_context_reports.some((file) => !nonEmpty(file))) errors.push('existing_context_reports must be a non-empty list of audited Context report paths');
  if (JSON.stringify(manifest.existing_source_ready_issue_numbers || []) !== JSON.stringify(EXISTING_SOURCE_READY_ISSUES)) errors.push('existing_source_ready_issue_numbers must equal the frozen 50-item source-ready inventory');
  if (!nonEmpty(manifest.live_issue_snapshot)) errors.push('live_issue_snapshot is required; planning without a body-pinned read snapshot is forbidden');
  const inventoryFields = ['pending_inventory_snapshot', 'pending_inventory_ownership'];
  if (inventoryFields.some((field) => manifest[field] !== undefined)) {
    for (const field of inventoryFields) if (!nonEmpty(manifest[field])) errors.push(`${field} is required when pending inventory dependency is enabled`);
    if (!HEX64.test(manifest.expected_pending_inventory_digest || '')) errors.push('expected_pending_inventory_digest must be a lowercase SHA-256');
    if (!HEX64.test(manifest.expected_pending_ownership_digest || '')) errors.push('expected_pending_ownership_digest must be a lowercase SHA-256');
  }
  if (manifest.expected_dependency_body_sha256 !== undefined) {
    if (!manifest.expected_dependency_body_sha256 || typeof manifest.expected_dependency_body_sha256 !== 'object') errors.push('expected_dependency_body_sha256 must be an object');
    else for (const issue of REQUIRED_DEPENDENCIES) if (!HEX64.test(manifest.expected_dependency_body_sha256[String(issue)] || '')) errors.push(`expected dependency #${issue} body SHA must be lowercase SHA-256`);
  }
  return { ok: errors.length === 0, errors };
}

function upstreamDigest(report, expectedSchema = report && report.schema_version) {
  const rule = UPSTREAM_DIGEST_RULES[expectedSchema];
  if (!rule) return { ok: false, errors: [`${expectedSchema || 'unknown'} has no declared upstream digest algorithm`] };
  const value = report && report[rule.field];
  if (!HEX64.test(value || '')) return { ok: false, errors: [`${expectedSchema}.${rule.field} is required`] };
  const input = rule.input(report);
  if (input == null || (expectedSchema === 'issue-1610-recovery-dry-run.v1' && typeof input !== 'object')) {
    return { ok: false, errors: [`${expectedSchema}.${rule.field} digest input is required`] };
  }
  return { ok: true, field: rule.field, expected: canonicalDigest(input), actual: value };
}

function validateUpstreamReport(report, label, expectedSchema) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { ok: false, errors: [`${label} must be an object`] };
  if (report.schema_version !== expectedSchema) errors.push(`${label}.schema_version must be ${expectedSchema}`);
  const digest = upstreamDigest(report, expectedSchema);
  if (!digest.ok) errors.push(...digest.errors.map((error) => `${label}: ${error}`));
  else if (digest.expected !== digest.actual) errors.push(`${label}.${digest.field} does not match its declared canonical digest input`);
  return { ok: errors.length === 0, errors };
}

function validateBoundaryReports(manifest, reports) {
  const errors = [];
  const boundaryItems = [];
  const seenSourceIssues = new Set();
  for (const expected of BOUNDARY_BATCHES) {
    const report = reports[expected.issue_number];
    const validation = validateUpstreamReport(report, `boundary #${expected.issue_number}`, 'source-note-boundary-review-batch.v1');
    errors.push(...validation.errors);
    if (!report) continue;
    if (report.repository !== manifest.repository) errors.push(`boundary #${expected.issue_number} repository drifted`);
    if (Number(report.total) !== expected.expected_count || !Array.isArray(report.items) || report.items.length !== expected.expected_count) errors.push(`boundary #${expected.issue_number} item count is not ${expected.expected_count}`);
    for (const item of report.items || []) {
      const number = Number(item.issue_number);
      if (!Number.isInteger(number) || number < expected.first || number > expected.last) errors.push(`boundary #${expected.issue_number} contains out-of-range SourceNote #${item.issue_number}`);
      if (seenSourceIssues.has(number)) errors.push(`SourceNote #${number} appears in more than one boundary batch`);
      seenSourceIssues.add(number);
      if (!HEX64.test(item.current_body_sha256 || '')) errors.push(`SourceNote #${number} has no frozen current_body_sha256`);
      if (!nonEmpty(item.source_note_id)) errors.push(`SourceNote #${number} has no source_note_id`);
      if (!Array.isArray(item.interview_note_ids)) errors.push(`SourceNote #${number} has no interview_note_ids disposition`);
      if (!['already_applied'].includes(item.status) && item.status !== undefined) errors.push(`boundary #${expected.issue_number} SourceNote #${number} is not already_applied`);
      if (item.status === 'blocked' || (item.errors && item.errors.length)) errors.push(`boundary #${expected.issue_number} contains a blocked item #${number}`);
      boundaryItems.push({ ...item, boundary_batch_issue_number: expected.issue_number });
    }
  }
  return { ok: errors.length === 0, errors, items: boundaryItems };
}

function materializationRows(reports, manifest, errors) {
  const rows = [];
  const seenSource = new Set();
  const seenInterview = new Set();
  const seenIssue = new Set();
  for (const [index, report] of reports.entries()) {
    const validation = validateUpstreamReport(report, `materialization report ${index + 1}`, 'source-note-interview-materialization-batch.v1');
    errors.push(...validation.errors);
    if (!report) continue;
    if (report.repository !== manifest.repository) errors.push(`materialization report ${index + 1} repository drifted`);
    for (const row of report.results || []) {
      if (row.action === 'skip-not-interview') continue;
      if (row.action !== 'already-materialized') {
        errors.push(`SourceNote #${row.source_note_issue_number} materialization is not converged (${row.action || 'unknown'})`);
        continue;
      }
      const request = row.request || {};
      const materialization = row.materialization || {};
      const issueNumber = Number(materialization.existing_issue_number);
      const sourceRef = request.expected_source_repository_ref || materialization.source_repository_ref || null;
      if (!HEX64.test(request.expected_source_note_body_sha256 || materialization.source_note_body_sha256 || '')) errors.push(`SourceNote #${row.source_note_issue_number} materialization has no body SHA`);
      if (sourceRef !== manifest.source_ref) errors.push(`SourceNote #${row.source_note_issue_number} materialization source ref drifted`);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) errors.push(`SourceNote #${row.source_note_issue_number} has no existing InterviewNote owner`);
      const interviewId = materialization.interview_note_id;
      if (!nonEmpty(interviewId)) errors.push(`SourceNote #${row.source_note_issue_number} has no InterviewNote identity`);
      if (seenSource.has(row.source_note_issue_number)) errors.push(`SourceNote #${row.source_note_issue_number} has duplicate materialization rows`);
      if (seenInterview.has(interviewId)) errors.push(`InterviewNote ${interviewId} has duplicate materialization ownership`);
      if (seenIssue.has(issueNumber)) errors.push(`InterviewNote Issue #${issueNumber} has duplicate materialization ownership`);
      seenSource.add(row.source_note_issue_number); seenInterview.add(interviewId); seenIssue.add(issueNumber);
      rows.push({
        source_note_issue_number: Number(row.source_note_issue_number),
        source_note_id: row.source_note_id || null,
        source_note_body_sha256: request.expected_source_note_body_sha256 || materialization.source_note_body_sha256,
        source_revision_id: request.expected_source_revision_id || null,
        source_ref: sourceRef,
        boundary_status: row.boundary_status || null,
        case_key: row.case_key == null ? null : row.case_key,
        interview_note_id: interviewId,
        interview_issue_number: issueNumber,
        projected_body_sha256: materialization.projected_body_sha256 || null,
        materialization_id: request.materialization_id || null,
      });
    }
  }
  return rows;
}

function validateRecovery(report, manifest, errors) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) { errors.push('recovery report must be an object'); return []; }
  const digest = upstreamDigest(report);
  if (!digest.ok) errors.push(...digest.errors.map((error) => `recovery report: ${error}`));
  else if (digest.expected !== digest.actual) errors.push(`recovery report.${digest.field} does not match its declared canonical digest input`);
  if (report.repository && report.repository !== manifest.repository) errors.push('recovery report repository drifted');
  const rows = Array.isArray(report.items) ? report.items : [];
  if (rows.length !== 2) errors.push('recovery report must contain exactly #1 and #2');
  const numbers = new Set();
  for (const row of rows) {
    const number = Number(row.interview_issue_number || row.issue_number);
    numbers.add(number);
    if (![1, 2].includes(number)) errors.push(`recovery report contains out-of-scope InterviewNote #${number}`);
    if (!['source-ready', 'blocked'].includes(row.final_status || row.status)) errors.push(`recovery #${number} has no explicit source review terminal status`);
    if (row.source_repository_ref && row.source_repository_ref !== manifest.source_ref) errors.push(`recovery #${number} source ref drifted`);
  }
  if (numbers.size !== 2 || !numbers.has(1) || !numbers.has(2)) errors.push('recovery report must cover both #1 and #2 exactly once');
  return rows;
}

function independentEvidenceRequest(row) {
  const subject = {
    schema_version: 'aggregate-source-review-evidence-request.v1',
    interview_note_id: row.interview_note_id,
    interview_issue_number: row.interview_issue_number,
    source_note_issue_number: row.source_note_issue_number,
    source_note_id: row.source_note_id,
    source_note_body_sha256: row.source_note_body_sha256,
    source_revision_id: row.source_revision_id,
    source_ref: row.source_ref,
    case_key: row.case_key,
  };
  return {
    ...subject,
    evidence_subject_sha256: canonicalDigest(subject),
    decision: 'pending-independent-source-review',
    boundary_evidence_reuse: false,
    required_checks: ['source_identity', 'source_revision_binding', 'artifact_reference_integrity', 'raw_projection_traceability', 'known_limitations_recorded', 'duplicate_ownership', 'no_fabrication'],
  };
}

function validateSourceReviewReceipts(receipts, rows, errors, liveIssues = new Map()) {
  if (!Array.isArray(receipts)) { errors.push('source_review_receipts must be an array'); return { byInterview: new Map(), evidence_requests: rows.map(independentEvidenceRequest) }; }
  const byInterview = new Map();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object') { errors.push('source review receipt must be an object'); continue; }
    const candidate = receipt.receipt || receipt;
    if (candidate.schema_version !== SOURCE_REVIEW_RECEIPT_SCHEMA) errors.push(`source review receipt for ${candidate.interview_note_id || 'unknown'} has the wrong schema`);
    if (!['source-ready', 'blocked'].includes(candidate.final_status || candidate.decision)) errors.push(`source review receipt for ${candidate.interview_note_id || 'unknown'} has no terminal decision`);
    if (!HEX64.test(candidate.interview_body_sha256 || '')) errors.push(`source review receipt for ${candidate.interview_note_id || 'unknown'} has no InterviewNote body SHA`);
    if (!HEX64.test(candidate.source_note_body_sha256 || '')) errors.push(`source review receipt for ${candidate.interview_note_id || 'unknown'} has no SourceNote body SHA`);
    if (candidate.source_repository_ref !== undefined && candidate.source_repository_ref !== null && candidate.source_repository_ref !== SOURCE_REF) errors.push(`source review receipt for ${candidate.interview_note_id || 'unknown'} source ref drifted`);
    const independent = receipt.independent === true || receipt.evidence && receipt.evidence.independent === true;
    if (!independent) errors.push(`source review receipt for ${candidate.interview_note_id || 'unknown'} does not prove independent evidence`);
    const id = candidate.interview_note_id;
    if (!nonEmpty(id)) continue;
    if (byInterview.has(id)) errors.push(`duplicate Source Review receipt for ${id}`);
    byInterview.set(id, { ...candidate, independent_evidence: independent });
  }
  const requests = [];
  for (const row of rows) {
    const receipt = byInterview.get(row.interview_note_id);
    if (!receipt) {
      requests.push(independentEvidenceRequest(row));
      errors.push(`InterviewNote ${row.interview_note_id} has no independent Source Review receipt`);
    }
    else {
      if (receipt.source_note_body_sha256 !== row.source_note_body_sha256) errors.push(`Source Review ${row.interview_note_id} does not bind the frozen SourceNote body SHA`);
      if (receipt.source_revision_id !== row.source_revision_id) errors.push(`Source Review ${row.interview_note_id} does not bind the frozen SourceRevision`);
      if (receipt.final_status === 'source-ready' && receipt.source_repository_ref !== SOURCE_REF) errors.push(`source-ready Source Review ${row.interview_note_id} does not bind the frozen source ref`);
      const live = liveIssues.get(row.interview_issue_number);
      if (!live) errors.push(`Source Review ${row.interview_note_id} lacks a body-pinned live Issue snapshot`);
      else if (sha256Text(live.body || '') !== receipt.interview_body_sha256) errors.push(`Source Review ${row.interview_note_id} InterviewNote body SHA drifted`);
    }
  }
  return { byInterview, evidence_requests: requests };
}

function validateContextReports(reports, rows, liveIssues, errors) {
  const contexts = new Map();
  for (const report of reports || []) {
    const items = Array.isArray(report) ? report : report && (report.items || report.results);
    if (!Array.isArray(items)) { errors.push('context report must contain items'); continue; }
    for (const item of items) {
      const number = Number(item.issue_number);
      if (contexts.has(number)) errors.push(`duplicate Context projection for InterviewNote #${number}`);
      contexts.set(number, item);
    }
  }
  const targets = [...rows];
  for (const item of contexts.values()) {
    if (!targets.some((row) => Number(row.interview_issue_number) === Number(item.issue_number))) {
      targets.push({ interview_issue_number: Number(item.issue_number), interview_note_id: item.context && item.context.interview_note_id });
    }
  }
  for (const row of targets) {
    const item = contexts.get(row.interview_issue_number);
    if (!item) continue;
    if (item.expected_body_sha256 && !HEX64.test(item.expected_body_sha256)) errors.push(`Context #${row.interview_issue_number} expected_body_sha256 is invalid`);
    if (item.context && !validateInterviewContext(item.context).ok) errors.push(`Context #${row.interview_issue_number} failed InterviewContext validation`);
    if (item.context && item.context.interview_note_id !== row.interview_note_id) errors.push(`Context #${row.interview_issue_number} identity mismatch`);
    if (Object.prototype.hasOwnProperty.call(item, 'body') || Object.prototype.hasOwnProperty.call(item, 'next_body')) errors.push(`Context #${row.interview_issue_number} attempts to mutate Raw InterviewNote body`);
    const issue = liveIssues.get(row.interview_issue_number) || item.live_issue;
    if (!issue) { errors.push(`Context #${row.interview_issue_number} lacks body-pinned live Issue snapshot`); continue; }
    const bodySha = sha256Text(issue.body || '');
    if (item.expected_body_sha256 && bodySha !== item.expected_body_sha256) errors.push(`Context #${row.interview_issue_number} live body SHA drifted`);
    const validation = validateInterviewNoteIssue({ body: issue.body, labels: labelsOf(issue), state: String(issue.state || 'open').toLowerCase() });
    if (!validation.ok) errors.push(...validation.errors.map((error) => `Context #${row.interview_issue_number}: ${error}`));
    const parsed = parseInterviewNoteIssue(issue.body || '');
    if (parsed.record && item.context && parsed.record.source_revision && parsed.record.source_revision.id !== item.context.source_revision_id) errors.push(`Context #${row.interview_issue_number} SourceRevision mismatch`);
      if (item.context && parsed.record) {
      const discovery = buildLearningDiscovery(item.context, parsed.record.source_published_at);
      if (!discovery.ok) errors.push(...discovery.errors.map((error) => `Context #${row.interview_issue_number}: ${error}`));
      else {
        if (item.title && item.title !== discovery.non_spoiler_title) errors.push(`Context #${row.interview_issue_number} title is not reproducible`);
        const preserved = labelsOf(issue).filter((label) => !/^(company:|role:|recruitment:|round:|source-year:|interview-year:)/.test(label));
        const expectedLabels = [...new Set([...preserved, ...discovery.learning_labels])].sort();
        if (item.labels && JSON.stringify([...item.labels].sort()) !== JSON.stringify(expectedLabels)) errors.push(`Context #${row.interview_issue_number} labels are not reproducible`);
      }
    }
  }
  return contexts;
}

function planAggregate({ manifest, boundaryReports, recoveryReport, materializationReports, sourceReviewReceipts, contextReports, existingContextReports, liveIssues = new Map(), pendingInventorySnapshot = null, pendingInventoryOwnership = null } = {}) {
  const errors = [];
  const manifestValidation = validateManifest(manifest);
  errors.push(...manifestValidation.errors);
  if (!manifestValidation.ok) return blockedPlan(manifest, errors);
  if (manifest.pending_inventory_snapshot) {
    if (!pendingInventorySnapshot || !pendingInventoryOwnership) errors.push('parent pending inventory snapshot and ownership index are required dependencies');
    else {
      const inventory = validateSnapshot(pendingInventorySnapshot, pendingInventoryOwnership);
      errors.push(...inventory.errors.map((error) => `pending inventory: ${error}`));
      if (pendingInventorySnapshot.canonical_digest !== manifest.expected_pending_inventory_digest) errors.push('pending inventory snapshot digest differs from manifest pin');
      if (pendingInventoryOwnership.canonical_digest !== manifest.expected_pending_ownership_digest) errors.push('pending inventory ownership digest differs from manifest pin');
    }
  }
  const boundary = validateBoundaryReports(manifest, boundaryReports || {});
  errors.push(...boundary.errors);
  const rows = materializationRows(materializationReports || [], manifest, errors);
  const recovery = validateRecovery(recoveryReport, manifest, errors);
  const boundaryBySourceIssue = new Map(boundary.items.map((item) => [Number(item.issue_number), item]));
  const boundaryIds = new Set(boundary.items.flatMap((item) => item.interview_note_ids || []));
  const materializedIds = new Set(rows.map((row) => row.interview_note_id));
  for (const id of boundaryIds) if (!materializedIds.has(id)) errors.push(`boundary-declared InterviewNote ${id} has no converged materialization row`);
  for (const row of rows) {
    const boundaryItem = boundaryBySourceIssue.get(row.source_note_issue_number);
    if (row.source_note_issue_number >= 20 && row.source_note_issue_number <= 1508 && !boundaryItem) errors.push(`materialized SourceNote #${row.source_note_issue_number} is absent from the frozen boundary selection`);
    if (boundaryItem && row.source_note_body_sha256 !== boundaryItem.current_body_sha256) errors.push(`SourceNote #${row.source_note_issue_number} materialization body SHA differs from the frozen boundary receipt`);
    if (boundaryItem && row.source_note_id !== boundaryItem.source_note_id) errors.push(`SourceNote #${row.source_note_issue_number} materialization identity differs from the frozen boundary receipt`);
    if (row.boundary_status === 'not-interview') errors.push(`not-interview SourceNote #${row.source_note_issue_number} was materialized`);
    if (boundaryItem && !boundaryItem.interview_note_ids.includes(row.interview_note_id)) errors.push(`InterviewNote ${row.interview_note_id} is not declared by its boundary receipt`);
  }
  const review = validateSourceReviewReceipts(sourceReviewReceipts, rows, errors, liveIssues);
  const contexts = validateContextReports(contextReports, rows, liveIssues, errors);
  const existingContexts = validateContextReports(existingContextReports || [], [], liveIssues, errors);
  const expectedExisting = manifest.existing_source_ready_issue_numbers;
  const actualExisting = [...existingContexts.keys()].sort((a, b) => a - b);
  if (JSON.stringify(actualExisting) !== JSON.stringify([...expectedExisting].sort((a, b) => a - b))) errors.push('audited existing source-ready Context inventory does not equal the frozen 50-item inventory');
  for (const item of existingContexts.values()) {
    if (item.action && item.action !== 'already_applied') errors.push(`existing source-ready Context #${item.issue_number} is not already_applied`);
    if (item.existing_source_ready !== true) errors.push(`existing source-ready Context #${item.issue_number} is missing existing_source_ready=true audit marker`);
  }
  const sourceReady = rows.filter((row) => review.byInterview.get(row.interview_note_id)?.final_status === 'source-ready');
  const blocked = rows.filter((row) => review.byInterview.get(row.interview_note_id)?.final_status === 'blocked');
  for (const row of sourceReady) if (!contexts.has(row.interview_issue_number)) errors.push(`source-ready InterviewNote #${row.interview_issue_number} has no reviewed Context projection`);
  const selection = rows.map((row) => ({
    ...row,
    source_review: review.byInterview.get(row.interview_note_id) || null,
    context: contexts.get(row.interview_issue_number) || null,
    raw_body_mutation: false,
  })).concat([...existingContexts.values()].map((item) => ({
    kind: 'existing-source-ready-audit',
    interview_issue_number: Number(item.issue_number),
    interview_note_id: item.context && item.context.interview_note_id,
    source_note_body_sha256: item.expected_body_sha256 || null,
    source_review: { final_status: 'source-ready', existing_source_ready_audit: true },
    context: item,
    raw_body_mutation: false,
  })));
  const planWithoutDigest = {
    schema_version: PLAN_SCHEMA_VERSION,
    aggregate_id: manifest.aggregate_id,
    repository: manifest.repository,
    source_repository: manifest.source_repository,
    source_ref: manifest.source_ref,
    parent_issue: manifest.parent_issue,
    issue_number: manifest.issue_number,
    dry_run: true,
    mutation_performed: false,
    blocked: errors.length > 0,
    errors,
    summary: {
      materialized: rows.length,
      source_ready: sourceReady.length + existingContexts.size,
      source_review_blocked: blocked.length,
      source_review_pending: review.evidence_requests.length,
      context_ready: contexts.size + existingContexts.size,
      mutation_count: errors.length > 0 ? 0 : sourceReady.length,
      pending_inventory: manifest.pending_inventory_snapshot ? {
        count: pendingInventorySnapshot && pendingInventorySnapshot.count || 0,
        canonical_digest: pendingInventorySnapshot && pendingInventorySnapshot.canonical_digest || null,
        ownership_digest: pendingInventoryOwnership && pendingInventoryOwnership.canonical_digest || null,
      } : null,
    },
    selection,
    independent_source_review_evidence_requests: review.evidence_requests,
    journals: { required: true, schema_version: 'aggregate-downstream-journal.v1', mutation_order: 'source-review-receipt-observed -> context-metadata-patch -> context-receipt -> post-read-audit' },
    receipts: { source_review: 'independent receipt required per materialized InterviewNote', context: 'one receipt per metadata projection', raw_body: 'none' },
    post_apply_audit: ['no pending mutation', 'no duplicate ownership', 'all artifacts pinned', 'all required labels exist', 'Raw InterviewNote body SHA unchanged', 'Outcome remains sealed'],
  };
  return { ok: errors.length === 0, plan: { ...planWithoutDigest, canonical_digest: canonicalDigest(planWithoutDigest) }, selection, errors };
}

function blockedPlan(manifest, errors) {
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    aggregate_id: manifest && manifest.aggregate_id || null,
    repository: manifest && manifest.repository || null,
    source_ref: manifest && manifest.source_ref || null,
    dry_run: true,
    mutation_performed: false,
    blocked: true,
    errors,
    summary: { materialized: 0, source_ready: 0, source_review_blocked: 0, source_review_pending: 0, context_ready: 0, mutation_count: 0 },
    selection: [],
    independent_source_review_evidence_requests: [],
    journals: { required: true, schema_version: 'aggregate-downstream-journal.v1', mutation_order: null },
    receipts: { source_review: 'not available', context: 'not available', raw_body: 'none' },
    post_apply_audit: [],
  };
  return { ok: false, plan: { ...plan, canonical_digest: canonicalDigest(plan) }, selection: [], errors };
}

function validateAuthorization(auth, planDigest, manifest) {
  const errors = [];
  if (!auth || auth.schema_version !== 'aggregate-downstream-apply-authorization.v1') errors.push('authorization schema is required');
  if (!auth || auth.aggregate_id !== manifest.aggregate_id || auth.issue_number !== 1611 || auth.parent_issue !== 1605) errors.push('authorization scope does not match #1611/#1605');
  if (!auth || auth.plan_digest !== planDigest || !HEX64.test(auth.plan_digest || '')) errors.push('authorization plan digest does not match');
  if (!auth || auth.allow_live_github !== true) errors.push('authorization must explicitly allow live GitHub');
  if (!auth || !nonEmpty(auth.authorized_by)) errors.push('authorization authorized_by is required');
  return { ok: errors.length === 0, errors };
}

function applyPlan(plan, options = {}) {
  if (!plan || plan.blocked || plan.mutation_performed || !Array.isArray(plan.selection)) throw new Error('blocked or malformed aggregate plan cannot be applied');
  if (typeof options.patchIssueMetadata !== 'function' || typeof options.postComment !== 'function') throw new Error('apply requires injected metadata/comment mutation adapters');
  const results = [];
  for (const item of plan.selection) {
    if (!item.context || !item.source_review || item.source_review.final_status !== 'source-ready') continue;
    if (item.kind === 'existing-source-ready-audit' && item.context.action === 'already_applied') continue;
    if (item.raw_body_mutation !== false) throw new Error(`Issue #${item.interview_issue_number} Raw mutation flag is not false`);
    const projection = item.context;
    const patch = { title: item.context.title, labels: item.context.labels };
    if (typeof patch.title !== 'string' || !Array.isArray(patch.labels)) throw new Error(`Issue #${item.interview_issue_number} has no explicit metadata projection`);
    options.patchIssueMetadata(item.interview_issue_number, patch);
    const receipt = { schema_version: RECEIPT_SCHEMA_VERSION, aggregate_id: plan.aggregate_id, issue_number: item.interview_issue_number, expected_body_sha256: item.context.expected_body_sha256, source_review_receipt: item.source_review, title: patch.title, labels: patch.labels, raw_body_mutation: false };
    const commentId = options.postComment(item.interview_issue_number, `<!-- aggregate-downstream-receipt\n${JSON.stringify(receipt, null, 2)}\n-->`);
    results.push({ issue_number: item.interview_issue_number, comment_id: commentId || null, mutation: 'metadata-only' });
  }
  return { schema_version: 'aggregate-downstream-apply-result.v1', aggregate_id: plan.aggregate_id, mutation_performed: results.length > 0, results };
}

module.exports = {
  SCHEMA_VERSION, PLAN_SCHEMA_VERSION, SOURCE_REF, BOUNDARY_BATCHES, REQUIRED_DEPENDENCIES, EXISTING_SOURCE_READY_ISSUES,
  RECEIPT_SCHEMA_VERSION, UPSTREAM_DIGEST_RULES, sha256Text, canonicalize, canonicalDigest, upstreamDigest, jsonDigest, without,
  validateManifest, validateUpstreamReport, validateBoundaryReports, materializationRows,
  validateRecovery, independentEvidenceRequest, validateSourceReviewReceipts,
  validateContextReports, planAggregate, validateAuthorization, applyPlan,
};
