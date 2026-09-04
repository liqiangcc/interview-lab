#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { buildPacketSet, renderSummary } = require('./lib/issue-1539-source-review-packets');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, report: null, pinned: null, output: null, summary: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') out.manifest = argv[++i];
    else if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--pinned-artifact-manifest') out.pinned = argv[++i];
    else if (argv[i] === '--output') out.output = argv[++i];
    else if (argv[i] === '--summary') out.summary = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  for (const key of ['manifest', 'report', 'pinned', 'output', 'summary']) if (!out[key]) throw new Error(`--${key.replace('pinned', 'pinned-artifact-manifest')} is required`);
  return out;
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function loadIssue(repository, number) {
  return ghJson(['api', `repos/${repository}/issues/${number}`]);
}

function loadComments(repository, number) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghJson(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments page ${page} was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`Issue #${number} comments exceeded 100 pages`);
}

function listIssues(repository, label) {
  const issues = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghJson(['api', `repos/${repository}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue list for ${label} page ${page} was not an array`);
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) return issues;
  }
  throw new Error(`Issue list for ${label} exceeded 100 pages`);
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const pinnedArtifactManifest = JSON.parse(fs.readFileSync(args.pinned, 'utf8'));
  const numbers = new Set();
  for (const item of manifest.source_review.items || []) numbers.add(Number(item.interview_issue_number));
  for (const item of manifest.source_review.items || []) numbers.add(Number(item.source_note_issue_number));
  const issues = [...numbers].map((number) => loadIssue(manifest.repository, number));
  const ownershipInventory = listIssues(manifest.repository, 'type:interview-note');
  const liveComments = new Map((manifest.source_review.items || []).map((item) => [Number(item.interview_issue_number), loadComments(manifest.repository, item.interview_issue_number)]));
  const packetSet = buildPacketSet({ manifest, report, pinnedArtifactManifest, liveIssues: [...issues, ...ownershipInventory], liveComments });
  atomicWrite(args.output, `${JSON.stringify(packetSet, null, 2)}\n`);
  atomicWrite(args.summary, renderSummary(packetSet));
  process.stdout.write(`${JSON.stringify({ ok: true, output: args.output, summary: args.summary, packet_count: packetSet.packets.length, packet_set_sha256: packetSet.packet_set_sha256, mutation_performed: false }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { parseArgs, main, listIssues, loadIssue };
