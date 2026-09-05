#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseInterviewNoteIssue } = require('./lib/interview-note-issue');
const { ownershipSearchEndpoint } = require('./lib/interview-note-ownership-search');
const {
  buildPacketSet, runBatch, initialProgress, validateProgress, acquireProgressLock,
} = require('./lib/issue-1539-boundary-evidence-batch');

const DEFAULT_GET_MAX_ATTEMPTS = 3;
const DEFAULT_GET_BACKOFF_MS = 250;
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE']);

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, report: null, output: null, progress: null, progressLock: null, requestDir: null, receiptDir: null, apply: false, confirmDryRun: null, reviewedAt: null, minMutationIntervalMs: 1000, getMaxAttempts: DEFAULT_GET_MAX_ATTEMPTS, getBackoffMs: DEFAULT_GET_BACKOFF_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--candidate-manifest') out.manifest = argv[++index];
    else if (arg === '--report') out.report = argv[++index];
    else if (arg === '--output') out.output = argv[++index];
    else if (arg === '--progress') out.progress = argv[++index];
    else if (arg === '--progress-lock') out.progressLock = argv[++index];
    else if (arg === '--request-dir') out.requestDir = argv[++index];
    else if (arg === '--receipt-dir') out.receiptDir = argv[++index];
    else if (arg === '--confirm-dry-run') out.confirmDryRun = argv[++index];
    else if (arg === '--reviewed-at') out.reviewedAt = argv[++index];
    else if (arg === '--min-mutation-interval-ms') out.minMutationIntervalMs = Number(argv[++index]);
    else if (arg === '--get-max-attempts') out.getMaxAttempts = Number(argv[++index]);
    else if (arg === '--get-backoff-ms') out.getBackoffMs = Number(argv[++index]);
    else if (arg === '--apply') out.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['manifest', 'progress']) if (!out[key]) throw new Error(`--${key === 'manifest' ? 'candidate-manifest' : key} is required`);
  if (out.apply && (!out.report || !out.output || !out.confirmDryRun || !out.requestDir || !out.receiptDir)) throw new Error('--apply requires --report, --output, --confirm-dry-run, --request-dir and --receipt-dir');
  if (out.apply && (!out.reviewedAt || Number.isNaN(Date.parse(out.reviewedAt)))) throw new Error('--apply requires --reviewed-at with a valid timestamp');
  if (!Number.isInteger(out.minMutationIntervalMs) || out.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  if (!Number.isInteger(out.getMaxAttempts) || out.getMaxAttempts < 1 || out.getMaxAttempts > 3) throw new Error('--get-max-attempts must be an integer from 1 to 3');
  if (!Number.isInteger(out.getBackoffMs) || out.getBackoffMs < 0) throw new Error('--get-backoff-ms must be a non-negative integer');
  return out;
}

function executeGh(args, input = null) {
  return execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

function ghJsonOnce(args, input = null, execute = executeGh) {
  return JSON.parse(execute(args, input));
}

function ghJson(args, input = null) {
  return ghJsonOnce(args, input);
}

function httpStatusFromError(error) {
  for (const value of [error && error.status, error && error.statusCode]) {
    if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
  }
  const text = [error && error.message, error && error.stderr, error && error.stdout].filter(Boolean).join(' ');
  const explicit = text.match(/\bHTTP\s*([45]\d{2})\b/i) || text.match(/\(([45]\d{2})\)/) || text.match(/\b(?:status|response)[^\d]{0,20}([45]\d{2})\b/i);
  return explicit ? Number(explicit[1]) : null;
}

function isRetryableGetError(error) {
  const status = httpStatusFromError(error);
  if (status !== null) return status === 429 || (status >= 500 && status <= 599);
  if (TRANSIENT_NETWORK_CODES.has(error && error.code)) return true;
  const text = [error && error.message, error && error.stderr, error && error.stdout].filter(Boolean).join(' ').toLowerCase();
  if (/(tls handshake timeout|i\/o timeout|connection reset|connection refused|socket hang up|temporary failure|network is unreachable|timed out)/i.test(text)) return true;
  // gh/Go transport reports some transient reads as `Get "<URL>": unexpected EOF`.
  // Require the complete GET-URL transport shape: arbitrary semantic messages
  // containing EOF must remain non-retryable.
  return /\bGet\s+["']?https?:\/\/\S+?["']?:\s*(?:unexpected\s+)?EOF\b/i.test(text);
}

function ghJsonGet(args, options = {}) {
  const maxAttempts = options.maxAttempts === undefined ? DEFAULT_GET_MAX_ATTEMPTS : options.maxAttempts;
  const backoffMs = options.backoffMs === undefined ? DEFAULT_GET_BACKOFF_MS : options.backoffMs;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new RangeError('GET maxAttempts must be an integer from 1 to 3');
  if (!Number.isInteger(backoffMs) || backoffMs < 0) throw new RangeError('GET backoffMs must be a non-negative integer');
  const execute = options.execute || executeGh;
  const sleep = options.sleep || sleepMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return ghJsonOnce(args, null, execute);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableGetError(error)) throw error;
      sleep(backoffMs * (2 ** (attempt - 1)));
    }
  }
  throw new Error('unreachable GET retry state');
}

