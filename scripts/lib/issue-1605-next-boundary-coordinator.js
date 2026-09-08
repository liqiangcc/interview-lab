'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAppliedBoundaryReviewReceipts } = require('./source-note-boundary-review-transition');
const { parseSourceNoteIssue } = require('./source-note-issue');
const { buildInventoryItem, validateInventoryItems } = require('./issue-1605-pending-inventory');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1605;
const FROZEN_TOTAL = 1397;
const COMPLETED_TOTAL = 419;
const REMAINING_TOTAL = 978;
const FROZEN_SNAPSHOT_DIGEST = '5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd';
const COMPLETED_PLAN_DIGEST = 'ad3e3974c21415e2371b8fe77a2ae54b65dd7783516ed6a68ef61bb070877781';
const COMPLETED_MANIFEST_DIGEST = '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a';
const SCOPE_SCHEMA = 'issue-1605-next-boundary-scope.v1';
const MANIFEST_SCHEMA = 'issue-1605-next-boundary-manifest.v1';
const EVIDENCE_SCHEMA = 'issue-1605-next-boundary-evidence-plan.v1';
const REQUEST_SCHEMA = 'issue-1605-next-boundary-request-plan.v1';
const TRANSITION_SCHEMA = 'issue-1605-next-boundary-transition-plan.v1';
const JOURNAL_SCHEMA = 'issue-1605-next-boundary-read-journal.v1';
const LOCK_SCHEMA = 'issue-1605-next-boundary-read-lock.v1';
const PENDING_LABELS = Object.freeze(['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review']);
const BATCHES = Object.freeze([
  { batch: 'A', child_issue: 1606, first_issue: 20, last_issue: 392, frozen_count: 327, remaining_count: 235 },
  { batch: 'B', child_issue: 1607, first_issue: 393, last_issue: 765, frozen_count: 367, remaining_count: 257 },
  { batch: 'C', child_issue: 1608, first_issue: 766, last_issue: 1138, frozen_count: 337, remaining_count: 248 },
  { batch: 'D', child_issue: 1609, first_issue: 1139, last_issue: 1508, frozen_count: 366, remaining_count: 238 },
]);
const HEX64 = /^[0-9a-f]{64}$/;

function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function canonicalDigest(value) { return sha256(canonical(value)); }
function without(value, key) { const copy = { ...value }; delete copy[key]; return copy; }
function frozenSnapshotDigestInput(snapshot) {
  const copy = { ...snapshot };
  delete copy.canonical_digest;
  delete copy.validation;
  delete copy.generated_at;
  return copy;
}
function same(a, b) { return canonical(a) === canonical(b); }
function labelsOf(issue) {
  return [...new Set((issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter((label) => typeof label === 'string' && label.trim()))].sort();
}
function bodySha256(body) { return sha256(body || ''); }
function batchForIssue(issueNumber) { return BATCHES.find((batch) => issueNumber >= batch.first_issue && issueNumber <= batch.last_issue) || null; }

function validateFrozenSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || snapshot.schema_version !== 'issue-1605-pending-source-note-inventory.v1') errors.push('frozen pending snapshot schema mismatch');
  if (snapshot?.repository !== REPOSITORY || snapshot?.parent_issue !== PARENT_ISSUE) errors.push('frozen pending snapshot repository/parent mismatch');
  if (snapshot?.source_repository !== SOURCE_REPOSITORY || snapshot?.source_ref !== SOURCE_REF) errors.push('frozen pending snapshot source ref is not the approved XHS ref');
  if (snapshot?.count !== FROZEN_TOTAL || snapshot?.items?.length !== FROZEN_TOTAL) errors.push(`frozen pending snapshot must contain ${FROZEN_TOTAL} items`);
  if (snapshot?.canonical_digest !== FROZEN_SNAPSHOT_DIGEST) errors.push('frozen pending snapshot canonical digest is not the approved 1397-row digest');
  if (snapshot && snapshot.canonical_digest !== canonicalDigest(frozenSnapshotDigestInput(snapshot))) errors.push('frozen pending snapshot canonical digest does not match content');
  const validation = validateInventoryItems(snapshot?.items);
  errors.push(...validation.errors);
  return { ok: errors.length === 0, errors, validation };
}

