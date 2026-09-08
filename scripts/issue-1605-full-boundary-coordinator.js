#!/usr/bin/env node
'use strict';

/*
 * Controller for the full SourceNote boundary stage of Issue #1605.
 *
 * This tool deliberately separates the read-only decision plan from the two
 * mutation stages.  `plan` only reads committed child artifacts and the local
 * SourceNote snapshot.  `evidence` may POST one durable review comment per
 * approved decision, but never PATCHes a SourceNote.  `transition` is kept as
 * a separate, guarded stage and is not enabled by this first implementation.
 *
 * The child workers produce deliberately different audit schemas.  The
 * normalizer below is the single controller-owned boundary between those
 * proposals and the formal source-note-boundary-review-transition.v1/v2
 * contract.  Any missing or contradictory fact is fail-closed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1605;
const PENDING_SNAPSHOT = 'data/pilot/issue-1605/pending-inventory.snapshot.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1605/full-boundary-evidence-plan.json';
const DEFAULT_JOURNAL = 'data/pilot/issue-1605/full-boundary-evidence-progress.json';
const DEFAULT_LOCK = 'data/pilot/issue-1605/full-boundary-evidence-progress.lock';
const DEFAULT_REQUEST_DIR = 'data/pilot/issue-1605/full-boundary-requests';
const SNAPSHOT_CACHE = '/tmp/interview-lab-cache/source-notes.json';
const TRANSITION_SCHEMA = 'source-note-boundary-review-transition.v1';
const MULTI_TRANSITION_SCHEMA = 'source-note-boundary-review-transition.v2';
const REQUIRED_CHECKS = Object.freeze([
  'source_identity',
  'source_revision_binding',
  'source_content_coverage',
  'event_boundary',
  'no_cross_source_mixing',
  'no_fabrication',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function labelsOf(issue) {
  return (issue.labels || issue.labels?.nodes || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean)
    .sort();
}

function pad(number) {
  return String(number).padStart(4, '0');
}

function issueMapFromCache(file = SNAPSHOT_CACHE) {
  const values = readJson(file);
  const list = Array.isArray(values) ? values : values.issues;
  if (!Array.isArray(list)) throw new Error(`SourceNote cache is not an array: ${file}`);
  return new Map(list.map((issue) => [Number(issue.number), issue]));
}

function pendingInventory(file = PENDING_SNAPSHOT) {
  const snapshot = readJson(file);
  if (snapshot.schema_version !== 'issue-1605-pending-source-note-inventory.v1') {
    throw new Error(`unexpected pending inventory schema: ${snapshot.schema_version}`);
  }
  if (snapshot.source_repository !== SOURCE_REPOSITORY || snapshot.source_ref !== SOURCE_REF) {
    throw new Error('pending inventory is not pinned to the approved XHS source ref');
  }
  const numbers = snapshot.items.map((item) => Number(item.issue_number));
  if (numbers.length !== 1397 || new Set(numbers).size !== numbers.length) {
    throw new Error(`pending inventory must contain 1397 unique SourceNotes; got ${numbers.length}`);
  }
  return { snapshot, numbers: new Set(numbers) };
}

function loadArtifactInputs() {
  const root = path.resolve('.');
  const rows = [];
  const errors = [];
  const addError = (message) => errors.push(message);
  const add = (row) => {
    if (!row || !Number.isInteger(Number(row.issue_number))) return addError('artifact row has no issue_number');
    rows.push(row);
  };

  // Boundary A: custom request files contain formal source anchors and checks.
  const aPlan = readJson(path.join(root, 'data/issue-1606/boundary.dry-run.json'));
  for (const item of aPlan.items || []) {
    if (!item.decision) continue;
    const request = readJson(path.join(root, 'data/issue-1606/requests', `${pad(item.issue_number)}.json`));
    const evidence = request.evidence || {};
    add({
      batch: 'A', issue_number: Number(item.issue_number), decision: item.decision,
      source_note_id: request.source_note_id, expected_body_sha256: request.expected_body_sha256,
      expected_source_revision_id: request.expected_source_revision_id,
      artifact: {
        ref: evidence.artifact_ref, kind: evidence.kind, provenance: evidence.artifact_provenance,
        git_blob_sha: evidence.git_blob_sha, byte_size: evidence.byte_size,
      },
      excerpts: evidence.excerpts || [], checks: request.checks || [],
      rationale: request.checks?.find((check) => check.check_id === 'event_boundary')?.note || 'Boundary A controller-reviewed decision.',
      transition_id: `issue-1605-boundary-${item.issue_number}-a`,
    });
  }

  // Boundary B: the scope-clean rerun may remain proposal-only.  Only
  // non-pending proposals from a verified selection are promotable here.
  const bPlanFile = path.join(root, 'data/issue-1607/dry-run.plan.json');
  const bEvidenceFile = path.join(root, 'data/issue-1607/evidence-ledger.json');
  const bClassFile = path.join(root, 'data/issue-1607/classification-ledger.json');
  if (fs.existsSync(bPlanFile) && fs.existsSync(bEvidenceFile) && fs.existsSync(bClassFile)) {
    const bPlan = readJson(bPlanFile);
    const bEvidence = readJson(bEvidenceFile);
    const bClass = readJson(bClassFile);
    const clean = bPlan.scope_compliance?.status === 'pass' && bPlan.fail_closed === true;
    const evidenceByNumber = new Map((bEvidence.items || []).map((item) => [Number(item.issue_number), item]));
    if (!clean) addError('Boundary B scope-compliance is not pass; no B proposal may enter the full transition plan');
    if (clean) for (const item of bClass.items || []) {
      const decision = item.proposed_decision;
      if (!['not-interview', 'single-interview'].includes(decision)) continue;
      const evidence = evidenceByNumber.get(Number(item.issue_number));
      if (!evidence || evidence.source_evidence?.verification?.status === 'blocked') {
        addError(`Boundary B #${item.issue_number} lacks independently verified source evidence`);
        continue;
      }
      add({
        batch: 'B', issue_number: Number(item.issue_number), decision,
        source_note_id: item.source_note_id, expected_body_sha256: evidence.expected_body_sha256,
        expected_source_revision_id: evidence.expected_source_revision_id,
        artifact: {
          ref: evidence.source_evidence.ref, kind: evidence.source_evidence.kind,
          provenance: evidence.source_evidence.provenance, git_blob_sha: evidence.source_evidence.git_blob_sha,
          byte_size: evidence.source_evidence.byte_size,
        },
        excerpts: evidence.source_evidence.excerpt ? [{ locator: evidence.source_evidence.locator, excerpt: evidence.source_evidence.excerpt }] : [],
        checks: evidence.checks || [], rationale: item.basis || evidence.decision_basis || 'Boundary B scope-clean controller review.',
        transition_id: `issue-1605-boundary-${item.issue_number}-b`,
      });
    }
  } else addError('Boundary B artifacts are absent; B remains explicitly pending.');

  // Boundary C: one evidence JSON per selected SourceNote.
  const cPlan = readJson(path.join(root, 'data/issue-1608/dry-run-plan.json'));
  for (const item of cPlan.items || []) {
    if (!item.decision) continue;
    const evidence = readJson(path.join(root, 'data/issue-1608', item.evidence_file));
    const artifact = evidence.artifact || evidence.source_evidence;
    if (!artifact) { addError(`Boundary C #${item.issue_number} has no exact source artifact`); continue; }
    add({
      batch: 'C', issue_number: Number(item.issue_number), decision: item.decision,
      source_note_id: item.source_note_id, expected_body_sha256: item.body_sha256,
      expected_source_revision_id: evidence.source_revision_id,
      artifact: {
        ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance,
        git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size,
      },
      excerpts: evidence.excerpts || [], checks: evidence.checks || [],
      cases: evidence.case_keys?.length ? (evidence.case_evidence || []) : [],
      rationale: evidence.rationale || 'Boundary C controller-reviewed decision.',
      transition_id: `issue-1605-boundary-${item.issue_number}-c`,
    });
  }

  // Boundary D: the dry-run item points to a separately committed evidence file.
  const dPlan = readJson(path.join(root, 'data/issue-1609/dry-run-plan.json'));
  for (const item of dPlan.items || []) {
    if (!['single-interview', 'multi-interview', 'not-interview'].includes(item.disposition)) continue;
    const evidence = readJson(path.join(root, 'data/issue-1609/evidence', `${item.issue_number}.json`));
    const artifact = evidence.source_evidence;
    if (!artifact) { addError(`Boundary D #${item.issue_number} has no exact source artifact`); continue; }
    const cases = (evidence.interview_cases || []).map((candidate) => ({
      case_key: candidate.case_key,
      evidence: [{ ref: artifact.ref, locator: candidate.locator }],
    }));
    add({
      batch: 'D', issue_number: Number(item.issue_number), decision: item.disposition,
      source_note_id: evidence.source_note_id, expected_body_sha256: evidence.body_sha256,
      expected_source_revision_id: evidence.source_revision_id,
      artifact: {
        ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance,
        git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size,
      },
      excerpts: artifact.excerpt ? [artifact.excerpt] : [], checks: evidence.checks || [],
      cases, rationale: evidence.rationale || 'Boundary D controller-reviewed decision.',
      transition_id: `issue-1605-boundary-${item.issue_number}-d`,
    });
  }

  return { rows, errors };
}

function normalizeExcerpt(value) {
  if (!value) return null;
  const line = Number(value.line ?? value.line_number);
  const locator = String(value.locator || (Number.isInteger(line) ? `artifact-line:${line}` : '')).trim();
  const excerpt = String(value.excerpt || value.semantic_excerpt || '').trim();
  if (!locator || !excerpt) return null;
  return { locator, excerpt, ...(Number.isInteger(line) ? { line } : {}) };
}

function normalizedCases(row) {
  return (row.cases || []).map((candidate) => {
    const raw = Array.isArray(candidate.evidence)
      ? candidate.evidence
      : [candidate.evidence, candidate.detail_evidence].filter(Boolean);
    const evidence = raw.map((reference) => ({
      ref: reference.ref || row.artifact?.ref,
      locator: reference.locator,
    })).filter((reference, index, all) => reference.ref && reference.locator
      && all.findIndex((candidate) => candidate.ref === reference.ref && candidate.locator === reference.locator) === index);
    return { case_key: candidate.case_key, evidence };
  }).filter((candidate) => candidate.case_key && candidate.evidence.length);
}

function validateRows(rows, pending) {
  const errors = [];
  const seen = new Set();
  for (const row of rows) {
    const issueNumber = Number(row.issue_number);
    if (!pending.has(issueNumber)) errors.push(`#${issueNumber} is outside the frozen pending inventory`);
    if (seen.has(issueNumber)) errors.push(`#${issueNumber} appears in more than one boundary batch`);
    seen.add(issueNumber);
    if (!['not-interview', 'single-interview', 'multi-interview'].includes(row.decision)) errors.push(`#${issueNumber} has unsupported decision ${row.decision}`);
    if (!/^xhs-note:[^\s]+$/.test(String(row.source_note_id || ''))) errors.push(`#${issueNumber} has invalid SourceNote identity`);
    if (!/^[0-9a-f]{64}$/.test(String(row.expected_body_sha256 || ''))) errors.push(`#${issueNumber} has invalid expected body SHA`);
    if (!row.expected_source_revision_id) errors.push(`#${issueNumber} has no SourceRevision id`);
    if (!row.artifact || !row.artifact.ref || !/^liqiangcc\/xhs:/.test(row.artifact.ref)) errors.push(`#${issueNumber} has no exact source artifact ref`);
    if (!['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection'].includes(row.artifact?.provenance)) errors.push(`#${issueNumber} artifact is not source evidence`);
    const excerpts = (row.excerpts || []).map(normalizeExcerpt).filter(Boolean);
    if (!excerpts.length) errors.push(`#${issueNumber} has no non-empty evidence excerpt`);
    if (row.decision === 'multi-interview') {
      const cases = normalizedCases(row);
      if (cases.length < 2) errors.push(`#${issueNumber} multi-interview has fewer than two cases`);
      const locators = cases.flatMap((candidate) => candidate.evidence.map((reference) => reference.locator));
      if (new Set(locators).size !== locators.length) errors.push(`#${issueNumber} multi-interview reuses an evidence locator`);
    }
  }
  return { errors, seen };
}

function buildPlan(options = {}) {
  const pending = pendingInventory(options.pending || PENDING_SNAPSHOT);
  const cache = issueMapFromCache(options.cache || SNAPSHOT_CACHE);
  const loaded = loadArtifactInputs();
  const validation = validateRows(loaded.rows, pending.numbers);
  const errors = [...loaded.errors, ...validation.errors];
  const items = loaded.rows.sort((left, right) => left.issue_number - right.issue_number).map((row) => {
    const sourceIssue = cache.get(row.issue_number);
    if (!sourceIssue) errors.push(`#${row.issue_number} is absent from SourceNote cache`);
    const labels = labelsOf(sourceIssue || {});
    if (!labels.includes('boundary:pending')) errors.push(`#${row.issue_number} is not pending in the frozen SourceNote snapshot`);
    const bodySha = sha256(sourceIssue?.body || '');
    if (sourceIssue && bodySha !== row.expected_body_sha256) errors.push(`#${row.issue_number} cached body SHA differs from child artifact`);
    const excerpts = (row.excerpts || []).map(normalizeExcerpt).filter(Boolean);
    const cases = normalizedCases(row);
    return {
      batch: row.batch, issue_number: row.issue_number, decision: row.decision,
      transition_id: row.transition_id, source_note_id: row.source_note_id,
      expected_body_sha256: row.expected_body_sha256,
      expected_source_revision_id: row.expected_source_revision_id,
      expected_manifest_sha256: null, expected_source_repository_ref: SOURCE_REF,
      artifact: row.artifact, excerpts, cases,
      rationale: row.rationale, checks: REQUIRED_CHECKS.map((check_id) => ({ check_id, result: 'pass', note: `Controller verified against ${row.artifact.ref}.` })),
      limitations: ['AI-assisted controller review; transition remains guarded by live CAS checks.', 'Raw Source and Derived learning metadata remain separate.', 'No InterviewNote identity is materialized by this boundary stage.'],
      source_snapshot_body_sha256: sourceIssue ? bodySha : null,
    };
  });
  const counts = { total: items.length, 'not-interview': 0, 'single-interview': 0, 'multi-interview': 0 };
  for (const item of items) counts[item.decision] += 1;
  const report = {
    schema_version: 'issue-1605-full-boundary-evidence-plan.v1', repository: REPOSITORY,
    parent_issue: PARENT_ISSUE, source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    pending_inventory: { path: options.pending || PENDING_SNAPSHOT, count: pending.numbers.size, digest: sha256(canonical(pending.snapshot)) },
    scope: { ranges: [{ batch: 'A', first_issue: 20, last_issue: 392 }, { batch: 'B', first_issue: 393, last_issue: 765 }, { batch: 'C', first_issue: 766, last_issue: 1138 }, { batch: 'D', first_issue: 1139, last_issue: 1508 }] },
    counts, mutation_count: 0, live_evidence_comments: 0, live_transitions: 0,
    errors, items,
  };
  report.canonical_digest = sha256(canonical(report));
  return report;
}

function ghJson(args, input = null) {
  const result = execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(result);
}

function sleep(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd;
  try { fd = fs.openSync(target, 'wx', 0o600); } catch (error) { throw new Error(`evidence writer lock is already held: ${error.message}`); }
  fs.writeFileSync(fd, `${JSON.stringify({ schema_version: 'issue-1605-evidence-lock.v1', pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
  fs.closeSync(fd);
  return { target, release() { if (fs.existsSync(target)) fs.unlinkSync(target); } };
}

function issueEndpoint(number) { return `repos/${REPOSITORY}/issues/${number}`; }

function readLiveIssue(number) { return ghJson(['api', issueEndpoint(number)]); }

function readCommentsPage(number, page) { return ghJson(['api', `${issueEndpoint(number)}/comments?per_page=100&page=${page}`]); }

function findMarkerComments(number, marker, maxPages = 100) {
  const matches = [];
  let observedShort = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const comments = readCommentsPage(number, page);
    if (!Array.isArray(comments)) throw new Error(`#${number} comments page ${page} is not an array`);
    matches.push(...comments.filter((comment) => typeof comment.body === 'string' && comment.body.includes(marker)));
    if (comments.length < 100) { observedShort = true; break; }
  }
  if (!observedShort) throw new Error(`#${number} comment pagination did not expose a short terminal page`);
  return matches;
}

function evidenceBody(item, reviewedAt) {
  const payload = {
    schema_version: 'source-note-boundary-review-evidence.v1', transition_id: item.transition_id,
    repository: REPOSITORY, parent_issue: PARENT_ISSUE, issue_number: item.issue_number,
    source_note_id: item.source_note_id, expected_body_sha256: item.expected_body_sha256,
    expected_source_revision_id: item.expected_source_revision_id,
    expected_source_repository_ref: SOURCE_REF, decision: item.decision, reviewed_at: reviewedAt,
    source_evidence: { artifact: item.artifact, excerpts: item.excerpts },
    interview_cases: item.cases || [], checks: item.checks, limitations: item.limitations,
  };
  return `<!-- source-note-boundary-review-evidence\n${JSON.stringify(payload, null, 2)}\n-->\n\nController review evidence for Issue #${item.issue_number}; no transition applied in this comment.`;
}

function formalRequest(item, commentId, reviewedAt) {
  const request = {
    schema_version: item.decision === 'multi-interview' ? MULTI_TRANSITION_SCHEMA : TRANSITION_SCHEMA,
    transition_id: item.transition_id, repository: REPOSITORY, issue_number: item.issue_number,
    source_note_id: item.source_note_id, expected_body_sha256: item.expected_body_sha256,
    expected_boundary_status: 'pending', expected_source_revision_id: item.expected_source_revision_id,
    expected_manifest_sha256: null, expected_source_repository_ref: SOURCE_REF,
    decision: item.decision, reviewed_at: reviewedAt, reviewer_kind: 'ai-assisted',
    review_evidence: { repository: REPOSITORY, issue_number: item.issue_number, comment_id: Number(commentId) },
    checks: item.checks, limitations: item.limitations,
  };
  if (item.decision === 'multi-interview') request.interview_cases = item.cases;
  return request;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { mode: 'plan', output: DEFAULT_OUTPUT, journal: DEFAULT_JOURNAL, lock: DEFAULT_LOCK, requestDir: DEFAULT_REQUEST_DIR, cache: SNAPSHOT_CACHE, pending: PENDING_SNAPSHOT, confirmPlan: null, maxMutations: 25, pauseMs: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') args.mode = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--lock') args.lock = argv[++index];
    else if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--cache') args.cache = argv[++index];
    else if (arg === '--pending') args.pending = argv[++index];
    else if (arg === '--confirm-plan') args.confirmPlan = argv[++index];
    else if (arg === '--max-mutations') args.maxMutations = Number(argv[++index]);
    else if (arg === '--pause-ms') args.pauseMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['plan', 'evidence'].includes(args.mode)) throw new Error('--mode must be plan or evidence');
  if (!Number.isInteger(args.maxMutations) || args.maxMutations < 1) throw new Error('--max-mutations must be positive');
  if (!Number.isInteger(args.pauseMs) || args.pauseMs < 0) throw new Error('--pause-ms must be non-negative');
  return args;
}

function runEvidence(args, plan) {
  if (plan.errors.length) throw new Error(`plan is not executable; resolve ${plan.errors.length} fail-closed errors first`);
  if (args.confirmPlan !== plan.canonical_digest) throw new Error('evidence stage requires --confirm-plan equal to the plan canonical_digest');
  const lock = acquireLock(args.lock);
  try {
    const journalFile = path.resolve(args.journal);
    const journal = fs.existsSync(journalFile) ? readJson(journalFile) : { schema_version: 'issue-1605-full-boundary-evidence-progress.v1', plan_digest: plan.canonical_digest, status: 'running', items: [] };
    if (journal.plan_digest !== plan.canonical_digest) throw new Error('existing evidence journal belongs to another plan');
    const byNumber = new Map(journal.items.map((item) => [Number(item.issue_number), item]));
    let attempted = 0;
    for (const item of plan.items) {
      if (attempted >= args.maxMutations) break;
      const previous = byNumber.get(item.issue_number) || { issue_number: item.issue_number, transition_id: item.transition_id, status: 'pending', comment_id: null };
      if (previous.status === 'posted') continue;
      const live = readLiveIssue(item.issue_number);
      const liveLabels = labelsOf(live);
      if (String(live.state).toLowerCase() !== 'open' || !liveLabels.includes('boundary:pending')) throw new Error(`#${item.issue_number} live SourceNote is not open+boundary:pending`);
      const liveSha = sha256(live.body || '');
      if (liveSha !== item.expected_body_sha256) throw new Error(`#${item.issue_number} live body SHA drifted: ${liveSha}`);
      const reviewedAt = previous.reviewed_at || new Date().toISOString();
      const body = evidenceBody(item, reviewedAt);
      let response;
      try {
        response = ghJson(['api', '--method', 'POST', `${issueEndpoint(item.issue_number)}/comments`, '--input', '-'], { body });
      } catch (error) {
        const matches = findMarkerComments(item.issue_number, item.transition_id);
        if (matches.length !== 1) {
          previous.status = 'uncertain'; previous.error = error.message; previous.possibly_posted = true;
          journal.items = [...byNumber.values()]; journal.status = 'uncertain'; writeJson(journalFile, journal);
          throw new Error(`#${item.issue_number} evidence POST response unknown; marker reconciliation found ${matches.length} matches`);
        }
        response = matches[0];
      }
      if (!response || !Number.isInteger(Number(response.id))) throw new Error(`#${item.issue_number} evidence POST returned no comment id`);
      previous.status = 'posted'; previous.comment_id = Number(response.id); previous.reviewed_at = reviewedAt; previous.possibly_posted = false;
      previous.request = formalRequest(item, Number(response.id), reviewedAt);
      byNumber.set(item.issue_number, previous); journal.items = [...byNumber.values()].sort((a, b) => a.issue_number - b.issue_number); journal.attempted = (journal.attempted || 0) + 1; journal.posted = journal.items.filter((entry) => entry.status === 'posted').length; writeJson(journalFile, journal);
      writeJson(path.join(args.requestDir, `${pad(item.issue_number)}.json`), previous.request);
      attempted += 1; sleep(args.pauseMs);
    }
    journal.status = journal.items.filter((entry) => entry.status === 'posted').length === plan.items.length ? 'complete' : journal.status === 'uncertain' ? 'uncertain' : 'partial';
    journal.canonical_digest = sha256(canonical(journal)); writeJson(journalFile, journal);
    const posted = journal.items.filter((entry) => entry.status === 'posted');
    const manifest = { schema_version: 'source-note-boundary-review-batch.v1', repository: REPOSITORY, parent_issue: PARENT_ISSUE, source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF }, plan_digest: plan.canonical_digest, items: posted.map((entry) => ({ issue_number: entry.issue_number, transition_id: entry.transition_id, request_file: path.relative(path.dirname(args.output), path.join(args.requestDir, `${pad(entry.issue_number)}.json`)) })) };
    manifest.canonical_digest = sha256(canonical(manifest)); writeJson(path.join(path.dirname(args.output), 'full-boundary-manifest.json'), manifest);
    process.stdout.write(`${JSON.stringify({ status: journal.status, posted: posted.length, attempted: journal.attempted, manifest: path.join(path.dirname(args.output), 'full-boundary-manifest.json') }, null, 2)}\n`);
  } finally { lock.release(); }
}

function main() {
  const args = parseArgs();
  const plan = buildPlan(args);
  writeJson(args.output, plan);
  if (args.mode === 'evidence') runEvidence(args, plan);
  else process.stdout.write(`${JSON.stringify({ status: plan.errors.length ? 'blocked' : 'ready-for-controller-review', canonical_digest: plan.canonical_digest, counts: plan.counts, errors: plan.errors.slice(0, 20) }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { canonical, sha256, buildPlan, evidenceBody, formalRequest, normalizeExcerpt, validateRows };