function atomicWriteText(file, value) {
  if (typeof value !== 'string') throw new TypeError('atomicWriteText requires text');
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, absolute);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) { /* preserve the original write error */ }
    throw error;
  }
  // Directory fsync makes the rename durable. Some platforms/filesystems do
  // not permit opening directories; tolerate only those documented cases.
  try {
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  }
}

function atomicWriteJson(file, value) { atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function sleepMs(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function loadIssue(repository, number, getOptions = {}) { return ghJsonGet(['api', `repos/${repository}/issues/${number}`], getOptions); }

function loadComments(repository, number, getOptions = {}) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = ghJsonGet(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`], getOptions);
    if (!Array.isArray(result)) throw new Error(`comments response for #${number} is not an array`);
    comments.push(...result);
    if (result.length < 100) return comments;
  }
  throw new Error(`comments pagination exceeded for #${number}`);
}

function readBlob(repository, sha, getOptions = {}) { return ghJsonGet(['api', `repos/${repository}/git/blobs/${sha}`], getOptions); }

function loadOwnership(repository, interviewNoteId, adapters = {}) {
  const endpoint = ownershipSearchEndpoint(repository, interviewNoteId);
  const getOptions = adapters.getOptions || {};
  const readPage = adapters.readPage || ((page) => ghJsonGet(['api', `${endpoint}&page=${page}`], getOptions));
  const readIssue = adapters.readIssue || ((number) => loadIssue(repository, number, getOptions));
  const owners = [];
  let totalCount = null;
  let collected = 0;
  for (let page = 1; page <= 10; page += 1) {
    const result = readPage(page);
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.incomplete_results !== false || !Array.isArray(result.items)
      || !Number.isInteger(result.total_count) || result.total_count < 0
      || result.items.length > 100) throw new Error('ownership search response is incomplete or malformed');
    if (totalCount === null) totalCount = result.total_count;
    if (result.total_count !== totalCount) throw new Error('ownership search total_count changed during pagination');
    collected += result.items.length;
    if (collected > totalCount) throw new Error('ownership search returned more items than total_count');
    for (const item of result.items) {
      const number = Number(item && item.number);
      if (!Number.isInteger(number) || number < 1) throw new Error('ownership search returned an invalid Issue number');
      const issue = readIssue(number);
      if (!issue.pull_request && parseInterviewNoteIssue(issue.body || '').marker?.interview_note_id === interviewNoteId) owners.push(issue);
    }
    if (collected === totalCount) return owners;
    if (result.items.length < 100) throw new Error('ownership search returned a short page before total_count');
  }
  throw new Error('ownership search exceeded bounded pages');
}

function writeRequestFiles(requestDir, packet, request) {
  atomicWriteText(path.join(requestDir, `issue-${packet.issue_number}.md`), `<!-- source-note-boundary-review-transition\n${JSON.stringify(request, null, 2)}\n-->`);
  atomicWriteJson(path.join(requestDir, `issue-${packet.issue_number}.json`), request);
}