function validateCompletedManifest(manifest) {
  const errors = [];
  if (!manifest || manifest.schema_version !== 'source-note-boundary-review-batch.v1') errors.push('completed manifest schema mismatch');
  if (manifest?.repository !== REPOSITORY || manifest?.parent_issue !== PARENT_ISSUE) errors.push('completed manifest repository/parent mismatch');
  if (manifest?.source_snapshot?.repository !== SOURCE_REPOSITORY || manifest?.source_snapshot?.ref !== SOURCE_REF) errors.push('completed manifest source ref mismatch');
  if (manifest?.items?.length !== COMPLETED_TOTAL) errors.push(`completed manifest must contain exactly ${COMPLETED_TOTAL} rows`);
  if (manifest?.plan_digest !== COMPLETED_PLAN_DIGEST) errors.push('completed manifest plan digest is not the approved 419-row digest');
  if (manifest?.canonical_digest !== COMPLETED_MANIFEST_DIGEST) errors.push('completed manifest digest is not the approved 419-row exclusion manifest');
  if (manifest && manifest.canonical_digest !== canonicalDigest(without(manifest, 'canonical_digest'))) errors.push('completed manifest canonical digest does not match content');
  const issues = new Set();
  for (const item of manifest?.items || []) {
    const issueNumber = Number(item && item.issue_number);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) errors.push('completed manifest contains an invalid issue number');
    if (issues.has(issueNumber)) errors.push(`completed manifest duplicates Issue #${issueNumber}`);
    issues.add(issueNumber);
    if (typeof item?.transition_id !== 'string' || !item.transition_id) errors.push(`completed manifest #${issueNumber} has no transition_id`);
    if (typeof item?.request_file !== 'string' || !item.request_file) errors.push(`completed manifest #${issueNumber} has no request_file`);
  }
  return { ok: errors.length === 0, errors, issues, digest: manifest?.canonical_digest || null };
}

function buildRemainingScope({ frozenSnapshot, completedManifest, completedManifestPath = null }) {
  const frozenValidation = validateFrozenSnapshot(frozenSnapshot);
  const completedValidation = validateCompletedManifest(completedManifest);
  const errors = [...frozenValidation.errors, ...completedValidation.errors];
  const frozenByIssue = new Map((frozenSnapshot?.items || []).map((item) => [Number(item.issue_number), item]));
  for (const issueNumber of completedValidation.issues || []) if (!frozenByIssue.has(issueNumber)) errors.push(`completed manifest Issue #${issueNumber} is outside the frozen 1397-row inventory`);
  const items = [...frozenByIssue.values()]
    .filter((item) => !(completedValidation.issues || new Set()).has(Number(item.issue_number)))
    .map((item) => {
      const batch = batchForIssue(Number(item.issue_number));
      if (!batch) errors.push(`remaining Issue #${item.issue_number} is outside A-D ranges`);
      return {
        batch: batch && batch.batch,
        child_issue: batch && batch.child_issue,
        issue_number: Number(item.issue_number),
        issue_url: item.issue_url,
        source_note_id: item.source_note_id,
        expected_body_sha256: item.body_sha256,
        expected_source_revision_id: item.source_revision.id,
        expected_source_repository_ref: SOURCE_REF,
        frozen_labels: item.labels,
      };
    })
    .sort((a, b) => a.issue_number - b.issue_number);
  if (items.length !== REMAINING_TOTAL) errors.push(`remaining scope must contain exactly ${REMAINING_TOTAL} rows; got ${items.length}`);
  const batches = BATCHES.map((batch) => {
    const batchItems = items.filter((item) => item.batch === batch.batch);
    if (batchItems.length !== batch.remaining_count) errors.push(`Boundary ${batch.batch} remaining count must be ${batch.remaining_count}; got ${batchItems.length}`);
    return { ...batch, count: batchItems.length, issue_numbers: batchItems.map((item) => item.issue_number) };
  });
  const content = {
    schema_version: SCOPE_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    frozen_inventory: { count: FROZEN_TOTAL, digest: frozenSnapshot?.canonical_digest || null },
    excluded_completed_manifest: {
      path: completedManifestPath,
      count: COMPLETED_TOTAL,
      canonical_digest: COMPLETED_MANIFEST_DIGEST,
      purpose: 'exclusion-only; not an authorization and not reusable for the remaining scope',
      authorization_reused: false,
    },
    remaining_count: items.length,
    batches,
    items,
    mutation_policy: { live_read_only: true, patch_count: 0, post_count: 0, transition_authorization: null },
  };
  return { ...content, ok: errors.length === 0, errors, scope_digest: canonicalDigest(content) };
}

