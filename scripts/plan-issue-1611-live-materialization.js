#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { issueSourceRecord } = require('./lib/interview-note-materialization-batch');
const { canonicalDigest, sha256Text } = require('./lib/aggregate-downstream-pipeline');
const {
  LIVE_BOUNDARY_REPORT_SCHEMA,
  LIVE_BOUNDARY_MANIFEST_SCHEMA,
  LIVE_COMPLETION_PROOF,
  liveSourceSnapshotDigest,
  SOURCE_REF,
  planIssue1605Materialization,
} = require('./lib/issue-1605-materialization-plan');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const PARENT_ISSUE = 1605;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const COMPLETION_COMMENT_ID = LIVE_COMPLETION_PROOF.comment_id;
const COMPLETION_PLAN_DIGEST = LIVE_COMPLETION_PROOF.plan_digest;
const COMPLETION_MANIFEST_DIGEST = LIVE_COMPLETION_PROOF.manifest_digest;
const HEX64 = /^[0-9a-f]{64}$/;

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter((label) => typeof label === 'string' && label.trim()))].sort();
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function ghJson(args) {
  if (args.some((arg) => ['--method', '--input', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(String(arg).toUpperCase()))) {
    throw new Error('live materialization planner accepts GET-only GitHub calls');
  }
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30_000 }));
}

