'use strict';

/*
 * Read-only coordinator for the 978 rows left after the approved 419-row
 * boundary run.  This module deliberately has no default mutation writer.
 * The apply-shaped helpers are guarded behind explicit authorization and are
 * exercised by simulation tests; live use remains an operator-controlled step.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseSourceNoteBoundaryReviewTransition,
  parseAppliedBoundaryReviewReceipts,
  planSourceNoteBoundaryReviewTransition,
  validateTransitionRequest,
  buildAppliedReceipt,
  renderAppliedReceiptComment,
  normalizeLabels,
  canonicalJson,
} = require('./source-note-boundary-review-transition');
const { validateSourceNoteIssue } = require('./source-note-issue');
const fullTransition = require('./issue-1605-full-boundary-transition');
const nextBoundary = require('./issue-1605-next-boundary-coordinator');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1605;
const REMAINING_SCHEMA = 'issue-1605-next-boundary-manifest.v1';
const PLAN_SCHEMA = 'issue-1605-remaining-boundary-transition-plan.v1';
const JOURNAL_SCHEMA = 'issue-1605-remaining-boundary-transition-journal.v1';
const AUTHORIZATION_SCHEMA = 'issue-1605-remaining-boundary-transition-authorization.v1';
const AUTHORIZATION_MARKER = 'issue-1605-remaining-boundary-transition-authorization';
const REMAINING_COUNT = 978;
const ACTIONABLE_COUNT = 557;
const BLOCKED_COUNT = 421;
const FROZEN_COUNT = 1397;
const REMAINING_SCOPE_DIGEST = '6ef4fa26e838fe8c30d571c08807c09d5a3280eb40aa4af57d679274f6a131a1';
const REMAINING_MANIFEST_DIGEST = 'fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9';
const FROZEN_SNAPSHOT_DIGEST = '5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd';
const COMPLETED_MANIFEST_DIGEST = '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a';
const MAX_READ_ATTEMPTS = 5;
const SAFE_HEX64 = /^[0-9a-f]{64}$/;

function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function canonical(value) { return canonicalJson(value); }
function without(value, key) { const copy = { ...value }; delete copy[key]; return copy; }
function bodySha256(issue) { return sha256Text(issue && issue.body || ''); }
function labels(issue) { return normalizeLabels(issue && issue.labels || []).sort(); }
function same(left, right) { return canonical(left) === canonical(right); }
function safeNonNegative(value) { return Number.isSafeInteger(value) && value >= 0; }

function readRegularJson(file) {
  const target = path.resolve(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`input must be a regular file: ${file}`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function digestWithoutCanonical(value) { return sha256Text(canonical(without(value, 'canonical_digest'))); }

function validateFrozenSnapshot(snapshot) {
  const result = nextBoundary.validateFrozenSnapshot(snapshot);
  return { ...result, digest: snapshot && snapshot.canonical_digest };
}

function validateRemainingManifest(manifest, completedDigest = COMPLETED_MANIFEST_DIGEST) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['remaining manifest must be an object'] };
  if (manifest.schema_version !== REMAINING_SCHEMA) errors.push(`remaining manifest schema must be ${REMAINING_SCHEMA}`);
  if (manifest.repository !== REPOSITORY || manifest.parent_issue !== PARENT_ISSUE) errors.push('remaining manifest repository/parent binding mismatch');
  if (manifest.source_snapshot?.repository !== SOURCE_REPOSITORY || manifest.source_snapshot?.ref !== SOURCE_REF) errors.push('remaining manifest source ref is not fixed');
  if (manifest.scope_digest !== REMAINING_SCOPE_DIGEST) errors.push('remaining manifest scope digest mismatch');
  const digestInput = { ...manifest };
  delete digestInput.ok;
  delete digestInput.canonical_digest;
  if (manifest.canonical_digest !== REMAINING_MANIFEST_DIGEST || nextBoundary.canonicalDigest(digestInput) !== manifest.canonical_digest) errors.push('remaining manifest canonical digest mismatch');
  if (manifest.remaining_count !== REMAINING_COUNT || !Array.isArray(manifest.items) || manifest.items.length !== REMAINING_COUNT) errors.push(`remaining manifest must contain exactly ${REMAINING_COUNT} rows`);
  if (manifest.excluded_completed_manifest?.canonical_digest !== completedDigest) errors.push('remaining manifest does not bind the completed 419-row exclusion');
  const seen = new Set();
  for (const item of manifest.items || []) {
    const number = Number(item && item.issue_number);
    if (!Number.isSafeInteger(number) || number < 1) errors.push('remaining manifest contains an invalid issue number');
    if (seen.has(number)) errors.push(`remaining manifest duplicates #${number}`);
    seen.add(number);
    if (item.expected_source_repository_ref !== SOURCE_REF) errors.push(`#${number} remaining manifest source ref mismatch`);
  }
  return { ok: errors.length === 0, errors, digest: manifest.canonical_digest };
}

function validateEvidencePlan(plan, manifest, snapshot) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['evidence plan must be an object'] };
  if (plan.schema_version !== 'issue-1605-full-boundary-evidence-plan.v1') errors.push('evidence plan schema mismatch');
  if (plan.repository !== REPOSITORY || plan.parent_issue !== PARENT_ISSUE) errors.push('evidence plan repository/parent binding mismatch');
  if (plan.source_snapshot?.repository !== SOURCE_REPOSITORY || plan.source_snapshot?.ref !== SOURCE_REF) errors.push('evidence plan source ref mismatch');
  if (plan.pending_inventory?.digest !== manifest.canonical_digest) errors.push('evidence plan pending inventory is not the remaining manifest');
  if (plan.frozen_inventory?.digest !== snapshot.canonical_digest) errors.push('evidence plan frozen inventory is not the approved snapshot');
  if (plan.scope?.remaining_scope_digest !== REMAINING_SCOPE_DIGEST) errors.push('evidence plan scope digest mismatch');
  if (!Array.isArray(plan.items) || plan.items.length !== ACTIONABLE_COUNT) errors.push(`evidence plan must contain the ${ACTIONABLE_COUNT} actionable rows`);
  if (plan.coverage?.remaining_total !== REMAINING_COUNT || plan.coverage?.audited_total !== REMAINING_COUNT || plan.coverage?.actionable_total !== ACTIONABLE_COUNT || plan.coverage?.blocked_total !== BLOCKED_COUNT) errors.push('evidence plan coverage is not exactly 557 actionable + 421 blocked');
  if (plan.counts?.scope_total !== REMAINING_COUNT || plan.counts?.actionable_total !== ACTIONABLE_COUNT || plan.counts?.blocked !== BLOCKED_COUNT) errors.push('evidence plan counts are not exactly 557 actionable + 421 blocked');
  if (!safeNonNegative(plan.mutation_count) || plan.mutation_count !== 0 || plan.live_evidence_comments !== 0 || plan.live_transitions !== 0) errors.push('evidence plan must prove zero mutations');
  if (!SAFE_HEX64.test(String(plan.canonical_digest || '')) || digestWithoutCanonical(plan) !== plan.canonical_digest) errors.push('evidence plan canonical digest is invalid');
  const manifestNumbers = new Set((manifest.items || []).map((item) => Number(item.issue_number)));
  const seen = new Set();
  for (const item of plan.items || []) {
    const number = Number(item && item.issue_number);
    if (!manifestNumbers.has(number)) errors.push(`#${number} evidence row is outside remaining manifest`);
    if (seen.has(number)) errors.push(`evidence plan duplicates #${number}`);
    seen.add(number);
  }
  if (seen.size !== ACTIONABLE_COUNT) errors.push('evidence plan does not cover every actionable remaining row');
  if (!plan.coverage?.invalid_decision_issue_numbers?.includes(735)) errors.push('evidence plan must retain #735 as blocked for insufficient multi-case evidence');
  return { ok: errors.length === 0, errors, digest: plan.canonical_digest };
}

function requestPathFor(item, requestDir) {
  const relative = item.request_file || `${String(item.issue_number).padStart(4, '0')}.json`;
  const root = path.resolve(requestDir);
  const target = path.resolve(root, relative);
  if (path.relative(root, target).startsWith(`..${path.sep}`) || path.relative(root, target) === '..' || path.isAbsolute(relative)) throw new Error(`#${item.issue_number}: request path escapes request directory`);
  return target;
}

function readRequest(file) {
  const target = path.resolve(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('request marker must be a regular file');
  const body = fs.readFileSync(target, 'utf8');
  const parsed = parseSourceNoteBoundaryReviewTransition(body);
  if (!parsed.request) throw new Error(parsed.errors.join('; '));
  return { request: parsed.request, marker_sha256: sha256Text(body) };
}

function validateRequestBinding(request, evidenceItem, manifestDigestValue) {
  const errors = [...validateTransitionRequest(request).errors];
  if (request.repository !== REPOSITORY || request.issue_number !== Number(evidenceItem.issue_number)) errors.push('request repository/issue binding mismatch');
  if (request.transition_id !== evidenceItem.transition_id) errors.push('request transition_id mismatch');
  if (request.source_note_id !== evidenceItem.source_note_id) errors.push('request source_note_id mismatch');
  if (request.expected_body_sha256 !== evidenceItem.expected_body_sha256) errors.push('request expected body CAS mismatch');
  if (request.expected_source_revision_id !== evidenceItem.expected_source_revision_id) errors.push('request SourceRevision CAS mismatch');
  if (request.schema_version === 'source-note-boundary-review-transition.v2') {
    if (request.expected_source_repository_ref !== null) errors.push('v2 request source ref must be null');
  } else if (request.expected_source_repository_ref !== SOURCE_REF) errors.push('request source ref mismatch');
  if (request.decision !== evidenceItem.decision) errors.push('request decision mismatch');
  if (evidenceItem.expected_manifest_sha256 != null && request.expected_manifest_sha256 !== evidenceItem.expected_manifest_sha256) errors.push('request expected SourceCapture manifest digest mismatch');
  if (request.decision === 'multi-interview' && (!Array.isArray(request.interview_cases) || request.interview_cases.length < 2)) errors.push('v2 multi-interview request needs at least two cases');
  return { ok: errors.length === 0, errors };
}

function parseRequestSet(evidencePlan, requestDir, manifestDigestValue) {
  const records = new Map();
  const errors = [];
  const requestRoot = path.resolve(requestDir);
  if (path.basename(requestRoot) === 'full-boundary-requests' || requestRoot.split(path.sep).includes('full-boundary-requests')) {
    return { records, errors: ['remaining transition request input may not reuse completed 419 full-boundary-requests artifacts'] };
  }
  for (const item of evidencePlan.items || []) {
    if (!item.decision || item.issue_number === 735) continue;
    let file;
    try { file = requestPathFor(item, requestDir); } catch (error) { errors.push(error.message); continue; }
    if (!fs.existsSync(file)) continue;
    try {
      const marker = readRequest(file);
      const binding = validateRequestBinding(marker.request, item, manifestDigestValue);
      if (!binding.ok) errors.push(`#${item.issue_number}: ${binding.errors.join('; ')}`);
      records.set(Number(item.issue_number), { evidence: item, request: marker.request, request_file: file, marker_sha256: marker.marker_sha256 });
    } catch (error) { errors.push(`#${item.issue_number}: ${error.message}`); }
  }
  return { records, errors };
}

function receiptValidation(receipt, request, planned, planDigestValue) {
  const errors = [];
  if (!receipt || receipt.schema_version !== 'source-note-boundary-review-applied.v1') errors.push('receipt schema mismatch');
  if (receipt?.transition_id !== request.transition_id || receipt?.issue_number !== request.issue_number || receipt?.source_note_id !== request.source_note_id) errors.push('receipt transition identity mismatch');
  if (receipt?.expected_source_revision_id !== request.expected_source_revision_id || receipt?.expected_source_repository_ref !== request.expected_source_repository_ref) errors.push('receipt SourceRevision/ref mismatch');
  if (receipt?.previous_body_sha256 !== request.expected_body_sha256 || receipt?.new_body_sha256 !== planned.current_body_sha256) errors.push('receipt body CAS mismatch');
  if (receipt?.plan_digest !== planDigestValue) errors.push('receipt plan digest mismatch');
  return { ok: errors.length === 0, errors };
}

function transitionItem(record, live, planDigestValue) {
  const comments = live && live.comments;
  if (!live || !live.issue || !Array.isArray(comments)) return { ok: false, status: 'blocked', errors: ['live issue/comments read is incomplete'] };
  const request = record.request;
  const evidence = comments.filter((comment) => Number(comment && comment.id) === request.review_evidence.comment_id);
  if (evidence.length !== 1) return { ok: false, status: 'blocked', errors: [`review evidence comment ${request.review_evidence.comment_id} must occur exactly once`] };
  const receipts = parseAppliedBoundaryReviewReceipts(comments);
  if (receipts.errors.length) return { ok: false, status: 'blocked', errors: receipts.errors };
  const matches = receipts.receipts.filter((item) => item.transition_id === request.transition_id);
  if (matches.length > 1) return { ok: false, status: 'blocked', errors: ['multiple applied receipts for one transition; refusing to choose one'] };
  const planned = planSourceNoteBoundaryReviewTransition(request, live.issue, { evidenceComment: evidence[0], receipts: receipts.receipts });
  const errors = [...(planned.errors || [])];
  if (!planned.already_applied && planned.ok) {
    const validation = validateSourceNoteIssue({ body: planned.next_body, labels: planned.next_labels, state: 'open' });
    if (!validation.ok) errors.push(...validation.errors.map((error) => `planned SourceNote invalid: ${error}`));
  }
  if (matches[0] && planDigestValue) {
    const receiptPlan = { ...planned, current_body_sha256: planned.already_applied ? bodySha256(live.issue) : planned.next_body_sha256 };
    const validReceipt = receiptValidation(matches[0], request, receiptPlan, planDigestValue);
    if (!validReceipt.ok) errors.push(...validReceipt.errors);
  }
  return { ...planned, ok: errors.length === 0, errors, status: errors.length ? 'blocked' : planned.already_applied ? (matches[0] ? 'already-applied' : 'receipt-needed') : 'ready', existing_receipt: matches[0] || null };
}

function itemDigest(item) {
  return sha256Text(canonical({ issue_number: item.issue_number, transition_id: item.transition_id, source_note_id: item.source_note_id, decision: item.decision, request_marker_sha256: item.request_marker_sha256, expected_body_sha256: item.expected_body_sha256, expected_source_revision_id: item.expected_source_revision_id, next_body_sha256: item.next_body_sha256, next_labels: item.next_labels, interview_note_ids: item.interview_note_ids, interview_note_cases: item.interview_note_cases }));
}

// A transition plan is an authorization input, not a snapshot of the current
// live state.  In particular, a successful apply changes an item from
// `ready` to `already-applied` and adds a receipt.  Those observations must
// not change the digest used to resume the same authorized plan.
function stablePlanDigestContent(content) {
  const counts = { ...content.counts };
  delete counts.transition_ready;
  const items = (content.items || []).map((item) => {
    const {
      status, current_body_sha256, existing_receipt, errors,
      mutation_count, possibly_performed, ...stable
    } = item;
    return stable;
  });
  return { ...content, counts, errors: [], items };
}

function buildTransitionPlan({ evidencePlan, evidencePlanPath = null, manifest, manifestPath = null, snapshot, snapshotPath = null, requestDir, liveLoader = null }) {
  const errors = [];
  const manifestCheck = validateRemainingManifest(manifest);
  const snapshotCheck = validateFrozenSnapshot(snapshot);
  const evidenceCheck = validateEvidencePlan(evidencePlan, manifest, snapshot);
  errors.push(...manifestCheck.errors, ...snapshotCheck.errors, ...evidenceCheck.errors);
  const requests = parseRequestSet(evidencePlan, requestDir, manifest && manifest.canonical_digest);
  errors.push(...requests.errors);
  const items = [];
  const evidenceByIssue = new Map((evidencePlan.items || []).map((item) => [Number(item.issue_number), item]));
  const blockedIssues = new Set(evidencePlan.coverage?.blocked_issue_numbers || []);
  for (const manifestItem of manifest.items || []) {
    const number = Number(manifestItem.issue_number);
    const evidenceItem = evidenceByIssue.get(number);
    const blockedByAudit = blockedIssues.has(number) || !evidenceItem;
    if (blockedByAudit) {
      const reason = number === 735 ? 'insufficient multi-case evidence' : (!evidenceItem ? 'audit row is absent from actionable evidence plan' : 'audit evidence is blocked');
      const item = { issue_number: number, transition_id: evidenceItem?.transition_id || null, source_note_id: manifestItem.source_note_id, decision: evidenceItem?.decision || null, status: 'blocked', scope_status: 'blocked', blocked_reason: reason, errors: number === 735 ? ['#735 multi-interview has fewer than two cases'] : [reason], mutation_count: 0, possibly_performed: false };
      item.item_digest = itemDigest(item); items.push(item); continue;
    }
    const record = requests.records.get(number);
    if (!record) {
      const item = { issue_number: number, transition_id: evidenceItem.transition_id, source_note_id: evidenceItem.source_note_id, decision: evidenceItem.decision, expected_body_sha256: evidenceItem.expected_body_sha256, expected_source_revision_id: evidenceItem.expected_source_revision_id, status: 'awaiting-formal-request', scope_status: 'actionable', errors: ['formal remaining-boundary transition request marker is not present'], mutation_count: 0, possibly_performed: false };
      item.item_digest = itemDigest(item); items.push(item); errors.push(`#${number}: ${item.errors[0]}`); continue;
    }
    let result = { ok: true, status: 'request-bound', errors: [] };
    if (liveLoader) {
      try {
        const live = liveLoader(record.request);
        const liveErrors = [];
        if (Number(live.issue?.number) !== number) liveErrors.push('live Issue identity differs from request');
        if (bodySha256(live.issue) !== manifestItem.expected_body_sha256) liveErrors.push('live body CAS differs from remaining manifest');
        if (!same(labels(live.issue), [...(manifestItem.frozen_labels || [])].sort())) liveErrors.push('live labels differ from remaining manifest frozen labels');
        if (record.request.schema_version !== 'source-note-boundary-review-transition.v2' && manifestItem.expected_source_repository_ref !== SOURCE_REF) liveErrors.push('remaining manifest SourceRevision ref is not fixed');
        if (!live.issue || !Array.isArray(live.comments)) liveErrors.push('live Issue/comments read is incomplete');
        if (liveErrors.length) result = { ok: false, status: 'blocked', errors: liveErrors };
        else result = transitionItem(record, live, null);
      }
      catch (error) { result = { ok: false, status: 'blocked', errors: [`live CAS read failed: ${error.message}`] }; }
    }
    const item = { issue_number: number, transition_id: record.request.transition_id, source_note_id: record.request.source_note_id, decision: record.request.decision, expected_body_sha256: record.request.expected_body_sha256, expected_source_revision_id: record.request.expected_source_revision_id, request_file: record.request_file, request_marker_sha256: record.marker_sha256, status: result.status, scope_status: 'actionable', current_body_sha256: result.current_body_sha256 || null, next_body_sha256: result.next_body_sha256 || null, next_labels: result.next_labels || null, next_body: result.next_body || null, next_plan: result.ok ? { interview_note_ids: result.interview_note_ids || [], interview_note_cases: result.interview_note_cases || [] } : null, evidence_comment_id: record.request.review_evidence.comment_id, existing_receipt: result.existing_receipt || null, errors: result.errors || [], mutation_count: 0, possibly_performed: false };
    item.item_digest = itemDigest(item); items.push(item);
    if (item.status === 'blocked' || item.errors.length) errors.push(`#${number}: ${item.errors.join('; ')}`);
  }
  const requestDigest = sha256Text(canonical([...requests.records.values()].sort((a, b) => a.request.issue_number - b.request.issue_number).map((record) => ({ issue_number: record.request.issue_number, transition_id: record.request.transition_id, marker_sha256: record.marker_sha256 }))));
  const blockedErrors = items.filter((item) => item.scope_status === 'blocked').flatMap((item) => item.errors || []);
  const blockedIssueSet = new Set(items.filter((item) => item.scope_status === 'blocked').map((item) => `#${item.issue_number}`));
  for (const error of evidencePlan.errors || []) {
    if (![...blockedIssueSet].some((prefix) => String(error).startsWith(prefix))) errors.push(`evidence plan: ${error}`);
  }
  const actionableItems = items.filter((item) => item.scope_status === 'actionable');
  const actionableReady = actionableItems.every((item) => ['ready', 'already-applied'].includes(item.status));
  const content = { schema_version: PLAN_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE, source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF }, frozen_snapshot: { path: snapshotPath, digest: snapshot.canonical_digest, count: FROZEN_COUNT }, remaining_manifest: { path: manifestPath, digest: manifest.canonical_digest, scope_digest: manifest.scope_digest, count: REMAINING_COUNT }, evidence_plan: { path: evidencePlanPath, digest: evidencePlan.canonical_digest }, request_input: { directory: path.resolve(requestDir), digest: requestDigest, bound_count: requests.records.size }, counts: { scope_total: REMAINING_COUNT, actionable_total: ACTIONABLE_COUNT, blocked_total: BLOCKED_COUNT, request_bound: requests.records.size, transition_ready: items.filter((item) => item.status === 'ready').length }, blocked_errors: blockedErrors, mutation_count: 0, possibly_performed: false, errors, items };
  const digest = sha256Text(canonical(stablePlanDigestContent(content)));
  const recordByIssue = requests.records;
  for (const item of items) {
    if (!item.existing_receipt || item.status === 'blocked') continue;
    const record = recordByIssue.get(Number(item.issue_number));
    if (!record) continue;
    const receiptCheck = receiptValidation(item.existing_receipt, record.request, { current_body_sha256: item.current_body_sha256 }, digest);
    if (!receiptCheck.ok) {
      item.errors.push(...receiptCheck.errors);
      item.status = 'blocked';
      errors.push(`#${item.issue_number}: ${receiptCheck.errors.join('; ')}`);
    }
  }
  return { ...content, ok: errors.length === 0 && actionableReady, ready_for_apply: errors.length === 0 && actionableReady, canonical_digest: digest };
}

function initialJournal(plan) {
  const content = { schema_version: JOURNAL_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE, plan_digest: plan.canonical_digest, manifest_digest: plan.remaining_manifest.digest, scope_digest: plan.remaining_manifest.scope_digest, status: 'planned', mutation_count: 0, items: plan.items.map((item) => ({ issue_number: item.issue_number, transition_id: item.transition_id, item_digest: item.item_digest, phase: item.status === 'blocked' ? 'blocked' : 'pending', mutation_count: 0, mutation_started: false, possibly_performed: false })) };
  return { ...content, canonical_digest: digestWithoutCanonical(content) };
}

function validateJournal(journal, plan, maxMutations = null) {
  const errors = [];
  if (!journal || journal.schema_version !== JOURNAL_SCHEMA) errors.push('journal schema mismatch');
  if (journal?.plan_digest !== plan.canonical_digest || journal?.manifest_digest !== plan.remaining_manifest.digest || journal?.scope_digest !== plan.remaining_manifest.scope_digest) errors.push('journal plan/manifest/scope binding mismatch');
  if (!SAFE_HEX64.test(String(journal?.canonical_digest || '')) || digestWithoutCanonical(journal) !== journal.canonical_digest) errors.push('journal canonical digest is invalid');
  if (!safeNonNegative(journal?.mutation_count)) errors.push('journal mutation_count must be a safe non-negative integer');
  if (maxMutations != null && (!Number.isSafeInteger(maxMutations) || maxMutations < 1)) errors.push('max mutation ceiling must be a positive safe integer');
  if (maxMutations != null && safeNonNegative(journal?.mutation_count) && journal.mutation_count > maxMutations) errors.push('journal mutation_count exceeds max mutation ceiling');
  const expected = new Map(plan.items.map((item) => [Number(item.issue_number), item]));
  const seen = new Set(); let sum = 0;
  for (const item of journal?.items || []) {
    const number = Number(item.issue_number);
    if (!expected.has(number)) errors.push(`journal contains unknown #${number}`);
    if (seen.has(number)) errors.push(`journal duplicates #${number}`); seen.add(number);
    if (expected.has(number) && item.item_digest !== expected.get(number).item_digest) errors.push(`journal item digest drifted for #${number}`);
    if (!['blocked', 'pending', 'ready', 'patch-pending', 'receipt-pending', 'complete', 'uncertain'].includes(item.phase)) errors.push(`journal phase invalid for #${number}`);
    if (!safeNonNegative(item.mutation_count)) errors.push(`journal #${number} mutation_count must be a safe non-negative integer`); else sum += item.mutation_count;
    if (typeof item.mutation_started !== 'boolean') errors.push(`journal #${number} mutation_started must be boolean`);
    if (typeof item.possibly_performed !== 'boolean') errors.push(`journal #${number} possibly_performed must be boolean`);
  }
  if (seen.size !== expected.size) errors.push('journal does not contain exactly one item for every plan row');
  if (safeNonNegative(journal?.mutation_count) && sum !== journal.mutation_count) errors.push('journal mutation_count must equal item mutation_count sum');
  if (maxMutations != null && safeNonNegative(journal?.mutation_count) && journal.mutation_count > maxMutations) errors.push('journal total exceeds max mutation ceiling');
  return { ok: errors.length === 0, errors };
}

function persistJournal(file, journal, plan, lock, maxMutations = null) {
  if (!lock || typeof lock.assertHeld !== 'function') throw new Error('durable journal write requires an exclusive lock');
  lock.assertHeld();
  const check = validateJournal(journal, plan, maxMutations);
  if (!check.ok) throw new Error(`journal validation failed before persist: ${check.errors.join('; ')}`);
  fullTransition.atomicWriteJson(file, journal);
}

function validateAuthorization(proof, planDigestValue, comments = []) {
  const errors = [];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, errors: ['authorization proof must be an object'] };
  if (proof.schema_version !== AUTHORIZATION_SCHEMA || proof.repository !== REPOSITORY || proof.parent_issue !== PARENT_ISSUE || proof.action !== 'authorize-remaining-boundary-transition') errors.push('authorization proof schema/repository/parent/action mismatch');
  if (proof.allow_live_github !== true) errors.push('authorization proof must explicitly allow live GitHub');
  if (proof.manifest_digest !== REMAINING_MANIFEST_DIGEST || proof.scope_digest !== REMAINING_SCOPE_DIGEST || proof.plan_digest !== planDigestValue) errors.push('authorization proof digest binding mismatch');
  if (!Number.isSafeInteger(proof.max_mutations) || proof.max_mutations < 1) errors.push('authorization max_mutations must be a positive safe integer');
  if (!Number.isSafeInteger(proof.comment_id) || proof.comment_id < 1) errors.push('authorization comment_id must be positive');
  if (!SAFE_HEX64.test(String(proof.proof_sha256 || '')) || sha256Text(canonical(without(proof, 'proof_sha256'))) !== proof.proof_sha256) errors.push('authorization proof digest invalid');
  const matches = comments.flatMap((comment) => Number(comment.id) === proof.comment_id ? [...String(comment.body || '').matchAll(new RegExp(`<!--\\s*${AUTHORIZATION_MARKER}\\s*([\\s\\S]*?)-->`, 'g'))].map((match) => { try { return JSON.parse(match[1].trim()); } catch (_) { return null; } }).filter(Boolean) : []);
  if (matches.length !== 1 || !same(matches[0], proof)) errors.push('parent authorization marker does not exactly match local proof');
  return { ok: errors.length === 0, errors };
}

function assertApplyGuards({ apply = false, confirmPlan, plan, authorization, maxMutations }) {
  if (apply !== true) throw new Error('apply requires explicit --apply');
  if (!SAFE_HEX64.test(String(confirmPlan || '')) || confirmPlan !== plan.canonical_digest) throw new Error('apply requires --confirm-plan equal to the transition plan digest');
  if (!Number.isSafeInteger(maxMutations) || maxMutations < 1) throw new Error('apply requires a positive --max-mutations');
  if (!authorization || !Number.isSafeInteger(authorization.max_mutations) || authorization.max_mutations < 1) throw new Error('authorization proof must declare a positive max_mutations ceiling');
  if (maxMutations > authorization.max_mutations) throw new Error('--max-mutations exceeds authorization proof ceiling');
}

function buildAppliedRemainingReceipt(request, planned, plan) {
  const receiptPlan = planned.already_applied
    ? { ...planned, current_body_sha256: request.expected_body_sha256, next_body_sha256: planned.current_body_sha256 }
    : planned;
  return { ...buildAppliedReceipt(request, receiptPlan, new Date().toISOString()), parent_issue: PARENT_ISSUE, manifest_digest: plan.remaining_manifest.digest, scope_digest: plan.remaining_manifest.scope_digest, plan_digest: plan.canonical_digest, expected_source_revision_id: request.expected_source_revision_id, expected_source_repository_ref: request.expected_source_repository_ref };
}

function mutationWritersDisabled() {
  return { patchIssue() { throw new Error('live PATCH is disabled in remaining-boundary plan-only runner'); }, postReceipt() { throw new Error('live POST is disabled in remaining-boundary plan-only runner'); } };
}

function reconcileUnknownResponse({ kind, record, liveLoader, expected, planDigestValue, attempts = 3, sleep = () => {} }) {
  if (!['patch', 'receipt'].includes(kind)) throw new Error('unknown-response reconciliation kind must be patch or receipt');
  if (typeof liveLoader !== 'function') throw new Error('unknown-response reconciliation requires a read-only live loader');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('reconcile attempts must be a safe integer from 1 to 5');
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = transitionItem(record, liveLoader(record.request), planDigestValue);
      const targetMatches = result.already_applied
        && result.current_body_sha256 === expected.next_body_sha256
        && same(labels({ labels: result.next_labels }), labels({ labels: expected.next_labels }));
      const receiptMatches = kind === 'patch' || Boolean(result.existing_receipt);
      if (result.ok && targetMatches && receiptMatches) return result;
      lastError = new Error(`#${record.request.issue_number} ${kind} response did not reconcile to an exact target/receipt`);
    } catch (error) { lastError = error; }
    if (attempt < attempts) sleep(attempt);
  }
  throw lastError || new Error(`${kind} response reconciliation failed`);
}

function postWriteValidate({ record, liveLoader, expected, planDigestValue, requireReceipt = false }) {
  const result = transitionItem(record, liveLoader(record.request), planDigestValue);
  if (!result.ok || !result.already_applied || result.current_body_sha256 !== expected.next_body_sha256 || (requireReceipt && !result.existing_receipt)) {
    throw new Error(`#${record.request.issue_number} post-write validator/CAS did not prove target and receipt`);
  }
  return result;
}

/*
 * Every writer is called at most once; an exception records
 * possibly_performed and only then invokes the read-only reconciler.  No
 * mutation retry is hidden here.
 */