function transientReadFailure(error) {
  const detail = [error?.code, error?.message, error?.stderr].filter(Boolean).join(' ').toLowerCase();
  return /eof|tls|ssl|timed? ?out|timeout|connection reset|socket hang up|network is unreachable|temporary failure|temporarily unavailable|econnreset|eai_again|enetunreach/.test(detail);
}

function readGhJson(read, args, input = null, options = {}) {
  if (args.some((arg) => ['--method', '--input', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(String(arg).toUpperCase()))) throw new Error('readGhJson accepts GET-only arguments');
  const maxAttempts = options.maxAttempts == null ? 5 : options.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('read retry maxAttempts must be an integer from 1 to 5');
  const sleep = options.sleep || (() => {});
  const shouldRetry = options.shouldRetry || transientReadFailure;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return read(args, input); }
    catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error)) throw error;
      sleep(100 * (2 ** (attempt - 1)));
    }
  }
  throw lastError || new Error('bounded read failed without an error');
}

function readCommentsPaged({ repository = REPOSITORY, issueNumber, read, maxPages = 100, maxAttempts = 5, sleep = () => {} }) {
  const comments = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const endpoint = `repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const batch = readGhJson(read, ['api', endpoint], null, { maxAttempts, sleep });
    if (!Array.isArray(batch)) throw new Error(`#${issueNumber} comments page ${page} was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return { comments, pages: page, terminal_page_short: true };
  }
  throw new Error(`#${issueNumber} comments pagination did not expose a short terminal page`);
}

function auditLiveItem(item, issue, comments) {
  const errors = [];
  const liveLabels = labelsOf(issue);
  if (!issue || Number(issue.number) !== item.issue_number) errors.push(`live Issue identity mismatch for #${item.issue_number}`);
  const inventory = buildInventoryItem(issue || {});
  if (!inventory.ok) errors.push(...inventory.errors);
  if (bodySha256(issue?.body) !== item.expected_body_sha256) errors.push(`live body SHA differs from frozen snapshot for #${item.issue_number}`);
  if (!same(liveLabels, item.frozen_labels)) errors.push(`live labels differ from frozen pending labels for #${item.issue_number}`);
  const parsed = parseSourceNoteIssue(issue?.body || '');
  const record = parsed.record;
  if (!record || record.source_note_id !== item.source_note_id) errors.push(`live SourceNote identity differs for #${item.issue_number}`);
  if (!record?.source_revision || record.source_revision.id !== item.expected_source_revision_id) errors.push(`live SourceRevision differs for #${item.issue_number}`);
  if (record?.source_revision?.source_repository_ref !== SOURCE_REF) errors.push(`live SourceRevision ref differs for #${item.issue_number}`);
  if (!Array.isArray(comments)) errors.push(`live comments for #${item.issue_number} were not an array`);
  const receiptResult = parseAppliedBoundaryReviewReceipts(comments || []);
  errors.push(...receiptResult.errors.map((error) => `#${item.issue_number}: ${error}`));
  const receipts = receiptResult.receipts || [];
  if (receipts.length) errors.push(`#${item.issue_number} has ${receipts.length} pre-existing applied receipt(s); remaining scope cannot reuse completed authorization`);
  return withObservationDigest({
    issue_number: item.issue_number,
    status: errors.length ? 'blocked' : 'review-required',
    errors,
    live_state: issue?.state || null,
    live_body_sha256: bodySha256(issue?.body),
    live_labels: liveLabels,
    live_source_note_id: record?.source_note_id || null,
    live_source_revision_id: record?.source_revision?.id || null,
    live_source_repository_ref: record?.source_revision?.source_repository_ref || null,
    comments_count: Array.isArray(comments) ? comments.length : null,
    comments_sha256: Array.isArray(comments) ? canonicalDigest(comments) : null,
    applied_receipts: receipts.map((receipt) => ({ transition_id: receipt.transition_id, applied_at: receipt.applied_at })),
    labels_verified: same(liveLabels, item.frozen_labels),
    source_ref_verified: record?.source_revision?.source_repository_ref === SOURCE_REF,
    review: { decision: null, evidence_comment_id: null, status: 'independent boundary review required' },
  });
}

