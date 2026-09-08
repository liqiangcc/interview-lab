#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  planIssue1605Materialization,
  sha256Text,
  canonicalJson,
} = require('./lib/issue-1605-materialization-plan');
const { issueSourceRecord } = require('./lib/interview-note-materialization-batch');
const {
  findOwnershipMatches,
} = require('./lib/source-note-interview-materialization');
const {
  exactOwnershipCandidates,
  ownershipSearchEndpoint,
  createSearchThrottle,
} = require('./lib/interview-note-ownership-search');

const DEFAULT_REPOSITORY = 'liqiangcc/interview-lab';
const DEFAULT_OUTPUT = 'data/pilot/issue-1605/materialization.dry-run.json';

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ghJson(args, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? options.attempts : 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(execFileSync('gh', args, {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        timeout: 20_000,
      }));
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(attempt * 1000);
    }
  }
  throw lastError;
}

function ghPagedItems(endpoint, maxPages = 100) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = ghJson(['api', `${endpoint}&page=${page}`]);
    if (!Array.isArray(pageItems)) throw new Error(`GitHub list endpoint returned a non-array page: ${endpoint} page=${page}`);
    items.push(...pageItems);
    if (pageItems.length === 0 || pageItems.length < 100) return items;
  }
  throw new Error(`GitHub list endpoint exceeded ${maxPages} pages: ${endpoint}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function readIssueArray(file, description) {
  const value = readJson(file);
  const issues = Array.isArray(value) ? value : value && Array.isArray(value.issues) ? value.issues : null;
  if (!issues) throw new Error(`${file} must contain ${description} as an array or {issues: []}`);
  return issues;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    repository: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    boundaryReports: [],
    sourceNotesFile: null,
    ownershipFile: null,
    receiptsFile: null,
    output: DEFAULT_OUTPUT,
    searchPauseMs: 2200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--boundary-report') args.boundaryReports.push(argv[++index]);
    else if (arg === '--source-notes-file') args.sourceNotesFile = argv[++index];
    else if (arg === '--ownership-file') args.ownershipFile = argv[++index];
    else if (arg === '--receipts-file') args.receiptsFile = argv[++index];
    else if (arg === '--repository') args.repository = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--search-pause-ms') args.searchPauseMs = Number(argv[++index]);
    else if (['--apply', '--confirm-apply', '--max-mutations', '--pause-ms'].includes(arg)) {
      throw new Error(`${arg} is forbidden: this command is plan-only and never PATCHes or POSTs`);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(String(args.repository || ''))) throw new Error('--repository must be owner/repo');
  if (!args.boundaryReports.length) throw new Error('at least one --boundary-report is required');
  if (args.boundaryReports.some((file) => !file)) throw new Error('--boundary-report requires a file path');
  if (!Number.isInteger(args.searchPauseMs) || args.searchPauseMs < 2100) throw new Error('--search-pause-ms must be an integer >= 2100');
  return args;
}

function loadSourceIssues(repository, file) {
  if (file) return { issues: readIssueArray(file, 'live SourceNotes'), snapshot: { mode: 'controlled-live-snapshot', file: path.resolve(file) } };
  const issues = ghPagedItems(`repos/${repository}/issues?state=all&labels=type%3Asource-note&per_page=100`)
    .filter((issue) => !issue.pull_request);
  return { issues, snapshot: { mode: 'github-live-read', endpoint: `repos/${repository}/issues?state=all&labels=type%3Asource-note&per_page=100` } };
}

function loadOwnershipFile(file, repository) {
  if (!file) return null;
  const value = readJson(file);
  if (!value || Array.isArray(value) || !Array.isArray(value.issues)) throw new Error(`${file} must contain an object with issues[]`);
  if (value.repository !== repository) throw new Error(`${file} repository does not match ${repository}`);
  if (!value.completeness || value.completeness.complete !== true) throw new Error(`${file} must carry completeness.complete=true`);
  const digest = sha256Text(JSON.stringify(value.issues));
  if (value.issues_sha256 !== digest) throw new Error(`${file} issues_sha256 does not match issues[]`);
  return { issues: value.issues, proof: { file: path.resolve(file), schema_version: value.schema_version || null, scope: value.scope || null, completeness: value.completeness, issues_sha256: value.issues_sha256 } };
}

function loadReceipts(file) {
  if (!file) return new Map();
  const value = readJson(file);
  const entries = value && (value.receipts_by_source_issue || value);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${file} must contain receipts_by_source_issue`);
  return new Map(Object.entries(entries).map(([number, receipts]) => [Number(number), receipts]));
}

