'use strict';

const crypto = require('crypto');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { parseInterviewNoteIssue } = require('./interview-note-issue');
const { parseAppliedBoundaryReviewReceipts } = require('./source-note-boundary-review-transition');

const SCHEMA_VERSION = 'issue-1539-boundary-expansion-candidates.v1';
const REPORT_SCHEMA_VERSION = 'issue-1539-boundary-expansion-report.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const FIXED_ISSUES = Object.freeze([158, 278, 361, 478, 649, 692, 843, 901, 937, 942, 946, 952, 987, 1121, 1168, 1221, 1301]);
const REQUIRED_LABELS = new Set(['type:source-note', 'migration:xhs-bulk', 'boundary:pending', 'task:boundary-review']);
const BOUNDARY_LABEL_RE = /^boundary:(pending|not-interview|single-interview|multi-interview)$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }

function sourceNoteExternalId(sourceNoteId) {
  const match = typeof sourceNoteId === 'string' ? sourceNoteId.match(/^xhs-note:(.+)$/) : null;
  return match && match[1] ? match[1] : null;
}

function canonicalSourceProjectionRef(sourceNoteId) {
  const externalId = sourceNoteExternalId(sourceNoteId);
  return externalId ? `${SOURCE_REPOSITORY}:note_desc/${externalId}.txt@${SOURCE_REF}` : null;
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return { ok: false, labels: [], errors: ['live labels must be an array'] };
  const out = [];
  const errors = [];
  for (const [index, label] of labels.entries()) {
    const value = typeof label === 'string' ? label : label && label.name;
    if (typeof value !== 'string' || !value) errors.push(`labels[${index}] must be a non-empty string or REST label object`);
    else out.push(value);
  }
  if (new Set(out).size !== out.length) errors.push('live labels contain duplicates');
  return { ok: errors.length === 0, labels: out, errors };
}

function validateCandidateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['candidate manifest must be an object'] };
  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (manifest.repository !== REPOSITORY) errors.push(`repository must be ${REPOSITORY}`);
  if (manifest.parent_issue !== 923) errors.push('parent_issue must be 923');
  if (manifest.epic_issue !== 919) errors.push('epic_issue must be 919');
  if (manifest.source_repository !== SOURCE_REPOSITORY) errors.push(`source_repository must be ${SOURCE_REPOSITORY}`);
  if (manifest.source_repository_ref !== SOURCE_REF) errors.push('source_repository_ref is not the fixed XHS snapshot');
  if (!Number.isInteger(manifest.minimum_candidates) || manifest.minimum_candidates < 17) errors.push('minimum_candidates must be at least 17');
  if (!Array.isArray(manifest.items) || manifest.items.length !== FIXED_ISSUES.length) errors.push(`items must contain exactly ${FIXED_ISSUES.length} fixed candidates`);
  const seen = new Set();
  for (const [index, item] of (manifest.items || []).entries()) {
    const prefix = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${prefix} must be an object`); continue; }
    const expectedIssue = FIXED_ISSUES[index];
    if (item.issue_number !== expectedIssue) errors.push(`${prefix}.issue_number must be fixed candidate #${expectedIssue}`);
    if (seen.has(item.issue_number)) errors.push(`${prefix}.issue_number is duplicated`);
    seen.add(item.issue_number);
    if (typeof item.source_note_id !== 'string' || item.source_note_id !== item.source_note_id.trim()) errors.push(`${prefix}.source_note_id is required`);
    const canonicalRef = canonicalSourceProjectionRef(item.source_note_id);
    if (!/^[0-9a-f]{64}$/.test(String(item.expected_body_sha256 || ''))) errors.push(`${prefix}.expected_body_sha256 must be lowercase sha256`);
    if (typeof item.expected_source_revision_id !== 'string' || !item.expected_source_revision_id) errors.push(`${prefix}.expected_source_revision_id is required`);
    if (item.recommended_decision !== 'single-interview') errors.push(`${prefix}.recommended_decision must remain single-interview`);
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) errors.push(`${prefix}.rationale is required`);
    const artifact = item.artifact;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) { errors.push(`${prefix}.artifact is required`); continue; }
    if (artifact.kind !== 'text_projection' || artifact.provenance !== 'source_projection') errors.push(`${prefix}.artifact must be a source_projection text_projection`);
    if (artifact.ref !== canonicalRef) errors.push(`${prefix}.artifact.ref must equal the canonical SourceNote projection ref ${canonicalRef || '<invalid source_note_id>'}`);
    if (!/^[0-9a-f]{40}$/.test(String(artifact.git_blob_sha || ''))) errors.push(`${prefix}.artifact.git_blob_sha must be lowercase Git blob SHA-1`);
    if (typeof artifact.anchor !== 'string' || !artifact.anchor.trim()) errors.push(`${prefix}.artifact.anchor is required`);
  }
  if (seen.size !== FIXED_ISSUES.length || FIXED_ISSUES.some((issue, index) => (manifest.items || [])[index]?.issue_number !== issue)) errors.push('candidate set/order is not the fixed issue-scoped set');
  return { ok: errors.length === 0, errors };
}

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

