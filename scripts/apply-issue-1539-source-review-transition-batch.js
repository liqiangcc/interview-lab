#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseRequest, parseReceipts } = require('./lib/interview-note-source-review-transition');
const { loadOwnershipMatches } = require('./plan-interview-note-source-review-transition');
const {
  BATCH_SCHEMA_VERSION,
  BATCH_ID,
  REPOSITORY,
  PACKET_SET_SHA256,
  PINNED_ARTIFACT_MANIFEST_SHA256,
  ISSUE_NUMBERS,
  initialProgress,
  validateProgress,
  planBatch,
  applyBatch,
  durableWriteJson,
  issueSnapshot,
  sameSnapshot,
  lifecycleOperationPlan,
  applyLifecycleOperation,
  lifecycleLabels,
  nonLifecycleLabels,
  preservesNonLifecycleLabels,
} = require('./lib/issue-1539-source-review-transition-batch');
const { validateManifest, verifyManifestDigest } = require('./lib/issue-1539-pinned-artifact-manifest');
const { acquireProgressLock } = require('./lib/issue-1539-evidence-batch');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    requestDir: null,
    pinnedArtifactManifest: null,
    output: null,
    progress: null,
    progressLock: null,
    confirmPlanSha256: null,
    minMutationIntervalMs: 1000,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--pinned-artifact-manifest') args.pinnedArtifactManifest = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--progress') args.progress = argv[++index];
    else if (arg === '--progress-lock') args.progressLock = argv[++index];
    else if (arg === '--confirm-plan-sha256') args.confirmPlanSha256 = argv[++index];
    else if (arg === '--min-mutation-interval-ms') args.minMutationIntervalMs = Number(argv[++index]);
    else if (arg === '--apply') args.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['requestDir', 'pinnedArtifactManifest', 'output', 'progress', 'progressLock']) if (!args[key]) throw new Error(`--${key} is required`);
  if (!Number.isInteger(args.minMutationIntervalMs) || args.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  if (args.apply && !/^[0-9a-f]{64}$/.test(String(args.confirmPlanSha256 || ''))) throw new Error('--apply requires --confirm-plan-sha256 <sha256>');
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function ghJson(args, input = null) {
  const output = execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return output.trim() ? JSON.parse(output) : null;
}
function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function loadRequests(requestDir) {
  const absolute = path.resolve(requestDir);
  const expected = new Set(ISSUE_NUMBERS.map((issue) => `issue-${issue}.json`));
  const jsonFiles = fs.readdirSync(absolute).filter((file) => file.endsWith('.json')).sort();
  if (jsonFiles.length !== expected.size || jsonFiles.some((file) => !expected.has(file))) throw new Error('request directory must contain exactly issue-1509.json through issue-1538.json');
  return ISSUE_NUMBERS.map((issue) => {
    const jsonPath = path.join(absolute, `issue-${issue}.json`);
    const mdPath = path.join(absolute, `issue-${issue}.md`);
    const request = readJson(jsonPath);
    if (!fs.existsSync(mdPath)) throw new Error(`missing Markdown request companion for #${issue}`);
    const parsed = parseRequest(fs.readFileSync(mdPath, 'utf8'));
    if (!parsed.request || !deepEqual(parsed.request, request)) throw new Error(`#${issue}: JSON request does not match Markdown request marker`);
    return request;
  });
}

function loadPinnedArtifactManifest(file) {
  const manifest = readJson(file);
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`invalid pinned artifact manifest: ${validation.errors.join('; ')}`);
  const digest = verifyManifestDigest(manifest, PINNED_ARTIFACT_MANIFEST_SHA256);
  if (!digest.ok) throw new Error(digest.errors.join('; '));
  return manifest;
}

