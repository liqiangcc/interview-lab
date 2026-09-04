'use strict';

const crypto = require('crypto');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { CHILD_CASE_KEY_RE, childInterviewNoteId } = require('./interview-note-identity');

const SCHEMA_VERSION = 'source-note-boundary-review-transition.v1';
const MULTI_SCHEMA_VERSION = 'source-note-boundary-review-transition.v2';
const SUPPORTED_SCHEMA_VERSIONS = new Set([SCHEMA_VERSION, MULTI_SCHEMA_VERSION]);
const MARKER_RE = /<!--\s*source-note-boundary-review-transition\s*([\s\S]*?)-->/g;
const APPLIED_MARKER_RE = /<!--\s*source-note-boundary-review-applied\s*([\s\S]*?)-->/g;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_CHECK_IDS = [
  'source_identity',
  'source_revision_binding',
  'source_content_coverage',
  'event_boundary',
  'no_cross_source_mixing',
  'no_fabrication',
];
const SOURCE_EVIDENCE_PROVENANCE = new Set([
  'raw_capture',
  'raw_dom_snapshot',
  'raw_context_capture',
  'source_projection',
]);

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeLabels(labels = []) {
  return labels.map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseSourceNoteBoundaryReviewTransition(body) {
  const matches = [...String(body || '').matchAll(MARKER_RE)];
  const errors = [];
  if (matches.length !== 1) {
    errors.push('comment must contain exactly one source-note-boundary-review-transition machine marker');
    return { request: null, errors };
  }
  try {
    return { request: JSON.parse(matches[0][1].trim()), errors };
  } catch (error) {
    errors.push(`source-note-boundary-review-transition marker must contain valid JSON: ${error.message}`);
    return { request: null, errors };
  }
}

function parseAppliedBoundaryReviewReceipts(comments = []) {
  const receipts = [];
  const errors = [];
  for (const comment of comments || []) {
    const matches = [...String(comment && comment.body || '').matchAll(APPLIED_MARKER_RE)];
    for (const match of matches) {
      try {
        const receipt = JSON.parse(match[1].trim());
        receipts.push({ ...receipt, comment_id: comment.id || comment.comment_id || null });
      } catch (error) {
        errors.push(`invalid source-note-boundary-review-applied marker in comment ${comment && comment.id || 'unknown'}: ${error.message}`);
      }
    }
  }
  return { receipts, errors };
}

function validateTransitionRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, errors: ['transition request must be an object'] };
  }
  const allowedKeys = new Set([
    'schema_version', 'transition_id', 'repository', 'issue_number', 'source_note_id',
    'expected_body_sha256', 'expected_boundary_status', 'expected_source_revision_id',
    'expected_manifest_sha256', 'expected_source_repository_ref', 'decision', 'reviewed_at',
    'reviewer_kind', 'review_evidence', 'checks', 'limitations', 'interview_cases',
  ]);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) errors.push(`unsupported transition request field: ${key}`);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(request.schema_version)) errors.push(`schema_version must be one of ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}`);
  if (!isNonEmptyString(request.transition_id)) errors.push('transition_id must be a non-empty string');
  if (!isNonEmptyString(request.repository) || !/^[^/]+\/[^/]+$/.test(request.repository)) errors.push('repository must use owner/repo');
  if (!Number.isInteger(request.issue_number) || request.issue_number < 1) errors.push('issue_number must be a positive integer');
  if (!isNonEmptyString(request.source_note_id) || !request.source_note_id.startsWith('xhs-note:')) errors.push('source_note_id must use xhs-note:<external-id>');
  if (!HEX64.test(String(request.expected_body_sha256 || ''))) errors.push('expected_body_sha256 must be a lowercase 64-char SHA-256');
  if (request.expected_boundary_status !== 'pending') errors.push('expected_boundary_status must be pending');
  if (!isNonEmptyString(request.expected_source_revision_id)) errors.push('expected_source_revision_id must be a non-empty string');
  if (request.expected_manifest_sha256 != null && !HEX64.test(String(request.expected_manifest_sha256))) errors.push('expected_manifest_sha256 must be null or a lowercase 64-char SHA-256');
  if (request.expected_source_repository_ref != null && !HEX40.test(String(request.expected_source_repository_ref))) errors.push('expected_source_repository_ref must be null or a lowercase 40-char Git ref');
  if (!['not-interview', 'single-interview', 'multi-interview'].includes(request.decision)) errors.push('decision must be not-interview/single-interview/multi-interview');
  if (!isNonEmptyString(request.reviewed_at) || Number.isNaN(Date.parse(request.reviewed_at))) errors.push('reviewed_at must be a valid timestamp');
  if (!['human', 'ai-assisted'].includes(request.reviewer_kind)) errors.push('reviewer_kind must be human or ai-assisted');
  if (!request.review_evidence || typeof request.review_evidence !== 'object' || Array.isArray(request.review_evidence)) {
    errors.push('review_evidence must be an object');
  } else {
    if (request.review_evidence.repository !== request.repository) errors.push('review_evidence.repository must equal repository');
    if (request.review_evidence.issue_number !== request.issue_number) errors.push('review_evidence.issue_number must equal issue_number');
    if (!Number.isInteger(request.review_evidence.comment_id) || request.review_evidence.comment_id < 1) errors.push('review_evidence.comment_id must be a positive integer');
  }
  if (!Array.isArray(request.checks) || request.checks.length === 0) {
    errors.push('checks must be a non-empty array');
  } else {
    const ids = new Set();
    for (const [index, check] of request.checks.entries()) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) {
        errors.push(`checks[${index}] must be an object`);
        continue;
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(String(check.check_id || ''))) errors.push(`checks[${index}].check_id is invalid`);
      if (ids.has(check.check_id)) errors.push(`duplicate check_id: ${check.check_id}`);
      ids.add(check.check_id);
      if (!['pass', 'fail'].includes(check.result)) errors.push(`checks[${index}].result must be pass/fail`);
    }
    for (const required of REQUIRED_CHECK_IDS) {
      const check = request.checks.find((item) => item && item.check_id === required);
      if (!check) errors.push(`missing required boundary review check: ${required}`);
      else if (check.result !== 'pass') errors.push(`required boundary review check must pass: ${required}`);
    }
  }
  if (!Array.isArray(request.limitations)) errors.push('limitations must be an array');
  if (request.schema_version === SCHEMA_VERSION && Object.prototype.hasOwnProperty.call(request, 'interview_cases')) {
    errors.push('source-note-boundary-review-transition.v1 must not contain interview_cases; use v2 for multi-interview');
  }
  if (request.schema_version === MULTI_SCHEMA_VERSION && request.decision !== 'multi-interview') {
    errors.push('source-note-boundary-review-transition.v2 is reserved for multi-interview decisions');
  }
  if (request.decision === 'multi-interview' && request.schema_version !== MULTI_SCHEMA_VERSION) {
    errors.push('multi-interview requires source-note-boundary-review-transition.v2');
  }
  return { ok: errors.length === 0, errors };
}