function applyBatch({ plan, records, liveLoader, patchIssue, postReceipt, lock, journal, journalFile, maxMutations, authorization, apply = false, confirmPlan, writeJournal, sleep = () => {}, now = () => new Date().toISOString() }) {
  if (!plan || !plan.ok || plan.ready_for_apply !== true) throw new Error('remaining transition plan is not ready; actionable rows remain fail-closed');
  assertApplyGuards({ apply, confirmPlan, plan, authorization, maxMutations });
  if (typeof patchIssue !== 'function' || typeof postReceipt !== 'function') throw new Error('apply requires explicitly injected mutation writers');
  if (!lock || typeof lock.assertHeld !== 'function') throw new Error('apply requires an exclusive lock');
  if (typeof writeJournal !== 'function') throw new Error('apply requires a durable journal writer');
  const state = journal || initialJournal(plan);
  if (!validateJournal(state, plan, maxMutations).ok) throw new Error('apply journal is not valid for this plan');
  const byIssue = new Map((state.items || []).map((item) => [Number(item.issue_number), item]));
  const recordByIssue = new Map((records || []).map((record) => [Number(record.request.issue_number), record]));
  let count = state.mutation_count;
  const persist = () => {
    lock.assertHeld();
    state.mutation_count = count;
    state.canonical_digest = digestWithoutCanonical(state);
    // The caller owns the durable destination.  Keeping the writer explicit
    // makes every phase transition crash-resumable and prevents an apply
    // caller from accidentally substituting an in-memory no-op.
    writeJournal(state, { plan, journalFile, maxMutations, lock });
  };
  const accountMutation = (entry, completedCount) => {
    if (!safeNonNegative(entry.mutation_count) || entry.mutation_count > completedCount) {
      throw new Error(`#${entry.issue_number}: journal mutation counter cannot reconcile to ${completedCount}`);
    }
    count += completedCount - entry.mutation_count;
    entry.mutation_count = completedCount;
  };
  const markUncertain = (entry, message) => {
    entry.phase = 'uncertain';
    entry.possibly_performed = true;
    entry.error = message;
    persist();
    throw new Error(`#${entry.issue_number}: ${message}`);
  };
  const reconcileInflight = (entry, record, expected, kind, observedError = null) => {
    if (!entry.mutation_started) return null;
    try {
      return reconcileUnknownResponse({ kind, record, liveLoader, expected, planDigestValue: plan.canonical_digest, sleep });
    } catch (error) {
      markUncertain(entry, `${observedError ? `${observedError}; ` : ''}${kind} in-flight mutation did not reconcile: ${error.message}`);
    }
  };
  for (const item of plan.items) {
    if (item.scope_status !== 'actionable') continue;
    const record = recordByIssue.get(item.issue_number);
    if (!record) throw new Error(`#${item.issue_number}: formal request is missing`);
    const entry = byIssue.get(item.issue_number);
    if (!entry) throw new Error(`#${item.issue_number}: journal item is missing`);
    if (entry.phase === 'uncertain') throw new Error(`#${item.issue_number}: journal is uncertain; refusing blind retry`);
    let fresh;
    let receiptOnly = false;
    if (entry.phase === 'patch-pending') {
      let observed;
      try { observed = transitionItem(record, liveLoader(record.request), plan.canonical_digest); }
      catch (error) { observed = reconcileInflight(entry, record, item, 'patch', `PATCH in-flight read failed: ${error.message}`); }
      if (!observed || !observed.ok) {
        if (entry.mutation_started) observed = reconcileInflight(entry, record, item, 'patch', `PATCH in-flight state is not an exact target: ${(observed && observed.errors || []).join('; ') || 'read failed'}`);
        if (!observed || !observed.ok) markUncertain(entry, `PATCH pre-write state drifted before retry: ${(observed && observed.errors || []).join('; ') || 'read failed'}`);
      }
      if (!observed.already_applied && entry.mutation_started) observed = reconcileInflight(entry, record, item, 'patch');
      if (!observed || !observed.ok || !observed.already_applied) {
        if (entry.mutation_started) markUncertain(entry, 'PATCH in-flight mutation did not prove the exact target');
        // The durable pre-write intent is explicit: no writer was started and
        // the live CAS still proves the original pending state.
        entry.phase = 'pending'; entry.error = null; persist();
      } else {
        accountMutation(entry, 1);
        entry.mutation_started = false; entry.possibly_performed = false; entry.error = null;
        if (observed.existing_receipt) {
          accountMutation(entry, 2); entry.phase = 'complete'; persist(); continue;
        }
        entry.phase = 'receipt-pending'; persist();
        fresh = observed; receiptOnly = true;
      }
    }
    if (entry.phase === 'receipt-pending' && !receiptOnly) {
      let observed;
      try { observed = transitionItem(record, liveLoader(record.request), plan.canonical_digest); }
      catch (error) { observed = reconcileInflight(entry, record, item, 'receipt', `receipt in-flight read failed: ${error.message}`); }
      if (!observed || !observed.ok) {
        if (entry.mutation_started) observed = reconcileInflight(entry, record, item, 'receipt', `receipt in-flight state is not verifiable: ${(observed && observed.errors || []).join('; ') || 'read failed'}`);
        if (!observed || !observed.ok) markUncertain(entry, `receipt in-flight state is not verifiable: ${(observed && observed.errors || []).join('; ') || 'read failed'}`);
      }
      if (!observed.already_applied) markUncertain(entry, 'receipt in-flight mutation lost the applied boundary target');
      if (observed.existing_receipt) {
        accountMutation(entry, 2); entry.mutation_started = false; entry.possibly_performed = false; entry.error = null; entry.phase = 'complete'; persist(); continue;
      }
      if (entry.mutation_started) observed = reconcileInflight(entry, record, item, 'receipt');
      if (!observed || !observed.ok || !observed.already_applied || !observed.existing_receipt) {
        if (entry.mutation_started) markUncertain(entry, 'receipt in-flight mutation has no exact applied receipt');
      }
      fresh = observed; receiptOnly = true;
    }
    if (entry.phase === 'uncertain') throw new Error(`#${item.issue_number}: journal is uncertain; refusing blind retry`);
    if (entry.phase === 'complete') {
      // A complete resume is never trusted from the journal alone.
      fresh = postWriteValidate({ record, liveLoader, expected: item, planDigestValue: plan.canonical_digest, requireReceipt: true });
      continue;
    }
    if (!receiptOnly) {
      fresh = transitionItem(record, liveLoader(record.request), plan.canonical_digest);
      if (!fresh.ok) throw new Error(`#${item.issue_number}: fresh live CAS failed: ${fresh.errors.join('; ')}`);
      if (fresh.already_applied) {
        if (count + 2 > maxMutations) throw new Error(`mutation ceiling would be exceeded at #${item.issue_number}`);
        accountMutation(entry, 1);
        entry.mutation_started = false; entry.possibly_performed = false; entry.error = null;
        if (fresh.existing_receipt) {
          accountMutation(entry, 2); entry.phase = 'complete'; persist(); continue;
        }
        entry.phase = 'receipt-pending'; persist();
        receiptOnly = true;
      }
    }
    const required = receiptOnly ? 1 : 2;
    if (count + required > maxMutations) throw new Error(`mutation ceiling would be exceeded at #${item.issue_number}`);
    let checked = receiptOnly ? fresh : null;
    if (!receiptOnly) {
      entry.phase = 'patch-pending'; entry.mutation_started = false; entry.error = null; persist();
      count += 1; entry.mutation_count += 1; entry.mutation_started = true; persist();
      try { lock.assertHeld(); patchIssue(item.issue_number, { body: fresh.next_body, labels: fresh.next_labels }); }
      catch (error) {
        entry.possibly_performed = true; entry.error = `PATCH response unknown: ${error.message}`; persist();
        try { checked = reconcileUnknownResponse({ kind: 'patch', record, liveLoader, expected: fresh, planDigestValue: plan.canonical_digest, sleep }); }
        catch (reconcileError) { entry.phase = 'uncertain'; entry.error += `; reconcile failed: ${reconcileError.message}`; persist(); throw reconcileError; }
        entry.mutation_started = false; entry.possibly_performed = false; entry.error = null; persist();
      }
      if (!checked) {
        try {
          checked = postWriteValidate({ record, liveLoader, expected: fresh, planDigestValue: plan.canonical_digest });
        } catch (error) {
          entry.possibly_performed = true;
          entry.error = `PATCH post-write validation unknown: ${error.message}`;
          persist();
          try {
            checked = reconcileUnknownResponse({ kind: 'patch', record, liveLoader, expected: fresh, planDigestValue: plan.canonical_digest, sleep });
          } catch (reconcileError) {
            entry.phase = 'uncertain';
            entry.error += `; reconcile failed: ${reconcileError.message}`;
            persist();
            throw reconcileError;
          }
          entry.mutation_started = false; entry.possibly_performed = false; entry.error = null; persist();
        }
      }
      entry.mutation_started = false; entry.possibly_performed = false; entry.error = null;
      entry.phase = 'receipt-pending'; persist();
    }
    const receipt = buildAppliedRemainingReceipt(record.request, checked, plan);
    count += 1; entry.mutation_count += 1; entry.mutation_started = true; persist();
    let response;
    let receiptReconciled = false;
    try { lock.assertHeld(); response = postReceipt(item.issue_number, renderAppliedReceiptComment(receipt)); }
    catch (error) {
      entry.possibly_performed = true; entry.error = `POST response unknown: ${error.message}`; persist();
      try { reconcileUnknownResponse({ kind: 'receipt', record, liveLoader, expected: checked, planDigestValue: plan.canonical_digest, sleep }); }
      catch (reconcileError) { entry.phase = 'uncertain'; entry.error += `; reconcile failed: ${reconcileError.message}`; persist(); throw reconcileError; }
      receiptReconciled = true;
      entry.possibly_performed = false; entry.error = null; persist();
    }
    if (!receiptReconciled && (!response || !Number.isSafeInteger(Number(response.id)))) {
      entry.possibly_performed = true;
      entry.error = `POST response was unknown or untrusted; reconciling by read only`;
      persist();
      try { reconcileUnknownResponse({ kind: 'receipt', record, liveLoader, expected: checked, planDigestValue: plan.canonical_digest, sleep }); }
      catch (reconcileError) { entry.phase = 'uncertain'; entry.error += `; reconcile failed: ${reconcileError.message}`; persist(); throw reconcileError; }
      receiptReconciled = true;
      entry.possibly_performed = false; entry.error = null; persist();
    }
    try {
      postWriteValidate({ record, liveLoader, expected: checked, planDigestValue: plan.canonical_digest, requireReceipt: true });
    } catch (error) {
      entry.possibly_performed = true;
      entry.error = `POST post-write validation unknown: ${error.message}`;
      persist();
      try {
        reconcileUnknownResponse({ kind: 'receipt', record, liveLoader, expected: checked, planDigestValue: plan.canonical_digest, sleep });
      } catch (reconcileError) {
        entry.phase = 'uncertain';
        entry.error += `; reconcile failed: ${reconcileError.message}`;
        persist();
        throw reconcileError;
      }
      entry.possibly_performed = false; entry.error = null; persist();
    }
    entry.phase = 'complete'; entry.mutation_started = false; entry.possibly_performed = false; entry.error = null; persist();
  }
  state.status = 'complete'; persist();
  return { ok: true, journal: state, mutation_count: count };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, PARENT_ISSUE, PLAN_SCHEMA, JOURNAL_SCHEMA, AUTHORIZATION_SCHEMA,
  REMAINING_COUNT, ACTIONABLE_COUNT, BLOCKED_COUNT, FROZEN_COUNT, REMAINING_SCOPE_DIGEST, REMAINING_MANIFEST_DIGEST, FROZEN_SNAPSHOT_DIGEST,
  canonical, sha256Text, readRegularJson, validateFrozenSnapshot, validateRemainingManifest, validateEvidencePlan,
  readRequest, validateRequestBinding, parseRequestSet, transitionItem, itemDigest, buildTransitionPlan,
  stablePlanDigestContent,
  initialJournal, validateJournal, persistJournal, validateAuthorization, assertApplyGuards,
  buildAppliedRemainingReceipt, renderAppliedReceiptComment, mutationWritersDisabled,
  reconcileUnknownResponse, postWriteValidate, applyBatch,
};
