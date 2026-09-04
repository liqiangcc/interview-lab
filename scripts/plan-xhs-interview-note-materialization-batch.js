#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  planBatchMaterialization,
  labelsOf,
  issueSourceRecord,
} = require('./lib/interview-note-materialization-batch');
const { parseMaterializationReceipts, findOwnershipMatches } = require('./lib/source-note-interview-materialization');
const { exactOwnershipCandidates, ownershipSearchEndpoint, createSearchThrottle } = require('./lib/interview-note-ownership-search');
const { sha256Text } = require('./lib/source-note-interview-materialization');

function ghItems(endpoint) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync('gh', ['api', '--paginate', '--jq', '.[]', endpoint], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      });
      return raw.trim() ? raw.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
    } catch (error) {
      lastError = error;
      if (attempt < 3) sleepMs(attempt * 1000);
    }
  }
  throw lastError;
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }));
}

function ghReadJson(args, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 3;
  const retryPauseMs = Number.isFinite(options.retryPauseMs) ? options.retryPauseMs : 1000;
  const delay = typeof options.sleep === 'function' ? options.sleep : sleepMs;
  const read = typeof options.read === 'function' ? options.read : () => ghJson(args);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return read(); } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        if (typeof options.beforeRetry === 'function') options.beforeRetry();
        else delay(retryPauseMs * attempt);
      }
    }
  }
  throw lastError;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    repository: process.env.GITHUB_REPOSITORY || null,
    sourceIssuesFile: null,
    selectionFile: null,
    interviewIssuesFile: null,
    dependencyGateFile: null,
    receiptsFile: null,
    skipComments: false,
    report: null,
    limit: null,
    searchPauseMs: 2200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repository') out.repository = argv[++i];
    else if (arg === '--source-issues-file') out.sourceIssuesFile = argv[++i];
    else if (arg === '--selection-file') out.selectionFile = argv[++i];
    else if (arg === '--interview-issues-file') out.interviewIssuesFile = argv[++i];
    else if (arg === '--dependency-gate-file') out.dependencyGateFile = argv[++i];
    else if (arg === '--receipts-file') out.receiptsFile = argv[++i];
    else if (arg === '--skip-comments') out.skipComments = true;
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--search-pause-ms') out.searchPauseMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.repository || !/^[^/]+\/[^/]+$/.test(out.repository)) throw new Error('--repository owner/repo is required');
  if (out.limit != null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(out.searchPauseMs) || out.searchPauseMs < 2100) throw new Error('--search-pause-ms must be an integer >= 2100 to remain within the GitHub search rate budget');
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

function loadSelectedIssues(repository, file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : null;
  if (!items) throw new Error(`${file} must contain selection items`);
  return items.map((item) => Number(item.issue_number)).filter((number) => Number.isInteger(number) && number > 0)
    .map((number) => ghReadJson(['api', `repos/${repository}/issues/${number}`]))
    .filter((issue) => !issue.pull_request);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownershipIdentityCandidates(sourceIssues) {
  const identities = new Set();
  for (const sourceIssue of sourceIssues) {
    const { validation, parsed } = issueSourceRecord(sourceIssue);
    if (!validation.ok || !parsed || !parsed.source) continue;
    const base = `${parsed.source.system}:${parsed.source.external_id}`;
    if (parsed.boundary_review && ['single-interview', 'not-interview'].includes(parsed.boundary_review.status)) identities.add(base);
    if (parsed.boundary_review && parsed.boundary_review.status === 'multi-interview') {
      for (const item of parsed.boundary_review.interview_note_cases || []) {
        if (item.interview_note_id) identities.add(item.interview_note_id);
      }
    }
  }
  return [...identities];
}

function loadOwnershipCandidates(repository, sourceIssues, options = {}) {
  const identities = ownershipIdentityCandidates(sourceIssues);
  const candidates = new Map();
  const beforePage = createSearchThrottle(options.searchPauseMs, options.sleep || sleepMs);
  for (const interviewNoteId of identities) {
    if (typeof options.onProgress === 'function') options.onProgress({ stage: 'ownership-search', interview_note_id: interviewNoteId, completed: false });
    const matches = exactOwnershipCandidates({
        interviewNoteId,
        readPage: (page) => options.readPage
          ? options.readPage(interviewNoteId, page)
          : ghReadJson(['api', `${ownershipSearchEndpoint(repository, interviewNoteId)}&page=${page}`], { retryPauseMs: options.searchPauseMs, beforeRetry: beforePage }),
        readIssue: (number) => options.readIssue
          ? options.readIssue(number)
          : ghReadJson(['api', `repos/${repository}/issues/${number}`]),
        matches: findOwnershipMatches,
        beforePage,
      });
    for (const issue of matches) candidates.set(Number(issue.number), issue);
    if (typeof options.onProgress === 'function') options.onProgress({ stage: 'ownership-search', interview_note_id: interviewNoteId, completed: true, candidate_count: candidates.size });
  }
  return [...candidates.values()];
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
    if (!labels.has('boundary:single-interview') && !labels.has('boundary:multi-interview')) continue;
    result.set(Number(issue.number), parseMaterializationReceipts(loadComments(repository, issue.number)));
  }
  return result;
}

