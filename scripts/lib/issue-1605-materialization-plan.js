'use strict';

const {
  buildMaterializationRequest,
  labelsOf,
  issueSourceRecord,
} = require('./interview-note-materialization-batch');
const {
  findOwnershipMatches,
  planMaterialization,
  sha256Text,
  canonicalJson,
} = require('./source-note-interview-materialization');
const { canonicalDigest } = require('./aggregate-downstream-pipeline');
const {
  childInterviewNoteId,
  CHILD_CASE_KEY_RE,
} = require('./interview-note-identity');

const SCHEMA_VERSION = 'issue-1605-interview-note-materialization-plan.v1';
const BOUNDARY_REPORT_SCHEMA = 'issue-1605-boundary-transition-report.v1';
const BOUNDARY_MANIFEST_SCHEMA = 'source-note-boundary-review-batch.v1';
const LIVE_BOUNDARY_MANIFEST_SCHEMA = 'issue-1605-live-boundary-materialization-manifest.v1';
const LIVE_BOUNDARY_REPORT_SCHEMA = 'issue-1605-live-boundary-materialization-report.v1';
const SUPPORTED_BOUNDARY_REPORT_SCHEMAS = new Set([
  BOUNDARY_REPORT_SCHEMA,
  'source-note-boundary-review-batch.v1',
  'issue-1606-boundary-dry-run.v1',
  'issue-1607-boundary-dry-run-plan.v1',
  'issue-1608-boundary-dry-run.v1',
  'issue-1609-boundary-dry-run.v1',
  LIVE_BOUNDARY_REPORT_SCHEMA,
]);
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const BOUNDARY_MANIFEST_PLAN_DIGEST = 'ad3e3974c21415e2371b8fe77a2ae54b65dd7783516ed6a68ef61bb070877781';
const BOUNDARY_MANIFEST_CANONICAL_DIGEST = '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a';
const BOUNDARY_MANIFEST_CANDIDATE_COUNT = 419;
const BOUNDARY_EVIDENCE_MARKER = 'source-note-boundary-review-evidence';
const HEX64 = /^[0-9a-f]{64}$/;
const LIVE_COMPLETION_PROOF = Object.freeze({
  issue_number: 1605,
  comment_id: 5596370635,
  plan_digest: 'f6c38fe75f3d83c40f24222b049890e03431e98cd339e928af0f22bcc9ac5ee2',
  manifest_digest: 'fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9',
});

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function canonicalSourceLabels(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(nonEmpty))].sort();
}

function transitionApplied(item) {
  return item && (
    item.transition_status === 'already_applied'
    || item.transition_status === 'applied'
    || item.status === 'already_applied'
    || item.status === 'applied'
    || item.receipt_state === 'applied'
    || item.receipt_state === 'already_applied'
  );
}

function reportDigest(report) {
  const field = ['report_sha256', 'dry_run_sha256', 'plan_sha256'].find((key) => HEX64.test(String(report && report[key] || '')));
  if (!field) return { ok: false, errors: ['boundary transition report has no supported SHA-256 digest'] };
  const copy = { ...report };
  delete copy[field];
  return { ok: true, field, expected: report[field], actual: sha256Text(canonicalJson(copy)) };
}

function boundaryManifestDigest(manifest) {
  const copy = { ...manifest };
  delete copy.canonical_digest;
  return sha256Text(canonicalJson(copy));
}

function liveSourceSnapshotDigest(sourceIssues) {
  return canonicalDigest((sourceIssues || []).map((issue) => {
    const { parsed } = issueSourceRecord(issue);
    const record = parsed || {};
    return {
      issue_number: Number(issue && issue.number),
      body_sha256: sha256Text(issue && issue.body || ''),
      source_note_id: record.source_note_id || null,
      source_revision_id: record.source_revision && record.source_revision.id || null,
      source_repository_ref: record.source_revision && record.source_revision.source_repository_ref || null,
      boundary_status: record.boundary_review && record.boundary_review.status || null,
      labels: canonicalSourceLabels(issue),
    };
  }).sort((left, right) => left.issue_number - right.issue_number));
}

function validateLiveManifestBindings(manifest, reports, sourceIssues, sourceSnapshot) {
  const errors = [];
  if (!manifest || manifest.schema_version !== LIVE_BOUNDARY_MANIFEST_SCHEMA) return { ok: true, errors };

  for (const field of ['issue_number', 'comment_id', 'plan_digest', 'manifest_digest']) {
    if (manifest.completion_proof?.[field] !== LIVE_COMPLETION_PROOF[field]) {
      errors.push(`live boundary manifest completion_proof.${field} is not the pinned online #1605 completion proof`);
    }
  }

  const liveReports = (reports || []).filter((report) => report && report.schema_version === LIVE_BOUNDARY_REPORT_SCHEMA);
  if (liveReports.length !== 1) {
    errors.push(`live boundary manifest requires exactly one ${LIVE_BOUNDARY_REPORT_SCHEMA} input (got ${liveReports.length})`);
  } else {
    const report = liveReports[0];
    const digest = reportDigest(report);
    if (!digest.ok) errors.push(...digest.errors.map((error) => `live boundary report binding: ${error}`));
    else if (manifest.boundary_report_digest !== digest.actual) errors.push('live boundary manifest boundary_report_digest does not equal the actual boundary report digest');
    if (report.source_snapshot_digest !== manifest.source_snapshot_digest) errors.push('live boundary report source_snapshot_digest does not equal the live boundary manifest source_snapshot_digest');
    for (const field of ['issue_number', 'comment_id', 'plan_digest', 'manifest_digest']) {
      if (report.completion_proof?.[field] != null && report.completion_proof[field] !== manifest.completion_proof?.[field]) {
        errors.push(`live boundary report completion_proof.${field} does not equal the manifest's pinned online #1605 completion proof`);
      }
    }
  }

  const actualSourceDigest = liveSourceSnapshotDigest(sourceIssues);
  if (manifest.source_snapshot_digest !== actualSourceDigest) errors.push('live boundary manifest source_snapshot_digest does not equal the actual source snapshot digest');
  if (sourceSnapshot && sourceSnapshot.digest != null && sourceSnapshot.digest !== actualSourceDigest) errors.push('planner sourceSnapshot.digest does not equal the actual source snapshot digest');
  if (sourceSnapshot && sourceSnapshot.digest != null && manifest.source_snapshot_digest !== sourceSnapshot.digest) errors.push('live boundary manifest source_snapshot_digest does not equal planner sourceSnapshot.digest');
  return { ok: errors.length === 0, errors };
}

function validateBoundaryManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['complete boundary authorization manifest is required'] };
  const liveManifest = manifest.schema_version === LIVE_BOUNDARY_MANIFEST_SCHEMA;
  if (manifest.schema_version !== BOUNDARY_MANIFEST_SCHEMA && !liveManifest) errors.push(`boundary authorization manifest schema must be ${BOUNDARY_MANIFEST_SCHEMA} or ${LIVE_BOUNDARY_MANIFEST_SCHEMA}`);
  if (manifest.repository !== 'liqiangcc/interview-lab') errors.push('boundary authorization manifest repository must be liqiangcc/interview-lab');
  if (manifest.parent_issue !== 1605) errors.push('boundary authorization manifest parent_issue must be 1605');
  if (manifest.source_snapshot?.repository !== SOURCE_REPOSITORY || manifest.source_snapshot?.ref !== SOURCE_REF) errors.push('boundary authorization manifest source snapshot is not pinned to the fixed source');
  if (!liveManifest) {
    if (manifest.plan_digest !== BOUNDARY_MANIFEST_PLAN_DIGEST) errors.push(`boundary authorization manifest plan_digest must be ${BOUNDARY_MANIFEST_PLAN_DIGEST}`);
    if (!Array.isArray(manifest.items) || manifest.items.length !== BOUNDARY_MANIFEST_CANDIDATE_COUNT) errors.push(`boundary authorization manifest must contain exactly ${BOUNDARY_MANIFEST_CANDIDATE_COUNT} candidate rows`);
    if (manifest.canonical_digest !== BOUNDARY_MANIFEST_CANONICAL_DIGEST) errors.push(`boundary authorization manifest canonical_digest must be ${BOUNDARY_MANIFEST_CANONICAL_DIGEST}`);
    else if (boundaryManifestDigest(manifest) !== manifest.canonical_digest) errors.push('boundary authorization manifest canonical_digest does not match canonical content');
  } else {
    if (manifest.coverage !== 'all-live-type-source-note-issues') errors.push('live boundary manifest must declare all-live-type-source-note-issues coverage');
    if (!Number.isSafeInteger(manifest.total) || manifest.total < 1) errors.push('live boundary manifest total must be a positive integer');
    if (!Array.isArray(manifest.items) || manifest.items.length !== manifest.total) errors.push('live boundary manifest total must match items length');
    if (!HEX64.test(String(manifest.source_snapshot_digest || ''))) errors.push('live boundary manifest source_snapshot_digest must be a SHA-256');
    if (!HEX64.test(String(manifest.completion_proof?.plan_digest || ''))) errors.push('live boundary manifest completion proof plan_digest is required');
    if (!HEX64.test(String(manifest.boundary_report_digest || ''))) errors.push('live boundary manifest boundary_report_digest must be a SHA-256');
    if (!HEX64.test(String(manifest.canonical_digest || ''))) errors.push('live boundary manifest canonical_digest is required');
    else if (boundaryManifestDigest(manifest) !== manifest.canonical_digest) errors.push('live boundary manifest canonical_digest does not match canonical content');
    for (const field of ['issue_number', 'comment_id', 'plan_digest', 'manifest_digest']) {
      if (manifest.completion_proof?.[field] !== LIVE_COMPLETION_PROOF[field]) errors.push(`live boundary manifest completion_proof.${field} is not the pinned online #1605 completion proof`);
    }
  }
  const issues = new Set();
  const transitions = new Set();
  for (const [index, item] of (manifest.items || []).entries()) {
    const issue = Number(item && item.issue_number);
    if (!Number.isSafeInteger(issue) || issue < 1) errors.push(`boundary authorization manifest item ${index} has invalid issue_number`);
    if (issues.has(issue)) errors.push(`boundary authorization manifest contains duplicate Issue #${issue}`);
    issues.add(issue);
    if (!liveManifest && !nonEmpty(item && item.transition_id)) errors.push(`boundary authorization manifest item ${index} has no transition_id`);
    if (item && item.transition_id != null) {
      if (transitions.has(item.transition_id)) errors.push(`boundary authorization manifest contains duplicate transition_id ${item.transition_id}`);
      transitions.add(item.transition_id);
    }
    if (!liveManifest && !nonEmpty(item && item.request_file)) errors.push(`boundary authorization manifest item ${index} has no request_file`);
  }
  return { ok: errors.length === 0, errors, issues, transitions, digest: manifest && manifest.canonical_digest || null };
}

function validateCompleteReportScope(reportItems, manifest) {
  const errors = [];
  const expected = new Map((manifest.items || []).map((item) => [Number(item.issue_number), item.transition_id]));
  const seen = new Set();
  for (const item of reportItems) {
    const issue = Number(item.source_note_issue_number);
    if (seen.has(issue)) continue;
    seen.add(issue);
    if (!expected.has(issue)) errors.push(`boundary transition report contains Issue #${issue} outside the authorized 419-row manifest`);
    else if (expected.get(issue) !== item.transition_id) errors.push(`Issue #${issue} transition_id is not the authorized manifest transition`);
  }
  for (const [issue, transition] of expected.entries()) {
    const item = reportItems.find((candidate) => Number(candidate.source_note_issue_number) === issue);
    if (!item) errors.push(`boundary transition report is partial: authorized Issue #${issue} (${transition}) is missing`);
  }
  const expectedCount = manifest.schema_version === LIVE_BOUNDARY_MANIFEST_SCHEMA ? manifest.total : BOUNDARY_MANIFEST_CANDIDATE_COUNT;
  if (reportItems.length !== expectedCount) errors.push(`boundary transition report must contain exactly ${expectedCount} authorized candidate rows`);
  return { ok: errors.length === 0, errors };
}