function pagedGet(endpoint, maxPages = MAX_PAGES) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = ghJson(['api', `${endpoint}&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`GET ${endpoint} page ${page} was not an array`);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return { items: all, pages: page, terminal_page_short: true };
  }
  throw new Error(`GET ${endpoint} reached maxPages=${maxPages} without a short terminal page`);
}

function sourceSnapshotDigest(issues) {
  return liveSourceSnapshotDigest(issues);
}

function markerValues(body, marker) {
  const matches = [...String(body || '').matchAll(new RegExp(`<!-- ${marker}\\n([\\s\\S]*?)\\n-->`, 'g'))];
  return matches.map((match) => {
    try { return JSON.parse(match[1]); } catch (error) { throw new Error(`${marker} comment marker is invalid JSON: ${error.message}`); }
  });
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactAppliedBoundaryEvidence(issue, comments) {
  const errors = [];
  const parsedResult = issueSourceRecord(issue);
  const parsed = parsedResult.parsed;
  const status = parsed && parsed.boundary_review && parsed.boundary_review.status;
  const sourceNoteId = parsed && parsed.source_note_id;
  const revision = parsed && parsed.source_revision && parsed.source_revision.id;
    const bodySha = sha256Text(issue.body || '');
  const labels = labelsOf(issue);
  const applied = [];
  const evidence = [];
  const legacyEvidence = [];
  const historicalEvidence = [];
  for (const comment of comments || []) {
    try {
      for (const value of markerValues(comment.body, 'source-note-boundary-review-applied')) applied.push({ comment, value });
      for (const value of markerValues(comment.body, 'source-note-boundary-review-evidence')) evidence.push({ comment, value });
      for (const value of markerValues(comment.body, 'issue-921-pilot-evidence')) legacyEvidence.push({ comment, value });
      for (const value of markerValues(comment.body, 'boundary-review-evidence.v1')) historicalEvidence.push({ comment, value });
    } catch (error) { errors.push(`#${issue.number} comment ${comment && comment.id}: ${error.message}`); }
  }
  const matchingApplied = applied.filter(({ value }) => value.issue_number === Number(issue.number));
  if (matchingApplied.length !== 1) errors.push(`#${issue.number} must have exactly one applied boundary receipt (got ${matchingApplied.length})`);
  const receipt = matchingApplied[0] && matchingApplied[0].value;
  const matchingEvidence = evidence.filter(({ value }) => value.issue_number === Number(issue.number)
    && receipt && value.transition_id === receipt.transition_id);
  const matchingLegacyEvidence = legacyEvidence.filter(({ value }) => value.issue_number === Number(issue.number)
    && receipt && value.transition_id === receipt.transition_id);
  const matchingHistoricalEvidence = historicalEvidence.filter(({ value }) => value.issue_number === Number(issue.number)
    && receipt && value.transition_id === receipt.transition_id);
  const selectedEvidence = matchingEvidence.length === 1 ? matchingEvidence[0] : matchingHistoricalEvidence.length === 1 ? matchingHistoricalEvidence[0] : matchingLegacyEvidence.length === 1 ? matchingLegacyEvidence[0] : null;
  const evidenceSchema = matchingEvidence.length === 1 ? 'source-note-boundary-review-evidence.v1' : matchingHistoricalEvidence.length === 1 ? 'boundary-review-evidence.v1' : matchingLegacyEvidence.length === 1 ? 'issue-921-pilot-evidence' : null;
  if (matchingEvidence.length + matchingHistoricalEvidence.length + matchingLegacyEvidence.length !== 1) errors.push(`#${issue.number} must have exactly one matching boundary evidence comment (got ${matchingEvidence.length + matchingHistoricalEvidence.length + matchingLegacyEvidence.length})`);
  const review = selectedEvidence && selectedEvidence.value;
  const equal = (label, actual, expected) => { if (actual !== expected) errors.push(`#${issue.number} boundary ${label} mismatch`); };
  if (receipt) {
    equal('receipt schema', receipt.schema_version, 'source-note-boundary-review-applied.v1');
    equal('receipt repository', receipt.repository, REPOSITORY);
    if (receipt.parent_issue != null) equal('receipt parent_issue', receipt.parent_issue, PARENT_ISSUE);
    equal('receipt source_note_id', receipt.source_note_id, sourceNoteId);
    equal('receipt decision', receipt.decision, status);
    if (receipt.expected_source_revision_id != null) equal('receipt expected_source_revision_id', receipt.expected_source_revision_id, revision);
    if (receipt.expected_source_repository_ref != null) equal('receipt expected_source_repository_ref', receipt.expected_source_repository_ref, SOURCE_REF);
    equal('receipt new_body_sha256', receipt.new_body_sha256, bodySha);
    if (JSON.stringify(receipt.interview_note_ids || []) !== JSON.stringify(parsed.boundary_review.interview_note_ids || [])) errors.push(`#${issue.number} receipt interview_note_ids mismatch`);
    const parsedCases = parsed.boundary_review.interview_note_cases || [];
    if (JSON.stringify(receipt.interview_note_cases || []) !== JSON.stringify(parsedCases)) errors.push(`#${issue.number} receipt interview_note_cases mismatch`);
  }
  if (review) {
    if (evidenceSchema === 'source-note-boundary-review-evidence.v1') equal('evidence schema', review.schema_version, 'source-note-boundary-review-evidence.v1');
    if (evidenceSchema === 'source-note-boundary-review-evidence.v1' || evidenceSchema === 'boundary-review-evidence.v1') {
      equal('evidence repository', review.repository, REPOSITORY);
      if (evidenceSchema === 'source-note-boundary-review-evidence.v1') equal('evidence parent_issue', review.parent_issue, PARENT_ISSUE);
    }
    equal('evidence source_note_id', review.source_note_id, sourceNoteId);
    if (evidenceSchema === 'source-note-boundary-review-evidence.v1' || evidenceSchema === 'boundary-review-evidence.v1') {
      equal('evidence expected_source_revision_id', review.expected_source_revision_id, revision);
      equal('evidence expected_source_repository_ref', review.expected_source_repository_ref, SOURCE_REF);
      equal('evidence decision', review.decision, status);
    } else {
      const sourceRevision = String(selectedEvidence.comment.body || '').match(/(?:^|\n)source_revision_id:\s*([^\n]+)/);
      const sourceRef = String(selectedEvidence.comment.body || '').match(/(?:^|\n)source_repository_ref:\s*([^\n]+)/);
      const decision = String(selectedEvidence.comment.body || '').match(/(?:^|\n)recommended_decision:\s*([^\n]+)/);
      equal('legacy evidence source_revision_id', sourceRevision && sourceRevision[1].trim(), revision);
      equal('legacy evidence source_repository_ref', sourceRef && sourceRef[1].trim(), SOURCE_REF);
      equal('legacy evidence decision', decision && decision[1].trim(), status);
    }
    for (const checkId of ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication']) {
      const check = (review.checks || []).find((candidate) => candidate && candidate.check_id === checkId);
      if (!check || check.result !== 'pass') errors.push(`#${issue.number} evidence check ${checkId} is not pass`);
    }
  }
  if (!labels.includes(`boundary:${status}`)) errors.push(`#${issue.number} lacks live boundary:${status} label`);
  if (parsed && parsed.source_revision && parsed.source_revision.source_repository_ref !== SOURCE_REF) errors.push(`#${issue.number} live SourceRevision ref drifted`);
  return {
    ok: errors.length === 0,
    errors,
    transition_id: receipt && receipt.transition_id || review && review.transition_id || null,
    evidence_comment_id: selectedEvidence && Number(selectedEvidence.comment.id) || null,
    receipt_comment_id: matchingApplied[0] && Number(matchingApplied[0].comment.id) || null,
    evidence_body_sha256: review && review.expected_body_sha256 || receipt && receipt.previous_body_sha256 || null,
    evidence_schema: evidenceSchema,
  };
}

