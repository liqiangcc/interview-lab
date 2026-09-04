#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { loadOwnershipMatches } = require('./plan-interview-note-source-review-transition');
const { validatePacketSet, runBatch, initialProgress, acquireProgressLock } = require('./lib/issue-1539-evidence-batch');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { packetSet: null, manifest: null, report: null, pinned: null, output: null, progress: null, progressLock: null, requestDir: null, apply: false, reviewedAt: null, minMutationIntervalMs: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--packet-set') out.packetSet = argv[++i];
    else if (argv[i] === '--manifest') out.manifest = argv[++i];
    else if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--pinned-artifact-manifest') out.pinned = argv[++i];
    else if (argv[i] === '--output') out.output = argv[++i];
    else if (argv[i] === '--progress') out.progress = argv[++i];
    else if (argv[i] === '--progress-lock') out.progressLock = argv[++i];
    else if (argv[i] === '--request-dir') out.requestDir = argv[++i];
    else if (argv[i] === '--reviewed-at') out.reviewedAt = argv[++i];
    else if (argv[i] === '--min-mutation-interval-ms') out.minMutationIntervalMs = Number(argv[++i]);
    else if (argv[i] === '--apply') out.apply = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  for (const key of ['packetSet', 'manifest', 'report', 'pinned', 'output', 'progress']) if (!out[key]) throw new Error(`--${key} is required`);
  if (out.apply && !out.requestDir) throw new Error('--request-dir is required with --apply');
  if (out.reviewedAt && Number.isNaN(Date.parse(out.reviewedAt))) throw new Error('--reviewed-at must be a valid timestamp');
  if (!Number.isInteger(out.minMutationIntervalMs) || out.minMutationIntervalMs < 0) throw new Error('--min-mutation-interval-ms must be a non-negative integer');
  return out;
}

function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sleepMs(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function atomicWriteText(file, value) {
  if (typeof value !== 'string') throw new TypeError('atomicWriteText requires a string');
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, value);
  fs.renameSync(temporary, file);
}
function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
function writeFormalRequestFiles(requestDir, packet, body, request) {
  fs.mkdirSync(requestDir, { recursive: true });
  atomicWriteText(`${requestDir}/issue-${packet.interview_issue_number}.md`, body);
  atomicWriteJson(`${requestDir}/issue-${packet.interview_issue_number}.json`, request);
}
function loadIssue(repository, number) { return ghJson(['api', `repos/${repository}/issues/${number}`]); }
function loadComments(repository, number) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghJson(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments response was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`Issue #${number} comments exceeded 100 pages`);
}
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const packetSet = readJson(args.packetSet);
  const manifest = readJson(args.manifest);
  const report = readJson(args.report);
  const pinnedArtifactManifest = readJson(args.pinned);
  const anchorValidation = validatePacketSet(packetSet, { manifest, report, pinnedArtifactManifest });
  if (!anchorValidation.ok) throw new Error(anchorValidation.errors.join('; '));
  const repository = packetSet.repository;
  const liveLoader = (packet) => ({
    interviewIssue: loadIssue(repository, packet.interview_issue_number),
    sourceIssue: loadIssue(repository, packet.source_note_issue_number),
    comments: loadComments(repository, packet.interview_issue_number),
    // Production planning needs the exact read-only owner candidates for duplicate-owner checks.
    allIssues: loadOwnershipMatches(repository, packet.interview_note_id),
  });
  const lock = args.apply ? acquireProgressLock(args.progressLock || `${args.progress}.lock`) : null;
  try {
    // Apply lock is acquired before this progress read and remains held through all
    // live evidence reads, pending intent writes, POSTs, request writes, and output.
    const priorProgress = fs.existsSync(args.progress) ? readJson(args.progress) : initialProgress(packetSet.packet_set_sha256, packetSet.packets.map((packet) => packet.packet_id));
    const progressWrites = [];
    let lastMutationAt = 0;
    const result = runBatch(packetSet, { manifest, report, pinnedArtifactManifest }, {
      apply: args.apply,
      liveLoader,
      progress: priorProgress,
      reviewedAt: args.reviewedAt,
      beforeEvidencePost: () => {
        const now = Date.now();
        sleepMs(Math.max(0, args.minMutationIntervalMs - (now - lastMutationAt)));
        lastMutationAt = Date.now();
      },
      persistProgress: (progress) => { atomicWriteJson(args.progress, progress); progressWrites.push(progress); },
      createEvidenceComment: (packet, body) => ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${packet.interview_issue_number}/comments`, '--input', '-'], { body }),
      writeRequest: (packet, body, request) => writeFormalRequestFiles(args.requestDir, packet, body, request),
    });
    atomicWriteJson(args.output, result);
    process.stdout.write(`${JSON.stringify({ ok: result.ok, mode: result.mode, mutation_attempted: result.mutation_attempted, mutation_performed: result.mutation_performed, possibly_performed: result.possibly_performed, packet_count: packetSet.packets.length, output: args.output, progress: args.progress, progress_writes: progressWrites.length }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    if (lock) lock.release();
  }
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, main, ghJson, loadIssue, loadComments, atomicWriteText, atomicWriteJson, writeFormalRequestFiles };
