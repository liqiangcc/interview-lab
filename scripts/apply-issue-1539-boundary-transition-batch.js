#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseSourceNoteBoundaryReviewTransition } = require('./lib/source-note-boundary-review-transition');
const boundaryEvidenceCli = require('./apply-issue-1539-boundary-evidence-batch');
const {
  ISSUE_NUMBERS,
  REPOSITORY,
  PACKET_SET_SHA256,
  buildPacketSet,
  initialProgress,
  validateProgress,
  planBatch,
  applyBatch,
  renderAppliedReceiptComment,
} = require('./lib/issue-1539-boundary-transition-batch');

const {
  atomicWriteJson,
  ghJson,
  loadIssue,
  loadComments,
  readBlob,
  loadOwnership,
} = boundaryEvidenceCli;

const DEFAULT_GET_MAX_ATTEMPTS = 3;
const DEFAULT_GET_BACKOFF_MS = 250;
const DEFAULT_MIN_MUTATION_INTERVAL_MS = 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    candidateManifest: null,
    requestDir: null,
    evidenceReceiptDir: null,
    transitionReceiptDir: null,
    output: null,
    progress: null,
    progressLock: null,
    confirmPlanDigest: null,
    getMaxAttempts: DEFAULT_GET_MAX_ATTEMPTS,
    getBackoffMs: DEFAULT_GET_BACKOFF_MS,
    minMutationIntervalMs: DEFAULT_MIN_MUTATION_INTERVAL_MS,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--candidate-manifest') args.candidateManifest = argv[++index];
    else if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--evidence-receipt-dir') args.evidenceReceiptDir = argv[++index];
    else if (arg === '--transition-receipt-dir') args.transitionReceiptDir = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--progress') args.progress = argv[++index];
    else if (arg === '--progress-lock') args.progressLock = argv[++index];
    else if (arg === '--confirm-plan-digest') args.confirmPlanDigest = argv[++index];
    else if (arg === '--get-max-attempts') args.getMaxAttempts = Number(argv[++index]);
    else if (arg === '--get-backoff-ms') args.getBackoffMs = Number(argv[++index]);
    else if (arg === '--min-mutation-interval-ms') args.minMutationIntervalMs = Number(argv[++index]);
    else if (arg === '--apply') args.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [key, flag] of [
    ['candidateManifest', '--candidate-manifest'],
    ['requestDir', '--request-dir'],
    ['evidenceReceiptDir', '--evidence-receipt-dir'],
    ['transitionReceiptDir', '--transition-receipt-dir'],
    ['output', '--output'],
    ['progress', '--progress'],
  ]) if (!args[key]) throw new Error(`${flag} is required`);
  if (args.apply && !args.progressLock) throw new Error('--apply requires --progress-lock');
  if (args.apply && !/^[0-9a-f]{64}$/.test(String(args.confirmPlanDigest || ''))) throw new Error('--apply requires --confirm-plan-digest <sha256>');
  if (!Number.isInteger(args.getMaxAttempts) || args.getMaxAttempts < 1 || args.getMaxAttempts > 3) throw new Error('--get-max-attempts must be an integer from 1 to 3');
  if (!Number.isInteger(args.getBackoffMs) || args.getBackoffMs < 0) throw new Error('--get-backoff-ms must be a non-negative integer');
  if (!Number.isInteger(args.minMutationIntervalMs) || args.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function fixedFiles(directory, suffix, description) {
  const absolute = path.resolve(directory);
  const expected = new Set(ISSUE_NUMBERS.map((issue) => `issue-${issue}.${suffix}`));
  const files = fs.readdirSync(absolute).filter((file) => file.endsWith(`.${suffix}`)).sort();
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) throw new Error(`${description} must contain exactly the fixed 17 Issue files`);
  return { absolute, expected };
}

function loadRequests(directory) {
  const { absolute } = fixedFiles(directory, 'json', 'Boundary transition request directory');
  return ISSUE_NUMBERS.map((issue) => {
    const request = readJson(path.join(absolute, `issue-${issue}.json`));
    const markdown = path.join(absolute, `issue-${issue}.md`);
    if (!fs.existsSync(markdown)) throw new Error(`#${issue}: request Markdown companion is missing`);
    const parsed = parseSourceNoteBoundaryReviewTransition(fs.readFileSync(markdown, 'utf8'));
    if (parsed.errors.length || !parsed.request || !deepEqual(parsed.request, request)) throw new Error(`#${issue}: request JSON/Markdown marker mismatch`);
    return request;
  });
}

function loadEvidenceReceipts(directory) {
  const { absolute } = fixedFiles(directory, 'json', '#1549 Boundary evidence receipt directory');
  return ISSUE_NUMBERS.map((issue) => readJson(path.join(absolute, `issue-${issue}.json`)));
}

function makeLiveLoader(repository, getOptions = {}, adapters = {}) {
  const readIssue = adapters.loadIssue || ((repo, issue) => loadIssue(repo, issue, getOptions));
  const readComments = adapters.loadComments || ((repo, issue) => loadComments(repo, issue, getOptions));
  const readPinnedBlob = adapters.readBlob || ((repo, sha) => readBlob(repo, sha, getOptions));
  const findOwnership = adapters.loadOwnership || ((repo, id) => loadOwnership(repo, id, { getOptions }));
  return (request) => {
    const sourceIssue = readIssue(repository, request.issue_number);
    const comments = readComments(repository, request.issue_number);
    const interviewNoteId = `xhs:${request.source_note_id.slice('xhs-note:'.length)}`;
    return {
      sourceIssue,
      comments,
      allIssues: findOwnership(repository, interviewNoteId),
      readBlob: (sha) => readPinnedBlob('liqiangcc/xhs', sha),
    };
  };
}