function commentsByIssue(comments) {
  const result = new Map();
  for (const comment of comments || []) {
    const match = String(comment && comment.issue_url || '').match(/\/issues\/(\d+)$/);
    if (!match) continue;
    const number = Number(match[1]);
    if (!result.has(number)) result.set(number, []);
    result.get(number).push(comment);
  }
  return result;
}

function materializationReceiptsBySourceIssue(comments) {
  const result = new Map();
  for (const [issueNumber, values] of comments.entries()) {
    const receipts = [];
    for (const comment of values) {
      for (const receipt of markerValues(comment.body, 'source-note-interview-materialized')) {
        const adapted = receipt.schema_version === 'issue-1556-materialization-receipt.v1'
          ? { ...receipt, schema_version: receipt.case_key == null ? 'source-note-interview-materialized.v1' : 'source-note-interview-materialized.v2', legacy_schema_version: receipt.schema_version }
          : receipt;
        receipts.push({ ...adapted, comment_id: Number(comment.id) });
      }
    }
    if (receipts.length) result.set(issueNumber, receipts);
  }
  return result;
}

function buildLiveBoundaryReport(sourceIssues, commentsByIssue, completion) {
  const errors = [];
  const counts = { 'single-interview': 0, 'multi-interview': 0, 'not-interview': 0, pending: 0 };
  const items = [];
  const sourceIds = new Map();
  for (const issue of [...sourceIssues].sort((a, b) => Number(a.number) - Number(b.number))) {
    const number = Number(issue.number);
    const result = issueSourceRecord(issue);
    if (!Number.isInteger(number) || !result.validation.ok || !result.parsed) {
      errors.push(`#${issue.number} SourceNote validation failed: ${result.validation.errors.join('; ')}`);
      continue;
    }
    const parsed = result.parsed;
    const status = parsed.boundary_review && parsed.boundary_review.status;
    if (!Object.prototype.hasOwnProperty.call(counts, status)) {
      errors.push(`#${number} has unsupported boundary status ${status || 'missing'}`);
      continue;
    }
    counts[status] += 1;
    const sourceNoteId = parsed.source_note_id;
    if (sourceIds.has(sourceNoteId)) errors.push(`SourceNote identity ${sourceNoteId} repeats on #${sourceIds.get(sourceNoteId)} and #${number}`);
    sourceIds.set(sourceNoteId, number);
  const bodySha = sha256Text(issue.body || '');
    const applied = status === 'pending' ? { ok: false, errors: [], transition_id: null, evidence_comment_id: null, receipt_comment_id: null, evidence_body_sha256: null, evidence_schema: null }
      : exactAppliedBoundaryEvidence(issue, commentsByIssue.get(number) || []);
    errors.push(...applied.errors);
    const cases = status === 'multi-interview' ? (parsed.boundary_review.interview_note_cases || []) : [];
    const ids = status === 'not-interview' ? [] : [...(parsed.boundary_review.interview_note_ids || [])];
    items.push({
      issue_number: number,
      source_note_id: sourceNoteId,
      source_note_body_sha256: bodySha,
      evidence_body_sha256: applied.evidence_body_sha256,
      live_source_note_body_sha256: bodySha,
      source_revision_id: parsed.source_revision.id,
      source_repository_ref: parsed.source_revision.source_repository_ref || null,
      decision: status === 'pending' ? 'blocked' : status,
      transition_id: applied.transition_id,
      transition_status: status === 'pending' ? 'pending' : 'applied',
      evidence_comment_id: applied.evidence_comment_id,
      receipt_comment_id: applied.receipt_comment_id,
      evidence_schema: applied.evidence_schema,
      interview_note_ids: ids,
      interview_note_cases: cases,
      labels: labelsOf(issue),
    });
  }
  const reportInput = {
    schema_version: LIVE_BOUNDARY_REPORT_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
    mode: 'live-read-plan-only',
    completion_proof: completion,
    total: items.length,
    counts,
    source_snapshot_digest: sourceSnapshotDigest(sourceIssues),
    items,
    errors,
  };
  const canonicalInput = jsonSafe(reportInput);
  return { ...canonicalInput, dry_run_sha256: canonicalDigest(canonicalInput) };
}

