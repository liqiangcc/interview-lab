#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  TARGETS,
  planBatch,
  applyBatch,
  initialProgress,
  validateProgress,
  validateEvidencePlan,
  validateRequests,
  transitionReceiptBody,
  acquireProgressLock,
} = require('./lib/issue-1577-source-review-transition-batch');
const { parseRequest } = require('./lib/interview-note-source-review-transition');
const { canonicalJson } = require('./lib/issue-1539-recovery-plan');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    manifest: 'data/issue-1577/source-review-manifest.json',
    evidencePlan: 'data/pilot/issue-1577/evidence-post-apply-plan.json',
    requestDir: 'data/pilot/issue-1577/requests',
    receiptDir: 'data/pilot/issue-1577/transition-receipts',
    output: null,
    progress: null,
    progressLock: null,
    apply: false,
    confirmPlanSha256: null,
    confirmAuthorizationSha256: null,
    minMutationIntervalMs: 1000,
    getMaxAttempts: 3,
    getBackoffMs: 1000,
    reviewedAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--manifest') out.manifest = next();
    else if (arg === '--evidence-plan') out.evidencePlan = next();
    else if (arg === '--request-dir') out.requestDir = next();
    else if (arg === '--transition-receipt-dir') out.receiptDir = next();
    else if (arg === '--output') out.output = next();
    else if (arg === '--progress') out.progress = next();
    else if (arg === '--progress-lock') out.progressLock = next();
    else if (arg === '--confirm-plan-sha256') out.confirmPlanSha256 = next();
    else if (arg === '--confirm-authorization-sha256') out.confirmAuthorizationSha256 = next();
    else if (arg === '--reviewed-at') out.reviewedAt = next();
    else if (arg === '--min-mutation-interval-ms') out.minMutationIntervalMs = Number(next());
    else if (arg === '--get-max-attempts') out.getMaxAttempts = Number(next());
    else if (arg === '--get-backoff-ms') out.getBackoffMs = Number(next());
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--help') { out.help = true; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.help) return out;
  if (!out.output) throw new Error('--output is required');
  if (!Number.isInteger(out.getMaxAttempts) || out.getMaxAttempts < 1 || out.getMaxAttempts > 3) throw new Error('--get-max-attempts must be an integer from 1 to 3');
  if (!Number.isInteger(out.getBackoffMs) || out.getBackoffMs < 0) throw new Error('--get-backoff-ms must be a non-negative integer');
  if (!Number.isInteger(out.minMutationIntervalMs) || out.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  if (out.apply) {
    for (const [name, value] of [['progress', out.progress], ['progressLock', out.progressLock], ['confirmPlanSha256', out.confirmPlanSha256], ['confirmAuthorizationSha256', out.confirmAuthorizationSha256]]) if (!value) throw new Error(`--${name} is required with --apply`);
    if (!/^[0-9a-f]{64}$/.test(out.confirmPlanSha256) || !/^[0-9a-f]{64}$/.test(out.confirmAuthorizationSha256)) throw new Error('confirmation digests must be lowercase SHA-256');
  }
  return out;
}
function help() { return 'Usage: node scripts/apply-issue-1577-source-review-transition.js --output <file> [--evidence-plan <file> --request-dir <dir> --transition-receipt-dir <dir>] [--apply --progress <file> --progress-lock <file> --confirm-plan-sha256 <sha> --confirm-authorization-sha256 <sha>]'; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function atomicWriteJson(file, value) {
  const absolute = path.resolve(file); fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`; const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, absolute);
}
function requestFiles(requestDir) {
  const expected = TARGETS.map((issue) => `issue-${issue}`);
  const names = fs.readdirSync(requestDir);
  const jsonNames = names.filter((name) => name.endsWith('.json')).sort();
  const mdNames = names.filter((name) => name.endsWith('.md')).sort();
  if (canonicalJson(jsonNames) !== canonicalJson(expected.map((name) => `${name}.json`).sort()) || canonicalJson(mdNames) !== canonicalJson(expected.map((name) => `${name}.md`).sort())) throw new Error('request directory must contain exactly the scoped 17 JSON/Markdown request pairs');
  return TARGETS.map((issue) => {
    const json = readJson(path.join(requestDir, `issue-${issue}.json`));
    const marker = fs.readFileSync(path.join(requestDir, `issue-${issue}.md`), 'utf8');
    const parsed = parseRequest(marker);
    if (parsed.errors.length || canonicalJson(parsed.request) !== canonicalJson(json)) throw new Error(`#${issue}: request JSON and Markdown marker differ`);
    return json;
  });
}
function receiptPath(receiptDir, request) {
  const root = path.resolve(receiptDir); const issue = Number(request.issue_number); const file = path.resolve(root, `issue-${issue}.json`);
  if (!Number.isSafeInteger(issue) || issue < 1 || path.dirname(file) !== root) throw new Error('transition receipt path escapes receipt directory');
  return file;
}
function readReceipt(receiptDir, request) { const file = receiptPath(receiptDir, request); if (!fs.existsSync(file)) return null; const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('transition receipt must be a regular file'); return readJson(file); }
function writeReceipt(receiptDir, request, receipt) { atomicWriteJson(receiptPath(receiptDir, request), receipt); }
function ghJson(args, input = null) { return JSON.parse(execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })); }
function readWithRetry(read, attempts, backoffMs, sleep) { let last; for (let attempt = 1; attempt <= attempts; attempt += 1) { try { return read(); } catch (error) { last = error; if (attempt === attempts) throw error; sleep(backoffMs * (2 ** (attempt - 1))); } } throw last; }
function main(argv = process.argv.slice(2), injected = {}) {
  const args = parseArgs(argv); if (args.help) { process.stdout.write(`${help()}\n`); return 0; }
  const manifest = readJson(args.manifest); const evidencePlan = readJson(args.evidencePlan); const requests = requestFiles(args.requestDir);
  const evidenceValidation = validateEvidencePlan(evidencePlan); if (!evidenceValidation.ok) throw new Error(`evidence plan validation failed: ${evidenceValidation.errors.join('; ')}`);
  const requestValidation = validateRequests(requests, evidencePlan); if (!requestValidation.ok) throw new Error(`request validation failed: ${requestValidation.errors.join('; ')}`);
  const command = injected.ghJson || ghJson; const sleep = injected.sleep || ((ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const apiRead = (apiArgs) => readWithRetry(() => command(['api', ...apiArgs]), args.getMaxAttempts, args.getBackoffMs, sleep);
  const loadIssue = (number) => apiRead([`repos/${manifest.repository}/issues/${number}`]);
  const loadComments = (number) => { const all = []; for (let page = 1; page <= 100; page += 1) { const batch = apiRead([`repos/${manifest.repository}/issues/${number}/comments?per_page=100&page=${page}`]); if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments response was not an array`); all.push(...batch); if (batch.length < 100) return all; } throw new Error(`Issue #${number} comments exceeded 100 pages`); };
  const loadOwnership = (id) => { const query = encodeURIComponent(`repo:${manifest.repository} is:issue in:body "${id}"`); const result = apiRead([`search/issues?q=${query}&per_page=100&page=1`]); if (!result || result.incomplete_results === true || !Array.isArray(result.items) || result.total_count !== result.items.length) throw new Error(`ownership search for ${id} was incomplete`); return result.items.map((item) => loadIssue(item.number)).filter((item) => item && !item.pull_request); };
  const liveLoader = (request) => ({ sourceIssue: loadIssue(request.source_note_issue_number), interviewIssue: loadIssue(request.issue_number), comments: loadComments(request.issue_number), sourceComments: loadComments(request.source_note_issue_number), allIssues: loadOwnership(request.interview_note_id) });
  let lock = null;
  try {
    const plan = planBatch({ requests, evidencePlan, liveLoader, pinnedArtifactManifest: evidencePlan.pinnedArtifactManifest });
    if (!args.apply) { atomicWriteJson(args.output, plan); return plan.ok ? 0 : 1; }
    lock = acquireProgressLock(args.progressLock);
    const progress = fs.existsSync(args.progress) ? readJson(args.progress) : initialProgress(plan);
    const throttle = (() => { let last = null; return () => { const now = Date.now(); if (last != null) { const wait = args.minMutationIntervalMs - (now - last); if (wait > 0) sleep(wait); } last = Date.now(); }; })();
    const result = applyBatch({ requests, evidencePlan, pinnedArtifactManifest: evidencePlan.pinnedArtifactManifest, liveLoader, progress, expectedPlanSha256: args.confirmPlanSha256, expectedAuthorizationSha256: args.confirmAuthorizationSha256 }, {
      lock,
      persistProgress: (value) => atomicWriteJson(args.progress, value),
      beforeMutation: throttle,
      patchLabel: (request, operation) => { if (operation.kind === 'add') command(['api', '--method', 'POST', `repos/${request.repository}/issues/${request.issue_number}/labels`, '--input', '-'], { labels: [operation.label] }); else command(['api', '--method', 'DELETE', `repos/${request.repository}/issues/${request.issue_number}/labels/${encodeURIComponent(operation.label)}`]); },
      postReceipt: (request, receipt) => command(['api', '--method', 'POST', `repos/${request.repository}/issues/${request.issue_number}/comments`, '--input', '-'], { body: transitionReceiptBody(receipt) }),
      writeReceipt: (request, receipt) => writeReceipt(args.receiptDir, request, receipt),
      readReceipt: (request) => readReceipt(args.receiptDir, request),
      reconcileAttempts: args.getMaxAttempts,
      reconcileBackoffMs: args.getBackoffMs,
      sleep,
      now: () => args.reviewedAt || new Date().toISOString(),
    });
    atomicWriteJson(args.output, result); return result.ok ? 0 : 1;
  } finally { if (lock) lock.release(); }
}
if (require.main === module) { try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; } }
module.exports = { TARGETS, parseArgs, requestFiles, receiptPath, readReceipt, writeReceipt, transitionReceiptBody, main };