function evidenceMarkerValues(body) {
  const matches = [...String(body || '').matchAll(new RegExp(`<!-- ${BOUNDARY_EVIDENCE_MARKER}\\n([\\s\\S]*?)\\n-->`, 'g'))];
  const errors = [];
  if (matches.length !== 1) return { values: [], errors: [`comment must contain exactly one exact ${BOUNDARY_EVIDENCE_MARKER} machine marker`] };
  try { return { values: [JSON.parse(matches[0][1])], errors }; }
  catch (error) { return { values: [], errors: [`${BOUNDARY_EVIDENCE_MARKER} marker must contain valid JSON: ${error.message}`] }; }
}

const REQUIRED_BOUNDARY_CHECKS = ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'];

function issue1608EvidenceValue(body) {
  const matches = [...String(body || '').matchAll(/<!--\s*issue-1608-boundary-evidence\.v1\n([\s\S]*?)\n-->/g)];
  if (matches.length !== 1) return { value: null, errors: ['issue-1608 evidence marker must occur exactly once'] };
  try { return { value: JSON.parse(matches[0][1].trim()), errors: [] }; }
  catch (error) { return { value: null, errors: [`issue-1608 evidence JSON is invalid: ${error.message}`] }; }
}

function validateIssue1608BoundaryEvidenceValue(value, expected) {
  // issue-1608 evidence was posted before the separate boundary transition.
  // Accept only its complete nested transition request and live binding; this
  // adapter does not infer or repair the later applied receipt.
  const errors = [];
  const issueNumber = Number(expected && expected.source_note_issue_number);
  const evidenceBodySha = expected && (expected.evidence_body_sha256 || expected.source_note_body_sha256);
  const equal = (field, actual, wanted) => { if (actual !== wanted) errors.push(`SourceNote #${issueNumber} issue-1608 evidence ${field} binding mismatch`); };
  if (!value || typeof value !== 'object') return { ok: false, errors: [`SourceNote #${issueNumber} issue-1608 evidence payload is missing`] };
  equal('schema_version', value.schema_version, 'issue-1608-boundary-evidence.v1');
  equal('issue_number', value.issue_number, issueNumber);
  equal('source_note_id', value.source_note_id, expected.source_note_id);
  equal('source_revision_id', value.source_revision_id, expected.source_revision_id);
  equal('source_repository', value.source_repository, 'liqiangcc/xhs');
  equal('source_repository_ref', value.source_repository_ref, SOURCE_REF);
  equal('evidence_status', value.evidence_status, 'sufficient-for-controller-review');
  equal('decision', value.decision, expected.decision);
  const request = value.transition_request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    errors.push(`SourceNote #${issueNumber} issue-1608 evidence transition_request is missing`);
  } else {
    equal('transition_request.schema_version', request.schema_version, 'source-note-boundary-review-transition.v1');
    equal('transition_request.transition_id', request.transition_id, expected.transition_id);
    equal('transition_request.repository', request.repository, 'liqiangcc/interview-lab');
    equal('transition_request.issue_number', request.issue_number, issueNumber);
    equal('transition_request.source_note_id', request.source_note_id, expected.source_note_id);
    equal('transition_request.expected_body_sha256', request.expected_body_sha256, evidenceBodySha);
    equal('transition_request.expected_boundary_status', request.expected_boundary_status, 'pending');
    equal('transition_request.expected_source_revision_id', request.expected_source_revision_id, expected.source_revision_id);
    equal('transition_request.expected_source_repository_ref', request.expected_source_repository_ref, SOURCE_REF);
    equal('transition_request.decision', request.decision, expected.decision);
    const binding = request.live_binding;
    if (!binding || typeof binding !== 'object') errors.push(`SourceNote #${issueNumber} issue-1608 evidence live_binding is missing`);
    else {
      equal('live_binding.issue_number', binding.issue_number, issueNumber);
      equal('live_binding.body_sha256', binding.body_sha256, evidenceBodySha);
      equal('live_binding.source_note_id', binding.source_note_id, expected.source_note_id);
      equal('live_binding.source_revision_id', binding.source_revision_id, expected.source_revision_id);
      equal('live_binding.source_repository', binding.source_repository, 'liqiangcc/xhs');
      equal('live_binding.source_repository_ref', binding.source_repository_ref, SOURCE_REF);
      const projection = request.source_projection;
      const artifact = value.artifact;
      if (!projection || typeof projection !== 'object' || !artifact || typeof artifact !== 'object') {
        errors.push(`SourceNote #${issueNumber} issue-1608 evidence source projection/artifact is missing`);
      } else {
        for (const field of ['ref', 'kind', 'provenance', 'byte_size']) equal(`artifact.${field}`, artifact[field], projection[field]);
        equal('artifact.git_blob_sha', artifact.git_blob_sha, projection.blob_sha);
        equal('artifact.content_sha256', artifact.content_sha256, projection.content_sha256);
        equal('live_binding.source_projection_ref', binding.source_projection_ref, projection.ref);
        equal('live_binding.source_projection_blob_sha', binding.source_projection_blob_sha, projection.blob_sha);
        equal('live_binding.source_projection_content_sha256', binding.source_projection_content_sha256, projection.content_sha256);
      }
    }
  }
  if (!Array.isArray(value.checks)) errors.push(`SourceNote #${issueNumber} issue-1608 evidence checks are missing`);
  else for (const checkId of REQUIRED_BOUNDARY_CHECKS) {
    const check = value.checks.find((candidate) => candidate && candidate.check_id === checkId);
    if (!check || check.result !== 'pass') errors.push(`SourceNote #${issueNumber} issue-1608 evidence check ${checkId} is not pass`);
  }
  if (!Array.isArray(value.excerpts) || value.excerpts.length === 0) errors.push(`SourceNote #${issueNumber} issue-1608 evidence excerpts are missing`);
  return { ok: errors.length === 0, errors, value };
}