function blockedAuditItem(item, error) {
  const observation = {
    issue_number: item.issue_number,
    status: 'blocked',
    errors: [error],
    live_state: null, live_body_sha256: null, live_labels: null,
    live_source_note_id: null, live_source_revision_id: null, live_source_repository_ref: null,
    comments_count: null, comments_sha256: null, applied_receipts: [], labels_verified: false,
    source_ref_verified: false,
    review: { decision: null, evidence_comment_id: null, status: 'blocked before independent boundary review' },
  };
  return withObservationDigest(observation);
}

function withObservationDigest(observation) {
  return { ...observation, observation_digest: canonicalDigest(observation) };
}

function validateAuditedObservation(item, observation) {
  const errors = [];
  if (!observation || observation.issue_number !== item.issue_number) errors.push(`observation identity mismatch for #${item.issue_number}`);
  if (observation?.status !== 'review-required') errors.push(`audited observation status is not review-required for #${item.issue_number}`);
  if (!Array.isArray(observation?.errors) || observation.errors.length) errors.push(`audited observation contains errors for #${item.issue_number}`);
  if (observation?.live_body_sha256 !== item.expected_body_sha256) errors.push(`audited observation body binding mismatch for #${item.issue_number}`);
  if (!same(observation?.live_labels, item.frozen_labels) || !observation?.labels_verified) errors.push(`audited observation labels binding mismatch for #${item.issue_number}`);
  if (observation?.live_source_note_id !== item.source_note_id) errors.push(`audited observation SourceNote binding mismatch for #${item.issue_number}`);
  if (observation?.live_source_revision_id !== item.expected_source_revision_id) errors.push(`audited observation SourceRevision binding mismatch for #${item.issue_number}`);
  if (observation?.live_source_repository_ref !== SOURCE_REF || !observation?.source_ref_verified) errors.push(`audited observation source ref binding mismatch for #${item.issue_number}`);
  if (!Array.isArray(observation?.applied_receipts) || observation.applied_receipts.length) errors.push(`audited observation has receipts for #${item.issue_number}`);
  if (observation?.observation_digest && observation.observation_digest !== canonicalDigest(without(observation, 'observation_digest'))) errors.push(`audited observation digest mismatch for #${item.issue_number}`);
  return { ok: errors.length === 0, errors };
}

function initialJournal(scope) {
  const content = {
    schema_version: JOURNAL_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    scope_digest: scope.scope_digest,
    status: 'running',
    completed_count: 0,
    blocked_count: 0,
    items: scope.items.map((item) => ({ issue_number: item.issue_number, status: 'pending', attempts: 0, observation: null, error: null })),
  };
  return { ...content, canonical_digest: canonicalDigest(content) };
}

function validateJournal(journal, scope) {
  const errors = [];
  if (!journal || journal.schema_version !== JOURNAL_SCHEMA) errors.push('read journal schema mismatch');
  if (journal?.scope_digest !== scope.scope_digest) errors.push('read journal scope digest mismatch');
  const expected = new Set(scope.items.map((item) => item.issue_number));
  const actual = new Set((journal?.items || []).map((item) => Number(item.issue_number)));
  if (expected.size !== actual.size || [...expected].some((issue) => !actual.has(issue))) errors.push('read journal item set does not equal remaining scope');
  if (journal && journal.canonical_digest !== canonicalDigest(without(journal, 'canonical_digest'))) errors.push('read journal canonical digest mismatch');
  for (const item of journal?.items || []) {
    if (!Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > 5) errors.push(`read journal attempts invalid for #${item.issue_number}`);
    if (!['pending', 'reading', 'audited', 'blocked'].includes(item.status)) errors.push(`read journal status invalid for #${item.issue_number}`);
  }
  return { ok: errors.length === 0, errors };
}