function validateInterviewCases(record, cases) {
  const errors = [];
  if (!Array.isArray(cases) || cases.length < 2) {
    errors.push('multi-interview requires at least two interview_cases');
    return { ok: false, errors };
  }
  if (!record || !record.source || !Array.isArray(record.artifacts)) {
    errors.push('multi-interview requires a valid SourceNote source and artifacts');
    return { ok: false, errors };
  }
  const artifacts = new Map(record.artifacts.map((artifact) => [artifact.ref, artifact]));
  const keys = new Set();
  const ids = new Set();
  const locators = new Set();
  const normalized = [];
  for (const [index, item] of cases.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`interview_cases[${index}] must be an object`);
      continue;
    }
    const unsupported = Object.keys(item).filter((key) => !['case_key', 'evidence'].includes(key));
    for (const key of unsupported) errors.push(`unsupported interview_cases[${index}] field: ${key}`);
    if (typeof item.case_key !== 'string' || !CHILD_CASE_KEY_RE.test(item.case_key)) {
      errors.push(`interview_cases[${index}].case_key must use lowercase stable identity syntax`);
    } else if (keys.has(item.case_key)) {
      errors.push(`duplicate interview case_key: ${item.case_key}`);
    } else {
      keys.add(item.case_key);
    }
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      errors.push(`interview_cases[${index}].evidence must contain at least one source evidence reference`);
      continue;
    }
    const evidence = [];
    for (const [evidenceIndex, reference] of item.evidence.entries()) {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        errors.push(`interview_cases[${index}].evidence[${evidenceIndex}] must be an object`);
        continue;
      }
      const referenceKeys = Object.keys(reference);
      for (const key of referenceKeys.filter((key) => !['ref', 'locator'].includes(key))) {
        errors.push(`unsupported interview evidence field: ${key}`);
      }
      if (typeof reference.ref !== 'string' || !reference.ref) {
        errors.push(`interview_cases[${index}].evidence[${evidenceIndex}].ref is required`);
        continue;
      }
      if (typeof reference.locator !== 'string' || !reference.locator.trim()) {
        errors.push(`interview_cases[${index}].evidence[${evidenceIndex}].locator is required`);
      }
      if (typeof reference.locator === 'string' && reference.locator.trim()) {
        const locator = reference.locator.trim();
        if (locators.has(locator)) errors.push(`duplicate interview evidence locator: ${locator}`);
        locators.add(locator);
      }
      const artifact = artifacts.get(reference.ref);
      if (!artifact) {
        errors.push(`interview case evidence ref is not an exact SourceNote artifact: ${reference.ref}`);
      } else if (!SOURCE_EVIDENCE_PROVENANCE.has(artifact.provenance)) {
        errors.push(`interview case evidence must not use Derived-only artifact: ${reference.ref}`);
      }
      evidence.push({ ref: reference.ref, locator: reference.locator });
    }
    if (typeof item.case_key === 'string' && CHILD_CASE_KEY_RE.test(item.case_key)) {
      let id;
      try {
        id = childInterviewNoteId(record.source, item.case_key);
      } catch (error) {
        errors.push(`interview_cases[${index}] identity derivation failed: ${error.message}`);
      }
      if (id && ids.has(id)) errors.push(`duplicate derived InterviewNote identity: ${id}`);
      if (id) ids.add(id);
      normalized.push({ case_key: item.case_key, evidence, interview_note_id: id });
    }
  }
  normalized.sort((left, right) => left.case_key.localeCompare(right.case_key));
  return { ok: errors.length === 0, errors, cases: normalized, interview_note_ids: normalized.map((item) => item.interview_note_id) };
}