function loadDependencyGate(file) {
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function readOfflineInterviewIssues(file, repository) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object' || !Array.isArray(value.issues)) {
    throw new Error(`${file} must contain the controlled offline input object with issues[]`);
  }
  if (value.repository !== repository) throw new Error(`${file} repository scope does not match ${repository}`);
  if (!value.scope || value.scope.kind !== 'explicit-interview-note-candidate-set' || !Array.isArray(value.scope.source_issue_numbers)) {
    throw new Error(`${file} must declare an explicit source_issue_numbers scope`);
  }
  if (!value.completeness || value.completeness.complete !== true || typeof value.completeness.method !== 'string' || !value.completeness.method.trim()) {
    throw new Error(`${file} must carry structured completeness proof`);
  }
  const digest = sha256Text(JSON.stringify(value.issues));
  if (value.issues_sha256 !== digest) throw new Error(`${file} issues_sha256 does not match issues[]`);
  return { issues: value.issues, proof: { schema_version: value.schema_version, repository: value.repository, scope: value.scope, completeness: value.completeness, issues_sha256: value.issues_sha256 } };
}

function publicResult(result) {
  const materialization = result.materialization;
  return {
    source_note_issue_number: result.source_note_issue_number,
    source_note_id: result.source_note_id,
    boundary_status: result.boundary_status,
    case_key: result.case_key || null,
    action: result.action,
    reason_code: result.reason_code,
    errors: result.errors,
    source_review: result.source_review || null,
    request: result.request || null,
    materialization: materialization ? {
      action: materialization.action,
      interview_note_id: materialization.interview_note_id,
      case_key: materialization.case_key || null,
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
  const progressFile = args.report ? `${args.report}.progress.json` : null;
  if (progressFile) atomicWrite(progressFile, { schema_version: 'source-note-interview-materialization-dry-run-progress.v1', status: 'running', stage: 'source-selection', identity: null, repository: args.repository, report: args.report, search_pause_ms: args.searchPauseMs, completed_identities: [] });
  try {
    const updateProgress = (patch) => {
      if (!progressFile) return;
      const current = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      atomicWrite(progressFile, { ...current, ...patch, updated_at: new Date().toISOString() });
    };
    const sourceIssues = args.sourceIssuesFile
      ? readJsonFile(args.sourceIssuesFile)
      : args.selectionFile
        ? loadSelectedIssues(args.repository, args.selectionFile)
        : loadIssues(args.repository, 'type:source-note');
    const limitedSources = args.limit == null ? sourceIssues : sourceIssues.slice(0, args.limit);
    const offline = args.interviewIssuesFile ? readOfflineInterviewIssues(args.interviewIssuesFile, args.repository) : null;
    const interviewIssues = offline
      ? offline.issues
      : loadOwnershipCandidates(args.repository, limitedSources, { searchPauseMs: args.searchPauseMs, onProgress: (item) => {
        if (!progressFile) return;
        const current = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        updateProgress({ stage: item.stage, identity: item.interview_note_id, ...(item.completed ? { completed_identities: [...new Set([...current.completed_identities, item.interview_note_id])] } : {}) });
      } });
    updateProgress({ stage: 'receipts', identity: null });
    const receiptsBySourceIssue = loadReceipts(args.repository, limitedSources, args.receiptsFile, args.skipComments);
    updateProgress({ stage: 'plan', identity: null });
    const report = planBatchMaterialization({
      repository: args.repository,
      sourceIssues: limitedSources,
      interviewIssues,
      receiptsBySourceIssue,
      dependencyGate: loadDependencyGate(args.dependencyGateFile),
    });
    const reportWithoutDigest = {
      ...report,
      results: report.results.map(publicResult),
      source_issue_count_loaded: sourceIssues.length,
      source_issue_count_planned: limitedSources.length,
      interview_issue_count_loaded: interviewIssues.length,
      ownership_search: args.interviewIssuesFile ? 'controlled-offline-input' : 'exact-identity-candidate-search',
      source_selection: args.selectionFile ? 'controlled-selection-file' : null,
      ownership_search_pause_ms: args.interviewIssuesFile ? null : args.searchPauseMs,
      offline_input_proof: offline ? offline.proof : null,
      ready_for_apply: offline ? false : report.ready_for_apply,
      mutation_performed: false,
    };
    const safeReport = { ...reportWithoutDigest, dry_run_sha256: sha256Text(JSON.stringify(reportWithoutDigest)) };
    if (args.report) atomicWrite(args.report, safeReport);
    if (progressFile) atomicWrite(progressFile, { schema_version: 'source-note-interview-materialization-dry-run-progress.v1', status: 'complete', stage: 'complete', identity: null, repository: args.repository, report: args.report, search_pause_ms: args.searchPauseMs, completed_identities: JSON.parse(fs.readFileSync(progressFile, 'utf8')).completed_identities, dry_run_sha256: safeReport.dry_run_sha256, updated_at: new Date().toISOString() });
    process.stdout.write(`${JSON.stringify(safeReport, null, 2)}\n`);
    return safeReport.ready_for_apply ? 0 : 1;
  } catch (error) {
    if (progressFile) {
      let current = {};
      try { current = JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch (_) { /* preserve failure below */ }
      atomicWrite(progressFile, { ...current, status: 'failed', error: error.message, updated_at: new Date().toISOString(), mutation_performed: false, ready_for_apply: false });
    }
    throw error;
  }
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
  readOfflineInterviewIssues,
  loadOwnershipCandidates,
  ownershipIdentityCandidates,
  ghReadJson,
  labelsOf,
  main,
};