function auditRemainingScope({ scope, readIssue, readComments, journal = initialJournal(scope), persist = () => {} }) {
  const journalValidation = validateJournal(journal, scope);
  if (!journalValidation.ok) throw new Error(journalValidation.errors.join('; '));
  const stateByIssue = new Map(journal.items.map((item) => [Number(item.issue_number), item]));
  const observations = [];
  for (const item of scope.items) {
    const state = stateByIssue.get(item.issue_number);
    if (state.status === 'audited' && state.observation) {
      const validation = validateAuditedObservation(item, state.observation);
      if (validation.ok) {
        if (!state.observation.observation_digest) {
          state.observation = withObservationDigest(state.observation);
          journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest'));
          persist(journal);
        }
        observations.push(state.observation);
        continue;
      }
      if (state.attempts >= 5) {
        const observation = blockedAuditItem(item, validation.errors.join('; '));
        state.status = 'blocked'; state.observation = observation; state.error = observation.errors[0]; observations.push(observation);
        journal.completed_count = journal.items.filter((entry) => ['audited', 'blocked'].includes(entry.status)).length;
        journal.blocked_count = journal.items.filter((entry) => entry.status === 'blocked').length;
        journal.last_issue_number = item.issue_number; journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest')); persist(journal);
        continue;
      }
      state.status = 'pending'; state.observation = null; state.error = validation.errors.join('; ');
      journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest')); persist(journal);
    }
    if (state.status === 'reading' && state.attempts >= 5) {
      const observation = blockedAuditItem(item, 'read journal was left in reading state at the retry bound; refusing an unbounded resume');
      state.status = 'blocked'; state.observation = observation; state.error = observation.errors[0]; observations.push(observation);
      journal.completed_count = journal.items.filter((entry) => ['audited', 'blocked'].includes(entry.status)).length;
      journal.blocked_count = journal.items.filter((entry) => entry.status === 'blocked').length;
      journal.last_issue_number = item.issue_number; journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest')); persist(journal);
      continue;
    }
    state.status = 'reading';
    state.attempts += 1;
    journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest'));
    persist(journal);
    let observation;
    try {
      const issue = readIssue(item.issue_number);
      const comments = readComments(item.issue_number);
      observation = auditLiveItem(item, issue, comments);
      state.status = observation.status === 'blocked' ? 'blocked' : 'audited';
      state.observation = observation;
      state.error = observation.errors.length ? observation.errors.join('; ') : null;
    } catch (error) {
      observation = blockedAuditItem(item, `read failed: ${error.message}`);
      state.status = 'blocked';
      state.observation = observation;
      state.error = error.message;
    }
    observations.push(observation);
    journal.completed_count = journal.items.filter((entry) => ['audited', 'blocked'].includes(entry.status)).length;
    journal.blocked_count = journal.items.filter((entry) => entry.status === 'blocked').length;
    journal.last_issue_number = item.issue_number;
    journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest'));
    persist(journal);
  }
  journal.status = journal.blocked_count ? 'complete-with-blockers' : 'complete';
  journal.canonical_digest = canonicalDigest(without(journal, 'canonical_digest'));
  persist(journal);
  return { observations, journal };
}

function buildManifest(scope, observations, artifactDir = null) {
  const observationByIssue = new Map(observations.map((item) => [item.issue_number, item]));
  const items = scope.items.map((item) => ({ ...item, live_audit: observationByIssue.get(item.issue_number) || blockedAuditItem(item, 'missing live audit observation') }));
  const errors = items.flatMap((item) => item.live_audit.errors.map((error) => `#${item.issue_number}: ${error}`));
  const content = {
    schema_version: MANIFEST_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    scope_digest: scope.scope_digest,
    excluded_completed_manifest: scope.excluded_completed_manifest,
    artifact_dir: artifactDir,
    remaining_count: items.length,
    batches: scope.batches.map((batch) => ({ ...batch, audit_blocked_count: items.filter((item) => item.batch === batch.batch && item.live_audit.status === 'blocked').length })),
    errors,
    items,
    plan_policy: {
      evidence: 'review-required; no evidence comment is claimed by this read-only coordinator',
      requests: 'not generated until independent decision/evidence is supplied',
      transitions: 'blocked; no live authorization, PATCH, or POST exists in this scheme',
    },
  };
  return { ...content, ok: observations.length === scope.items.length && errors.length === 0, canonical_digest: canonicalDigest(content) };
}

