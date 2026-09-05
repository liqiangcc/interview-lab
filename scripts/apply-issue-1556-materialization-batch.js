#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ISSUE_NUMBERS,
  REPOSITORY,
  PACKET_SET_SHA256,
  planBatch,
  applyBatch,
  renderMaterializationReceipt,
  validateProgress,
  durableWriteJson,
  acquireProgressLock,
} = require('./lib/issue-1556-materialization-batch');
const { buildPacketSet } = require('./lib/issue-1539-boundary-evidence-batch');
const { loadIssue, loadComments, readBlob, loadOwnership } = require('./apply-issue-1539-boundary-evidence-batch');

const DEFAULT_GET_MAX_ATTEMPTS = 3;
const DEFAULT_GET_BACKOFF_MS = 250;
const DEFAULT_MIN_MUTATION_INTERVAL_MS = 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    manifest: null,
    requestDir: null,
    evidenceReceiptDir: null,
    transitionReceiptDir: null,
    output: null,
    progress: null,
    materializationRequestDir: null,
    materializationReceiptDir: null,
    progressLock: null,
    confirmPlanSha256: null,
    confirmAuthorizationSha256: null,
    getMaxAttempts: DEFAULT_GET_MAX_ATTEMPTS,
    getBackoffMs: DEFAULT_GET_BACKOFF_MS,
    minMutationIntervalMs: DEFAULT_MIN_MUTATION_INTERVAL_MS,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = argv[++index];
    else if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--evidence-receipt-dir') args.evidenceReceiptDir = argv[++index];
    else if (arg === '--transition-receipt-dir') args.transitionReceiptDir = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--progress') args.progress = argv[++index];
    else if (arg === '--materialization-request-dir') args.materializationRequestDir = argv[++index];
    else if (arg === '--materialization-receipt-dir') args.materializationReceiptDir = argv[++index];
    else if (arg === '--progress-lock') args.progressLock = argv[++index];
    else if (arg === '--confirm-plan-sha256') args.confirmPlanSha256 = argv[++index];
    else if (arg === '--confirm-authorization-sha256') args.confirmAuthorizationSha256 = argv[++index];
    else if (arg === '--get-max-attempts') args.getMaxAttempts = Number(argv[++index]);
    else if (arg === '--get-backoff-ms') args.getBackoffMs = Number(argv[++index]);
    else if (arg === '--min-mutation-interval-ms') args.minMutationIntervalMs = Number(argv[++index]);
    else if (arg === '--apply') args.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [key, flag] of [
    ['manifest', '--manifest'],
    ['requestDir', '--request-dir'],
    ['evidenceReceiptDir', '--evidence-receipt-dir'],
    ['transitionReceiptDir', '--transition-receipt-dir'],
    ['output', '--output'],
    ['progress', '--progress'],
  ]) if (!args[key]) throw new Error(`${flag} is required`);
  if (args.apply && !args.materializationRequestDir) throw new Error('--apply requires --materialization-request-dir');
  if (args.apply && !args.materializationReceiptDir) throw new Error('--apply requires --materialization-receipt-dir');
  if (args.apply && !args.progressLock) throw new Error('--apply requires --progress-lock');
  if (args.apply && !/^[0-9a-f]{64}$/.test(String(args.confirmPlanSha256 || ''))) throw new Error('--apply requires --confirm-plan-sha256 <sha256>');
  if (args.apply && !/^[0-9a-f]{64}$/.test(String(args.confirmAuthorizationSha256 || ''))) throw new Error('--apply requires --confirm-authorization-sha256 <sha256>');
  if (!Number.isInteger(args.getMaxAttempts) || args.getMaxAttempts < 1 || args.getMaxAttempts > 3) throw new Error('--get-max-attempts must be an integer from 1 to 3');
  if (!Number.isInteger(args.getBackoffMs) || args.getBackoffMs < 0) throw new Error('--get-backoff-ms must be a non-negative integer');
  if (!Number.isInteger(args.minMutationIntervalMs) || args.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function fixedJsonFiles(directory, description) {
  const absolute = path.resolve(directory);
  const expected = new Set(ISSUE_NUMBERS.map((issue) => `issue-${issue}.json`));
  const files = fs.readdirSync(absolute).filter((file) => file.endsWith('.json')).sort();
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) throw new Error(`${description} must contain exactly the fixed 17 Issue JSON files`);
  return absolute;
}