function verifyPinnedArtifact(item, sourceRecord, readBlob) {
  const errors = [];
  const expected = item.artifact;
  const canonicalRef = canonicalSourceProjectionRef(item.source_note_id);
  if (!canonicalRef || expected.ref !== canonicalRef) errors.push('candidate artifact ref is not canonically bound to its SourceNote external id');
  if (!sourceRecord || sourceRecord.source_note_id !== item.source_note_id || sourceRecord.source?.external_id !== sourceNoteExternalId(item.source_note_id)) errors.push('live SourceNote identity does not match candidate artifact binding');
  const liveArtifact = ((sourceRecord && sourceRecord.artifacts) || []).find((artifact) => artifact.provenance === 'source_projection' && artifact.kind === 'text_projection');
  if (!liveArtifact) errors.push('live SourceNote has no source_projection text_projection');
  else {
    for (const field of ['ref', 'git_blob_sha']) if (liveArtifact[field] !== expected[field]) errors.push(`live source artifact ${field} does not match candidate manifest`);
  }
  if (typeof readBlob !== 'function') errors.push('pinned artifact reader is required');
  let blob = null;
  if (!errors.length) {
    try { blob = readBlob(expected.git_blob_sha); } catch (error) { errors.push(`pinned artifact read failed: ${error.message}`); }
  }
  if (!blob || typeof blob !== 'object') errors.push('pinned artifact response is required');
  else {
    if (blob.sha !== expected.git_blob_sha) errors.push('pinned artifact response SHA mismatch');
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') errors.push('pinned artifact response must be base64 Git blob content');
    if (blob.encoding === 'base64' && typeof blob.content === 'string') {
      let bytes;
      try { bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64'); } catch (error) { errors.push(`pinned artifact base64 invalid: ${error.message}`); }
      if (bytes) {
        if (gitBlobSha(bytes) !== expected.git_blob_sha) errors.push('pinned artifact Git blob SHA does not verify content');
        if (!bytes.toString('utf8').includes(expected.anchor)) errors.push('pinned artifact does not contain the exact candidate anchor');
        if (bytes.length === 0) errors.push('pinned artifact must be non-empty');
      }
    }
  }
  return { ok: errors.length === 0, errors, artifact: expected };
}

function buildBoundaryRequest(item, options = {}) {
  const request = {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: `issue-1539-boundary-expansion-${String(item.issue_number).padStart(4, '0')}`,
    repository: REPOSITORY,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.expected_body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.expected_source_revision_id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: SOURCE_REF,
    decision: item.recommended_decision,
    reviewed_at: options.reviewed_at || null,
    reviewer_kind: 'ai-assisted',
    review_evidence: null,
    checks: [
      { check_id: 'source_identity', result: 'pass', note: `SourceNote #${item.issue_number} and source_note_id are bound to the candidate manifest.` },
      { check_id: 'source_revision_binding', result: 'pass', note: `SourceRevision is pinned to ${SOURCE_REF}.` },
      { check_id: 'source_content_coverage', result: 'pass', note: `source_projection anchor: ${item.artifact.anchor}` },
      { check_id: 'event_boundary', result: 'pass', note: item.rationale },
      { check_id: 'no_cross_source_mixing', result: 'pass', note: 'Only the one pinned XHS text projection is in scope.' },
      { check_id: 'no_fabrication', result: 'pass', note: 'Candidate facts are copied from the pinned source artifact; no derived interview facts are added.' },
    ],
    limitations: [
      'Candidate inventory is not an independent Source Review evidence comment.',
      'Boundary Review must be independently evidenced before this request can be validated or applied.',
    ],
  };
  return { request, executable: Boolean(request.reviewed_at && request.review_evidence) };
}

function buildMaterializationRequest(item) {
  return {
    schema_version: 'source-note-interview-materialization.v1',
    materialization_id: `issue-1539-boundary-expansion-materialization-${String(item.issue_number).padStart(4, '0')}`,
    repository: REPOSITORY,
    source_note_issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_source_note_body_sha256: item.expected_body_sha256,
    expected_boundary_status: 'single-interview',
    expected_source_revision_id: item.expected_source_revision_id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: SOURCE_REF,
  };
}

function exactOwnership(issues, interviewNoteId) {
  const matches = (issues || []).filter((issue) => issue && !issue.pull_request)
    .filter((issue) => parseInterviewNoteIssue(issue.body || '').marker?.interview_note_id === interviewNoteId);
  return { count: matches.length, issue_numbers: matches.map((issue) => Number(issue.number)).sort((a, b) => a - b) };
}

function planBoundaryExpansion(manifest, options = {}) {
  const manifestResult = validateCandidateManifest(manifest);
  if (!manifestResult.ok) return { ok: false, errors: manifestResult.errors, report: null };
  const manifestSha256 = sha256Text(canonicalJson(manifest));
  const items = [];
  for (const item of manifest.items) {
    const errors = [];
    let issue = null;
    try { issue = options.readIssue(item.issue_number); } catch (error) { errors.push(`Issue read failed: ${error.message}`); }
    if (!issue) errors.push('live SourceNote Issue is required');
    let parsed = null;
    let sourceRecord = null;
    if (issue) {
      if (Number(issue.number) !== item.issue_number) errors.push('live Issue number mismatch');
      if (String(issue.state || '').toLowerCase() !== 'open') errors.push('SourceNote Issue must be open');
      if (sha256Text(issue.body || '') !== item.expected_body_sha256) errors.push('live SourceNote body SHA mismatch');
      const labels = normalizeLabels(issue.labels);
      errors.push(...labels.errors);
      if (labels.ok) {
        for (const label of REQUIRED_LABELS) if (!labels.labels.includes(label)) errors.push(`live SourceNote is missing ${label}`);
        const boundaryLabels = labels.labels.filter((label) => BOUNDARY_LABEL_RE.test(label));
        if (boundaryLabels.length !== 1 || boundaryLabels[0] !== 'boundary:pending') errors.push('live Boundary label is not exactly boundary:pending');
      }
      parsed = parseSourceNoteIssue(issue.body || '');
      const validation = validateSourceNoteIssue({ body: issue.body || '', labels: labels.labels, state: String(issue.state || '').toLowerCase() });
      if (!validation.ok) errors.push(...validation.errors.map((error) => `SourceNote invalid: ${error}`));
      sourceRecord = validation.parsed && validation.parsed.record;
      if (!sourceRecord) errors.push('live SourceNote record is unavailable');
      else {
        if (sourceRecord.source_note_id !== item.source_note_id) errors.push('source_note_id does not match candidate manifest');
        if (sourceRecord.source_revision?.id !== item.expected_source_revision_id) errors.push('SourceRevision id does not match candidate manifest');
        if (sourceRecord.source_revision?.source_repository_ref !== SOURCE_REF) errors.push('SourceRevision ref is not the fixed XHS snapshot');
        if (sourceRecord.boundary_review?.status !== 'pending') errors.push('live SourceNote boundary status is not pending');
      }
    }
    const artifact = sourceRecord ? verifyPinnedArtifact(item, sourceRecord, options.readBlob) : { ok: false, errors: ['artifact check skipped because SourceNote is unavailable'] };
    errors.push(...artifact.errors.map((error) => `artifact: ${error}`));
    const interviewNoteId = sourceRecord ? `${sourceRecord.source.system}:${sourceRecord.source.external_id}` : null;
    let ownership = { count: null, issue_numbers: [], status: 'unavailable' };
    if (interviewNoteId) {
      try { ownership = { ...exactOwnership(options.findOwnership(interviewNoteId), interviewNoteId), status: 'checked' }; }
      catch (error) { errors.push(`ownership search failed: ${error.message}`); ownership = { count: null, issue_numbers: [], status: 'error' }; }
      if (ownership.count !== 0) errors.push(`InterviewNote ownership is not empty: ${ownership.issue_numbers.join(', ')}`);
    }
    let receipts = [];
    if (issue) {
      try {
        const parsedReceipts = parseAppliedBoundaryReviewReceipts(options.readComments(item.issue_number) || []);
        if (parsedReceipts.errors.length) errors.push(...parsedReceipts.errors.map((error) => `receipt: ${error}`));
        receipts = parsedReceipts.receipts.filter((receipt) => receipt.transition_id === `issue-1539-boundary-expansion-${String(item.issue_number).padStart(4, '0')}`);
      } catch (error) { errors.push(`receipt read failed: ${error.message}`); }
    }
    const boundary = buildBoundaryRequest(item);
    const materialization = buildMaterializationRequest(item);
    items.push({
      issue_number: item.issue_number,
      source_note_id: item.source_note_id,
      status: errors.length ? 'blocked' : 'candidate-awaiting-independent-boundary-evidence',
      checks: {
        source_note: errors.length === 0,
        pinned_artifact: artifact.ok,
        unique_interview_note_ownership: ownership.status === 'checked' && ownership.count === 0,
        boundary_receipt_count: receipts.length,
      },
      ownership,
      receipts: receipts.map((receipt) => ({ comment_id: receipt.comment_id, transition_id: receipt.transition_id, request_sha256: receipt.request_sha256 || null })),
      boundary_review: { action: 'awaiting-independent-review-evidence', executable: false, request: boundary.request },
      materialization: { action: 'blocked-until-boundary-single-interview', executable: false, request: materialization },
      source_ready_claimed: false,
      errors,
    });
  }
  const reportWithoutDigest = {
    schema_version: REPORT_SCHEMA_VERSION,
    repository: REPOSITORY,
    parent_issue: 923,
    epic_issue: 919,
    manifest_sha256: manifestSha256,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    fixed_issue_numbers: FIXED_ISSUES,
    total: items.length,
    mutation_count: 0,
    source_ready_claimed: 0,
    formal_boundary_requests_ready: items.filter((item) => item.boundary_review.executable).length,
    materialization_requests_ready: items.filter((item) => item.materialization.executable).length,
    blocked: items.filter((item) => item.status === 'blocked').map((item) => ({ issue_number: item.issue_number, errors: item.errors })),
    exclusion_reasons: [
      { category: 'already-source-ready-or-owned', issue_numbers: [3, 4, 915, ...Array.from({ length: 30 }, (_, index) => 1509 + index)], reason: 'already occupied by the completed Source Review/source-ready set; excluded from this expansion.' },
      { category: 'prior-boundary-decision', reason: '#921 already decided 45 pilot items; not re-opened by this fixed expansion.' },
      { category: 'insufficient-evidence', issue_numbers: [90, 92, 1115, 1452, 1460], reason: 'prior Boundary Review remains blocked; no evidence is invented.' },
      { category: 'not-a-single-interview-candidate', reason: 'question banks, tutorials, marketing/long-term summaries, and mixed independent processes remain excluded or require multi-interview review.' },
    ],
    execution_contract: {
      mode: 'plan-only',
      mutation_allowed: false,
      fixed_collection: true,
      ownership: 'exact InterviewNote machine-marker scan; zero owners required',
      cas: 'body SHA, SourceRevision/ref, open state and controlled labels are re-read before any delegated mutation',
      lock: 'delegate only to the existing boundary/materialization batch lock and durable progress/journal',
      receipts: 'boundary transition receipt and materialization receipt are both required',
      recovery: 'stale plans fail closed; re-plan before a separately authorized resume',
      sequencing: 'Boundary Review → materialization → independent Source Review; no direct source-ready',
    },
    items,
  };
  const report = { ...reportWithoutDigest, report_sha256: sha256Text(canonicalJson(reportWithoutDigest)) };
  return { ok: items.every((item) => item.status !== 'blocked'), errors: report.blocked.flatMap((item) => item.errors), report, manifest_sha256: manifestSha256 };
}

module.exports = {
  SCHEMA_VERSION, REPORT_SCHEMA_VERSION, REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, FIXED_ISSUES,
  canonicalJson, sha256Text, sourceNoteExternalId, canonicalSourceProjectionRef, normalizeLabels, validateCandidateManifest, gitBlobSha, verifyPinnedArtifact,
  buildBoundaryRequest, buildMaterializationRequest, exactOwnership, planBoundaryExpansion,
};