function buildBatchArtifacts(manifest) {
  const artifacts = {};
  for (const batch of BATCHES) {
    const items = manifest.items.filter((item) => item.batch === batch.batch);
    const blocked = items.filter((item) => item.live_audit.status === 'blocked');
    const evidence = {
      schema_version: EVIDENCE_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE,
      batch: batch.batch, child_issue: batch.child_issue, source_ref: SOURCE_REF,
      scope_manifest_digest: manifest.canonical_digest, status: blocked.length ? 'blocked' : 'review-required',
      counts: { total: items.length, live_pending_verified: items.length - blocked.length, live_blocked: blocked.length, decision_required: items.length, evidence_comments: 0 },
      items: items.map((item) => ({ issue_number: item.issue_number, source_note_id: item.source_note_id, expected_body_sha256: item.expected_body_sha256, expected_source_revision_id: item.expected_source_revision_id, expected_source_repository_ref: SOURCE_REF, live_audit: item.live_audit, evidence: { status: 'required', decision: null, comment_id: null } })),
    };
    evidence.canonical_digest = canonicalDigest(evidence);
    const request = {
      schema_version: REQUEST_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE,
      batch: batch.batch, child_issue: batch.child_issue, source_ref: SOURCE_REF,
      scope_manifest_digest: manifest.canonical_digest, status: 'blocked', request_count: 0,
      items: items.map((item) => ({ issue_number: item.issue_number, transition_id: null, request_file: null, status: 'awaiting-independent-evidence-and-decision', blockers: [...item.live_audit.errors, 'decision and evidence comment are not present'] })),
    };
    request.canonical_digest = canonicalDigest(request);
    const transition = {
      schema_version: TRANSITION_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE,
      batch: batch.batch, child_issue: batch.child_issue, source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
      scope_manifest_digest: manifest.canonical_digest, status: 'blocked', mutation_count: 0,
      authorization: { present: false, reused_completed_419_authorization: false },
      items: items.map((item) => ({ issue_number: item.issue_number, status: 'blocked', mutation_count: 0, possibly_performed: false, blockers: [...item.live_audit.errors, 'independent boundary decision/evidence required'] })),
    };
    transition.canonical_digest = canonicalDigest(transition);
    artifacts[batch.batch] = { evidence, request, transition };
  }
  return artifacts;
}

function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function acquireReadLock(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd;
  try { fd = fs.openSync(target, 'wx+', 0o600); } catch (error) { throw new Error(`next-boundary read lock is already held: ${error.message}`); }
  const record = { schema_version: LOCK_SCHEMA, pid: process.pid, token: crypto.randomBytes(16).toString('hex'), acquired_at: new Date().toISOString() };
  try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8'); fs.fsyncSync(fd); } catch (error) { fs.closeSync(fd); throw error; }
  const parent = path.dirname(target);
  const syncParent = () => { const directory = fs.openSync(parent, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } };
  syncParent();
  const inode = fs.fstatSync(fd);
  let released = false;
  const readRecordFromFd = () => {
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  };
  const assertHeld = () => {
    if (released) throw new Error('next-boundary read lock is already released');
    const current = readRecordFromFd();
    const currentFdInode = fs.fstatSync(fd);
    const currentInode = fs.lstatSync(target);
    if (current.token !== record.token || currentFdInode.dev !== inode.dev || currentFdInode.ino !== inode.ino || currentInode.dev !== inode.dev || currentInode.ino !== inode.ino || currentInode.isSymbolicLink()) throw new Error('next-boundary read lock ownership/inode changed');
  };
  return {
    assertHeld,
    release() {
      try { assertHeld(); fs.unlinkSync(target); }
      finally { released = true; fs.closeSync(fd); syncParent(); }
    },
  };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, PARENT_ISSUE, FROZEN_TOTAL, FROZEN_SNAPSHOT_DIGEST, COMPLETED_TOTAL, REMAINING_TOTAL,
  COMPLETED_PLAN_DIGEST, COMPLETED_MANIFEST_DIGEST, SCOPE_SCHEMA, MANIFEST_SCHEMA, EVIDENCE_SCHEMA, REQUEST_SCHEMA, TRANSITION_SCHEMA, JOURNAL_SCHEMA,
  BATCHES, PENDING_LABELS, canonical, canonicalDigest, sha256, bodySha256, labelsOf, validateFrozenSnapshot, validateCompletedManifest,
  buildRemainingScope, readGhJson, readCommentsPaged, auditLiveItem, blockedAuditItem, validateAuditedObservation, initialJournal, validateJournal, auditRemainingScope,
  buildManifest, buildBatchArtifacts, atomicWriteJson, acquireReadLock,
};
