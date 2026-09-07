#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  FIXED_ITEMS,
  planBatch,
  applyBatch,
  initialProgress,
  validateProgress,
  acquireProgressLock,
} = require('./lib/issue-1577-source-review-batch');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    manifest: 'data/issue-1577/source-review-manifest.json',
    output: null,
    progress: null,
    progressLock: null,
    requestDir: null,
    receiptDir: null,
    apply: false,
    confirmPlanSha256: null,
    confirmAuthorizationSha256: null,
    reviewedAt: null,
    getMaxAttempts: 3,
    getBackoffMs: 1000,
    minMutationIntervalMs: 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--progress') out.progress = argv[++i];
    else if (arg === '--progress-lock') out.progressLock = argv[++i];
    else if (arg === '--request-dir') out.requestDir = argv[++i];
    else if (arg === '--receipt-dir') out.receiptDir = argv[++i];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--confirm-plan-sha256') out.confirmPlanSha256 = argv[++i];
    else if (arg === '--confirm-authorization-sha256') out.confirmAuthorizationSha256 = argv[++i];
    else if (arg === '--reviewed-at') out.reviewedAt = argv[++i];
    else if (arg === '--get-max-attempts') out.getMaxAttempts = Number(argv[++i]);
    else if (arg === '--get-backoff-ms') out.getBackoffMs = Number(argv[++i]);
    else if (arg === '--min-mutation-interval-ms') out.minMutationIntervalMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.output) throw new Error('--output is required');
  if (!Number.isInteger(out.getMaxAttempts) || out.getMaxAttempts < 1 || out.getMaxAttempts > 3) throw new Error('--get-max-attempts must be an integer from 1 to 3');
  if (!Number.isInteger(out.getBackoffMs) || out.getBackoffMs < 0) throw new Error('--get-backoff-ms must be a non-negative integer');
  if (!Number.isInteger(out.minMutationIntervalMs) || out.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  if (out.apply) {
    for (const [key, value] of [['progress', out.progress], ['progressLock', out.progressLock], ['requestDir', out.requestDir], ['receiptDir', out.receiptDir], ['confirmPlanSha256', out.confirmPlanSha256], ['confirmAuthorizationSha256', out.confirmAuthorizationSha256]]) if (!value) throw new Error(`--${key} is required with --apply`);
    if (!/^[0-9a-f]{64}$/.test(out.confirmPlanSha256) || !/^[0-9a-f]{64}$/.test(out.confirmAuthorizationSha256)) throw new Error('confirmation digests must be lowercase SHA-256');
  }
  return out;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch (_) { /* Windows does not support directory fsync. */ }
}
function atomicWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch (_) { /* Windows does not support directory fsync. */ }
}

function receiptFilePath(receiptDir, packet) {
  if (typeof receiptDir !== 'string' || receiptDir.length === 0) throw new Error('receipt directory is required');
  const issueNumber = packet && packet.interview_issue_number;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('receipt packet issue number is invalid');
  const root = path.resolve(receiptDir);
  const fileName = `issue-${issueNumber}.json`;
  const file = path.resolve(root, fileName);
  if (path.dirname(file) !== root || file !== path.join(root, fileName)) throw new Error('receipt path escapes receipt directory');
  return file;
}

function readReceiptFile(receiptDir, packet) {
  const file = receiptFilePath(receiptDir, packet);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('receipt file must be a regular file');
  const value = readJson(file);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt file must contain one JSON object');
  return value;
}

function transientGetError(error) {
  const status = Number(error && (error.statusCode || error.status));
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status === 429 || status >= 500;
  const text = [error && error.message, error && error.stderr, error && error.stdout].filter(Boolean).join(' ');
  return /TLS|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|unexpected EOF|\bEOF\b/i.test(text);
}

