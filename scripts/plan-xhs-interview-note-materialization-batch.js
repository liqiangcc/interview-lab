#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  planBatchMaterialization,
  labelsOf,
} = require('./lib/interview-note-materialization-batch');
const { parseMaterializationReceipts } = require('./lib/source-note-interview-materialization');
const { sha256Text } = require('./lib/source-note-interview-materialization');

function ghItems(endpoint) {
  const raw = execFileSync('gh', ['api', '--paginate', '--jq', '.[]', endpoint], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return raw.trim() ? raw.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    repository: process.env.GITHUB_REPOSITORY || null,
    sourceIssuesFile: null,
    interviewIssuesFile: null,
    dependencyGateFile: null,
    receiptsFile: null,
    skipComments: false,
    report: null,
    limit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repository') out.repository = argv[++i];
    else if (arg === '--source-issues-file') out.sourceIssuesFile = argv[++i];
    else if (arg === '--interview-issues-file') out.interviewIssuesFile = argv[++i];
    else if (arg === '--dependency-gate-file') out.dependencyGateFile = argv[++i];
    else if (arg === '--receipts-file') out.receiptsFile = argv[++i];
    else if (arg === '--skip-comments') out.skipComments = true;
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.repository || !/^[^/]+\/[^/]+$/.test(out.repository)) throw new Error('--repository owner/repo is required');
  if (out.limit != null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error('--limit must be a positive integer');
  return out;
}

function readJsonFile(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.issues)) return value.issues;
  if (value && typeof value === 'object' && Number.isInteger(value.number)) return [value];
  throw new Error(`${file} must contain an issue array or {issues: []}`);
}

function loadIssues(repository, label) {
  return ghItems(`repos/${repository}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100`)
    .filter((issue) => !issue.pull_request);
}

function loadAllIssues(repository) {
  return ghItems(`repos/${repository}/issues?state=all&per_page=100`)
    .filter((issue) => !issue.pull_request);
}

function loadComments(repository, issueNumber) {
  return ghItems(`repos/${repository}/issues/${issueNumber}/comments?per_page=100`);
}

function loadReceipts(repository, sourceIssues, receiptsFile, skipComments) {
  if (receiptsFile) {
    const value = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));
    const entries = value.receipts_by_source_issue || value;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${receiptsFile} must contain receipts_by_source_issue object`);
    return new Map(Object.entries(entries).map(([key, receipts]) => [Number(key), receipts]));
  }
  if (skipComments) return new Map();
  const result = new Map();
  for (const issue of sourceIssues) {
    const labels = new Set(labelsOf(issue));
    if (!labels.has('boundary:single-interview')) continue;
    result.set(Number(issue.number), parseMaterializationReceipts(loadComments(repository, issue.number)));
  }
  return result;
}

function loadDependencyGate(file) {
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function publicResult(result) {
  const materialization = result.materialization;
  return {
    source_note_issue_number: result.source_note_issue_number,
    source_note_id: result.source_note_id,
    boundary_status: result.boundary_status,
    action: result.action,
    reason_code: result.reason_code,
    errors: result.errors,
    source_review: result.source_review || null,
    request: result.request || null,
    materialization: materialization ? {
      action: materialization.action,
      interview_note_id: materialization.interview_note_id,
      ownership_count: materialization.ownership_count,
      existing_issue_number: materialization.existing_issue_number,
      already_materialized: materialization.already_materialized,
      needs_receipt_repair: materialization.needs_receipt_repair,
      source_note_body_sha256: materialization.source_note_body_sha256,
      projected_body_sha256: materialization.projection ? sha256Text(materialization.projection.body) : null,
      projected_title: materialization.projection ? materialization.projection.title : null,
      projected_labels: materialization.projection ? materialization.projection.labels : null,
    } : null,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sourceIssues = args.sourceIssuesFile ? readJsonFile(args.sourceIssuesFile) : loadIssues(args.repository, 'type:source-note');
  const interviewIssues = args.interviewIssuesFile ? readJsonFile(args.interviewIssuesFile) : loadAllIssues(args.repository);
  const limitedSources = args.limit == null ? sourceIssues : sourceIssues.slice(0, args.limit);
  const receiptsBySourceIssue = loadReceipts(args.repository, limitedSources, args.receiptsFile, args.skipComments);
  const report = planBatchMaterialization({
    repository: args.repository,
    sourceIssues: limitedSources,
    interviewIssues,
    receiptsBySourceIssue,
    dependencyGate: loadDependencyGate(args.dependencyGateFile),
  });
  const safeReport = {
    ...report,
    results: report.results.map(publicResult),
    source_issue_count_loaded: sourceIssues.length,
    source_issue_count_planned: limitedSources.length,
    interview_issue_count_loaded: interviewIssues.length,
    mutation_performed: false,
  };
  if (args.report) fs.writeFileSync(args.report, `${JSON.stringify(safeReport, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ...safeReport,
  }, null, 2)}\n`);
  return report.ready_for_apply ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  parseArgs,
  readJsonFile,
  labelsOf,
  main,
};