function validateLiveBoundaryEvidenceComment(comment, expected, sourceIssue) {
  const errors = [];
  const issueNumber = Number(expected && expected.source_note_issue_number);
  const expectedCommentId = Number(expected && expected.evidence_comment_id);
  if (!Number.isSafeInteger(expectedCommentId) || expectedCommentId < 1) errors.push(`SourceNote #${issueNumber} transition-applied candidate has no evidence comment id`);
  if (Number(comment && (comment.id || comment.comment_id)) !== expectedCommentId) errors.push(`SourceNote #${issueNumber} live evidence comment id is not ${expectedCommentId}`);
  const expectedApiUrl = `https://api.github.com/repos/liqiangcc/interview-lab/issues/${issueNumber}`;
  if (comment && comment.issue_url !== expectedApiUrl) errors.push(`SourceNote #${issueNumber} evidence comment issue_url is not bound to the exact repository/issue`);
  if (expected && expected.evidence_schema === 'issue-1608-boundary-evidence.v1') {
    const parsed = issue1608EvidenceValue(comment && comment.body);
    const validation = validateIssue1608BoundaryEvidenceValue(parsed.value, expected);
    return { ok: errors.length === 0 && validation.ok, errors: [...errors, ...parsed.errors, ...validation.errors], value: parsed.value };
  }
  if (expected && expected.evidence_schema === 'issue-921-pilot-evidence') {
    const matches = [...String(comment && comment.body || '').matchAll(/<!-- issue-921-pilot-evidence\n([\s\S]*?)\n-->/g)];
    if (matches.length !== 1) return { ok: false, errors: [...errors, `SourceNote #${issueNumber} legacy evidence marker must occur exactly once`] };
    let value;
    try { value = JSON.parse(matches[0][1]); } catch (error) { return { ok: false, errors: [...errors, `SourceNote #${issueNumber} legacy evidence JSON is invalid: ${error.message}`] }; }
    const equal = (field, actual, wanted) => { if (actual !== wanted) errors.push(`SourceNote #${issueNumber} legacy evidence ${field} binding mismatch`); };
    equal('transition_id', value.transition_id, expected.transition_id);
    equal('issue_number', value.issue_number, issueNumber);
    equal('source_note_id', value.source_note_id, expected.source_note_id);
    const sourceRevision = String(comment && comment.body || '').match(/(?:^|\n)source_revision_id:\s*([^\n]+)/);
    const sourceRef = String(comment && comment.body || '').match(/(?:^|\n)source_repository_ref:\s*([^\n]+)/);
    equal('source_revision_id', sourceRevision && sourceRevision[1].trim(), expected.source_revision_id);
    equal('source_repository_ref', sourceRef && sourceRef[1].trim(), SOURCE_REF);
    equal('decision', String(comment && comment.body || '').match(/(?:^|\n)recommended_decision:\s*([^\n]+)/)?.[1]?.trim(), expected.decision);
    for (const checkId of REQUIRED_BOUNDARY_CHECKS) {
      const check = (value.checks || []).find((candidate) => candidate && candidate.check_id === checkId);
      if (!check || check.result !== 'pass') errors.push(`SourceNote #${issueNumber} legacy evidence check ${checkId} is not pass`);
    }
    return { ok: errors.length === 0, errors, value };
  }
  if (expected && expected.evidence_schema === 'boundary-review-evidence.v1') {
    const matches = [...String(comment && comment.body || '').matchAll(/<!-- boundary-review-evidence\.v1\n([\s\S]*?)\n-->/g)];
    if (matches.length !== 1) return { ok: false, errors: [...errors, `SourceNote #${issueNumber} historical evidence marker must occur exactly once`] };
    let value;
    try { value = JSON.parse(matches[0][1]); } catch (error) { return { ok: false, errors: [...errors, `SourceNote #${issueNumber} historical evidence JSON is invalid: ${error.message}`] }; }
    const equal = (field, actual, wanted) => { if (actual !== wanted) errors.push(`SourceNote #${issueNumber} historical evidence ${field} binding mismatch`); };
    equal('schema_version', value.schema_version, 'boundary-review-evidence.v1');
    equal('repository', value.repository, 'liqiangcc/interview-lab');
    equal('issue_number', value.issue_number, issueNumber);
    equal('source_note_issue_number', value.source_note_issue_number, issueNumber);
    equal('source_note_id', value.source_note_id, expected.source_note_id);
    equal('transition_id', value.transition_id, expected.transition_id);
    equal('expected_body_sha256', value.expected_body_sha256, expected.evidence_body_sha256 || expected.source_note_body_sha256);
    equal('expected_source_revision_id', value.expected_source_revision_id, expected.source_revision_id);
    equal('expected_source_repository_ref', value.expected_source_repository_ref, SOURCE_REF);
    equal('decision', value.decision, expected.decision);
    for (const checkId of REQUIRED_BOUNDARY_CHECKS) {
      const check = (value.checks || []).find((candidate) => candidate && candidate.check_id === checkId);
      if (!check || check.result !== 'pass') errors.push(`SourceNote #${issueNumber} historical evidence check ${checkId} is not pass`);
    }
    return { ok: errors.length === 0, errors, value };
  }
  const marker = evidenceMarkerValues(comment && comment.body);
  errors.push(...marker.errors);
  const value = marker.values[0];
  if (!value) return { ok: false, errors, value: null };
  const equal = (field, actual, wanted) => { if (actual !== wanted) errors.push(`SourceNote #${issueNumber} evidence ${field} binding mismatch`); };
  equal('schema_version', value.schema_version, 'source-note-boundary-review-evidence.v1');
  equal('repository', value.repository, 'liqiangcc/interview-lab');
  equal('parent_issue', value.parent_issue, 1605);
  equal('issue_number', value.issue_number, issueNumber);
  equal('transition_id', value.transition_id, expected.transition_id);
  equal('source_note_id', value.source_note_id, expected.source_note_id);
  const liveParsed = issueSourceRecord(sourceIssue).parsed;
  const liveRevision = liveParsed && liveParsed.source_revision && liveParsed.source_revision.id;
  equal('expected_body_sha256', value.expected_body_sha256, expected.evidence_body_sha256 || expected.source_note_body_sha256);
  equal('expected_source_revision_id', value.expected_source_revision_id, liveRevision);
  equal('expected_source_revision_id/report', value.expected_source_revision_id, expected.source_revision_id);
  equal('expected_source_repository_ref', value.expected_source_repository_ref, SOURCE_REF);
  equal('decision', value.decision, expected.decision);
  if (liveParsed && liveParsed.boundary_review) equal('decision/live', value.decision, liveParsed.boundary_review.status);
  if (!Array.isArray(value.checks) || value.checks.length === 0) errors.push(`SourceNote #${issueNumber} evidence checks are missing`);
  else for (const checkId of REQUIRED_BOUNDARY_CHECKS) {
    const check = value.checks.find((candidate) => candidate && candidate.check_id === checkId);
    if (!check || check.result !== 'pass') errors.push(`SourceNote #${issueNumber} evidence check ${checkId} is not pass`);
  }
  return { ok: errors.length === 0, errors, value };
}

