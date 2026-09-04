'use strict';

const crypto = require('crypto');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./interview-note-issue');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { CHILD_CASE_KEY_RE, childInterviewNoteId } = require('./interview-note-identity');

const SCHEMA_VERSION = 'interview-note-source-review-transition.v1';
const REQUEST_RE = /<!--\s*interview-note-source-review-transition\s*\n([\s\S]*?)\n-->/g;
const RECEIPT_RE = /<!--\s*interview-note-source-review-applied\s*\n([\s\S]*?)\n-->/g;
const REQUIRED_CHECK_IDS = [
  'source_identity',
  'source_revision_binding',
  'artifact_reference_integrity',
  'raw_projection_traceability',
  'known_limitations_recorded',
  'duplicate_ownership',
  'no_fabrication',
];
const ALLOWED_REQUEST_FIELDS = new Set([
  'schema_version','transition_id','repository','issue_number','interview_note_id',
  'expected_interview_body_sha256','expected_initial_status','expected_source_revision_id',
  'source_note_issue_number','expected_source_note_body_sha256','expected_manifest_sha256',
  'expected_source_repository_ref','decision','reviewed_at','reviewer_kind','review_evidence','checks','limitations','case_key',
]);

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
function canonicalJson(value) { return JSON.stringify(value, Object.keys(value || {}).sort()); }
function requestSha256(request) { return sha256Text(JSON.stringify(request)); }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function labelsOf(issue) { return (issue.labels || []).map((x) => typeof x === 'string' ? x : x.name).filter(Boolean); }
function statusOf(issue) {
  const values = labelsOf(issue).filter((x) => x.startsWith('status:'));
  return values.length === 1 ? values[0].slice('status:'.length) : null;
}
function replaceLifecycle(labels, status, task) {
  const out = labels.filter((x) => !x.startsWith('status:') && x !== 'task:source-review' && x !== 'task:source-recovery');
  out.push(`status:${status}`);
  if (task) out.push(task);
  return [...new Set(out)].sort();
}
function extractInterviewNoteId(body) {
  const match = String(body || '').match(/<!--\s*interview-note:\s*id=([^\s]+)\s+schema=interview-note-issue\.v\d+\s*-->/);
  return match ? match[1] : null;
}
function ownershipMatches(issues, id) {
  return (issues || []).filter((issue) => !issue.pull_request && extractInterviewNoteId(issue.body) === id);
}
function parseJsonMarker(body, re, label) {
  const matches = [...String(body || '').matchAll(re)];
  if (matches.length !== 1) return { value: null, errors: [`${label} must appear exactly once`] };
  try { return { value: JSON.parse(matches[0][1].trim()), errors: [] }; }
  catch (error) { return { value: null, errors: [`${label} must contain valid JSON: ${error.message}`] }; }
}
function parseRequest(body) {
  const parsed = parseJsonMarker(body, REQUEST_RE, 'source-review transition marker');
  return { request: parsed.value, errors: parsed.errors };
}
function parseReceipts(comments) {
  const receipts = [];
  const errors = [];
  for (const comment of comments || []) {
    for (const match of String(comment.body || '').matchAll(RECEIPT_RE)) {
      try { receipts.push({ ...JSON.parse(match[1].trim()), comment_id: Number(comment.id) }); }
      catch (error) { errors.push(`invalid source-review receipt in comment ${comment.id}: ${error.message}`); }
    }
  }
  return { receipts, errors };
}
function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, errors: ['request must be an object'] };
  for (const key of Object.keys(request)) if (!ALLOWED_REQUEST_FIELDS.has(key)) errors.push(`unsupported transition request field: ${key}`);
  if (request.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(request.transition_id)) errors.push('transition_id is required');
  if (!/^[^/]+\/[^/]+$/.test(String(request.repository || ''))) errors.push('repository must be owner/repo');
  if (!Number.isInteger(request.issue_number) || request.issue_number < 1) errors.push('issue_number must be a positive integer');
  if (!isNonEmptyString(request.interview_note_id)) errors.push('interview_note_id is required');
  if (request.case_key != null && (typeof request.case_key !== 'string' || !CHILD_CASE_KEY_RE.test(request.case_key))) errors.push('case_key must use lowercase stable identity syntax');
  for (const key of ['expected_interview_body_sha256','expected_source_note_body_sha256']) if (!/^[0-9a-f]{64}$/.test(String(request[key] || ''))) errors.push(`${key} must be lowercase SHA-256`);
  if (request.expected_manifest_sha256 != null && !/^[0-9a-f]{64}$/.test(String(request.expected_manifest_sha256))) errors.push('expected_manifest_sha256 must be null or lowercase SHA-256');
  if (request.expected_source_repository_ref != null && !/^[0-9a-f]{40}$/.test(String(request.expected_source_repository_ref))) errors.push('expected_source_repository_ref must be null or lowercase 40-char Git ref');
  if (request.expected_manifest_sha256 == null && request.expected_source_repository_ref == null) errors.push('one of expected_manifest_sha256 or expected_source_repository_ref is required');
  if (request.expected_initial_status !== 'captured') errors.push('expected_initial_status must be captured');
  if (!isNonEmptyString(request.expected_source_revision_id)) errors.push('expected_source_revision_id is required');
  if (!Number.isInteger(request.source_note_issue_number) || request.source_note_issue_number < 1) errors.push('source_note_issue_number must be positive');
  if (!['source-ready','blocked'].includes(request.decision)) errors.push('decision must be source-ready or blocked');
  if (!isNonEmptyString(request.reviewed_at) || Number.isNaN(Date.parse(request.reviewed_at))) errors.push('reviewed_at must be a valid timestamp');
  if (!['human','ai-assisted'].includes(request.reviewer_kind)) errors.push('reviewer_kind must be human or ai-assisted');
  if (!request.review_evidence || typeof request.review_evidence !== 'object') errors.push('review_evidence is required');
  if (!Array.isArray(request.checks)) errors.push('checks must be an array');
  if (!Array.isArray(request.limitations)) errors.push('limitations must be an array');
  const ids = Array.isArray(request.checks) ? request.checks.map((c) => c && c.check_id) : [];
  for (const id of REQUIRED_CHECK_IDS) if (ids.filter((x) => x === id).length !== 1) errors.push(`checks must contain exactly one ${id}`);
  return { ok: errors.length === 0, errors };
}
function sameTimeFact(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }
function checkPass(check_id, result, note) { return { check_id, result: result ? 'pass' : 'fail', note }; }
function computeChecks(request, interviewIssue, sourceIssue, allIssues) {
  const ip = parseInterviewNoteIssue(interviewIssue.body || '');
  const sp = parseSourceNoteIssue(sourceIssue.body || '');
  const ir = ip.record;
  const sr = sp.record;
  const sourceId = sr && sr.source ? `${sr.source.system}:${sr.source.external_id}` : null;
  let expectedId = sourceId;
  if (request.case_key && sr && sr.source) {
    try { expectedId = childInterviewNoteId(sr.source, request.case_key); } catch (_) { expectedId = null; }
  }
  const expectedBoundary = request.case_key ? 'multi-interview' : 'single-interview';
  const declaredCase = sr && sr.boundary_review && (sr.boundary_review.interview_note_cases || []).find((item) => item.case_key === request.case_key);
  const sourceIdentityOk = Boolean(ir && sr && ir.interview_note_id === request.interview_note_id && expectedId === request.interview_note_id && ir.source.system === sr.source.system && ir.source.external_id === sr.source.external_id && sr.boundary_review && sr.boundary_review.status === expectedBoundary && (request.case_key ? declaredCase && declaredCase.interview_note_id === request.interview_note_id : JSON.stringify(sr.boundary_review.interview_note_ids) === JSON.stringify([request.interview_note_id])));
  const sourceRevisionOk = Boolean(ir && sr && ir.source_revision && sr.source_revision && ir.source_revision.id === request.expected_source_revision_id && sr.source_revision.id === request.expected_source_revision_id && (request.expected_manifest_sha256 != null ? sr.source_revision.manifest_sha256 === request.expected_manifest_sha256 : sr.source_revision.source_repository_ref === request.expected_source_repository_ref));
  const sourceArtifacts = new Map((sr && Array.isArray(sr.artifacts) ? sr.artifacts : []).map((a) => [a.ref, a]));
  const interviewArtifacts = ir && Array.isArray(ir.artifacts) ? ir.artifacts : [];
  const artifactOk = interviewArtifacts.length > 0 && interviewArtifacts.every((a) => {
    const source = sourceArtifacts.get(a.ref);
    return Boolean(source && (a.sha256 ?? null) === (source.sha256 ?? null) && a.provenance === source.provenance);
  });
  const projections = sr && Array.isArray(sr.artifacts) ? sr.artifacts.filter((a) => a.provenance === 'source_projection') : [];
  const traceabilityOk = projections.length > 0 && projections.every((p) => Array.isArray(p.derived_from) && p.derived_from.length > 0 && p.derived_from.every((ref) => {
    const root = sourceArtifacts.get(ref);
    return Boolean(root && root.provenance === 'raw_capture');
  }));
  const sourceLimitations = sr && Array.isArray(sr.limitations) ? sr.limitations : [];
  const interviewLimitations = ir && Array.isArray(ir.limitations) ? ir.limitations : [];
  const limitationsOk = sourceLimitations.every((x) => interviewLimitations.includes(x));
  const owners = ownershipMatches(allIssues, request.interview_note_id);
  const ownershipOk = owners.length === 1 && Number(owners[0].number) === Number(request.issue_number);
  const noFabricationOk = Boolean(ir && sr && sameTimeFact(ir.source_published_at, sr.source_published_at) && sameTimeFact(ir.source_edited_at, sr.source_edited_at) && ir.interview_occurred_at && ir.interview_occurred_at.precision === 'unknown' && ir.interview_occurred_at.value == null && ir.source.url === sr.source.url);
  return [
    checkPass('source_identity', sourceIdentityOk, sourceIdentityOk ? 'InterviewNote identity matches reviewed SourceNote single-interview identity.' : 'Source identity/boundary binding mismatch.'),
    checkPass('source_revision_binding', sourceRevisionOk, sourceRevisionOk ? 'InterviewNote and SourceNote bind the exact requested SourceRevision/manifest.' : 'SourceRevision or manifest binding mismatch.'),
    checkPass('artifact_reference_integrity', artifactOk, artifactOk ? 'Every InterviewNote artifact ref/hash/provenance resolves to SourceNote evidence.' : 'InterviewNote artifact does not resolve exactly to SourceNote evidence.'),
    checkPass('raw_projection_traceability', traceabilityOk, traceabilityOk ? 'Every Source projection is explicitly derived from registered Raw capture refs.' : 'Source projection Raw traceability is incomplete.'),
    checkPass('known_limitations_recorded', limitationsOk, limitationsOk ? 'All SourceNote limitations are retained by InterviewNote.' : 'InterviewNote drops one or more SourceNote limitations.'),
    checkPass('duplicate_ownership', ownershipOk, ownershipOk ? `Exactly one InterviewNote owner exists: #${request.issue_number}.` : `Ownership count/Issue mismatch: ${owners.map((x) => x.number).join(',') || 'none'}.`),
    checkPass('no_fabrication', noFabricationOk, noFabricationOk ? 'Source time/URL facts are mechanically preserved; interview time remains unknown.' : 'Materialized Source facts exceed or differ from SourceNote evidence.'),
  ];
}
function validateEvidenceComment(request, comment, errors) {
  if (!comment || Number(comment.id) !== Number(request.review_evidence.comment_id)) { errors.push('review evidence comment does not resolve'); return; }
  const body = String(comment.body || '');
  const tokens = [request.transition_id, request.interview_note_id, request.expected_source_revision_id, String(request.source_note_issue_number), request.expected_manifest_sha256, request.expected_source_repository_ref, request.decision, request.case_key].filter((token) => token != null);
  for (const token of tokens) if (!body.includes(token)) errors.push(`review evidence comment must bind transition fact: ${token}`);
  for (const check of request.checks || []) if (!body.includes(check.check_id) || !body.includes(check.result)) errors.push(`review evidence comment must bind check/result: ${check.check_id}:${check.result}`);
}
function buildReceipt(request, finalStatus, appliedAt) {
  return {
    schema_version: 'interview-note-source-review-applied.v1',
    transition_id: request.transition_id,
    request_sha256: requestSha256(request),
    repository: request.repository,
    issue_number: request.issue_number,
    interview_note_id: request.interview_note_id,
    ...(request.case_key == null ? {} : { case_key: request.case_key }),
    source_note_issue_number: request.source_note_issue_number,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    decision: request.decision,
    final_status: finalStatus,
    reviewed_at: request.reviewed_at,
    applied_at: appliedAt,
  };
}
function planSourceReview(request, interviewIssue, options = {}) {
  const errors = [];
  errors.push(...validateRequest(request).errors);
  if (!interviewIssue || Number(interviewIssue.number) !== Number(request.issue_number)) errors.push('InterviewNote Issue number mismatch');
  const sourceIssue = options.sourceIssue;
  if (!sourceIssue || Number(sourceIssue.number) !== Number(request.source_note_issue_number)) errors.push('SourceNote Issue number mismatch');
  if (errors.length) return { ok: false, errors };
  if (sha256Text(interviewIssue.body) !== request.expected_interview_body_sha256) errors.push('stale InterviewNote body digest');
  if (sha256Text(sourceIssue.body) !== request.expected_source_note_body_sha256) errors.push('stale SourceNote body digest');
  const interviewValidation = validateInterviewNoteIssue({ body: interviewIssue.body, labels: labelsOf(interviewIssue), state: String(interviewIssue.state || 'open').toLowerCase() });
  if (!interviewValidation.ok) errors.push(...interviewValidation.errors.map((x) => `live InterviewNote invalid: ${x}`));
  const sourceValidation = validateSourceNoteIssue({ body: sourceIssue.body, labels: labelsOf(sourceIssue), state: String(sourceIssue.state || 'open').toLowerCase() });
  if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((x) => `live SourceNote invalid: ${x}`));
  const ir = interviewValidation.parsed.record;
  const sr = sourceValidation.parsed.record;
  if (!ir || ir.interview_note_id !== request.interview_note_id) errors.push('InterviewNote identity mismatch');
  if (!ir || !ir.source_revision || ir.source_revision.id !== request.expected_source_revision_id) errors.push('stale InterviewNote SourceRevision');
  if (!sr || !sr.source_revision || sr.source_revision.id !== request.expected_source_revision_id) errors.push('stale SourceNote SourceRevision');
  if (request.expected_manifest_sha256 != null && (!sr || !sr.source_revision || sr.source_revision.manifest_sha256 !== request.expected_manifest_sha256)) errors.push('stale SourceCapture manifest');
  if (request.expected_source_repository_ref != null && (!sr || !sr.source_revision || sr.source_revision.source_repository_ref !== request.expected_source_repository_ref)) errors.push('stale fixed source repository ref');
  if (request.case_key) {
    let expectedChild;
    try { expectedChild = sr && sr.source ? childInterviewNoteId(sr.source, request.case_key) : null; } catch (error) { errors.push(error.message); }
    const child = sr.boundary_review && (sr.boundary_review.interview_note_cases || []).find((item) => item.case_key === request.case_key);
    if (!child || child.interview_note_id !== expectedChild || request.interview_note_id !== expectedChild) errors.push('multi-interview SourceNote child identity binding mismatch');
  } else if (!sr || sr.boundary_review.status !== 'single-interview') errors.push('single-interview source review requires single-interview boundary');
  const currentStatus = statusOf(interviewIssue);
  if (!['captured','source-review','source-ready','blocked'].includes(currentStatus)) errors.push(`unsupported current lifecycle status: ${currentStatus}`);
  validateEvidenceComment(request, options.evidenceComment, errors);
  const computedChecks = computeChecks(request, interviewIssue, sourceIssue, options.allIssues || []);
  const computedById = new Map(computedChecks.map((c) => [c.check_id, c]));
  for (const requested of request.checks || []) {
    const actual = computedById.get(requested.check_id);
    if (!actual || actual.result !== requested.result) errors.push(`requested check result does not match machine evidence: ${requested.check_id}`);
  }
  const allPass = computedChecks.every((c) => c.result === 'pass');
  if (request.decision === 'source-ready' && !allPass) errors.push('source-ready requires all source-review checks to pass');
  if (request.decision === 'blocked' && allPass) errors.push('blocked requires at least one failed source-review check');
  const receipts = (options.receipts || []).filter((r) => r.transition_id === request.transition_id);
  if (receipts.length > 1) errors.push('multiple source-review receipts found');
  const receipt = receipts.length === 1 ? receipts[0] : null;
  if (receipt) {
    if (receipt.request_sha256 !== requestSha256(request)) errors.push('source-review receipt request digest mismatch');
    if (receipt.interview_note_id !== request.interview_note_id) errors.push('source-review receipt InterviewNote mismatch');
    if (receipt.source_revision_id !== request.expected_source_revision_id) errors.push('source-review receipt SourceRevision mismatch');
    if (receipt.manifest_sha256 !== request.expected_manifest_sha256) errors.push('source-review receipt manifest mismatch');
    if ((receipt.source_repository_ref ?? null) !== (request.expected_source_repository_ref ?? null)) errors.push('source-review receipt source repository ref mismatch');
    if (receipt.final_status !== request.decision) errors.push('source-review receipt final status mismatch');
  }
  const beginLabels = replaceLifecycle(labelsOf(interviewIssue), 'source-review', 'task:source-review');
  const finalLabels = replaceLifecycle(labelsOf(interviewIssue), request.decision, request.decision === 'blocked' ? 'task:source-recovery' : null);
  const finalMatches = currentStatus === request.decision && JSON.stringify([...labelsOf(interviewIssue)].sort()) === JSON.stringify(finalLabels);
  if (currentStatus === 'source-ready' || currentStatus === 'blocked') {
    if (!finalMatches) errors.push(`final lifecycle state conflicts with requested decision: ${currentStatus}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    request,
    request_sha256: requestSha256(request),
    current_status: currentStatus,
    computed_checks: computedChecks,
    begin_labels: beginLabels,
    final_labels: finalLabels,
    receipt,
    already_applied: Boolean(receipt && finalMatches),
    needs_receipt_repair: Boolean(!receipt && finalMatches),
    needs_begin: currentStatus === 'captured',
    resumable_review: currentStatus === 'source-review',
  };
}

module.exports = {
  SCHEMA_VERSION,
  REQUIRED_CHECK_IDS,
  sha256Text,
  requestSha256,
  parseRequest,
  parseReceipts,
  validateRequest,
  ownershipMatches,
  computeChecks,
  buildReceipt,
  planSourceReview,
};