function loadFixedJson(directory, description) {
  const absolute = fixedJsonFiles(directory, description);
  return ISSUE_NUMBERS.map((issue) => readJson(path.join(absolute, `issue-${issue}.json`)));
}

function makeLiveLoader(repository, getOptions = {}, adapters = {}) {
  const getIssue = adapters.loadIssue || ((repo, issue) => loadIssue(repo, issue, getOptions));
  const getComments = adapters.loadComments || ((repo, issue) => loadComments(repo, issue, getOptions));
  const getBlob = adapters.readBlob || ((repo, sha) => readBlob(repo, sha, getOptions));
  const getOwners = adapters.loadOwnership || ((repo, id) => loadOwnership(repo, id, { getOptions }));
  return (request) => ({
    sourceIssue: getIssue(repository, request.source_note_issue_number),
    comments: getComments(repository, request.source_note_issue_number),
    allIssues: getOwners(repository, `xhs:${request.source_note_id.slice('xhs-note:'.length)}`),
    readBlob: (sha) => getBlob('liqiangcc/xhs', sha),
  });
}

function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }));
}

function createInterviewIssue(repository, projection, execute = ghJson) {
  return execute(['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], {
    title: projection.title,
    body: projection.body,
    labels: projection.labels,
  });
}

function postReceipt(repository, request, receipt, execute = ghJson) {
  return execute(['api', '--method', 'POST', `repos/${repository}/issues/${request.source_note_issue_number}/comments`, '--input', '-'], {
    body: renderMaterializationReceipt(receipt),
  });
}

function outputFor(plan, args, mode, extra = {}) {
  const countStatus = mode === 'plan' ? 'plan' : (plan.count_status || plan.progress?.count_status || 'unknown');
  const invalidCounts = mode !== 'plan' && countStatus === 'invalid';
  const createMutationCount = mode === 'plan' ? 0 : invalidCounts ? null : (plan.create_mutation_count ?? plan.progress?.create_mutation_count ?? 0);
  const receiptMutationCount = mode === 'plan' ? 0 : invalidCounts ? null : (plan.receipt_mutation_count ?? plan.progress?.receipt_mutation_count ?? 0);
  return {
    schema_version: 'issue-1556-interview-note-materialization-cli.v1',
    repository: REPOSITORY,
    packet_set_sha256: PACKET_SET_SHA256,
    mode,
    ok: plan.ok,
    plan_sha256: plan.plan_sha256 || plan.report?.plan_sha256 || null,
    authorization_sha256: plan.authorization_sha256 || plan.report?.authorization_sha256 || null,
    create_mutation_count: createMutationCount,
    receipt_mutation_count: receiptMutationCount,
    mutation_count: invalidCounts ? null : createMutationCount + receiptMutationCount,
    count_status: countStatus,
    mutation_attempted: mode === 'plan' ? false : Boolean(plan.mutation_attempted || plan.progress?.mutation_attempted),
    mutation_performed: mode === 'plan' ? false : Boolean(plan.mutation_performed || plan.progress?.mutation_performed),
    possibly_performed: mode === 'plan' ? false : Boolean(plan.possibly_performed || plan.progress?.possibly_performed),
    errors: plan.errors || [],
    report: plan.report || null,
    items: plan.items || plan.report?.items || [],
    output: path.resolve(args.output),
    progress: path.resolve(args.progress),
    ...extra,
  };
}