function canonicalInterviewCases(cases = []) {
  return [...cases]
    .map((item) => ({
      ...item,
      evidence: [...(item.evidence || [])].sort((left, right) => {
        const leftKey = `${left.ref}\n${left.locator}`;
        const rightKey = `${right.ref}\n${right.locator}`;
        return leftKey.localeCompare(rightKey);
      }),
    }))
    .sort((left, right) => left.case_key.localeCompare(right.case_key));
}

function computedInterviewNoteIds(record, decision, cases = null) {
  if (decision === 'not-interview') return [];
  if (decision === 'single-interview') {
    if (!record || !record.source || !record.source.system || !record.source.external_id) return [];
    return [`${record.source.system}:${record.source.external_id}`];
  }
  if (!Array.isArray(cases)) return [];
  return cases.map((item) => item.interview_note_id || childInterviewNoteId(record.source, item.case_key));
}

function replaceMachineRecord(body, nextRecord) {
  const re = /<!--\s*source-note-record\s*\n[\s\S]*?\n-->/;
  if (!re.test(String(body || ''))) throw new Error('source-note-record block not found for transition');
  return String(body).replace(re, `<!-- source-note-record\n${JSON.stringify(nextRecord, null, 2)}\n-->`);
}

function replaceReadableBoundarySection(body, decision, reviewedAt, ids, cases = []) {
  const re = /## 边界审核\n[\s\S]*?(?=\n## 来源限制)/;
  if (!re.test(String(body || ''))) throw new Error('readable boundary review section not found for transition');
  const lines = [
    '## 边界审核',
    '',
    `- 状态：\`${decision}\``,
    `- reviewed_at：\`${reviewedAt}\``,
  ];
  if (decision === 'not-interview') lines.push('- 结果：当前 Source 不创建 InterviewNote identity。');
  if (decision === 'single-interview') lines.push(`- InterviewNote id：\`${ids[0]}\``);
  if (decision === 'multi-interview') {
    lines.push('- 结果：Source evidence 支持多个有边界的 InterviewNote case；以下 identity 由 SourceNote 与稳定 case key 机械派生。');
    cases.forEach((item) => lines.push(`- case \`${item.case_key}\` → InterviewNote id：\`${item.interview_note_id}\``));
  }
  return String(body).replace(re, `${lines.join('\n')}\n`);
}