function normalizeBoundaryReport(report, sourceRef = SOURCE_REF) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { ok: false, errors: ['boundary transition report must be an object'], items: [] };
  if (!SUPPORTED_BOUNDARY_REPORT_SCHEMAS.has(report.schema_version)) errors.push(`unsupported boundary transition report schema_version: ${report.schema_version || 'missing'}`);
  if (report.repository !== 'liqiangcc/interview-lab') errors.push('boundary transition report repository must be liqiangcc/interview-lab');
  if (report.parent_issue != null && report.parent_issue !== 1605) errors.push('boundary transition report parent_issue must be 1605');
  const reportSource = report.source_repository || report.source_snapshot && report.source_snapshot.repository;
  const reportRef = report.source_ref || report.source_repository_ref || report.source_snapshot && report.source_snapshot.ref;
  if (reportSource !== SOURCE_REPOSITORY) errors.push(`boundary transition report source_repository must be ${SOURCE_REPOSITORY}`);
  if (reportRef !== sourceRef) errors.push(`boundary transition report source_ref must be ${sourceRef}`);
  const digest = reportDigest(report);
  if (!digest.ok) errors.push(...digest.errors);
  else if (digest.expected !== digest.actual) errors.push(`boundary transition report ${digest.field} does not match its canonical content`);
  if (!Array.isArray(report.items) || report.items.length === 0) errors.push('boundary transition report items must be a non-empty array');
  const items = [];
  const seenNumbers = new Set();
  for (const raw of report.items || []) {
    const number = Number(raw && (raw.source_note_issue_number || raw.issue_number));
    const item = {
      source_note_issue_number: number,
      source_note_id: raw && (raw.source_note_id || raw.source_identity) || null,
      source_note_body_sha256: raw && (raw.source_note_body_sha256 || raw.current_body_sha256 || raw.body_sha256 || raw.expected_body_sha256 || raw.next_body_sha256) || null,
      evidence_body_sha256: raw && (raw.evidence_body_sha256 || raw.expected_body_sha256 || raw.previous_body_sha256 || raw.source_note_body_sha256 || raw.body_sha256) || null,
      live_source_note_body_sha256: raw && (raw.live_source_note_body_sha256 || raw.new_body_sha256 || raw.next_body_sha256 || raw.current_body_sha256 || raw.body_sha256 || raw.source_note_body_sha256 || raw.expected_body_sha256) || null,
      source_revision_id: raw && (raw.source_revision_id || raw.expected_source_revision_id) || null,
      decision: raw && (raw.decision || (raw.disposition === 'ready' ? 'single-interview' : raw.disposition)) || null,
      transition_id: raw && (raw.transition_id || raw.boundary_transition_id) || null,
      transition_status: raw && (raw.transition_status || raw.status || raw.receipt_state) || null,
      evidence_comment_id: raw && (raw.evidence_comment_id || raw.review_evidence_comment_id || raw.review_evidence && raw.review_evidence.comment_id) || null,
      evidence_schema: raw && raw.evidence_schema || null,
      interview_note_ids: Array.isArray(raw && raw.interview_note_ids) ? [...raw.interview_note_ids] : [],
      interview_note_cases: Array.isArray(raw && raw.interview_note_cases) ? raw.interview_note_cases : [],
    };
    if (!Number.isInteger(number) || number < 1) errors.push('boundary transition report contains an invalid SourceNote issue number');
    else if (seenNumbers.has(number)) errors.push(`boundary transition report contains duplicate SourceNote #${number}`);
    else seenNumbers.add(number);
    if (!nonEmpty(item.source_note_id)) errors.push(`boundary transition report SourceNote #${number} has no source_note_id`);
    if (!HEX64.test(String(item.source_note_body_sha256 || ''))) errors.push(`boundary transition report SourceNote #${number} has no body SHA-256`);
    if (!nonEmpty(item.source_revision_id)) errors.push(`boundary transition report SourceNote #${number} has no SourceRevision id`);
    if (transitionApplied(item) && !nonEmpty(item.transition_id)) errors.push(`applied boundary transition for SourceNote #${number} has no transition_id`);
    if (['pending', 'review-required', 'awaiting-live-evidence-comment'].includes(item.decision)) item.decision = 'blocked';
    if (!['not-interview', 'single-interview', 'multi-interview', 'blocked'].includes(item.decision)) errors.push(`boundary transition report SourceNote #${number} has unsupported decision`);
    if (item.interview_note_ids.some((id) => !nonEmpty(id))) errors.push(`boundary transition report SourceNote #${number} has an invalid InterviewNote identity`);
    if (new Set(item.interview_note_ids).size !== item.interview_note_ids.length) errors.push(`boundary transition report SourceNote #${number} repeats an InterviewNote identity`);
    items.push(item);
  }
  return { ok: errors.length === 0, errors, items, digest };
}