function buildLiveManifest(report) {
  const input = {
    schema_version: LIVE_BOUNDARY_MANIFEST_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    coverage: 'all-live-type-source-note-issues',
    total: report.total,
    source_snapshot_digest: report.source_snapshot_digest,
    boundary_report_digest: report.dry_run_sha256,
    completion_proof: {
      ...LIVE_COMPLETION_PROOF,
    },
    items: report.items.map((item) => ({ issue_number: item.issue_number, transition_id: item.transition_id })),
    mutation_policy: { plan_only: true, patch: 0, post: 0, create: 0 },
  };
  const canonicalInput = jsonSafe(input);
  return { ...canonicalInput, canonical_digest: canonicalDigest(canonicalInput) };
}

function validateInventory(inventory) {
  const errors = [];
  if (!inventory || inventory.schema_version !== 'aggregate-interview-note-ownership-inventory.v1') errors.push('full ownership inventory schema mismatch');
  if (inventory.repository !== REPOSITORY || inventory.coverage !== 'all-repository-interview-note-issues' || inventory.complete !== true) errors.push('full ownership inventory is not complete all-repository coverage');
  if (!Array.isArray(inventory.entries) || inventory.count !== inventory.entries.length) errors.push('full ownership inventory count/entries mismatch');
  if (!HEX64.test(String(inventory.canonical_digest || ''))) errors.push('full ownership inventory canonical_digest is required');
  else { const { canonical_digest: ignored, ...input } = inventory; if (canonicalDigest(input) !== inventory.canonical_digest) errors.push('full ownership inventory canonical_digest drifted'); }
  const ids = new Set(); const numbers = new Set();
  for (const entry of inventory.entries || []) {
    if (!entry || typeof entry.interview_note_id !== 'string' || ids.has(entry.interview_note_id)) errors.push('full ownership inventory has duplicate/missing interview_note_id');
    if (!Number.isInteger(Number(entry && entry.issue_number)) || numbers.has(Number(entry.issue_number))) errors.push('full ownership inventory has duplicate/invalid issue_number');
    ids.add(entry && entry.interview_note_id); numbers.add(Number(entry && entry.issue_number));
  }
  return { ok: errors.length === 0, errors };
}