function targetStateMatches(request, record, labels, cases = null) {
  if (!record || !record.boundary_review) return false;
  if (record.boundary_review.status !== request.decision) return false;
  if (record.boundary_review.reviewed_at !== request.reviewed_at) return false;
  const expectedIds = computedInterviewNoteIds(record, request.decision, cases || record.boundary_review.interview_note_cases);
  if (canonicalJson(record.boundary_review.interview_note_ids || []) !== canonicalJson(expectedIds)) return false;
  if (request.decision === 'multi-interview'
      && canonicalJson(canonicalInterviewCases(record.boundary_review.interview_note_cases || []))
        !== canonicalJson(canonicalInterviewCases(cases || []))) return false;
  const labelSet = new Set(normalizeLabels(labels));
  if (!labelSet.has(`boundary:${request.decision}`)) return false;
  if (labelSet.has('task:boundary-review')) return false;
  return true;
}

function findReceipt(receipts, transitionId) {
  return (receipts || []).find((receipt) => receipt && receipt.transition_id === transitionId) || null;
}

function planSourceNoteBoundaryReviewTransition(request, issue, options = {}) {
  const errors = [];
  const requestResult = validateTransitionRequest(request);
  errors.push(...requestResult.errors);
  if (errors.length) return { ok: false, errors, request, already_applied: false };

  if (!issue || typeof issue !== 'object') return { ok: false, errors: ['live SourceNote issue is required'], request, already_applied: false };
  const issueNumber = Number(issue.number);
  if (issueNumber !== request.issue_number) errors.push(`issue_number mismatch: request=${request.issue_number} live=${issueNumber}`);
  const liveState = String(issue.state || '').toLowerCase();
  if (liveState !== 'open') errors.push(`boundary review transition requires open SourceNote issue, got ${issue.state}`);

  const body = String(issue.body || '');
  const parsed = parseSourceNoteIssue(body);
  if (parsed.recordParseError) errors.push(`live source-note-record JSON invalid: ${parsed.recordParseError}`);
  if (!parsed.record) errors.push('live SourceNote machine record missing');
  const record = parsed.record;
  if (parsed.marker && parsed.marker.source_note_id !== request.source_note_id) errors.push('live SourceNote marker does not match requested source_note_id');
  if (record && record.source_note_id !== request.source_note_id) errors.push('live record.source_note_id does not match request');
  if (record && (!record.source_revision || record.source_revision.id !== request.expected_source_revision_id)) errors.push('stale SourceRevision: live source_revision.id differs from expected_source_revision_id');

  if (record && record.schema_version === 'source-note-issue.v2') {
    if (!HEX64.test(String(request.expected_manifest_sha256 || ''))) errors.push('SourceNote v2 transition requires expected_manifest_sha256');
    if (request.expected_source_repository_ref !== null) errors.push('SourceNote v2 transition must use expected_source_repository_ref=null');
    if (record.source_revision && record.source_revision.manifest_sha256 !== request.expected_manifest_sha256) errors.push('stale SourceCapture manifest: live manifest_sha256 differs from expected_manifest_sha256');
  } else if (record && record.schema_version === 'source-note-issue.v1') {
    if (request.expected_manifest_sha256 !== null) errors.push('SourceNote v1 transition must use expected_manifest_sha256=null');
    if (!HEX40.test(String(request.expected_source_repository_ref || ''))) errors.push('SourceNote v1 transition requires expected_source_repository_ref');
    if (record.source_revision && record.source_revision.source_repository_ref !== request.expected_source_repository_ref) errors.push('stale Git Source snapshot: live source_repository_ref differs from expected_source_repository_ref');
  }

  const labels = normalizeLabels(issue.labels || []);

  let normalizedCases = null;
  if (request.decision === 'multi-interview') {
    const caseResult = validateInterviewCases(record, request.interview_cases);
    errors.push(...caseResult.errors);
    normalizedCases = caseResult.cases || [];
  }

  const evidenceComment = options.evidenceComment || null;
  if (!evidenceComment) {
    errors.push(`review evidence comment ${request.review_evidence.comment_id} is required`);
  } else {
    const evidenceId = Number(evidenceComment.id || evidenceComment.comment_id);
    if (evidenceId !== request.review_evidence.comment_id) errors.push('live review evidence comment id differs from request.review_evidence.comment_id');
    const evidenceBody = String(evidenceComment.body || '');
    if (!evidenceBody.trim()) errors.push('review evidence comment body must not be empty');
    const requiredEvidenceTokens = [
      request.transition_id,
      request.source_note_id,
      request.expected_source_revision_id,
      request.decision,
    ];
    if (request.expected_manifest_sha256) requiredEvidenceTokens.push(request.expected_manifest_sha256);
    if (request.expected_source_repository_ref) requiredEvidenceTokens.push(request.expected_source_repository_ref);
    if (request.decision === 'multi-interview') {
      for (const item of request.interview_cases || []) {
        requiredEvidenceTokens.push(item.case_key);
        for (const reference of item.evidence || []) requiredEvidenceTokens.push(reference.ref, reference.locator);
      }
    }
    for (const token of requiredEvidenceTokens) {
      if (typeof token !== 'string' || !evidenceBody.includes(token)) errors.push(`review evidence comment must bind transition fact: ${token || '(missing)'}`);
    }
    for (const checkId of REQUIRED_CHECK_IDS) {
      if (!evidenceBody.includes(checkId)) errors.push(`review evidence comment must name required check: ${checkId}`);
    }
  }

  const receipts = options.receipts || [];
  const receipt = findReceipt(receipts, request.transition_id);
  if (errors.length === 0 && record && targetStateMatches(request, record, labels, normalizedCases)) {
    if (receipt) {
      return {
        ok: true,
        errors: [],
        request,
        already_applied: true,
        receipt,
        decision: request.decision,
        interview_note_ids: computedInterviewNoteIds(record, request.decision, normalizedCases),
        current_body_sha256: sha256Text(body),
        next_body_sha256: sha256Text(body),
        next_body: body,
        next_labels: labels,
      };
    }
    return {
      ok: true,
      errors: [],
      request,
      already_applied: true,
      receipt: null,
      decision: request.decision,
      interview_note_ids: computedInterviewNoteIds(record, request.decision, normalizedCases),
      current_body_sha256: sha256Text(body),
      next_body_sha256: sha256Text(body),
      next_body: body,
      next_labels: labels,
      warnings: ['target boundary state already matches request but no applied receipt was found'],
    };
  }

  const liveBodySha = sha256Text(body);
  if (liveBodySha !== request.expected_body_sha256) errors.push(`stale SourceNote body: expected_body_sha256=${request.expected_body_sha256} live=${liveBodySha}`);
  if (record && (!record.boundary_review || record.boundary_review.status !== request.expected_boundary_status)) errors.push(`stale boundary state: expected=${request.expected_boundary_status} live=${record && record.boundary_review && record.boundary_review.status}`);
  if (record && record.boundary_review && record.boundary_review.interview_note_ids && record.boundary_review.interview_note_ids.length !== 0) errors.push('pending SourceNote must not already declare InterviewNote ids');

  const boundaryLabels = labels.filter((label) => label.startsWith('boundary:'));
  if (boundaryLabels.length !== 1 || boundaryLabels[0] !== `boundary:${request.expected_boundary_status}`) errors.push(`stale boundary label: expected exactly boundary:${request.expected_boundary_status}, found ${boundaryLabels.join(',') || 'none'}`);
  if (!labels.includes('task:boundary-review')) errors.push('pending SourceNote must still carry task:boundary-review before transition');

  if (errors.length) return { ok: false, errors, request, already_applied: false, current_body_sha256: liveBodySha };

  const ids = computedInterviewNoteIds(record, request.decision, normalizedCases);
  const nextRecord = JSON.parse(JSON.stringify(record));
  nextRecord.boundary_review = {
    status: request.decision,
    reviewed_at: request.reviewed_at,
    interview_note_ids: ids,
  };
  if (request.decision === 'multi-interview') nextRecord.boundary_review.interview_note_cases = normalizedCases;
  let nextBody;
  try {
    nextBody = replaceMachineRecord(body, nextRecord);
    nextBody = replaceReadableBoundarySection(nextBody, request.decision, request.reviewed_at, ids, normalizedCases || []);
  } catch (error) {
    return { ok: false, errors: [error.message], request, already_applied: false, current_body_sha256: liveBodySha };
  }
  const nextLabels = labels.filter((label) => !label.startsWith('boundary:') && label !== 'task:boundary-review');
  nextLabels.push(`boundary:${request.decision}`);
  const validation = validateSourceNoteIssue({ body: nextBody, labels: nextLabels, state: 'open' });
  if (!validation.ok) errors.push(...validation.errors.map((error) => `planned SourceNote invalid: ${error}`));

  return {
    ok: errors.length === 0,
    errors,
    request,
    already_applied: false,
    decision: request.decision,
    interview_note_ids: ids,
    previous_boundary_status: record.boundary_review.status,
    current_body_sha256: liveBodySha,
    next_body_sha256: sha256Text(nextBody),
    next_body: nextBody,
    current_labels: labels,
    next_labels: nextLabels,
    validator_warnings: validation.warnings || [],
    interview_note_cases: normalizedCases,
  };
}

