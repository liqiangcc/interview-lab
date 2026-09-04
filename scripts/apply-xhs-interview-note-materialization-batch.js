#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  sha256Text,
  requestSha256,
  parseMaterializationReceipts,
  planMaterialization,
  findOwnershipMatches,
} = require('./lib/source-note-interview-materialization');
const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { parseSourceNoteIssue } = require('./lib/source-note-issue');
const { childInterviewNoteId } = require('./lib/interview-note-identity');
const { exactOwnershipCandidates, ownershipSearchEndpoint, createSearchThrottle } = require('./lib/interview-note-ownership-search');

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }));
}
function ghReadJson(args, input = null, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 3;
  const retryPauseMs = Number.isFinite(options.retryPauseMs) ? options.retryPauseMs : 1000;
  const delay = typeof options.sleep === 'function' ? options.sleep : sleepMs;
  const read = typeof options.read === 'function' ? options.read : () => ghJson(args, input);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return read(); } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        if (typeof options.beforeRetry === 'function') options.beforeRetry();
        else delay(retryPauseMs * attempt);
      }
    }
  }
  throw lastError;
}
function labelsOf(issue) { return (issue.labels || []).map((x) => typeof x === 'string' ? x : x.name).filter(Boolean); }
function loadIssue(repository, number) { return ghReadJson(['api', `repos/${repository}/issues/${number}`]); }
function loadComments(repository, number) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghReadJson(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments response was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`Issue #${number} comments exceeded 100 pages; refusing to continue`);
}
function ownership(repository, interviewNoteId, beforePage, options = {}) {
  return exactOwnershipCandidates({
    interviewNoteId,
    readPage: options.readPage || ((page) => ghReadJson(['api', `${ownershipSearchEndpoint(repository, interviewNoteId)}&page=${page}`], null, { retryPauseMs: 2200, beforeRetry: beforePage })),
    readIssue: options.readIssue || ((number) => loadIssue(repository, number)),
    matches: findOwnershipMatches,
    beforePage,
  });
}
function patchLabels(repository, number, labels) { return ghJson(['api', '--method', 'PATCH', `repos/${repository}/issues/${number}`, '--input', '-'], { labels }); }
function addComment(repository, number, body) { return ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-'], { body }); }
function createIssue(repository, projection) { return ghJson(['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], { title: projection.title, body: projection.body, labels: projection.labels }); }
function parseArgs(argv = process.argv.slice(2)) {
  const out = { report: null, apply: false, confirm: false, authorizationDigest: null, maxMutations: null, pauseMs: 2200 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--confirm-dry-run') out.confirm = true;
    else if (argv[i] === '--authorization-digest') out.authorizationDigest = argv[++i];
    else if (argv[i] === '--max-mutations') out.maxMutations = Number(argv[++i]);
    else if (argv[i] === '--pause-ms') out.pauseMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.report) throw new Error('--report is required');
  if (!Number.isInteger(out.pauseMs) || out.pauseMs < 2100) throw new Error('--pause-ms must be an integer >= 2100');
  if (out.maxMutations != null && (!Number.isInteger(out.maxMutations) || out.maxMutations < 1)) throw new Error('--max-mutations must be a positive integer');
  return out;
}
function readAuthorizedReport(file, digest) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { dry_run_sha256: actual, ...withoutDigest } = report;
  const expected = sha256Text(JSON.stringify(withoutDigest));
  if (!actual || actual !== expected) throw new Error(`dry-run report digest is invalid: expected ${expected}, got ${actual || 'missing'}`);
  if (digest !== actual) throw new Error(`authorization digest does not match dry-run report: ${digest || 'missing'} != ${actual}`);
  if (report.mutation_performed !== false) throw new Error('only a mutation-free dry-run report may authorize apply');
  if (!report.dependency_gate || report.dependency_gate.ok !== true) throw new Error('dependency gate is not passing');
  if (report.ready_for_apply !== true) throw new Error('dry-run report ready_for_apply is not true');
  if (report.apply_blocked !== 0) throw new Error(`report contains ${report.apply_blocked} hard-blocked cases`);
  const candidates = (report.results || []).filter((entry) => ['would-materialize', 'would-repair-receipt'].includes(entry.action));
  if (candidates.length !== Number(report.materialization_candidates)) throw new Error(`report candidate count mismatch: rows=${candidates.length} summary=${report.materialization_candidates}`);
  if (Number(report.counts && report.counts['would-materialize'] || 0) + Number(report.counts && report.counts['would-repair-receipt'] || 0) !== candidates.length) throw new Error('report action counts do not match candidate rows');
  return report;
}

function parseDependencyEvidenceUrl(repository, dependencyNumber, evidenceUrl) {
  let parsed;
  try { parsed = new URL(evidenceUrl); } catch (_) { throw new Error(`#${dependencyNumber} dependency evidence URL is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/') !== repository) {
    throw new Error(`#${dependencyNumber} dependency evidence URL is outside ${repository}`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length === 4 && parts[2] === 'issues' && /^\d+$/.test(parts[3]) && /^issuecomment-\d+$/.test(parsed.hash.slice(1))) {
    if (Number(parts[3]) !== Number(dependencyNumber)) throw new Error(`#${dependencyNumber} evidence comment belongs to Issue #${parts[3]}`);
    return { kind: 'issue-comment', issue_number: Number(parts[3]), comment_id: Number(parsed.hash.slice(1).slice('issuecomment-'.length)) };
  }
  if (parts.length === 4 && parts[2] === 'commit' && /^[0-9a-f]{7,40}$/.test(parts[3]) && !parsed.hash) {
    return { kind: 'commit', ref: parts[3] };
  }
  throw new Error(`#${dependencyNumber} dependency evidence URL must identify a readable issue comment or commit`);
}

const DEPENDENCY_ACCEPTANCE_RE = /<!--\s*issue-dependency-acceptance\s*\n([\s\S]*?)\n-->/g;
function parseDependencyAcceptance(body, repository, dependencyNumber) {
  const text = String(body || '');
  const matches = [...text.matchAll(DEPENDENCY_ACCEPTANCE_RE)];
  const openings = (text.match(/<!--\s*issue-dependency-acceptance\b/g) || []).length;
  if (openings !== matches.length || matches.length !== 1) throw new Error(`#${dependencyNumber} evidence must contain exactly one issue-dependency-acceptance marker`);
  let value;
  try { value = JSON.parse(matches[0][1].trim()); } catch (error) { throw new Error(`#${dependencyNumber} dependency acceptance marker JSON is invalid: ${error.message}`); }
  const allowed = new Set(['schema_version', 'issue_number', 'acceptance', 'accepted_by', 'acceptance_evidence']);
  for (const key of Object.keys(value || {})) if (!allowed.has(key)) throw new Error(`#${dependencyNumber} dependency acceptance marker has unsupported field ${key}`);
  if (!value || value.schema_version !== 'issue-dependency-acceptance.v1' || value.issue_number !== Number(dependencyNumber) || value.acceptance !== 'pass' || typeof value.accepted_by !== 'string' || !value.accepted_by.trim()) {
    throw new Error(`#${dependencyNumber} dependency acceptance marker is not a final structured pass`);
  }
  const support = parseDependencyEvidenceUrl(repository, dependencyNumber, value.acceptance_evidence);
  if (support.kind !== 'issue-comment') throw new Error(`#${dependencyNumber} acceptance_evidence must identify an issue comment`);
  return value;
}

function assertEvidenceIssueUrl(evidence, repository, dependencyNumber) {
  const expectedPath = `/repos/${repository}/issues/${dependencyNumber}`;
  let parsed;
  try { parsed = new URL(String(evidence && evidence.issue_url || '')); } catch (_) { throw new Error(`#${dependencyNumber} evidence comment has no valid issue_url`); }
  if (parsed.hostname !== 'api.github.com' || parsed.pathname !== expectedPath) throw new Error(`#${dependencyNumber} evidence comment issue_url does not belong to dependency Issue`);
}

function readDependencyEvidence(repository, anchor) {
  return anchor.kind === 'issue-comment'
    ? ghReadJson(['api', `repos/${repository}/issues/comments/${anchor.comment_id}`])
    : ghReadJson(['api', `repos/${repository}/commits/${anchor.ref}`]);
}

function validateLiveDependencyGate(report, options = {}) {
  const dependencies = report.dependency_gate && report.dependency_gate.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error('dry-run report lacks structured dependency-gate entries');
  const readIssue = options.readIssue || ((number) => loadIssue(report.repository, number));
  const readEvidence = options.readEvidence || ((anchor) => readDependencyEvidence(report.repository, anchor));
  for (const dependencyNumber of ['917', '920', '921']) {
    const item = dependencies[dependencyNumber];
    if (!item || item.issue_number !== Number(dependencyNumber) || item.state !== 'closed' || item.acceptance !== 'pass' || item.evidence_schema !== 'issue-dependency-acceptance.v1' || typeof item.evidence !== 'string' || !item.evidence.trim() || typeof item.acceptance_evidence !== 'string' || !item.acceptance_evidence.trim()) {
      throw new Error(`#${dependencyNumber} live dependency artifact entry is not structurally accepted`);
    }
    const liveIssue = readIssue(Number(dependencyNumber));
    if (!liveIssue || String(liveIssue.state || '').toLowerCase() !== 'closed') throw new Error(`#${dependencyNumber} live dependency is not closed`);
    const anchor = parseDependencyEvidenceUrl(report.repository, dependencyNumber, item.evidence);
    const evidence = readEvidence(anchor);
    if (!evidence || typeof evidence !== 'object') throw new Error(`#${dependencyNumber} dependency evidence resource is not readable`);
    if (anchor.kind !== 'issue-comment') throw new Error(`#${dependencyNumber} dependency acceptance anchor must be an issue comment`);
    if (Number(evidence.id) !== anchor.comment_id) throw new Error(`#${dependencyNumber} evidence comment identity mismatch`);
    assertEvidenceIssueUrl(evidence, report.repository, dependencyNumber);
    const marker = parseDependencyAcceptance(evidence.body, report.repository, dependencyNumber);
    if (marker.acceptance_evidence !== item.acceptance_evidence) throw new Error(`#${dependencyNumber} acceptance_evidence does not match dependency gate artifact`);
    const support = parseDependencyEvidenceUrl(report.repository, dependencyNumber, item.acceptance_evidence);
    const supportEvidence = readEvidence(support);
    if (!supportEvidence || typeof supportEvidence !== 'object' || Number(supportEvidence.id) !== support.comment_id) throw new Error(`#${dependencyNumber} acceptance_evidence resource is not readable`);
    assertEvidenceIssueUrl(supportEvidence, report.repository, dependencyNumber);
  }
  return true;
}
function materializationReceipt(request, plan, issueNumber) {
  return {
    schema_version: request.case_key == null ? 'source-note-interview-materialized.v1' : 'source-note-interview-materialized.v2',
    materialization_id: request.materialization_id,
    request_sha256: plan.request_sha256,
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256 ?? null,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    interview_note_id: plan.interview_note_id,
    ...(request.case_key == null ? {} : { case_key: request.case_key }),
    interview_issue_number: Number(issueNumber),
    interview_issue_body_sha256: sha256Text(plan.projection.body),
    materialized_at: new Date().toISOString(),
  };
}
function receiptBody(receipt) { return `<!-- source-note-interview-materialized\n${JSON.stringify(receipt, null, 2)}\n-->\n\nInterviewNote materialization completed and post-create validation passed.`; }
function blockedReviewBody(request, interviewNoteId, reason) {
  return `<!-- interview-note-source-review-blocked\n${JSON.stringify({
    schema_version: 'interview-note-source-review-blocked.v1',
    materialization_id: request.materialization_id,
    interview_note_id: interviewNoteId,
    case_key: request.case_key || null,
    source_note_issue_number: request.source_note_issue_number,
    reason,
    evidence_policy: 'Boundary Review evidence is not used as InterviewNote Source Review evidence; independent InterviewNote evidence is required.',
  }, null, 2)}\n-->`;
}
function findBlockedReview(comments, request, interviewNoteId) {
  let found = null;
  for (const comment of comments || []) {
    const match = String(comment.body || '').match(/<!--\s*interview-note-source-review-blocked\s*\n([\s\S]*?)\n-->/);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (value.interview_note_id === interviewNoteId && value.materialization_id !== request.materialization_id) throw new Error('blocked review marker conflicts with this materialization');
      if (value.materialization_id === request.materialization_id) {
        if (value.interview_note_id !== interviewNoteId) throw new Error('blocked review marker identity mismatch');
        if ((value.case_key == null ? null : value.case_key) !== (request.case_key == null ? null : request.case_key)) throw new Error('blocked review marker case_key mismatch');
        if (found) throw new Error('duplicate blocked review markers for the same materialization');
        found = comment;
      }
    } catch (error) { throw new Error(`invalid blocked review marker: ${error.message}`); }
  }
  return found;
}
function waitForOwnership(read, expectedIssueNumber, sleep, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 4;
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = read();
    if (last.length > 1) throw new Error(`post-create duplicate ownership conflict: ${last.map((issue) => issue.number).join(',')}`);
    if (last.length === 1) {
      if (Number(last[0].number) !== Number(expectedIssueNumber)) throw new Error(`post-create ownership points to unexpected Issue #${last[0].number}; expected #${expectedIssueNumber}`);
      return last;
    }
    if (attempt < attempts) sleep(attempt * 1);
  }
  throw new Error(`post-create ownership was not visible after ${attempts} bounded retries; found ${last.map((issue) => issue.number).join(',') || 'none'}`);
}
function atomicWrite(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
function completedMaterializationIds(results) {
  return new Set((results || [])
    .filter((item) => item && item.status === 'succeeded' && ['blocked', 'source-ready'].includes(item.final_status) && Number.isInteger(Number(item.interview_issue_number)))
    .map((item) => item.materialization_id));
}
const INTENT_SCHEMA_VERSION = 'source-note-interview-materialization-intent.v1';

function materializationIntent(request, plan, phase = 'create-pending') {
  return {
    schema_version: INTENT_SCHEMA_VERSION,
    materialization_id: request.materialization_id,
    request_sha256: plan.request_sha256,
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    interview_note_id: plan.interview_note_id,
    case_key: request.case_key == null ? null : request.case_key,
    projection_body_sha256: sha256Text(plan.projection.body),
    phase,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function validateMaterializationIntent(intent, request, plan) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error(`mutation intent for ${request.materialization_id} is malformed; refusing POST`);
  const expected = materializationIntent(request, plan, intent.phase);
  const required = ['schema_version', 'materialization_id', 'request_sha256', 'repository', 'source_note_issue_number', 'source_note_id', 'interview_note_id', 'case_key', 'projection_body_sha256', 'phase'];
  for (const key of required) if (!(key in intent)) throw new Error(`mutation intent for ${request.materialization_id} lacks ${key}; refusing POST`);
  for (const key of required) if (intent[key] !== expected[key]) throw new Error(`mutation intent for ${request.materialization_id} does not match the live request/plan at ${key}; refusing POST`);
  if (!['create-pending', 'create-response-lost', 'resolved'].includes(intent.phase)) throw new Error(`mutation intent for ${request.materialization_id} has unsupported phase; refusing POST`);
  return true;
}

function recoverExactOwner(read, sleep, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 4;
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = read();
    if (!Array.isArray(last)) throw new Error('ownership recovery returned a non-array; refusing to infer the POST result');
    if (last.length > 1) throw new Error(`ownership recovery found duplicate InterviewNote owners: ${last.map((issue) => issue.number).join(',')}`);
    if (last.length === 1) return last[0];
    if (attempt < attempts) sleep(attempt * (Number.isFinite(options.pauseMs) ? options.pauseMs : 1));
  }
  throw new Error(`unresolved mutation intent: exact owner was not visible after ${attempts} bounded recovery attempts; refusing another POST`);
}

function resultFor(request, plan, issueNumber, created, finalStatus, extra = {}) {
  return {
    status: 'succeeded',
    materialization_id: request.materialization_id,
    request_sha256: plan.request_sha256,
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    interview_note_id: plan.interview_note_id,
    case_key: request.case_key == null ? null : request.case_key,
    interview_issue_number: Number(issueNumber),
    created,
    final_status: finalStatus,
    ...extra,
  };
}

function candidateMap(report) {
  const map = new Map();
  for (const entry of report.results || []) {
    if (!['would-materialize', 'would-repair-receipt'].includes(entry.action) || !entry.request) continue;
    const id = entry.request.materialization_id;
    if (map.has(id)) throw new Error(`report contains duplicate materialization_id ${id}`);
    map.set(id, entry.request);
  }
  return map;
}

function validateProgress(progress, report) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) throw new Error('apply progress is not an object; refusing to resume');
  if (progress.schema_version !== 'source-note-interview-materialization-apply-progress.v1') throw new Error('apply progress schema is unsupported; refusing to resume');
  if (progress.dry_run_sha256 !== report.dry_run_sha256) throw new Error('apply progress belongs to a different dry-run digest');
  if (!Array.isArray(progress.results)) throw new Error('apply progress results must be an array; refusing to resume');
  const candidates = candidateMap(report);
  const successful = new Map();
  for (const item of progress.results) {
    if (!item || typeof item !== 'object' || !candidates.has(item.materialization_id)) throw new Error('apply progress contains an unknown or malformed materialization_id; refusing to resume');
    const request = candidates.get(item.materialization_id);
    if (item.status === 'failed') {
      if (typeof item.error !== 'string' || !item.error.trim() || item.final_status != null) throw new Error(`failed progress entry ${item.materialization_id} is malformed; refusing to resume`);
      continue;
    }
    if (item.status !== 'succeeded' || !['blocked', 'source-ready'].includes(item.final_status)) throw new Error(`progress entry ${item.materialization_id} is not an explicit successful convergence; refusing to resume`);
    if (successful.has(item.materialization_id)) throw new Error(`progress contains duplicate successful results for ${item.materialization_id}`);
    const expectedId = request.case_key == null
      ? null
      : request.case_key;
    if (item.request_sha256 !== requestSha256(request) || item.repository !== request.repository || item.source_note_issue_number !== request.source_note_issue_number || item.source_note_id !== request.source_note_id || item.case_key !== expectedId || typeof item.interview_note_id !== 'string' || !Number.isInteger(Number(item.interview_issue_number))) {
      throw new Error(`progress entry ${item.materialization_id} does not match its report request mapping; refusing to resume`);
    }
    const materialization = (report.results || []).find((entry) => entry.request && entry.request.materialization_id === item.materialization_id).materialization;
    if (!materialization || item.interview_note_id !== materialization.interview_note_id) throw new Error(`progress entry ${item.materialization_id} has the wrong InterviewNote identity; refusing to resume`);
    if (materialization.existing_issue_number != null && Number(item.interview_issue_number) !== Number(materialization.existing_issue_number)) throw new Error(`progress entry ${item.materialization_id} has the wrong InterviewNote Issue number; refusing to resume`);
    successful.set(item.materialization_id, item);
  }
  const intents = progress.intents == null ? {} : progress.intents;
  if (!intents || typeof intents !== 'object' || Array.isArray(intents)) throw new Error('apply progress mutation intents are malformed; refusing to resume');
  for (const id of Object.keys(intents)) if (!candidates.has(id)) throw new Error(`apply progress contains an intent for unknown materialization ${id}; refusing to resume`);
  return { candidates, successful };
}

function recheckCompletedItem(request, expectedResult, pauseMs, searchThrottle = createSearchThrottle(pauseMs, sleepMs), options = {}) {
  const api = {
    loadIssue: options.loadIssue || loadIssue,
    loadComments: options.loadComments || loadComments,
    ownership: options.ownership || ((repository, interviewNoteId) => ownership(repository, interviewNoteId, searchThrottle)),
  };
  const source = api.loadIssue(request.repository, request.source_note_issue_number);
  const sourceComments = api.loadComments(request.repository, request.source_note_issue_number);
  const sourceRecord = parseSourceNoteIssue(source.body).record;
  if (!sourceRecord) throw new Error(`completed progress ${request.materialization_id} SourceNote has no valid machine record`);
  const target = request.case_key ? childInterviewNoteId(sourceRecord.source, request.case_key) : `${sourceRecord.source.system}:${sourceRecord.source.external_id}`;
  if (expectedResult.interview_note_id !== target) throw new Error(`completed progress ${request.materialization_id} identity does not match live SourceNote`);
  const owners = api.ownership(request.repository, target);
  if (owners.length !== 1 || Number(owners[0].number) !== Number(expectedResult.interview_issue_number)) throw new Error(`completed progress ${request.materialization_id} failed live ownership recheck`);
  const plan = planMaterialization(request, { repository: request.repository, sourceIssue: source, issues: owners, receipts: parseMaterializationReceipts(sourceComments) });
  if (!plan.ok || !plan.already_materialized || plan.existing_issue_number !== Number(expectedResult.interview_issue_number)) throw new Error(`completed progress ${request.materialization_id} failed live materialization recheck`);
  const interview = api.loadIssue(request.repository, Number(expectedResult.interview_issue_number));
  const labels = labelsOf(interview);
  const currentStatus = labels.find((label) => label.startsWith('status:'));
  if (currentStatus === 'status:source-ready') {
    if (expectedResult.final_status !== 'source-ready' || !validateInterviewNoteIssue({ body: interview.body, labels, state: interview.state }).ok) throw new Error(`completed progress ${request.materialization_id} source-ready recheck failed`);
    return true;
  }
  if (currentStatus === 'status:blocked' && expectedResult.final_status === 'blocked' && labels.includes('task:source-recovery') && findBlockedReview(api.loadComments(request.repository, Number(expectedResult.interview_issue_number)), request, target)) return true;
  throw new Error(`completed progress ${request.materialization_id} status/review recheck failed`);
}

function applyOne(request, pauseMs, searchThrottle = createSearchThrottle(pauseMs, sleepMs), options = {}) {
  const api = {
    loadIssue: options.loadIssue || loadIssue,
    loadComments: options.loadComments || loadComments,
    ownership: options.ownership || ((repository, interviewNoteId) => ownership(repository, interviewNoteId, searchThrottle)),
    createIssue: options.createIssue || createIssue,
    patchLabels: options.patchLabels || patchLabels,
    addComment: options.addComment || addComment,
    sleep: options.sleep || sleepMs,
  };
  const persistIntent = typeof options.persistIntent === 'function' ? options.persistIntent : () => {};
  const source = api.loadIssue(request.repository, request.source_note_issue_number);
  const sourceComments = api.loadComments(request.repository, request.source_note_issue_number);
  const sourceRecord = parseSourceNoteIssue(source.body).record;
  if (!sourceRecord) throw new Error(`SourceNote #${request.source_note_issue_number} has no valid machine record`);
  const target = request.case_key ? childInterviewNoteId(sourceRecord.source, request.case_key) : `${sourceRecord.source.system}:${sourceRecord.source.external_id}`;
  const currentOwners = api.ownership(request.repository, target);
  const plan = planMaterialization(request, { repository: request.repository, sourceIssue: source, issues: currentOwners, receipts: parseMaterializationReceipts(sourceComments) });
  if (!plan.ok) throw new Error(`pre-write CAS failed for ${request.materialization_id}: ${plan.errors.join('; ')}`);
  let issueNumber = plan.existing_issue_number;
  let created = false;
  let intent = options.intent || null;
  if (intent) validateMaterializationIntent(intent, request, plan);
  if (plan.action === 'create') {
    if (intent && intent.phase === 'resolved') {
      throw new Error(`resolved mutation intent for ${request.materialization_id} has no live owner; refusing another POST`);
    } else if (intent) {
      const recovered = recoverExactOwner(
        () => api.ownership(request.repository, plan.interview_note_id),
        api.sleep,
        { attempts: options.unresolvedIntentAttempts || 8, pauseMs }
      );
      issueNumber = Number(recovered.number);
    } else {
      intent = materializationIntent(request, plan);
      persistIntent(intent);
      let createdIssue;
      try {
        createdIssue = api.createIssue(request.repository, plan.projection);
        if (!createdIssue || !Number.isInteger(Number(createdIssue.number))) throw new Error('create response lacked a valid Issue number');
        issueNumber = Number(createdIssue.number);
        created = true;
      } catch (error) {
        intent = { ...intent, phase: 'create-response-lost', updated_at: new Date().toISOString() };
        persistIntent(intent);
        try {
          const recovered = recoverExactOwner(
            () => api.ownership(request.repository, plan.interview_note_id),
            api.sleep,
            { attempts: options.responseLossAttempts || 4, pauseMs }
          );
          issueNumber = Number(recovered.number);
        } catch (recoveryError) {
          throw new Error(`${error.message}; ${recoveryError.message}`);
        }
      }
    }
    const live = api.loadIssue(request.repository, issueNumber);
    const valid = validateInterviewNoteIssue({ body: live.body, labels: labelsOf(live), state: live.state });
    if (!valid.ok || sha256Text(live.body) !== sha256Text(plan.projection.body)) throw new Error(`post-create InterviewNote validation failed for #${issueNumber}`);
    api.sleep(pauseMs);
    waitForOwnership(() => api.ownership(request.repository, plan.interview_note_id), issueNumber, (ms) => api.sleep(ms * pauseMs));
  }
  if (!plan.receipt) {
    const receipt = materializationReceipt(request, plan, issueNumber);
    api.addComment(request.repository, request.source_note_issue_number, receiptBody(receipt));
  }
  const finalSource = api.loadIssue(request.repository, request.source_note_issue_number);
  const finalOwners = api.ownership(request.repository, plan.interview_note_id);
  const final = planMaterialization(request, { repository: request.repository, sourceIssue: finalSource, issues: finalOwners, receipts: parseMaterializationReceipts(api.loadComments(request.repository, request.source_note_issue_number)) });
  if (!final.ok || !final.already_materialized) throw new Error(`final materialization CAS did not converge for ${request.materialization_id}`);
  const liveInterview = api.loadIssue(request.repository, issueNumber);
  const liveLabels = labelsOf(liveInterview);
  const statusLabels = liveLabels.filter((label) => label.startsWith('status:'));
  const currentStatus = statusLabels[0] || null;
  if (currentStatus === 'status:source-ready') {
    const valid = validateInterviewNoteIssue({ body: liveInterview.body, labels: labelsOf(liveInterview), state: liveInterview.state });
    if (!valid.ok) throw new Error(`existing source-ready InterviewNote validation failed for #${issueNumber}: ${valid.errors.join('; ')}`);
    if (intent && intent.phase !== 'resolved') persistIntent({ ...intent, phase: 'resolved', updated_at: new Date().toISOString() });
    return resultFor(request, plan, issueNumber, created, 'source-ready', { receipt_repaired: !plan.receipt });
  }
  if (currentStatus === 'status:blocked') {
    if (statusLabels.length !== 1 || !liveLabels.includes('task:source-recovery') || liveLabels.includes('task:source-review')) throw new Error(`existing blocked InterviewNote is not exactly the source-recovery state for ${request.materialization_id}`);
    const interviewComments = api.loadComments(request.repository, issueNumber);
    const existingBlocked = findBlockedReview(interviewComments, request, plan.interview_note_id);
    if (!existingBlocked) api.addComment(request.repository, issueNumber, blockedReviewBody(request, plan.interview_note_id, 'independent InterviewNote Source Review evidence was not supplied in this authorized batch; Boundary Review evidence is deliberately not reused'));
    const blockedFinal = api.loadIssue(request.repository, issueNumber);
    const blockedComments = api.loadComments(request.repository, issueNumber);
    if (!labelsOf(blockedFinal).includes('status:blocked') || !labelsOf(blockedFinal).includes('task:source-recovery') || !findBlockedReview(blockedComments, request, plan.interview_note_id)) throw new Error(`blocked Source Review recovery state did not converge for ${request.materialization_id}`);
    if (intent && intent.phase !== 'resolved') persistIntent({ ...intent, phase: 'resolved', updated_at: new Date().toISOString() });
    return resultFor(request, plan, issueNumber, created, 'blocked', { receipt_repaired: !plan.receipt });
  }
  const blockedLabels = [...new Set(labelsOf(liveInterview).filter((label) => !label.startsWith('status:') && label !== 'task:source-review' && label !== 'task:source-recovery'))].sort();
  blockedLabels.push('status:blocked', 'task:source-recovery');
  if (JSON.stringify(labelsOf(liveInterview).sort()) !== JSON.stringify([...new Set(blockedLabels)].sort())) api.patchLabels(request.repository, issueNumber, [...new Set(blockedLabels)].sort());
  const interviewComments = api.loadComments(request.repository, issueNumber);
  if (!findBlockedReview(interviewComments, request, plan.interview_note_id)) api.addComment(request.repository, issueNumber, blockedReviewBody(request, plan.interview_note_id, 'independent InterviewNote Source Review evidence was not supplied in this authorized batch; Boundary Review evidence is deliberately not reused'));
  const blockedFinal = api.loadIssue(request.repository, issueNumber);
  const blockedComments = api.loadComments(request.repository, issueNumber);
  if (!labelsOf(blockedFinal).includes('status:blocked') || !labelsOf(blockedFinal).includes('task:source-recovery') || !findBlockedReview(blockedComments, request, plan.interview_note_id)) throw new Error(`blocked Source Review recovery state did not converge for ${request.materialization_id}`);
  if (intent && intent.phase !== 'resolved') persistIntent({ ...intent, phase: 'resolved', updated_at: new Date().toISOString() });
  api.sleep(pauseMs);
  return resultFor(request, plan, issueNumber, created, 'blocked');
}
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = readAuthorizedReport(args.report, args.authorizationDigest);
  validateLiveDependencyGate(report);
  if (!args.apply || !args.confirm) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'authorization-preflight', dry_run_sha256: report.dry_run_sha256, mutation_performed: false, eligible_mutations: report.materialization_candidates, required_flags: ['--apply', '--confirm-dry-run', '--authorization-digest <digest>'] }, null, 2)}\n`);
    return 0;
  }
  const max = args.maxMutations == null ? report.materialization_candidates : args.maxMutations;
  if (max > report.materialization_candidates) throw new Error(`--max-mutations ${max} exceeds report candidate count ${report.materialization_candidates}`);
  if (max !== report.materialization_candidates) throw new Error('partial apply is disabled until the batch coordinator provides a resumable item manifest');
  const progressFile = `${args.report}.apply-progress.json`;
  let progress = fs.existsSync(progressFile)
    ? JSON.parse(fs.readFileSync(progressFile, 'utf8'))
    : { schema_version: 'source-note-interview-materialization-apply-progress.v1', dry_run_sha256: report.dry_run_sha256, results: [], intents: {} };
  const progressState = validateProgress(progress, report);
  let results = [...progress.results];
  progress = { ...progress, intents: progress.intents || {} };
  const persistProgress = (status) => {
    progress = { ...progress, status, updated_at: new Date().toISOString(), results };
    atomicWrite(progressFile, progress);
  };
  const persistIntent = (intent) => {
    progress = { ...progress, intents: { ...progress.intents, [intent.materialization_id]: intent }, updated_at: new Date().toISOString() };
    atomicWrite(progressFile, progress);
  };
  persistProgress('running');
  const completed = completedMaterializationIds(results);
  const searchThrottle = createSearchThrottle(args.pauseMs, sleepMs);
  for (const item of report.results.filter((entry) => ['would-materialize', 'would-repair-receipt'].includes(entry.action))) {
    let result;
    try {
      if (completed.has(item.request.materialization_id)) {
        recheckCompletedItem(item.request, progressState.successful.get(item.request.materialization_id), args.pauseMs, searchThrottle);
        continue;
      }
      result = applyOne(item.request, args.pauseMs, searchThrottle, {
        intent: progress.intents[item.request.materialization_id] || null,
        persistIntent,
      });
    } catch (error) {
      result = { materialization_id: item.request.materialization_id, status: 'failed', error: error.message, failed_at: new Date().toISOString() };
      results.push(result);
      persistProgress('failed');
      throw error;
    }
    results.push(result);
    persistProgress('running');
    sleepMs(args.pauseMs);
  }
  atomicWrite(progressFile, { ...progress, status: 'complete', updated_at: new Date().toISOString(), results });
  process.stdout.write(`${JSON.stringify({ ok: true, mode: 'apply', dry_run_sha256: report.dry_run_sha256, mutation_performed: true, results }, null, 2)}\n`);
  return 0;
}
if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { parseArgs, ghReadJson, readAuthorizedReport, parseDependencyEvidenceUrl, parseDependencyAcceptance, validateLiveDependencyGate, materializationReceipt, blockedReviewBody, findBlockedReview, waitForOwnership, atomicWrite, completedMaterializationIds, loadComments, ownership, materializationIntent, validateMaterializationIntent, recoverExactOwner, validateProgress, recheckCompletedItem, applyOne };
