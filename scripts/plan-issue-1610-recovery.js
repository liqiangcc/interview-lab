#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const {
  buildManifest: buildPinnedArtifactManifest,
  validateManifest: validatePinnedArtifactManifest,
} = require('./lib/issue-1539-pinned-artifact-manifest');
const {
  parseInterviewNoteIssue,
  validateInterviewNoteIssue,
} = require('./lib/interview-note-issue');
const {
  parseSourceNoteIssue,
  validateSourceNoteIssue,
} = require('./lib/source-note-issue');
const {
  exactOwnershipCandidates,
  ownershipSearchEndpoint,
  createSearchThrottle,
} = require('./lib/interview-note-ownership-search');
const {
  canonicalJson,
  clone,
  sha256Text,
  labelsOf,
  statusOf,
  normalizeArtifacts,
  validateSelection,
  stableAttempt,
  buildEvidencePacket,
  summarizeRecovery,
  PLAN_SCHEMA_VERSION,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  REQUIRED_CHECK_IDS,
} = require('./lib/issue-1610-recovery');

const MAX_PAGES = 10;
const IMAGE_TIMEOUT_SECONDS = 20;

function parseArgs(argv = process.argv.slice(2)) {
  const out = { selection: null, output: null, journal: null, pinnedManifest: null, evidenceDir: null, searchPauseMs: 2200 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--selection') out.selection = argv[++index];
    else if (arg === '--output') out.output = argv[++index];
    else if (arg === '--journal') out.journal = argv[++index];
    else if (arg === '--pinned-artifact-manifest') out.pinnedManifest = argv[++index];
    else if (arg === '--evidence-dir') out.evidenceDir = argv[++index];
    else if (arg === '--search-pause-ms') out.searchPauseMs = Number(argv[++index]);
    else if (arg === '--apply') throw new Error('issue-1610 recovery planner has no apply entrypoint; live GitHub writes are out of scope');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.selection) throw new Error('--selection is required');
  if (!Number.isInteger(out.searchPauseMs) || out.searchPauseMs < 0) throw new Error('--search-pause-ms must be a non-negative integer');
  return out;
}

function sleepMs(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ghJson(args, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(execFileSync('gh', ['api', ...args], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        timeout: 15000,
        killSignal: 'SIGTERM',
      }));
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(attempt * 1000);
    }
  }
  throw lastError;
}

function ghGraphql(query, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15000,
        killSignal: 'SIGTERM',
      }));
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(attempt * 1000);
    }
  }
  throw lastError;
}

function loadIssue(repository, number) {
  return ghJson([`repos/${repository}/issues/${number}`]);
}