function buildAppliedReceipt(request, plan, appliedAt) {
  return {
    schema_version: 'source-note-boundary-review-applied.v1',
    transition_id: request.transition_id,
    repository: request.repository,
    issue_number: request.issue_number,
    source_note_id: request.source_note_id,
    decision: request.decision,
    reviewed_at: request.reviewed_at,
    applied_at: appliedAt,
    previous_body_sha256: plan.current_body_sha256,
    new_body_sha256: plan.next_body_sha256,
    interview_note_ids: plan.interview_note_ids,
    interview_note_cases: plan.interview_note_cases || null,
  };
}

function renderAppliedReceiptComment(receipt) {
  return `<!-- source-note-boundary-review-applied\n${JSON.stringify(receipt, null, 2)}\n-->\n\nBoundary Review transition applied and post-write validation passed.`;
}

module.exports = {
  SCHEMA_VERSION,
  MULTI_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  REQUIRED_CHECK_IDS,
  SOURCE_EVIDENCE_PROVENANCE,
  sha256Text,
  normalizeLabels,
  canonicalJson,
  canonicalInterviewCases,
  parseSourceNoteBoundaryReviewTransition,
  parseAppliedBoundaryReviewReceipts,
  validateTransitionRequest,
  validateInterviewCases,
  computedInterviewNoteIds,
  planSourceNoteBoundaryReviewTransition,
  buildAppliedReceipt,
  renderAppliedReceiptComment,
};