function writeReceiptFile(receiptDir, packet, receipt) { atomicWriteJson(path.join(receiptDir, `issue-${packet.issue_number}.json`), receipt); }

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = readJson(path.resolve(args.manifest));
  const packetSet = buildPacketSet(manifest);
  const repository = packetSet.repository;
  const getOptions = { maxAttempts: args.getMaxAttempts, backoffMs: args.getBackoffMs };
  const liveLoader = (packet) => {
    const sourceIssue = loadIssue(repository, packet.issue_number, getOptions);
    return {
      sourceIssue,
      comments: loadComments(repository, packet.issue_number, getOptions),
      readBlob: (sha) => readBlob('liqiangcc/xhs', sha, getOptions),
      allIssues: loadOwnership(repository, `xhs:${packet.source_note_id.slice('xhs-note:'.length)}`, { getOptions }),
    };
  };
  const lock = args.apply ? acquireProgressLock(args.progressLock || `${args.progress}.lock`) : null;
  try {
    const progress = fs.existsSync(args.progress)
      ? readJson(args.progress)
      : initialProgress(packetSet.packet_set_sha256, packetSet.packets.map((packet) => packet.packet_id));
    const progressValidation = validateProgress(progress, packetSet);
    if (!progressValidation.ok) throw new Error(`progress validation failed closed: ${progressValidation.errors.join('; ')}`);
    const baseOptions = { liveLoader, progress, persistProgress: (value) => atomicWriteJson(args.progress, value) };
    const planned = runBatch(packetSet, manifest, { ...baseOptions, apply: false });
    if (!planned.ok) throw new Error(`preflight failed closed: ${planned.errors.join('; ')}`);
    if (!args.apply) {
      if (args.report) atomicWriteJson(args.report, planned.report);
      if (args.output) atomicWriteJson(args.output, planned);
      process.stdout.write(`${JSON.stringify({ ok: true, mode: 'plan', packet_set_sha256: packetSet.packet_set_sha256, dry_run_sha256: planned.dry_run_sha256, total: packetSet.packets.length, expected_mutations: planned.items.filter((item) => item.action === 'would-post-evidence').length, mutation_count: 0, report: args.report || null }, null, 2)}\n`);
      return 0;
    }
    if (args.confirmDryRun !== planned.dry_run_sha256) throw new Error(`dry-run confirmation mismatch: expected ${planned.dry_run_sha256}`);
    let lastMutationAt = 0;
    const result = runBatch(packetSet, manifest, {
      ...baseOptions,
      apply: true,
      reviewedAt: args.reviewedAt,
      beforeEvidencePost: () => { const now = Date.now(); sleepMs(Math.max(0, args.minMutationIntervalMs - (now - lastMutationAt))); lastMutationAt = Date.now(); },
      createEvidenceComment: (packet, body) => ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${packet.issue_number}/comments`, '--input', '-'], { body }),
      writeRequest: (packet, _body, request) => writeRequestFiles(path.resolve(args.requestDir), packet, request),
      writeReceipt: (packet, receipt) => writeReceiptFile(path.resolve(args.receiptDir), packet, receipt),
      readReceipt: (packet) => {
        const file = path.join(path.resolve(args.receiptDir), `issue-${packet.issue_number}.json`);
        return fs.existsSync(file) ? readJson(file) : null;
      },
      readRequest: (packet) => {
        const file = path.join(path.resolve(args.requestDir), `issue-${packet.issue_number}.json`);
        return fs.existsSync(file) ? readJson(file) : null;
      },
    });
    if (args.report) atomicWriteJson(args.report, result.report || result);
    if (args.output) atomicWriteJson(args.output, result);
    process.stdout.write(`${JSON.stringify({ ok: result.ok, mode: 'apply', packet_set_sha256: packetSet.packet_set_sha256, dry_run_sha256: result.dry_run_sha256, mutation_attempted: result.mutation_attempted, mutation_performed: result.mutation_performed, possibly_performed: result.possibly_performed, items: result.items.length, output: args.output, progress: args.progress }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    if (lock) lock.release();
  }
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, main, atomicWriteText, atomicWriteJson, loadIssue, loadComments, readBlob, loadOwnership, ghJson, ghJsonOnce, ghJsonGet, httpStatusFromError, isRetryableGetError, writeRequestFiles, writeReceiptFile };