function sourceSnapshotDigest(issues) {
  return sha256Text(canonicalJson((issues || []).map((issue) => {
    const { parsed } = issueSourceRecord(issue);
    return {
      issue_number: Number(issue.number),
      body_sha256: sha256Text(issue.body),
      source_note_id: parsed && parsed.source_note_id || null,
      source_revision_id: parsed && parsed.source_revision && parsed.source_revision.id || null,
    };
  }).sort((left, right) => left.issue_number - right.issue_number)));
}

function plannedIdentities(boundaryReports, sourceIssues) {
  const numbers = new Set();
  for (const report of boundaryReports) for (const item of report.items || []) {
    const status = item.transition_status || item.status || item.receipt_state;
    if (['already_applied', 'applied'].includes(status)) numbers.add(Number(item.source_note_issue_number || item.issue_number));
  }
  const identities = new Set();
  for (const issue of sourceIssues) {
    if (!numbers.has(Number(issue.number))) continue;
    const { validation, parsed } = issueSourceRecord(issue);
    if (!validation.ok || !parsed || !parsed.boundary_review) continue;
    const base = `${parsed.source.system}:${parsed.source.external_id}`;
    if (['single-interview', 'not-interview'].includes(parsed.boundary_review.status)) identities.add(base);
    if (parsed.boundary_review.status === 'multi-interview') for (const item of parsed.boundary_review.interview_note_cases || []) if (item.interview_note_id) identities.add(item.interview_note_id);
  }
  return [...identities].sort();
}

function loadLiveOwnership(repository, identities, pauseMs) {
  const candidates = new Map();
  const errors = new Map();
  const beforePage = createSearchThrottle(pauseMs, sleepMs);
  for (const identity of identities) {
    try {
      const matches = exactOwnershipCandidates({
        interviewNoteId: identity,
        readPage: (page) => ghJson(['api', `${ownershipSearchEndpoint(repository, identity)}&page=${page}`]),
        readIssue: (number) => ghJson(['api', `repos/${repository}/issues/${number}`]),
        matches: findOwnershipMatches,
        beforePage,
      });
      for (const issue of matches) candidates.set(Number(issue.number), issue);
    } catch (error) {
      errors.set(identity, error.message);
    }
  }
  return { issues: [...candidates.values()], errors };
}

function atomicWrite(file, value) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, absolute);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const boundaryReports = args.boundaryReports.map(readJson);
  const source = loadSourceIssues(args.repository, args.sourceNotesFile);
  const ownershipOffline = loadOwnershipFile(args.ownershipFile, args.repository);
  const identities = plannedIdentities(boundaryReports, source.issues);
  const ownership = ownershipOffline
    ? { issues: ownershipOffline.issues, errors: new Map(), proof: ownershipOffline.proof }
    : loadLiveOwnership(args.repository, identities, args.searchPauseMs);
  const receipts = loadReceipts(args.receiptsFile);
  const report = planIssue1605Materialization({
    repository: args.repository,
    boundaryReports,
    sourceIssues: source.issues,
    ownershipIssues: ownership.issues,
    receiptsBySourceIssue: receipts,
    ownershipErrors: ownership.errors,
    ownershipSnapshot: {
      mode: ownershipOffline ? 'controlled-offline-ownership-snapshot' : 'github-exact-marker-search',
      proof: ownership.proof || null,
    },
    sourceSnapshot: {
      ...source.snapshot,
      count: source.issues.length,
      digest: sourceSnapshotDigest(source.issues),
    },
  });
  atomicWrite(args.output, report);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(args.output), dry_run_sha256: report.dry_run_sha256, counts: report.counts, blocked_reasons: report.blocked_reasons, mutation_performed: report.mutation_performed }, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, sourceSnapshotDigest, plannedIdentities, main };