function loadComments(repository, number) {
  const comments = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = ghJson([`repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments response is not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`Issue #${number} comments exceeded ${MAX_PAGES} pages`);
}

function loadSourceTree(sourceSnapshot, artifacts = []) {
  const entries = [];
  const seen = new Set();
  const paths = [];
  for (const artifact of artifacts) {
    const match = String(artifact.ref || '').match(/^([^:]+):(.+)@([0-9a-f]{40})$/);
    if (!match) throw new Error(`invalid pinned artifact ref: ${artifact.ref}`);
    const [, repository, artifactPath, ref] = match;
    if (repository !== sourceSnapshot.repository || ref !== sourceSnapshot.ref) throw new Error(`artifact is outside pinned source snapshot: ${artifact.ref}`);
    if (seen.has(artifactPath)) continue;
    seen.add(artifactPath);
    paths.push({ repository, artifactPath, ref });
  }
  const fields = paths.map((entry, index) => `a${index}: object(expression: ${JSON.stringify(`${entry.ref}:${entry.artifactPath}`)}) { oid ... on Blob { byteSize } }`).join('\n');
  const response = ghGraphql(`query { repository(owner: "${sourceSnapshot.repository.split('/')[0]}", name: "${sourceSnapshot.repository.split('/')[1]}") { ${fields} } }`);
  const objects = response && response.data && response.data.repository || {};
  for (const [index, entry] of paths.entries()) {
    const object = objects[`a${index}`];
    if (!object || !object.oid || object.byteSize == null) throw new Error(`pinned source object is missing for ${entry.artifactPath}`);
    entries.push({ type: 'blob', path: entry.artifactPath, sha: object.oid, size: object.byteSize });
  }
  return { tree: entries, sha: null, truncated: false };
}

function readPinnedBlob(sourceSnapshot, gitBlobSha) {
  const blob = ghJson([`repos/${sourceSnapshot.repository}/git/blobs/${gitBlobSha}`]);
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`pinned blob ${gitBlobSha} is not a base64 blob response`);
  return Buffer.from(blob.content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function bodySha(body) {
  return crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

function labelsEqual(actual, expected) {
  return JSON.stringify([...new Set(labelsOf(actual))].sort()) === JSON.stringify([...new Set(expected)].sort());
}

function sourceItemFor(selection, issueNumber) {
  const item = selection.items.find((candidate) => Number(candidate.issue_number) === Number(issueNumber));
  if (!item) throw new Error(`selection has no fixed item for InterviewNote #${issueNumber}`);
  return item;
}

function verifyFrozenLiveFacts(selection, item, interviewIssue, sourceIssue, interviewRecord, sourceRecord) {
  const errors = [];
  if (Number(interviewIssue.number) !== item.issue_number) errors.push('InterviewNote Issue number drift');
  if (Number(sourceIssue.number) !== item.source_note_issue_number) errors.push('SourceNote Issue number drift');
  if (bodySha(interviewIssue.body) !== item.expected_interview_body_sha256) errors.push('InterviewNote body SHA-256 drift');
  if (bodySha(sourceIssue.body) !== item.expected_source_note_body_sha256) errors.push('SourceNote body SHA-256 drift');
  if (!labelsEqual(interviewIssue, item.expected_labels)) errors.push('InterviewNote labels drift');
  if (!labelsEqual(sourceIssue, item.expected_source_note_labels)) errors.push('SourceNote labels drift');
  if (!interviewRecord || interviewRecord.interview_note_id !== item.interview_note_id) errors.push('InterviewNote identity drift');
  if (!sourceRecord || sourceRecord.source_note_id !== item.source_note_id) errors.push('SourceNote identity drift');
  if (!sourceRecord || !sourceRecord.source_revision || sourceRecord.source_revision.id !== item.source_revision_id) errors.push('SourceNote SourceRevision drift');
  if (!sourceRecord || sourceRecord.source_revision.source_repository !== SOURCE_REPOSITORY || sourceRecord.source_revision.source_repository_ref !== SOURCE_REF) errors.push('SourceNote pinned source ref drift');
  if (!interviewRecord || !interviewRecord.source_revision || interviewRecord.source_revision.id !== item.interview_source_revision_id) errors.push('InterviewNote legacy SourceRevision drift');
  if (errors.length) throw new Error(`frozen selection drift for InterviewNote #${item.issue_number}: ${errors.join('; ')}`);
}

function checkResults({ item, interviewRecord, sourceRecord, pinnedArtifactVerified, ownership, attempts }) {
  const sourceIdentityOk = interviewRecord.interview_note_id === item.interview_note_id
    && sourceRecord.source_note_id === item.source_note_id
    && sourceRecord.source.system === interviewRecord.source.system
    && sourceRecord.source.external_id === interviewRecord.source.external_id;
  const sourceRevisionOk = interviewRecord.source_revision.id === item.source_revision_id
    && sourceRecord.source_revision.id === item.source_revision_id
    && sourceRecord.source_revision.source_repository_ref === SOURCE_REF;
  const targetArtifacts = normalizeArtifacts(interviewRecord.artifacts);
  const pinnedArtifacts = normalizeArtifacts(sourceRecord.artifacts);
  const artifactReferenceOk = targetArtifacts.length > 0
    && targetArtifacts.every((artifact) => artifact.ref.endsWith(`@${SOURCE_REF}`))
    && JSON.stringify(targetArtifacts) === JSON.stringify(pinnedArtifacts);
  const projections = (sourceRecord.artifacts || []).filter((artifact) => artifact.provenance === 'source_projection');
  const rawProjectionTraceabilityOk = projections.length > 0 && projections.every((projection) => Array.isArray(projection.derived_from) && projection.derived_from.length > 0);
  const limitations = Array.isArray(sourceRecord.limitations) ? sourceRecord.limitations : [];
  const targetLimitations = new Set(Array.isArray(interviewRecord.limitations) ? interviewRecord.limitations : []);
  const limitationsOk = limitations.every((limitation) => targetLimitations.has(limitation));
  const ownerOk = ownership.length === 1 && Number(ownership[0].number) === item.issue_number;
  const noFabricationOk = interviewRecord.source.url == null && interviewRecord.interview_occurred_at && typeof interviewRecord.interview_occurred_at.precision === 'string';
  const boundaryStatus = sourceRecord.boundary_review && sourceRecord.boundary_review.status;
  const boundaryOk = boundaryStatus === 'single-interview';
  const imageRecoveryOk = attempts.length === 2 && attempts.every((attempt) => attempt.accepted_artifact === true);
  return [
    checkResults.check('source_identity', sourceIdentityOk, sourceIdentityOk ? 'Both live records bind the frozen external source identity.' : 'InterviewNote/SourceNote identity binding is not complete.'),
    checkResults.check('source_revision_binding', sourceRevisionOk, sourceRevisionOk ? 'Both live records bind the pinned SourceRevision.' : `InterviewNote uses ${interviewRecord.source_revision.id}; pinned SourceNote uses ${item.source_revision_id}.`),
    checkResults.check('artifact_reference_integrity', artifactReferenceOk, artifactReferenceOk ? 'InterviewNote artifacts exactly match pinned SourceNote artifacts.' : 'InterviewNote artifact refs are legacy/unpinned or do not exactly match the pinned SourceNote artifact set.'),
    checkResults.check('raw_projection_traceability', rawProjectionTraceabilityOk, rawProjectionTraceabilityOk ? 'Every Source projection has explicit Raw lineage.' : 'Source projections have no explicit derived_from Raw lineage; Raw is not upgraded.'),
    checkResults.check('source_artifact_provenance', pinnedArtifactVerified, pinnedArtifactVerified ? 'Every frozen artifact path/blob was verified against the pinned commit tree.' : 'Pinned artifact manifest verification failed.'),
    checkResults.check('known_limitations_recorded', limitationsOk, limitationsOk ? 'InterviewNote retains all SourceNote limitations.' : 'InterviewNote does not retain every SourceNote limitation verbatim.'),
    checkResults.check('duplicate_ownership', ownerOk, ownerOk ? 'Exact ownership search found only the fixed InterviewNote owner.' : `Exact ownership search found ${ownership.length} matching owners.`),
    checkResults.check('no_fabrication', noFabricationOk, noFabricationOk ? 'No new source fact was inferred by this dry-run.' : 'Source fact preservation could not be proven.'),
    checkResults.check('boundary_disposition', boundaryOk, boundaryOk ? 'SourceNote has an independently reviewed single-interview disposition.' : `SourceNote boundary status is ${boundaryStatus || 'unknown'}, not single-interview.`),
    checkResults.check('image_recovery', imageRecoveryOk, imageRecoveryOk ? 'Both recorded URLs returned non-empty image bytes.' : 'No verified non-empty image artifact was recovered from the recorded URLs.'),
  ];
}

checkResults.check = (checkId, passed, note) => ({ check_id: checkId, result: passed ? 'pass' : 'fail', note });

function parseHeaders(rawHeaders) {
  const headers = {};
  for (const line of String(rawHeaders || '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function fetchImage(url, sequence) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1610-recovery-'));
  const bodyPath = path.join(temporaryRoot, 'response.bin');
  const headerPath = path.join(temporaryRoot, 'response.headers');
  const requestedAt = new Date().toISOString();
  const result = spawnSync('curl', [
    '-L', '--max-time', String(IMAGE_TIMEOUT_SECONDS), '--connect-timeout', '10', '--retry', '0',
    '-sS', '-D', headerPath, '-o', bodyPath,
    '-w', '%{http_code}\n%{content_type}\n%{url_effective}\n%{time_total}\n', url,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const responseBytes = fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath) : Buffer.alloc(0);
  const responseHeaders = fs.existsSync(headerPath) ? parseHeaders(fs.readFileSync(headerPath, 'utf8')) : {};
  const [httpCode, contentType, effectiveUrl, totalSeconds] = String(result.stdout || '').trim().split('\n');
  const completedAt = new Date().toISOString();
  const attempt = {
    sequence,
    method: 'GET',
    url,
    requested_at: requestedAt,
    completed_at: completedAt,
    curl_exit: result.status == null ? 1 : result.status,
    http_code: Number(httpCode || 0),
    content_type: contentType || responseHeaders['content-type'] || null,
    effective_url: effectiveUrl || url,
    time_total_seconds: Number(totalSeconds || 0),
    response_headers: {
      'content-length': responseHeaders['content-length'] || null,
      'content-type': responseHeaders['content-type'] || null,
      date: responseHeaders.date || null,
      server: responseHeaders.server || null,
    },
    bytes: responseBytes.length,
    sha256: crypto.createHash('sha256').update(responseBytes).digest('hex'),
    stderr: String(result.stderr || '').trim() || null,
  };
  attempt.accepted_artifact = attempt.curl_exit === 0
    && attempt.http_code === 200
    && attempt.bytes > 0
    && /^image\//i.test(String(attempt.content_type || ''));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  return attempt;
}

function independentEvidenceCommentIds(comments) {
  const marker = /<!--\s*interview-note-source-review-evidence\.v1\s*\n/;
  return comments.filter((comment) => marker.test(String(comment.body || ''))).map((comment) => Number(comment.id)).sort((a, b) => a - b);
}

function writeJson(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function buildJournal({ selection, planSha256, itemResults }) {
  return {
    schema_version: 'issue-1610-recovery-journal.v1',
    scope: selection.scope,
    repository: selection.repository,
    source_snapshot: clone(selection.source_snapshot),
    plan_sha256: planSha256,
    mutation_performed: false,
    entries: itemResults.map((item) => ({
      issue_number: item.issue_number,
      source_note_issue_number: item.source_note_issue_number,
      interview_note_id: item.interview_note_id,
      expected_interview_body_sha256: item.expected_interview_body_sha256,
      expected_source_note_body_sha256: item.expected_source_note_body_sha256,
      source_revision_id: item.source_revision_id,
      recovery_attempts: item.recovery_attempts,
      live_independent_evidence_comment_ids: item.live_independent_evidence_comment_ids,
      failed_check_ids: item.failed_check_ids,
      decision: item.decision,
      mutation_performed: false,
    })),
  };
}

function plan(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const selection = JSON.parse(fs.readFileSync(args.selection, 'utf8'));
  const selectionValidation = validateSelection(selection);
  if (!selectionValidation.ok) throw new Error(selectionValidation.errors.join('; '));
  const repository = selection.repository;
  const sourceTree = (dependencies.loadSourceTree || loadSourceTree)(selection.source_snapshot, selection.items.flatMap((item) => item.artifacts));
  const liveByItem = [];
  const pinnedEntries = [];
  for (const item of selection.items) {
    const interviewIssue = (dependencies.loadIssue || loadIssue)(repository, item.issue_number);
    const sourceIssue = (dependencies.loadIssue || loadIssue)(repository, item.source_note_issue_number);
    const interviewParsed = parseInterviewNoteIssue(interviewIssue.body || '');
    const sourceParsed = parseSourceNoteIssue(sourceIssue.body || '');
    const interviewValidation = validateInterviewNoteIssue({ body: interviewIssue.body || '', labels: labelsOf(interviewIssue), state: String(interviewIssue.state || '').toLowerCase() });
    const sourceValidation = validateSourceNoteIssue({ body: sourceIssue.body || '', labels: labelsOf(sourceIssue), state: String(sourceIssue.state || '').toLowerCase() });
    if (!interviewValidation.ok) throw new Error(`InterviewNote #${item.issue_number} validation failed: ${interviewValidation.errors.join('; ')}`);
    if (!sourceValidation.ok) throw new Error(`SourceNote #${item.source_note_issue_number} validation failed: ${sourceValidation.errors.join('; ')}`);
    verifyFrozenLiveFacts(selection, item, interviewIssue, sourceIssue, interviewParsed.record, sourceParsed.record);
    pinnedEntries.push({
      interview_issue_number: item.issue_number,
      source_note_issue_number: item.source_note_issue_number,
      source_note_id: sourceParsed.record.source_note_id,
      source_revision_id: sourceParsed.record.source_revision.id,
      artifacts: sourceParsed.record.artifacts,
    });
    liveByItem.push({ item, interviewIssue, sourceIssue, interview: interviewParsed, source: sourceParsed });
  }
  const pinnedArtifactManifest = buildPinnedArtifactManifest({
    repository,
    scope: selection.scope,
    sourceSnapshot: selection.source_snapshot,
    entries: pinnedEntries,
    treeEntries: sourceTree.tree,
    treeSha: sourceTree.sha || null,
  });
  const pinnedManifestValidation = validatePinnedArtifactManifest(pinnedArtifactManifest);
  if (!pinnedManifestValidation.ok) throw new Error(`pinned artifact manifest validation failed: ${pinnedManifestValidation.errors.join('; ')}`);
  const pinnedArtifactManifestSha256 = pinnedArtifactManifest.digest;
  const searchThrottle = createSearchThrottle(args.searchPauseMs, sleepMs);
  const itemResults = [];
  for (const live of liveByItem) {
    const { item, interviewIssue, sourceIssue, interview, source } = live;
    const ownership = exactOwnershipCandidates({
      interviewNoteId: item.interview_note_id,
      readPage: (page) => (dependencies.ghJson || ghJson)([`${ownershipSearchEndpoint(repository, item.interview_note_id)}&page=${page}`]),
      readIssue: (number) => (dependencies.loadIssue || loadIssue)(repository, number),
      matches: (issues, id) => issues.filter((issue) => !issue.pull_request && parseInterviewNoteIssue(issue.body || '').marker?.interview_note_id === id),
      beforePage: searchThrottle,
    });
    const comments = (dependencies.loadComments || loadComments)(repository, item.issue_number);
    const attempts = item.image_urls.map((url, index) => (dependencies.fetchImage || fetchImage)(url, index + 1));
    const pinnedItem = pinnedArtifactManifest.items.find((candidate) => Number(candidate.interview_issue_number) === item.issue_number);
    const pinnedArtifactVerified = Boolean(pinnedArtifactManifest.verified && pinnedItem);
    const checks = checkResults({ item, interviewRecord: interview.record, sourceRecord: source.record, pinnedArtifactVerified, ownership, attempts });
    const evidence = buildEvidencePacket({ selection, item, live, pinnedArtifactManifestSha256, checks, attempts, ownership });
    const independentIds = independentEvidenceCommentIds(comments);
    const failedCheckIds = checks.filter((entry) => entry.result === 'fail').map((entry) => entry.check_id);
    itemResults.push({
      issue_number: item.issue_number,
      interview_note_id: item.interview_note_id,
      source_note_issue_number: item.source_note_issue_number,
      source_note_id: item.source_note_id,
      expected_interview_body_sha256: item.expected_interview_body_sha256,
      expected_source_note_body_sha256: item.expected_source_note_body_sha256,
      source_revision_id: item.source_revision_id,
      interview_source_revision_id: interview.record.source_revision.id,
      current_status: statusOf(interviewIssue),
      current_labels: labelsOf(interviewIssue).sort(),
      source_note_boundary_status: source.record.boundary_review?.status || null,
      recovery_attempts: attempts,
      recovery_summary: summarizeRecovery(attempts),
      checks,
      failed_check_ids: failedCheckIds,
      live_independent_evidence_comment_ids: independentIds,
      independent_evidence: evidence,
      decision: 'blocked',
      transition: {
        legal: false,
        reason: 'Current evidence does not satisfy the Source Review gate; no transition request or live mutation is emitted.',
        requested_initial_status: 'blocked',
        requested_decision: 'blocked',
      },
      mutation_performed: false,
      raw_overwrite_performed: false,
      source_issue_body_sha256: bodySha(sourceIssue.body),
      interview_issue_body_sha256: bodySha(interviewIssue.body),
    });
  }
  const digestInput = {
    schema_version: PLAN_SCHEMA_VERSION,
    scope: selection.scope,
    repository,
    source_snapshot: selection.source_snapshot,
    selection_sha256: sha256Text(canonicalJson(selection)),
    pinned_artifact_manifest_sha256: pinnedArtifactManifestSha256,
    items: itemResults.map((item) => ({
      issue_number: item.issue_number,
      source_note_issue_number: item.source_note_issue_number,
      interview_note_id: item.interview_note_id,
      expected_interview_body_sha256: item.expected_interview_body_sha256,
      expected_source_note_body_sha256: item.expected_source_note_body_sha256,
      source_revision_id: item.source_revision_id,
      interview_source_revision_id: item.interview_source_revision_id,
      current_status: item.current_status,
      source_note_boundary_status: item.source_note_boundary_status,
      recovery_attempts: item.recovery_attempts.map(stableAttempt),
      checks: item.checks,
      evidence_subject_sha256: item.independent_evidence.evidence_subject_sha256,
      live_independent_evidence_comment_ids: item.live_independent_evidence_comment_ids,
      decision: item.decision,
      mutation_performed: false,
    })),
    mutation_performed: false,
    raw_overwrite_performed: false,
  };
  const planSha256 = sha256Text(canonicalJson(digestInput));
  const journal = buildJournal({ selection, planSha256, itemResults });
  const journalSha256 = sha256Text(canonicalJson(journal));
  const report = {
    schema_version: PLAN_SCHEMA_VERSION,
    scope: selection.scope,
    repository,
    controller_issue_number: selection.controller_issue_number,
    scope_issue_number: selection.scope_issue_number,
    source_snapshot: clone(selection.source_snapshot),
    selection: {
      path: args.selection,
      selection_sha256: digestInput.selection_sha256,
      controller_body_sha256: selection.controller_body_sha256,
      scope_body_sha256: selection.scope_body_sha256,
      fixed_issue_numbers: [1, 2],
      source_note_issue_numbers: [903, 904],
      overlap_or_extra_items: [],
    },
    pinned_artifact_manifest: {
      path: args.pinnedManifest,
      sha256: pinnedArtifactManifestSha256,
      verified: pinnedArtifactManifest.verified,
      item_count: pinnedArtifactManifest.items.length,
    },
    observed_at: new Date().toISOString(),
    summary: {
      total: itemResults.length,
      blocked: itemResults.filter((item) => item.decision === 'blocked').length,
      candidate_source_ready: 0,
      independent_evidence_candidate_count: itemResults.filter((item) => item.independent_evidence).length,
      live_independent_evidence_count: itemResults.filter((item) => item.live_independent_evidence_comment_ids.length > 0).length,
      recovered_image_count: itemResults.reduce((sum, item) => sum + item.recovery_summary.successful, 0),
    },
    items: itemResults,
    digest_input: digestInput,
    plan_sha256: planSha256,
    journal_sha256: journalSha256,
    ready_for_authorization: false,
    mutation_performed: false,
    safety: {
      apply_entrypoint: 'none',
      github_post_count: 0,
      github_patch_count: 0,
      live_comment_or_label_write: false,
      raw_overwrite_performed: false,
      no_learning_labels_or_context_generated: true,
      boundary_review_evidence_reused: false,
      fail_closed_on_drift_or_network_error: true,
    },
  };
  return { args, selection, pinnedArtifactManifest, report, journal };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const result = plan(argv, dependencies);
    writeJson(result.args.pinnedManifest, result.pinnedArtifactManifest);
    writeJson(result.args.journal, result.journal);
    if (result.args.evidenceDir) {
      for (const item of result.report.items) writeJson(path.join(result.args.evidenceDir, `issue-${item.issue_number}.json`), item.independent_evidence);
    }
    writeJson(result.args.output, result.report);
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const args = (() => { try { return parseArgs(argv); } catch (_) { return {}; } })();
    const failure = {
      schema_version: PLAN_SCHEMA_VERSION,
      status: 'blocked',
      error: error.message,
      mutation_performed: false,
      raw_overwrite_performed: false,
      fail_closed: true,
      observed_at: new Date().toISOString(),
    };
    writeJson(args.output, failure);
    writeJson(args.journal, { schema_version: 'issue-1610-recovery-journal.v1', status: 'blocked', failure, mutation_performed: false });
    process.stderr.write(`ERROR: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  parseArgs,
  plan,
  main,
  bodySha,
  parseHeaders,
  fetchImage,
  verifyFrozenLiveFacts,
  checkResults,
  independentEvidenceCommentIds,
};