function loadIssue(repository, issueNumber) { return ghJson(['api', `repos/${repository}/issues/${issueNumber}`]); }
function loadComments(repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghJson(['api', `repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`#${issueNumber}: comments response was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`#${issueNumber}: comments exceeded 100 pages`);
}
function loadEvidence(repository, commentId) { return ghJson(['api', `repos/${repository}/issues/comments/${commentId}`]); }
function loadLive(request) {
  const comments = loadComments(request.repository, request.issue_number);
  const parsedReceipts = parseReceipts(comments);
  if (parsedReceipts.errors.length) throw new Error(`#${request.issue_number}: ${parsedReceipts.errors.join('; ')}`);
  return {
    interviewIssue: loadIssue(request.repository, request.issue_number),
    sourceIssue: loadIssue(request.repository, request.source_note_issue_number),
    evidenceComment: loadEvidence(request.repository, request.review_evidence.comment_id),
    receipts: parsedReceipts.receipts,
    allIssues: loadOwnershipMatches(request.repository, request.interview_note_id),
  };
}
function patchLifecycleLabelOperation(request, operation, expectedSnapshot, operations = {}) {
  if (!expectedSnapshot || !Array.isArray(expectedSnapshot.labels)) throw new Error(`#${request.issue_number}: lifecycle PATCH requires the recorded precondition snapshot`);
  if (!operation || !['add', 'remove'].includes(operation.kind) || typeof operation.label !== 'string' || !operation.label.startsWith('status:') && !['task:source-recovery', 'task:source-review'].includes(operation.label)) {
    throw new Error(`#${request.issue_number}: invalid lifecycle label operation`);
  }
  const readIssue = operations.loadIssue || loadIssue;
  const callGh = operations.ghJson || ghJson;
  const addLabels = operations.addLabels || ((repository, issueNumber, values) => callGh(['api', '--method', 'POST', `repos/${repository}/issues/${issueNumber}/labels`, '--input', '-'], { labels: values }));
  const removeLabel = operations.removeLabel || ((repository, issueNumber, label) => callGh(['api', '--method', 'DELETE', `repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`]));
  const beforeIssue = readIssue(request.repository, request.issue_number);
  const beforeSnapshot = issueSnapshot(beforeIssue);
  if (!sameSnapshot(beforeSnapshot, expectedSnapshot)) throw new Error(`#${request.issue_number}: lifecycle label CAS changed before mutation`);
  const expectedControlled = applyLifecycleOperation(lifecycleLabels(beforeSnapshot.labels), operation);
  if (operation.kind === 'add') addLabels(request.repository, request.issue_number, [operation.label]);
  else removeLabel(request.repository, request.issue_number, operation.label);
  const after = readIssue(request.repository, request.issue_number);
  const afterSnapshot = issueSnapshot(after);
  if (JSON.stringify(lifecycleLabels(afterSnapshot.labels)) !== JSON.stringify(expectedControlled)
    || !preservesNonLifecycleLabels(afterSnapshot, beforeSnapshot.labels)) {
    throw new Error(`#${request.issue_number}: lifecycle ${operation.kind} did not preserve labels or converge`);
  }
  return after;
}
function patchLifecycleLabels(request, labels, expectedSnapshot, operations = {}) {
  let current = expectedSnapshot;
  for (const operation of lifecycleOperationPlan(expectedSnapshot.labels, labels)) {
    const after = patchLifecycleLabelOperation(request, operation, current, operations);
    current = issueSnapshot(after);
  }
  return current;
}
function receiptBody(receipt) {
  return `<!-- interview-note-source-review-applied\n${JSON.stringify(receipt, null, 2)}\n-->\n\nSource Review transition applied and post-write validation passed.`;
}

function main(argv = process.argv.slice(2), runtime = {}) {
  const args = parseArgs(argv);
  const requests = loadRequests(args.requestDir);
  const pinnedArtifactManifest = loadPinnedArtifactManifest(args.pinnedArtifactManifest);
  const lock = acquireProgressLock(args.progressLock);
  const liveLoader = runtime.loadLive || loadLive;
  const writeJson = runtime.durableWriteJson || durableWriteJson;
  try {
    let progress = null;
    if (fs.existsSync(args.progress)) {
      progress = readJson(args.progress);
      const progressValidation = validateProgress(progress, requests);
      if (!progressValidation.ok) throw new Error(`progress validation failed: ${progressValidation.errors.join('; ')}`);
    }
    const planOptions = { loadLive: liveLoader, planTransition: runtime.planTransition, progress };
    const planned = planBatch(requests, pinnedArtifactManifest, planOptions);
    const planOutput = {
      ...planned.report,
      mode: 'plan',
      mutation_attempted: false,
      mutation_performed: false,
      possibly_performed: false,
    };
    if (!planned.ok) {
      writeJson(args.output, planOutput);
      process.stdout.write(`${JSON.stringify(planOutput, null, 2)}\n`);
      return 1;
    }
    if (!args.apply) {
      writeJson(args.output, planOutput);
      process.stdout.write(`${JSON.stringify(planOutput, null, 2)}\n`);
      return 0;
    }
    if (args.confirmPlanSha256 !== planned.report.plan_sha256) throw new Error(`plan confirmation mismatch: expected ${planned.report.plan_sha256}`);
    if (!progress) progress = initialProgress(requests);
    let lastMutationAt = 0;
    const result = applyBatch(requests, pinnedArtifactManifest, progress, {
      loadLive: liveLoader,
      planTransition: runtime.planTransition,
      expectedPlanSha256: args.confirmPlanSha256,
      patchLabels: runtime.patchLabels || function patchLabels(request, labels, expectedSnapshot, operation) {
        const now = Date.now();
        sleepMs(Math.max(0, args.minMutationIntervalMs - (now - lastMutationAt)));
        lastMutationAt = Date.now();
        return patchLifecycleLabelOperation(request, operation, expectedSnapshot);
      },
      postReceipt: runtime.postReceipt || function postReceipt(request, receipt) {
        const now = Date.now();
        sleepMs(Math.max(0, args.minMutationIntervalMs - (now - lastMutationAt)));
        lastMutationAt = Date.now();
        return ghJson(['api', '--method', 'POST', `repos/${request.repository}/issues/${request.issue_number}/comments`, '--input', '-'], { body: receiptBody(receipt) });
      },
      persistProgress(value) { if (runtime.persistProgress) runtime.persistProgress(value); else durableWriteJson(args.progress, value); },
    });
    const output = {
      schema_version: BATCH_SCHEMA_VERSION,
      batch_id: BATCH_ID,
      repository: REPOSITORY,
      packet_set_sha256: PACKET_SET_SHA256,
      pinned_artifact_manifest_sha256: PINNED_ARTIFACT_MANIFEST_SHA256,
      mode: 'apply',
      ok: result.ok,
      errors: result.errors,
      items: result.items,
      mutation_attempted: result.progress && result.progress.mutation_attempted,
      mutation_performed: result.progress && result.progress.mutation_performed,
      possibly_performed: result.progress && result.progress.possibly_performed,
      progress: args.progress,
    };
    writeJson(args.output, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  parseArgs,
  loadRequests,
  loadPinnedArtifactManifest,
  loadLive,
  patchLifecycleLabels,
  patchLifecycleLabelOperation,
  receiptBody,
  main,
};