function sleepMs(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function patchSourceNote(request, plan) {
  return ghJson([
    'api', '--method', 'PATCH', `repos/${request.repository}/issues/${request.issue_number}`, '--input', '-',
  ], { body: plan.next_body, labels: plan.next_labels });
}

function postReceipt(request, receipt) {
  return ghJson([
    'api', '--method', 'POST', `repos/${request.repository}/issues/${request.issue_number}/comments`, '--input', '-',
  ], { body: renderAppliedReceiptComment(receipt) });
}

function buildOutput(planned, args, mode, packetSetSha256) {
  return {
    schema_version: 'issue-1539-boundary-review-transition-batch.v1',
    batch_id: 'issue-1539-boundary-review-transition-001',
    repository: REPOSITORY,
    packet_set_sha256: packetSetSha256,
    mode,
    ok: planned.ok,
    errors: planned.errors || [],
    plan_sha256: planned.report?.plan_sha256 || null,
    items: planned.report?.items || [],
    mutation_attempted: mode === 'plan' ? false : Boolean(planned.progress?.mutation_attempted),
    mutation_performed: mode === 'plan' ? false : Boolean(planned.progress?.mutation_performed),
    possibly_performed: mode === 'plan' ? false : Boolean(planned.progress?.possibly_performed),
    output: path.resolve(args.output),
    progress: path.resolve(args.progress),
  };
}

function main(argv = process.argv.slice(2), runtime = {}) {
  const args = parseArgs(argv);
  const manifest = runtime.manifest || readJson(args.candidateManifest);
  const packetSet = runtime.packetSet || buildPacketSet(manifest);
  const expectedPacketSetSha256 = runtime.expectedPacketSetSha256 || PACKET_SET_SHA256;
  if (packetSet.packet_set_sha256 !== expectedPacketSetSha256) throw new Error(`packet set digest must equal authorized fixed digest ${expectedPacketSetSha256}`);
  const requests = runtime.requests || loadRequests(args.requestDir);
  const evidenceReceipts = runtime.evidenceReceipts || loadEvidenceReceipts(args.evidenceReceiptDir);
  const getOptions = { maxAttempts: args.getMaxAttempts, backoffMs: args.getBackoffMs };
  const liveLoader = runtime.loadLive || makeLiveLoader(REPOSITORY, getOptions);
  const readTransitionReceipt = runtime.readTransitionReceipt || ((request) => {
    const file = path.join(path.resolve(args.transitionReceiptDir), `issue-${request.issue_number}.json`);
    return fs.existsSync(file) ? readJson(file) : null;
  });
  const writeProgress = runtime.persistProgress || ((value) => atomicWriteJson(args.progress, value));
  const writeReceipt = runtime.writeReceipt || ((request, receipt) => atomicWriteJson(path.join(path.resolve(args.transitionReceiptDir), `issue-${request.issue_number}.json`), receipt));
  let lastMutationAt = null;
  const clock = runtime.clock || Date.now;
  const sleep = runtime.sleep || sleepMs;
  function beforeMutation() {
    const now = clock();
    if (lastMutationAt !== null) sleep(Math.max(0, args.minMutationIntervalMs - (now - lastMutationAt)));
    lastMutationAt = clock();
  }
  const lock = args.apply ? (runtime.acquireLock ? runtime.acquireLock(args.progressLock) : require('./lib/issue-1539-evidence-batch').acquireProgressLock(args.progressLock)) : null;
  try {
    const progressExists = fs.existsSync(args.progress);
    let progress = progressExists ? (runtime.progress || readJson(args.progress)) : null;
    if (progress) {
      const validation = validateProgress(progress, requests, packetSet.packet_set_sha256);
      if (!validation.ok) throw new Error(`progress validation failed closed: ${validation.errors.join('; ')}`);
    }
    const baseOptions = {
      manifest,
      evidenceReceipts,
      expectedPacketSetSha256,
      loadLive: liveLoader,
      readTransitionReceipt,
      planTransition: runtime.planTransition,
    };
    const planned = planBatch(requests, packetSet, baseOptions);
    const planOutput = buildOutput(planned, args, 'plan', packetSet.packet_set_sha256);
    if (!planned.ok) {
      atomicWriteJson(args.output, planOutput);
      process.stdout.write(`${JSON.stringify(planOutput, null, 2)}\n`);
      return 1;
    }
    if (!args.apply) {
      atomicWriteJson(args.output, planOutput);
      process.stdout.write(`${JSON.stringify(planOutput, null, 2)}\n`);
      return 0;
    }
    if (args.confirmPlanDigest !== planned.report.plan_sha256) throw new Error(`plan confirmation mismatch: expected ${planned.report.plan_sha256}`);
    if (!progress) progress = initialProgress(requests, packetSet.packet_set_sha256);
    const result = applyBatch(requests, packetSet, progress, {
      ...baseOptions,
      expectedPlanSha256: args.confirmPlanDigest,
      persistProgress: writeProgress,
      writeReceipt,
      patchIssue: (request, plan) => { beforeMutation(); return (runtime.patchIssue || patchSourceNote)(request, plan); },
      postReceipt: (request, receipt) => { beforeMutation(); return (runtime.postReceipt || postReceipt)(request, receipt); },
      now: runtime.now,
    });
    const output = buildOutput({ ...result, report: result.report }, args, 'apply', packetSet.packet_set_sha256);
    atomicWriteJson(args.output, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    if (lock) lock.release();
  }
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  parseArgs,
  loadRequests,
  loadEvidenceReceipts,
  makeLiveLoader,
  patchSourceNote,
  postReceipt,
  main,
};
