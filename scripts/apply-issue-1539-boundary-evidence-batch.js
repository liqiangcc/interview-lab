#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseInterviewNoteIssue } = require('./lib/interview-note-issue');
const { ownershipSearchEndpoint } = require('./lib/interview-note-ownership-search');
const {
  buildPacketSet, runBatch, initialProgress, validateProgress, acquireProgressLock,
} = require('./lib/issue-1539-boundary-evidence-batch');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, report: null, output: null, progress: null, progressLock: null, requestDir: null, receiptDir: null, apply: false, confirmDryRun: null, reviewedAt: null, minMutationIntervalMs: 1000 };
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
    else if (arg === '--apply') out.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['manifest', 'progress']) if (!out[key]) throw new Error(`--${key === 'manifest' ? 'candidate-manifest' : key} is required`);
  if (out.apply && (!out.report || !out.output || !out.confirmDryRun || !out.requestDir || !out.receiptDir)) throw new Error('--apply requires --report, --output, --confirm-dry-run, --request-dir and --receipt-dir');
  if (out.apply && (!out.reviewedAt || Number.isNaN(Date.parse(out.reviewedAt)))) throw new Error('--apply requires --reviewed-at with a valid timestamp');
  if (!Number.isInteger(out.minMutationIntervalMs) || out.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  return out;
}

function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function atomicWriteText(file, value) {
  if (typeof value !== 'string') throw new TypeError('atomicWriteText requires text');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, value);
  fs.renameSync(temp, file);
}

function atomicWriteJson(file, value) { atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function sleepMs(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function loadIssue(repository, number) { return ghJson(['api', `repos/${repository}/issues/${number}`]); }

function loadComments(repository, number) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = ghJson(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(result)) throw new Error(`comments response for #${number} is not an array`);
    comments.push(...result);
    if (result.length < 100) return comments;
  }
  throw new Error(`comments pagination exceeded for #${number}`);
}

function readBlob(repository, sha) { return ghJson(['api', `repos/${repository}/git/blobs/${sha}`]); }

function loadOwnership(repository, interviewNoteId) {
  const endpoint = ownershipSearchEndpoint(repository, interviewNoteId);
  const owners = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = ghJson(['api', `${endpoint}&page=${page}`]);
    if (!result || result.incomplete_results === true || !Array.isArray(result.items)) throw new Error('ownership search is incomplete');
    for (const item of result.items) {
      const issue = loadIssue(repository, Number(item.number));
      if (!issue.pull_request && parseInterviewNoteIssue(issue.body || '').marker?.interview_note_id === interviewNoteId) owners.push(issue);
    }
    if (result.items.length < 100 || page * 100 >= Number(result.total_count || 0)) return owners;
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
  const liveLoader = (packet) => {
    const sourceIssue = loadIssue(repository, packet.issue_number);
    return {
      sourceIssue,
      comments: loadComments(repository, packet.issue_number),
      readBlob: (sha) => readBlob('liqiangcc/xhs', sha),
      allIssues: loadOwnership(repository, `xhs:${packet.source_note_id.slice('xhs-note:'.length)}`),
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

module.exports = { parseArgs, main, atomicWriteText, atomicWriteJson, writeRequestFiles, writeReceiptFile };