function readWithRetry(read, attempts, backoffMs, sleep) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return read(); } catch (error) {
      lastError = error;
      if (attempt === attempts || !transientGetError(error)) throw error;
      sleep(backoffMs * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function createMutationIntervalHook(intervalMs, { now = () => Date.now(), sleep = () => {} } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error('mutation interval must be a non-negative integer');
  let lastMutationAt = null;
  return () => {
    const current = now();
    if (lastMutationAt !== null) {
      const waitMs = intervalMs - (current - lastMutationAt);
      if (waitMs > 0) sleep(waitMs);
    }
    lastMutationAt = now();
  };
}

function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function main(argv = process.argv.slice(2), injected = {}) {
  const args = parseArgs(argv);
  const readCommand = injected.ghJson || ghJson;
  const sleep = injected.sleep || ((ms) => { if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const now = injected.now || (() => Date.now());
  const manifest = readJson(args.manifest);
  const apiRead = (apiArgs) => readWithRetry(() => readCommand(['api', ...apiArgs]), args.getMaxAttempts, args.getBackoffMs, sleep);
  const loadIssue = (number) => apiRead([`repos/${manifest.repository}/issues/${number}`]);
  const loadComments = (number) => {
    const result = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = apiRead([`repos/${manifest.repository}/issues/${number}/comments?per_page=100&page=${page}`]);
      if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments response was not an array`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
    throw new Error(`Issue #${number} comments exceeded 100 pages`);
  };
  const loadOwnership = (interviewNoteId) => {
    const query = encodeURIComponent(`repo:${manifest.repository} is:issue in:body "${interviewNoteId}"`);
    const search = apiRead([`search/issues?q=${query}&per_page=100&page=1`]);
    if (!search || search.incomplete_results === true || !Array.isArray(search.items) || !Number.isInteger(search.total_count) || search.total_count !== search.items.length) throw new Error(`ownership search for ${interviewNoteId} was incomplete`);
    return search.items.map((item) => loadIssue(item.number)).filter((issue) => issue && !issue.pull_request);
  };
  const tree = apiRead([`repos/${manifest.source_snapshot.repository}/git/trees/${manifest.source_snapshot.ref}?recursive=1`]);
  const snapshots = new Map();
  const liveLoader = (item) => {
    const key = `${item.source_note_issue_number}:${item.interview_issue_number}`;
    // Planning may reuse a read snapshot, but apply must always re-read after
    // each mutation so an uncertain POST can be reconciled against live state.
    if (!args.apply && snapshots.has(key)) return snapshots.get(key);
    {
      const sourceIssue = loadIssue(item.source_note_issue_number);
      const interviewIssue = loadIssue(item.interview_issue_number);
      snapshots.set(key, {
        sourceIssue,
        interviewIssue,
        comments: loadComments(item.interview_issue_number),
        sourceComments: loadComments(item.source_note_issue_number),
        allIssues: loadOwnership(`xhs:${item.source_note_id.replace(/^xhs-note:/, '')}`),
      });
    }
    return snapshots.get(key);
  };
  const lock = args.apply ? acquireProgressLock(args.progressLock) : null;
  try {
    const progress = args.progress && fs.existsSync(args.progress) ? readJson(args.progress) : null;
    if (args.apply) {
      const result = applyBatch({ fixedManifest: manifest, treeEntries: tree.tree, liveLoader, progress, expectedPlanSha256: args.confirmPlanSha256, expectedAuthorizationSha256: args.confirmAuthorizationSha256 }, {
        lock,
        reviewedAt: args.reviewedAt,
        beforeEvidencePost: createMutationIntervalHook(args.minMutationIntervalMs, { now, sleep }),
        evidenceReconcileAttempts: args.getMaxAttempts,
        evidenceReconcileBackoffMs: args.getBackoffMs,
        sleep,
        planBatch: injected.planBatch,
        planFormalRequest: injected.planFormalRequest,
        createEvidenceComment: (packet, body) => readCommand(['api', '--method', 'POST', `repos/${manifest.repository}/issues/${packet.interview_issue_number}/comments`, '--input', '-'], { body }),
        persistProgress: (value) => atomicWriteJson(args.progress, value),
        writeRequest: injected.writeRequest || ((packet, body, request) => { atomicWriteJson(`${args.requestDir}/issue-${packet.interview_issue_number}.json`, request); const file = `${args.requestDir}/issue-${packet.interview_issue_number}.md`; atomicWriteText(file, body); }),
        writeReceipt: injected.writeReceipt || ((packet, receipt) => atomicWriteJson(receiptFilePath(args.receiptDir, packet), receipt)),
        readReceipt: injected.readReceipt || ((packet) => readReceiptFile(args.receiptDir, packet)),
      });
      atomicWriteJson(args.output, result);
      return result.ok ? 0 : 1;
    }
    const result = planBatch({ fixedManifest: manifest, treeEntries: tree.tree, liveLoader });
    if (progress) result.progress_validation = validateProgress(progress, result.packetSet || { packet_set_sha256: null, packets: [] }, result.authorization_sha256);
    result.output = args.output;
    atomicWriteJson(args.output, result);
    return result.ok ? 0 : 1;
  } finally { if (lock) lock.release(); }
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { FIXED_ITEMS, parseArgs, atomicWriteJson, atomicWriteText, receiptFilePath, readReceiptFile, createMutationIntervalHook, transientGetError, readWithRetry, main };