function sourceIssueMap(sourceIssues) {
  const map = new Map();
  const errors = [];
  for (const issue of sourceIssues || []) {
    const number = Number(issue && (issue.number || issue.issue_number));
    if (!Number.isInteger(number) || number < 1) { errors.push('live SourceNotes contain an invalid issue number'); continue; }
    if (map.has(number)) errors.push(`live SourceNotes contain duplicate Issue #${number}`);
    map.set(number, issue);
  }
  return { map, errors };
}

function derivedCases(sourceIssue, reportItem) {
  const { validation, parsed } = issueSourceRecord(sourceIssue);
  if (!validation.ok || !parsed) return { ok: false, errors: validation.errors, cases: [], parsed };
  const status = parsed.boundary_review && parsed.boundary_review.status;
  if (status === 'not-interview') return { ok: true, errors: [], cases: [{ case_key: null, interview_note_id: `${parsed.source.system}:${parsed.source.external_id}` }], parsed };
  if (status === 'single-interview') {
    try {
      buildMaterializationRequest(sourceIssue, 'liqiangcc/interview-lab');
      return { ok: true, errors: [], cases: [{ case_key: null, interview_note_id: `${parsed.source.system}:${parsed.source.external_id}` }], parsed };
    } catch (error) { return { ok: false, errors: [error.message], cases: [], parsed }; }
  }
  if (status !== 'multi-interview') return { ok: false, errors: [`live SourceNote boundary status is ${status || 'missing'}`], cases: [], parsed };
  const cases = [];
  for (const entry of parsed.boundary_review.interview_note_cases || []) {
    if (!entry || typeof entry.case_key !== 'string' || !CHILD_CASE_KEY_RE.test(entry.case_key)) {
      return { ok: false, errors: ['multi-interview contains an invalid case_key'], cases: [], parsed };
    }
    let interviewNoteId;
    try { interviewNoteId = childInterviewNoteId(parsed.source, entry.case_key); }
    catch (error) { return { ok: false, errors: [error.message], cases: [], parsed }; }
    if (entry.interview_note_id !== interviewNoteId) return { ok: false, errors: [`case_key ${entry.case_key} has a non-derived InterviewNote identity`], cases: [], parsed };
    cases.push({ case_key: entry.case_key, interview_note_id: interviewNoteId });
  }
  if (cases.length < 2) return { ok: false, errors: ['multi-interview requires at least two approved cases'], cases: [], parsed };
  return { ok: true, errors: [], cases, parsed };
}

function reportIdentitySet(item) {
  const ids = Array.isArray(item.interview_note_ids) ? item.interview_note_ids : [];
  const cases = Array.isArray(item.interview_note_cases) ? item.interview_note_cases : [];
  return sortedUnique([...ids, ...cases.map((entry) => entry && entry.interview_note_id).filter(nonEmpty)]);
}

function resultBase(reportItem) {
  return {
    source_note_issue_number: reportItem.source_note_issue_number,
    source_note_id: reportItem.source_note_id,
    transition_id: reportItem.transition_id,
    evidence_comment_id: reportItem.evidence_comment_id,
    boundary_decision: reportItem.decision,
    boundary_transition_status: reportItem.transition_status,
  };
}

function blockedResult(reportItem, reasonCode, errors, extra = {}) {
  return {
    ...resultBase(reportItem),
    ...extra,
    action: 'blocked',
    reason_code: reasonCode,
    errors: [...errors],
    mutation_performed: false,
  };
}

function publicProjection(materialization) {
  if (!materialization || !materialization.projection) return null;
  return {
    interview_note_id: materialization.projection.interview_note_id,
    projected_body_sha256: sha256Text(materialization.projection.body),
    projected_title: materialization.projection.title,
    projected_labels: materialization.projection.labels,
  };
}

