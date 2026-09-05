#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseReceipts } = require('./lib/interview-note-source-review-transition');
const { loadRequests, loadPinnedArtifactManifest } = require('./apply-issue-1539-source-review-transition-batch');
const { durableWriteJson } = require('./lib/issue-1539-source-review-transition-batch');
const { REPOSITORY } = require('./lib/issue-1539-source-review-transition-batch');
const {
  LEGACY_PLAN_SHA256,
  RECOVERY_SCHEMA_VERSION,
  recoverLegacyUncertain,
} = require('./lib/issue-1539-legacy-uncertain-recovery');
const { acquireProgressLock } = require('./lib/issue-1539-evidence-batch');

function parseArgs(argv = process.argv.slice(2), expectedPlanSha256 = LEGACY_PLAN_SHA256) {
  const args = {
    requestDir: null,
    plan: null,
    progress: null,
    progressLock: null,
    pinnedArtifactManifest: null,
    planSha256: expectedPlanSha256,
    confirmLivePrefixSha256: null,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--plan') args.plan = argv[++index];
    else if (arg === '--progress') args.progress = argv[++index];
    else if (arg === '--progress-lock') args.progressLock = argv[++index];
    else if (arg === '--pinned-artifact-manifest') args.pinnedArtifactManifest = argv[++index];
    else if (arg === '--plan-sha256') args.planSha256 = argv[++index];
    else if (arg === '--confirm-live-prefix-sha256') args.confirmLivePrefixSha256 = argv[++index];
    else if (arg === '--apply') args.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['requestDir', 'plan', 'progress', 'pinnedArtifactManifest']) if (!args[key]) throw new Error(`--${key} is required`);
  args.progressLock ||= `${args.progress}.lock`;
  if (args.planSha256 !== expectedPlanSha256) throw new Error(`--plan-sha256 must be ${expectedPlanSha256}`);
  if (args.apply && !/^[0-9a-f]{64}$/.test(String(args.confirmLivePrefixSha256 || ''))) throw new Error('--apply requires --confirm-live-prefix-sha256 <sha256>');
  return args;
}
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function ghJson(args) {
  const output = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return output.trim() ? JSON.parse(output) : null;
}
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
function loadLive(request) {
  const comments = loadComments(request.repository, request.issue_number);
  const receipts = parseReceipts(comments);
  if (receipts.errors.length) throw new Error(`#${request.issue_number}: ${receipts.errors.join('; ')}`);
  return {
    interviewIssue: ghJson(['api', `repos/${request.repository}/issues/${request.issue_number}`]),
    receipts: receipts.receipts,
  };
}
function main(argv = process.argv.slice(2), runtime = {}) {
  const expectedPlanSha256 = runtime.expectedPlanSha256 || LEGACY_PLAN_SHA256;
  const args = parseArgs(argv, expectedPlanSha256);
  const requests = loadRequests(args.requestDir);
  loadPinnedArtifactManifest(args.pinnedArtifactManifest);
  const plan = readJson(args.plan);
  const progress = readJson(args.progress);
  let lock = null;
  try {
    if (args.apply) lock = acquireProgressLock(args.progressLock);
    const request = requests.find((value) => Number(value.issue_number) === 1509);
    const live = (runtime.loadLive || loadLive)(request);
    const result = recoverLegacyUncertain({ plan, progress, requests, live, receipts: live.receipts, expectedPlanSha256 });
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify({ recovery_schema_version: RECOVERY_SCHEMA_VERSION, mode: args.apply ? 'apply' : 'plan', ok: false, errors: result.errors, write_performed: false, mutation_performed: false }, null, 2)}\n`);
      return 1;
    }
    if (args.apply && result.live_prefix_sha256 !== args.confirmLivePrefixSha256) throw new Error(`live-prefix confirmation mismatch: expected ${result.live_prefix_sha256}`);
    if (args.apply) {
      if (typeof runtime.persistProgress === 'function') runtime.persistProgress(result.recovery_progress);
      else durableWriteJson(args.progress, result.recovery_progress);
    }
    const output = {
      ...result,
      mode: args.apply ? 'apply' : 'plan',
      ok: true,
      write_performed: Boolean(args.apply),
      progress_path: args.progress,
      ...(args.apply ? {} : { recovery_progress: result.recovery_progress }),
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } finally {
    if (lock) lock.release();
  }
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, loadLive, main };