function atomicWrite(file, value) {
  const target = path.resolve(file); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    repository: REPOSITORY,
    sourceNotesFile: null,
    sourceNotesOutput: 'data/pilot/issue-1611/source-note-live.snapshot.json',
    ownershipFile: 'data/pilot/issue-1611/interview-note-ownership.inventory.json',
    boundaryReportOutput: 'data/pilot/issue-1611/live-boundary.materialization-report.json',
    boundaryManifestOutput: 'data/pilot/issue-1611/live-boundary.materialization-manifest.json',
    output: 'data/pilot/issue-1611/materialization.live.dry-run.json',
    maxPages: MAX_PAGES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repository') args.repository = argv[++index];
    else if (arg === '--source-notes-file') args.sourceNotesFile = argv[++index];
    else if (arg === '--source-notes-output') args.sourceNotesOutput = argv[++index];
    else if (arg === '--ownership-file') args.ownershipFile = argv[++index];
    else if (arg === '--boundary-report-output') args.boundaryReportOutput = argv[++index];
    else if (arg === '--boundary-manifest-output') args.boundaryManifestOutput = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (['--apply', '--method', '--patch', '--post', '--create'].includes(arg)) throw new Error(`${arg} is forbidden: this planner is GET-only plan-only`);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(args.repository)) throw new Error('--repository must be owner/repo');
  if (!Number.isSafeInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > MAX_PAGES) throw new Error(`--max-pages must be an integer from 1 to ${MAX_PAGES}`);
  return args;
}