function main(argv = process.argv.slice(2), runtime = {}) {
  const args = parseArgs(argv);
  const manifest = runtime.manifest || readJson(args.manifest);
  const packetSet = runtime.packetSet || buildPacketSet(manifest);
  if (packetSet.packet_set_sha256 !== PACKET_SET_SHA256) throw new Error(`packet set digest must equal ${PACKET_SET_SHA256}`);
  const transitionRequests = runtime.transitionRequests || loadFixedJson(args.requestDir, 'Boundary transition request directory');
  const evidenceReceipts = runtime.evidenceReceipts || loadFixedJson(args.evidenceReceiptDir, '#1549 evidence receipt directory');
  const transitionReceipts = runtime.transitionReceipts || loadFixedJson(args.transitionReceiptDir, '#1554 transition receipt directory');
  const getOptions = { maxAttempts: args.getMaxAttempts, backoffMs: args.getBackoffMs };
  const liveLoader = runtime.loadLive || makeLiveLoader(REPOSITORY, getOptions);
  const readPinnedBlob = runtime.readBlob || ((sha) => readBlobForLive('liqiangcc/xhs', sha, getOptions));
  const lock = args.apply ? (runtime.acquireLock ? runtime.acquireLock(args.progressLock) : acquireProgressLock(args.progressLock)) : null;
  let result = null;
  try {
    let progress = null;
    if (fs.existsSync(args.progress)) progress = runtime.progress || readJson(args.progress);
    const initial = planBatch({
      packetSet,
      manifest,
      transitionRequests,
      evidenceReceipts,
      transitionReceipts,
      loadLive: liveLoader,
      readBlob: readPinnedBlob,
    });
    const plannedOutput = outputFor(initial, args, 'plan');
    if (!initial.ok) {
      durableWriteJson(args.output, plannedOutput);
      process.stdout.write(`${JSON.stringify(plannedOutput, null, 2)}\n`);
      return 1;
    }
    if (!args.apply) {
      durableWriteJson(args.output, plannedOutput);
      process.stdout.write(`${JSON.stringify(plannedOutput, null, 2)}\n`);
      return 0;
    }
    if (args.confirmPlanSha256 !== initial.plan_sha256) throw new Error(`plan digest confirmation mismatch: expected ${initial.plan_sha256}`);
    if (args.confirmAuthorizationSha256 !== initial.authorization_sha256) throw new Error(`authorization digest confirmation mismatch: expected ${initial.authorization_sha256}`);
    if (progress) {
      const validation = validateProgress(progress, initial.items, initial.authorization_sha256);
      if (!validation.ok) throw new Error(`progress validation failed closed: ${validation.errors.join('; ')}`);
    }
    let lastMutationAt = null;
    const clock = runtime.clock || Date.now;
    const sleep = runtime.sleep || ((milliseconds) => { if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
    const beforeMutation = () => {
      const now = clock();
      if (lastMutationAt !== null) sleep(Math.max(0, args.minMutationIntervalMs - (now - lastMutationAt)));
      lastMutationAt = clock();
    };
    result = applyBatch({
      planResult: initial,
      packetSet,
      manifest,
      transitionRequests,
      transitionReceipts,
      evidenceReceipts,
      progress,
    }, {
      expectedPlanSha256: args.confirmPlanSha256,
      expectedAuthorizationSha256: args.confirmAuthorizationSha256,
      lock,
      loadLive: liveLoader,
      readBlob: readPinnedBlob,
      persistProgress: runtime.persistProgress || ((value) => durableWriteJson(args.progress, value)),
      writeRequest: runtime.writeRequest || ((request, value) => durableWriteJson(path.join(path.resolve(args.materializationRequestDir), `issue-${request.source_note_issue_number}.json`), value)),
      writeReceipt: runtime.writeReceipt || ((request, receipt) => durableWriteJson(path.join(path.resolve(args.materializationReceiptDir), `issue-${request.source_note_issue_number}.json`), receipt)),
      beforeMutation,
      postCreateMaxAttempts: args.getMaxAttempts,
      postCreateBackoff: args.getBackoffMs,
      sleep,
      createInterviewIssue: runtime.createInterviewIssue || ((request, projection) => createInterviewIssue(REPOSITORY, projection, runtime.ghJson || ghJson)),
      postReceipt: runtime.postReceipt || ((request, receipt) => postReceipt(REPOSITORY, request, receipt, runtime.ghJson || ghJson)),
    });
    const output = outputFor(result, args, 'apply', {
      plan_sha256: initial.plan_sha256,
      authorization_sha256: initial.authorization_sha256,
    });
    durableWriteJson(args.output, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    if (lock) {
      try { lock.release(); }
      catch (error) {
        // Preserve an already returned apply failure (especially a lock-loss
        // result) instead of replacing it with the release assertion error.
        // A successful apply still surfaces release failure to the caller.
        if (!result || result.ok) throw error;
      }
    }
  }
}

function readBlobForLive(repository, sha, getOptions) {
  return readBlob(repository, sha, getOptions);
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, main, makeLiveLoader, createInterviewIssue, postReceipt, outputFor };