function planIssue1605Materialization({
  repository = 'liqiangcc/interview-lab',
  boundaryReports = [],
  sourceIssues = [],
  ownershipIssues = [],
  receiptsBySourceIssue = new Map(),
  ownershipErrors = new Map(),
  sourceSnapshot = null,
  ownershipSnapshot = null,
  boundaryManifest = null,
  boundaryEvidenceComments = new Map(),
  boundaryEvidenceSnapshot = null,
  requireCompleteScope = true,
} = {}) {
  const errors = [];
  const verifyLiveEvidence = requireCompleteScope || Boolean(boundaryManifest);
  if (repository !== 'liqiangcc/interview-lab') errors.push('repository must be liqiangcc/interview-lab');
  if (!Array.isArray(boundaryReports) || boundaryReports.length === 0) errors.push('at least one boundary transition report is required');
  const normalizedReports = [];
  const reportItems = [];
  let scopeInputInvalid = false;
  for (const report of boundaryReports || []) {
    const normalized = normalizeBoundaryReport(report);
    normalizedReports.push({ schema_version: report && report.schema_version, digest: normalized.digest || null, ok: normalized.ok, errors: normalized.errors });
    errors.push(...normalized.errors);
    if (Array.isArray(report && report.errors)) errors.push(...report.errors.map((error) => `boundary report: ${error}`));
    for (const item of normalized.items) reportItems.push(item);
  }
  const manifestValidation = boundaryManifest ? validateBoundaryManifest(boundaryManifest) : { ok: !requireCompleteScope, errors: requireCompleteScope ? ['complete 419-row boundary authorization manifest is required'] : [] };
  errors.push(...manifestValidation.errors);
  if (!manifestValidation.ok) scopeInputInvalid = true;
  if (boundaryManifest && manifestValidation.ok) {
    const scope = validateCompleteReportScope(reportItems, boundaryManifest);
    errors.push(...scope.errors);
    if (!scope.ok) scopeInputInvalid = true;
  }
  if (boundaryManifest && boundaryManifest.schema_version === LIVE_BOUNDARY_MANIFEST_SCHEMA) {
    const binding = validateLiveManifestBindings(boundaryManifest, boundaryReports, sourceIssues, sourceSnapshot);
    errors.push(...binding.errors);
    if (!binding.ok) scopeInputInvalid = true;
  }
  const sources = sourceIssueMap(sourceIssues);
  errors.push(...sources.errors);
  const sourceByNumber = sources.map;
  const seenSourceIds = new Map();
  const plannedClaims = new Map();
  for (const item of reportItems) {
    if (!Number.isInteger(item.source_note_issue_number)) continue;
    const source = sourceByNumber.get(item.source_note_issue_number);
    if (!source) continue;
    const parsedResult = issueSourceRecord(source);
    if (parsedResult.parsed && parsedResult.parsed.source_note_id) {
      const id = parsedResult.parsed.source_note_id;
      if (!seenSourceIds.has(id)) seenSourceIds.set(id, []);
      seenSourceIds.get(id).push(item.source_note_issue_number);
    }
    if (!transitionApplied(item) || item.decision === 'blocked') continue;
    const derived = derivedCases(source, item);
    if (!derived.ok) continue;
    for (const claim of derived.cases) {
      if (!plannedClaims.has(claim.interview_note_id)) plannedClaims.set(claim.interview_note_id, []);
      plannedClaims.get(claim.interview_note_id).push({ source_note_issue_number: item.source_note_issue_number, case_key: claim.case_key });
    }
  }
  for (const [sourceId, numbers] of seenSourceIds.entries()) if (numbers.length > 1) errors.push(`SourceNote identity ${sourceId} appears in live Issues #${numbers.join(', #')}`);
  const duplicateClaims = new Map([...plannedClaims.entries()].filter(([, claims]) => claims.length > 1));
  const ownershipByIdentity = new Map();
  for (const identity of plannedClaims.keys()) ownershipByIdentity.set(identity, findOwnershipMatches(ownershipIssues, identity));
  for (const [identity, ownerError] of ownershipErrors.entries()) if (plannedClaims.has(identity)) errors.push(`ownership search for ${identity} failed: ${ownerError}`);

  const results = [];
  const invalidInput = scopeInputInvalid || normalizedReports.some((report) => !report.ok) || sources.errors.length > 0 || errors.some((error) => error === 'repository must be liqiangcc/interview-lab');
  for (const item of reportItems.sort((left, right) => left.source_note_issue_number - right.source_note_issue_number)) {
    const base = resultBase(item);
    if (invalidInput) {
      results.push(blockedResult(item, 'planner-input-invalid', ['one or more planner inputs failed validation; no identity or materialization action is emitted']));
      continue;
    }
    if (!transitionApplied(item)) {
      results.push(blockedResult(item, 'boundary-transition-not-live-applied', ['boundary transition report does not prove a live-applied transition; no InterviewNote identity is derived']));
      continue;
    }
    if (item.decision === 'blocked') {
      results.push(blockedResult(item, 'boundary-transition-blocked', ['boundary transition is explicitly blocked/pending']));
      continue;
    }
    const sourceIssue = sourceByNumber.get(item.source_note_issue_number);
    if (!sourceIssue) {
      results.push(blockedResult(item, 'live-source-note-missing', ['live SourceNote Issue is missing']));
      continue;
    }
    const { validation, parsed } = issueSourceRecord(sourceIssue);
    if (!validation.ok || !parsed) {
      results.push(blockedResult(item, 'live-source-note-invalid', validation.errors));
      continue;
    }
    const actualBodySha = sha256Text(sourceIssue.body);
    if (actualBodySha !== item.live_source_note_body_sha256) {
      results.push(blockedResult(item, 'stale-live-source-note', ['live SourceNote body SHA-256 differs from the boundary transition report'], { live_source_note_body_sha256: actualBodySha }));
      continue;
    }
    if (parsed.source_note_id !== item.source_note_id) {
      results.push(blockedResult(item, 'source-note-identity-drift', ['live SourceNote identity differs from the boundary transition report']));
      continue;
    }
    if (!parsed.source_revision || parsed.source_revision.id !== item.source_revision_id) {
      results.push(blockedResult(item, 'source-revision-drift', ['live SourceNote SourceRevision differs from the boundary transition report']));
      continue;
    }
    const liveStatus = parsed.boundary_review && parsed.boundary_review.status;
    if (liveStatus !== item.decision) {
      results.push(blockedResult(item, 'boundary-disposition-drift', [`live SourceNote boundary disposition is ${liveStatus || 'missing'}, report says ${item.decision}`]));
      continue;
    }
    const liveLabels = labelsOf(sourceIssue);
    if (!liveLabels.includes(`boundary:${item.decision}`)) {
      results.push(blockedResult(item, 'boundary-label-drift', [`live SourceNote lacks boundary:${item.decision}`]));
      continue;
    }
    const derived = derivedCases(sourceIssue, item);
    if (!derived.ok) {
      results.push(blockedResult(item, 'identity-derivation-failed', derived.errors));
      continue;
    }
    const reportIds = reportIdentitySet(item);
    const derivedIds = sortedUnique(derived.cases.map((claim) => claim.interview_note_id));
    if (item.decision !== 'not-interview' && JSON.stringify(reportIds) !== JSON.stringify(derivedIds)) {
      results.push(blockedResult(item, 'boundary-identity-drift', ['boundary transition report identities do not equal identities re-derived from the live SourceNote'], { derived_interview_note_ids: derivedIds, reported_interview_note_ids: reportIds }));
      continue;
    }
    if (seenSourceIds.get(parsed.source_note_id).length > 1) {
      results.push(blockedResult(item, 'duplicate-source-note-identity', ['the live SourceNote identity is owned by more than one SourceNote Issue']));
      continue;
    }
    if (verifyLiveEvidence && transitionApplied(item)) {
      const comments = boundaryEvidenceComments instanceof Map
        ? boundaryEvidenceComments.get(item.source_note_issue_number) || []
        : boundaryEvidenceComments[item.source_note_issue_number] || [];
      const exact = comments.filter((comment) => Number(comment && (comment.id || comment.comment_id)) === Number(item.evidence_comment_id));
      if (exact.length !== 1) {
        results.push(blockedResult(item, 'boundary-evidence-missing-or-ambiguous', [`live boundary evidence must contain exactly one comment with id ${item.evidence_comment_id || 'missing'}`]));
        continue;
      }
      const evidence = validateLiveBoundaryEvidenceComment(exact[0], item, sourceIssue);
      if (!evidence.ok) {
        results.push(blockedResult(item, 'boundary-evidence-binding-failed', evidence.errors, { evidence_comment_id: Number(item.evidence_comment_id) || null }));
        continue;
      }
    }
    if (item.decision === 'not-interview') {
      const identity = derived.cases[0].interview_note_id;
      const owners = ownershipByIdentity.get(identity) || [];
      if (ownershipErrors.has(identity)) {
        results.push(blockedResult(item, 'ownership-search-failed', [ownershipErrors.get(identity)], { derived_interview_note_id: identity }));
      } else if (owners.length === 0) {
        results.push({ ...base, action: 'skip-not-interview', reason_code: null, errors: [], derived_interview_note_id: identity, ownership: { count: 0, issue_numbers: [] }, mutation_performed: false });
      } else {
        results.push(blockedResult(item, 'not-interview-has-interview-owner', [`not-interview SourceNote has ${owners.length} InterviewNote owner(s); deletion is never automatic`], { derived_interview_note_id: identity, ownership: { count: owners.length, issue_numbers: owners.map((owner) => Number(owner.number)).sort((a, b) => a - b) } }));
      }
      continue;
    }
    for (const claim of derived.cases) {
      const identity = claim.interview_note_id;
      const extra = { case_key: claim.case_key, derived_interview_note_id: identity };
      if (duplicateClaims.has(identity)) {
        results.push(blockedResult(item, 'duplicate-interview-note-identity', [`InterviewNote identity ${identity} is claimed by multiple boundary rows`], extra));
        continue;
      }
      if (ownershipErrors.has(identity)) {
        results.push(blockedResult(item, 'ownership-search-failed', [ownershipErrors.get(identity)], extra));
        continue;
      }
      const receipts = receiptsBySourceIssue instanceof Map ? receiptsBySourceIssue.get(item.source_note_issue_number) || [] : receiptsBySourceIssue[item.source_note_issue_number] || [];
      let request;
      try { request = buildMaterializationRequest(sourceIssue, repository, { caseKey: claim.case_key }); }
      catch (error) {
        results.push(blockedResult(item, 'materialization-request-invalid', [error.message], extra));
        continue;
      }
      const materialization = planMaterialization(request, { repository, sourceIssue, issues: ownershipByIdentity.get(identity) || [], receipts });
      if (!materialization.ok) {
        results.push(blockedResult(item, 'materialization-preflight-failed', materialization.errors, { ...extra, request }));
        continue;
      }
      const action = materialization.already_materialized ? 'already-materialized' : materialization.needs_receipt_repair ? 'would-repair-receipt' : 'would-materialize';
      results.push({
        ...base,
        ...extra,
        action,
        reason_code: null,
        errors: [],
        request,
        request_sha256: materialization.request_sha256,
        ownership: {
          count: materialization.ownership_count,
          issue_numbers: (ownershipByIdentity.get(identity) || []).map((owner) => Number(owner.number)).sort((a, b) => a - b),
        },
        projection: publicProjection(materialization),
        mutation_performed: false,
      });
    }
  }
  const counts = {};
  const blockedReasons = {};
  for (const result of results) {
    counts[result.action] = (counts[result.action] || 0) + 1;
    if (result.action === 'blocked') blockedReasons[result.reason_code] = (blockedReasons[result.reason_code] || 0) + 1;
  }
  const digestInput = {
    schema_version: SCHEMA_VERSION,
    repository,
    parent_issue: 1605,
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
    mode: 'plan-only',
    mutation_performed: false,
    write_operations: { patch: 0, post: 0, create: 0 },
    boundary_reports: normalizedReports,
    boundary_manifest: boundaryManifest ? {
      schema_version: boundaryManifest.schema_version,
      parent_issue: boundaryManifest.parent_issue,
      plan_digest: boundaryManifest.plan_digest || null,
      canonical_digest: boundaryManifest.canonical_digest,
      boundary_report_digest: boundaryManifest.boundary_report_digest,
      source_snapshot_digest: boundaryManifest.source_snapshot_digest,
      completion_proof: boundaryManifest.completion_proof,
      candidate_count: Array.isArray(boundaryManifest.items) ? boundaryManifest.items.length : 0,
      complete: manifestValidation.ok && errors.every((error) => !error.includes('partial') && !error.includes('authorized Issue')),
    } : null,
    boundary_evidence: boundaryEvidenceSnapshot || { mode: 'not-supplied', candidate_issue_count: 0, comments_loaded: 0 },
    source_snapshot: sourceSnapshot,
    ownership: {
      identity_count: plannedClaims.size,
      ownership_search_errors: [...ownershipErrors.entries()].map(([identity, error]) => ({ identity, error })),
      ...(ownershipSnapshot || {}),
    },
    counts,
    blocked_reasons: blockedReasons,
    results,
    errors,
  };
  digestInput.ok = errors.length === 0;
  return { ...digestInput, dry_run_sha256: sha256Text(canonicalJson(digestInput)) };
}

module.exports = {
  SCHEMA_VERSION,
  BOUNDARY_REPORT_SCHEMA,
  LIVE_BOUNDARY_REPORT_SCHEMA,
  BOUNDARY_MANIFEST_SCHEMA,
  LIVE_BOUNDARY_MANIFEST_SCHEMA,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  BOUNDARY_MANIFEST_PLAN_DIGEST,
  BOUNDARY_MANIFEST_CANONICAL_DIGEST,
  BOUNDARY_MANIFEST_CANDIDATE_COUNT,
  BOUNDARY_EVIDENCE_MARKER,
  canonicalJson,
  sha256Text,
  transitionApplied,
  reportDigest,
  boundaryManifestDigest,
  liveSourceSnapshotDigest,
  validateLiveManifestBindings,
  LIVE_COMPLETION_PROOF,
  validateBoundaryManifest,
  validateCompleteReportScope,
  evidenceMarkerValues,
  issue1608EvidenceValue,
  validateIssue1608BoundaryEvidenceValue,
  validateLiveBoundaryEvidenceComment,
  normalizeBoundaryReport,
  sourceIssueMap,
  planIssue1605Materialization,
};