function loadCompletionProof() {
  const comments = ghJson(['api', `repos/${REPOSITORY}/issues/comments/${COMPLETION_COMMENT_ID}`]);
  const match = String(comments.body || '').match(/<!-- issue-1605-remaining-boundary-transition-complete\n([\s\S]*?)\n-->/);
  if (!match) throw new Error(`completion proof comment ${COMPLETION_COMMENT_ID} has no exact machine marker`);
  const proof = JSON.parse(match[1]);
  if (proof.schema_version !== 'issue-1605-remaining-boundary-transition-complete.v1'
    || proof.plan_digest !== COMPLETION_PLAN_DIGEST || proof.manifest_digest !== COMPLETION_MANIFEST_DIGEST
    || proof.scope?.remaining_total !== 978 || proof.scope?.actionable !== 557 || proof.scope?.blocked !== 421
    || proof.live_source_note_boundary_counts?.total !== 1460
    || proof.live_source_note_boundary_counts?.['single-interview'] !== 763
    || proof.live_source_note_boundary_counts?.['multi-interview'] !== 29
    || proof.live_source_note_boundary_counts?.['not-interview'] !== 247
    || proof.live_source_note_boundary_counts?.pending !== 421) throw new Error('online #1605 completion proof does not match the approved remaining-boundary facts');
  return { comment_id: COMPLETION_COMMENT_ID, ...proof };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const completion = loadCompletionProof();
  const source = args.sourceNotesFile
    ? (() => {
      const value = readJson(args.sourceNotesFile);
      const issues = Array.isArray(value) ? value : value && value.issues;
      if (!Array.isArray(issues)) throw new Error('source notes file must be an array or an object with issues[]');
      return { issues, pagination: value && value.pagination || { mode: 'controlled-source-snapshot', file: path.resolve(args.sourceNotesFile) } };
    })()
    : (() => { const value = pagedGet(`repos/${args.repository}/issues?state=all&labels=type%3Asource-note&per_page=${PAGE_SIZE}`, args.maxPages); return { issues: value.items.filter((issue) => !issue.pull_request), pagination: { mode: 'github-live-read', pages: value.pages, terminal_page_short: value.terminal_page_short } }; })();
  if (!Array.isArray(source.issues)) throw new Error('source notes snapshot must be an array');
  if (source.issues.length !== completion.live_source_note_boundary_counts.total) throw new Error(`live SourceNote snapshot must contain exactly ${completion.live_source_note_boundary_counts.total} issues`);
  atomicWrite(args.sourceNotesOutput, {
    schema_version: 'issue-1611-live-source-note-snapshot.v1',
    repository: args.repository,
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
    count: source.issues.length,
    pagination: source.pagination,
    issues: source.issues,
    canonical_digest: sourceSnapshotDigest(source.issues),
  });
  const inventory = readJson(args.ownershipFile);
  const inventoryValidation = validateInventory(inventory);
  if (!inventoryValidation.ok) throw new Error(`full ownership inventory failed closed: ${inventoryValidation.errors.join('; ')}`);
  const ownerIssues = [];
  for (const entry of inventory.entries) {
    const issue = ghJson(['api', `repos/${args.repository}/issues/${entry.issue_number}`]);
    const labels = labelsOf(issue);
    const parsed = parseInterviewNoteIssue(issue.body || '');
    if (Number(issue.number) !== Number(entry.issue_number) || parsed.marker?.interview_note_id !== entry.interview_note_id
      || sha256Text(issue.body || '') !== entry.body_sha256 || canonicalDigest(labels) !== canonicalDigest(entry.labels)) {
      throw new Error(`full ownership owner Issue #${entry.issue_number} drifted from inventory ${inventory.canonical_digest}`);
    }
    const validation = validateInterviewNoteIssue({ body: issue.body, labels, state: String(issue.state || 'open').toLowerCase() });
    if (!validation.ok) throw new Error(`full ownership owner Issue #${entry.issue_number} failed validation: ${validation.errors.join('; ')}`);
    ownerIssues.push(issue);
  }
  const appliedNumbers = new Set(source.issues.filter((issue) => labelsOf(issue).some((label) => ['boundary:single-interview', 'boundary:multi-interview', 'boundary:not-interview'].includes(label))).map((issue) => Number(issue.number)));
  const commentsPage = pagedGet(`repos/${args.repository}/issues/comments?per_page=${PAGE_SIZE}&state=all&sort=created&direction=asc`, args.maxPages);
  const commentsByIssueMap = commentsByIssue(commentsPage.items);
  const report = buildLiveBoundaryReport(source.issues, commentsByIssueMap, completion);
  const manifest = buildLiveManifest(report);
  const materializationReceipts = materializationReceiptsBySourceIssue(commentsByIssueMap);
  const planned = planIssue1605Materialization({
    repository: args.repository,
    boundaryReports: [report],
    boundaryManifest: manifest,
    sourceIssues: source.issues,
    ownershipIssues: ownerIssues,
    receiptsBySourceIssue: materializationReceipts,
    boundaryEvidenceComments: commentsByIssueMap,
    boundaryEvidenceSnapshot: { mode: 'github-live-read-global-paginated', candidate_issue_count: appliedNumbers.size, comments_loaded: commentsPage.items.length, pages: commentsPage.pages, terminal_page_short: commentsPage.terminal_page_short },
    sourceSnapshot: { mode: source.pagination.mode, count: source.issues.length, digest: sourceSnapshotDigest(source.issues), pages: source.pagination.pages || null, terminal_page_short: source.pagination.terminal_page_short ?? null },
    ownershipSnapshot: { mode: 'github-live-owner-issue-reconcile', inventory_digest: inventory.canonical_digest, count: inventory.count },
    requireCompleteScope: true,
  });
  atomicWrite(args.boundaryReportOutput, report);
  atomicWrite(args.boundaryManifestOutput, manifest);
  atomicWrite(args.output, planned);
  process.stdout.write(`${JSON.stringify({
    output: path.resolve(args.output), boundary_report: path.resolve(args.boundaryReportOutput), boundary_manifest: path.resolve(args.boundaryManifestOutput), source_snapshot: path.resolve(args.sourceNotesOutput),
    dry_run_sha256: planned.dry_run_sha256, boundary_report_sha256: report.dry_run_sha256, boundary_manifest_canonical_digest: manifest.canonical_digest,
    source_count: source.issues.length, ownership_count: inventory.count, boundary_counts: report.counts, candidate_identity_count: planned.ownership.identity_count,
    materialization_counts: planned.counts, blocked_reasons: planned.blocked_reasons, errors: planned.errors, mutation_performed: false, write_operations: { patch: 0, post: 0, create: 0 },
  }, null, 2)}\n`);
  return planned.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { labelsOf, pagedGet, commentsByIssue, materializationReceiptsBySourceIssue, sourceSnapshotDigest, markerValues, exactAppliedBoundaryEvidence, buildLiveBoundaryReport, buildLiveManifest, validateInventory, parseArgs, main };
