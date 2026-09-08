'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseSourceNoteBoundaryReviewTransition,
  planSourceNoteBoundaryReviewTransition,
  buildAppliedReceipt,
  renderAppliedReceiptComment,
  parseAppliedBoundaryReviewReceipts,
  validateTransitionRequest,
  normalizeLabels,
  canonicalJson,
} = require('./source-note-boundary-review-transition');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1605;
const MANIFEST_SCHEMA = 'source-note-boundary-review-batch.v1';
const PLAN_SCHEMA = 'issue-1605-full-boundary-transition-plan.v1';
const AUTHORIZATION_SCHEMA = 'issue-1605-full-boundary-transition-authorization.v1';
const JOURNAL_SCHEMA = 'issue-1605-full-boundary-transition-journal.v1';
const LOCK_SCHEMA = 'issue-1605-full-boundary-transition-lock.v1';
const AUTHORIZATION_MARKER = 'issue-1605-full-boundary-transition-authorization';
const FULL_MANIFEST_ITEM_COUNT = 419;
const FULL_MANIFEST_PLAN_DIGEST = 'ad3e3974c21415e2371b8fe77a2ae54b65dd7783516ed6a68ef61bb070877781';
const FULL_MANIFEST_CANONICAL_DIGEST = '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a';
const DEFAULT_RECONCILE_ATTEMPTS = 3;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function canonical(value) { return canonicalJson(value); }
function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
function labelsOf(issue) { return normalizeLabels(issue && issue.labels || []).sort(); }
function bodySha256(issue) { return sha256Text(issue && issue.body || ''); }
function same(a, b) { return canonical(a) === canonical(b); }

function readRegularJson(file) {
  const target = path.resolve(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`input must be a regular file: ${file}`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function readRequestMarker(file) {
  const target = path.resolve(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`request marker must be a regular file: ${file}`);
  const body = fs.readFileSync(target, 'utf8');
  const parsed = parseSourceNoteBoundaryReviewTransition(body);
  if (!parsed.request) throw new Error(`${file}: ${parsed.errors.join('; ')}`);
  return { request: parsed.request, body, digest: sha256Text(body) };
}

function manifestDigest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  return sha256Text(canonical(without(manifest, 'canonical_digest')));
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['manifest must be an object'] };
  if (manifest.schema_version !== MANIFEST_SCHEMA) errors.push(`manifest schema must be ${MANIFEST_SCHEMA}`);
  if (manifest.repository !== REPOSITORY) errors.push(`manifest repository must be ${REPOSITORY}`);
  if (manifest.parent_issue !== PARENT_ISSUE) errors.push(`manifest parent_issue must be ${PARENT_ISSUE}`);
  if (!manifest.source_snapshot || manifest.source_snapshot.repository !== SOURCE_REPOSITORY) errors.push('manifest source repository is not pinned');
  if (manifest.source_snapshot && manifest.source_snapshot.ref !== SOURCE_REF) errors.push('manifest source ref is not the fixed approved ref');
  if (manifest.items?.length !== FULL_MANIFEST_ITEM_COUNT) errors.push(`manifest must contain the complete #1605 full scope of ${FULL_MANIFEST_ITEM_COUNT} items`);
  if (manifest.plan_digest !== FULL_MANIFEST_PLAN_DIGEST) errors.push('manifest plan_digest is not the approved #1605 full-boundary plan');
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) errors.push('manifest items must be a non-empty array');
  if (!HEX64.test(String(manifest.canonical_digest || ''))) errors.push('manifest canonical_digest must be a SHA-256');
  else if (manifestDigest(manifest) !== manifest.canonical_digest) errors.push('manifest canonical_digest does not match canonical manifest content');
  if (manifest.canonical_digest !== FULL_MANIFEST_CANONICAL_DIGEST) errors.push('manifest canonical_digest is not the approved #1605 full manifest');
  const seenIssues = new Set();
  const seenTransitions = new Set();
  for (const [index, item] of (manifest.items || []).entries()) {
    const issue = Number(item && item.issue_number);
    if (!Number.isSafeInteger(issue) || issue < 1) errors.push(`manifest item ${index} has invalid issue_number`);
    if (seenIssues.has(issue)) errors.push(`manifest contains duplicate Issue #${issue}`);
    seenIssues.add(issue);
    if (typeof item?.transition_id !== 'string' || !item.transition_id) errors.push(`manifest item ${index} has no transition_id`);
    if (seenTransitions.has(item?.transition_id)) errors.push(`manifest contains duplicate transition_id ${item.transition_id}`);
    seenTransitions.add(item?.transition_id);
    if (typeof item?.request_file !== 'string' || !item.request_file || path.isAbsolute(item.request_file)) errors.push(`manifest item ${index} request_file must be relative`);
  }
  return { ok: errors.length === 0, errors, digest: manifest.canonical_digest };
}

function validateRequestBinding(request, item, manifest) {
  const result = validateTransitionRequest(request);
  const errors = [...result.errors];
  if (request.repository !== REPOSITORY) errors.push('request repository is not the strict target repository');
  if (request.issue_number !== Number(item.issue_number)) errors.push('request issue_number differs from manifest item');
  if (request.transition_id !== item.transition_id) errors.push('request transition_id differs from manifest item');
  if (request.expected_source_repository_ref !== SOURCE_REF) errors.push('request source ref differs from the fixed approved ref');
  if (manifest.parent_issue !== PARENT_ISSUE) errors.push('request is not under parent #1605');
  return { ok: errors.length === 0, errors };
}

function requestFiles(manifest, manifestFile) {
  const root = path.dirname(path.resolve(manifestFile));
  const errors = [];
  const records = [];
  for (const item of manifest.items) {
    const relative = item.request_file;
    const target = path.resolve(root, relative);
    if (path.relative(root, target).startsWith(`..${path.sep}`) || path.relative(root, target) === '..') {
      errors.push(`#${item.issue_number}: request_file escapes manifest directory`);
      continue;
    }
    try {
      const marker = readRequestMarker(target);
      const binding = validateRequestBinding(marker.request, item, manifest);
      if (!binding.ok) errors.push(`#${item.issue_number}: ${binding.errors.join('; ')}`);
      records.push({ ...item, request: marker.request, request_marker_sha256: marker.digest, request_file: target });
    } catch (error) {
      errors.push(`#${item.issue_number}: ${error.message}`);
    }
  }
  return { records, errors };
}

function findMarker(body, marker) {
  const re = new RegExp(`<!--\\s*${marker}\\s*([\\s\\S]*?)-->`, 'g');
  return [...String(body || '').matchAll(re)].map((match) => {
    try { return JSON.parse(match[1].trim()); } catch (_) { return null; }
  }).filter(Boolean);
}

function authorizationDigest(proof) { return sha256Text(canonical(without(proof, 'proof_sha256'))); }

function validateAuthorization(proof, manifestDigestValue, planDigestValue, comments = []) {
  const errors = [];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, errors: ['authorization proof must be an object'] };
  if (proof.schema_version !== AUTHORIZATION_SCHEMA) errors.push(`authorization schema must be ${AUTHORIZATION_SCHEMA}`);
  if (proof.repository !== REPOSITORY) errors.push('authorization repository mismatch');
  if (proof.parent_issue !== PARENT_ISSUE) errors.push('authorization parent must be #1605');
  if (proof.action !== 'authorize-full-boundary-transition') errors.push('authorization action is not full-boundary transition');
  if (proof.allow_live_github !== true) errors.push('authorization must explicitly allow live GitHub transition');
  if (proof.manifest_digest !== manifestDigestValue) errors.push('authorization manifest digest mismatch');
  if (proof.plan_digest !== planDigestValue) errors.push('authorization plan digest mismatch');
  if (!Number.isSafeInteger(proof.max_mutations) || proof.max_mutations < 1) errors.push('authorization max_mutations must be a positive integer');
  if (!Number.isSafeInteger(proof.comment_id) || proof.comment_id < 1) errors.push('authorization comment_id must be positive');
  if (typeof proof.authorized_by !== 'string' || !proof.authorized_by.trim()) errors.push('authorization authorized_by is required');
  if (!HEX64.test(String(proof.proof_sha256 || '')) || authorizationDigest(proof) !== proof.proof_sha256) errors.push('authorization proof_sha256 is invalid');
  const matches = [];
  for (const comment of comments) {
    if (Number(comment && comment.id) !== proof.comment_id) continue;
    const values = findMarker(comment.body, AUTHORIZATION_MARKER);
    matches.push(...values.map((value) => ({ comment, value })));
  }
  if (matches.length !== 1) errors.push(`parent #${PARENT_ISSUE} must contain exactly one matching authorization marker; found ${matches.length}`);
  else if (!same(matches[0].value, proof)) errors.push('live parent authorization marker differs from local proof');
  return { ok: errors.length === 0, errors, comment: matches[0] && matches[0].comment };
}

function stripBoundary(body) {
  let value = String(body || '');
  const machine = /<!--\s*source-note-record\s*\n[\s\S]*?\n-->/g;
  const readable = /## 边界审核\n[\s\S]*?(?=\n## 来源限制)/g;
  const machineMatches = value.match(machine) || [];
  const readableMatches = value.match(readable) || [];
  if (machineMatches.length !== 1 || readableMatches.length !== 1) return null;
  value = value.replace(machine, '<SOURCE-NOTE-RECORD-BOUNDARY>');
  return value.replace(readable, '<READABLE-BOUNDARY>');
}

function assertBoundaryOnly(beforeBody, afterBody, beforeLabels, afterLabels, decision) {
  const errors = [];
  if (stripBoundary(beforeBody) === null || stripBoundary(afterBody) === null) errors.push('body boundary blocks are not uniquely addressable');
  else if (stripBoundary(beforeBody) !== stripBoundary(afterBody)) errors.push('PATCH body changes content outside SourceNote machine/readable boundary');
  const beforeRecord = parseSourceNoteIssue(beforeBody).record;
  const afterRecord = parseSourceNoteIssue(afterBody).record;
  if (!beforeRecord || !afterRecord) errors.push('boundary-only audit cannot parse SourceNote records');
  else if (!same(without(beforeRecord, 'boundary_review'), without(afterRecord, 'boundary_review'))) errors.push('PATCH machine record changes fields outside boundary_review');
  const before = new Set(beforeLabels);
  const after = new Set(afterLabels);
  const beforeStable = [...before].filter((label) => !label.startsWith('boundary:') && label !== 'task:boundary-review').sort();
  const afterStable = [...after].filter((label) => !label.startsWith('boundary:') && label !== 'task:boundary-review').sort();
  if (!same(beforeStable, afterStable)) errors.push('PATCH changes a non-boundary label');
  if (!before.has('boundary:pending') || before.has(`boundary:${decision}`)) errors.push('PATCH precondition must have boundary:pending');
  if (after.has('boundary:pending') || !after.has(`boundary:${decision}`)) errors.push(`PATCH must set boundary:${decision} and remove boundary:pending`);
  if (after.has('task:boundary-review')) errors.push('PATCH must remove task:boundary-review after a completed boundary review');
  const boundaryAfter = [...after].filter((label) => label.startsWith('boundary:'));
  if (boundaryAfter.length !== 1) errors.push('PATCH must leave exactly one boundary:* label');
  return { ok: errors.length === 0, errors };
}

function validateReceipt(receipt, request, plan, manifestDigestValue, planDigestValue) {
  const errors = [];
  if (!receipt || receipt.schema_version !== 'source-note-boundary-review-applied.v1') errors.push('receipt schema mismatch');
  if (receipt?.transition_id !== request.transition_id) errors.push('receipt transition_id mismatch');
  if (receipt?.repository !== REPOSITORY || receipt?.parent_issue !== PARENT_ISSUE) errors.push('receipt repository/parent binding mismatch');
  if (receipt?.issue_number !== request.issue_number || receipt?.source_note_id !== request.source_note_id) errors.push('receipt SourceNote identity mismatch');
  if (receipt?.decision !== request.decision || receipt?.reviewed_at !== request.reviewed_at) errors.push('receipt decision/reviewed_at mismatch');
  if (receipt?.manifest_digest !== manifestDigestValue || receipt?.plan_digest !== planDigestValue) errors.push('receipt manifest/plan digest mismatch');
  if (receipt?.expected_source_revision_id !== request.expected_source_revision_id) errors.push('receipt SourceRevision binding mismatch');
  if (receipt?.expected_source_repository_ref !== request.expected_source_repository_ref) errors.push('receipt source repository ref binding mismatch');
  if (receipt?.previous_body_sha256 !== request.expected_body_sha256 || receipt?.new_body_sha256 !== (plan.already_applied ? plan.current_body_sha256 : plan.next_body_sha256)) errors.push('receipt body CAS digest mismatch');
  if (!same(receipt?.interview_note_ids, plan.interview_note_ids)) errors.push('receipt InterviewNote ids mismatch');
  if (request.decision === 'multi-interview' && !same(receipt?.interview_note_cases || [], plan.interview_note_cases || [])) errors.push('receipt interview case mapping mismatch');
  if (!isTimestamp(receipt?.applied_at)) errors.push('receipt applied_at must be a timestamp');
  return { ok: errors.length === 0, errors };
}

function isTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }

function planItem(record, live) {
  const request = record.request;
  const comments = live.comments;
  const evidenceComments = comments.filter((comment) => Number(comment && comment.id) === request.review_evidence.comment_id);
  if (evidenceComments.length !== 1) return { ok: false, errors: [`review evidence comment ${request.review_evidence.comment_id} must occur exactly once on #${request.issue_number}`], request, comments };
  const receiptsResult = parseAppliedBoundaryReviewReceipts(comments);
  if (receiptsResult.errors.length) return { ok: false, errors: receiptsResult.errors, request, comments };
  const planned = planSourceNoteBoundaryReviewTransition(request, live.issue, {
    evidenceComment: evidenceComments[0],
    receipts: receiptsResult.receipts,
  });
  const errors = [...(planned.errors || [])];
  if (!planned.already_applied && planned.ok) {
    errors.push(...assertBoundaryOnly(live.issue.body, planned.next_body, labelsOf(live.issue), planned.next_labels, request.decision).errors);
    if (!validateSourceNoteIssue({ body: planned.next_body, labels: planned.next_labels, state: 'open' }).ok) errors.push('planned SourceNote fails validator');
  }
  const matchingReceipts = receiptsResult.receipts.filter((candidate) => candidate.transition_id === request.transition_id);
  if (matchingReceipts.length > 1) errors.push(`multiple applied receipts found for transition ${request.transition_id}; refusing to choose one`);
  const receipt = matchingReceipts[0] || null;
  if (receipt && planned.ok && record.plan_digest && !validateReceipt(receipt, request, planned, record.manifest_digest, record.plan_digest).ok) errors.push('existing applied receipt is not bound to this request/plan');
  return {
    ...planned,
    ok: errors.length === 0,
    errors,
    manifest_digest: record.manifest_digest,
    plan_digest: record.plan_digest,
    request_marker_sha256: record.request_marker_sha256,
    evidence_comment_id: request.review_evidence.comment_id,
    existing_receipt: receipt,
    status: errors.length ? 'blocked' : planned.already_applied ? (receipt ? 'already-applied' : 'receipt-needed') : 'ready',
  };
}

function itemDigest(item) {
  return sha256Text(canonical({
    issue_number: item.issue_number,
    transition_id: item.transition_id,
    source_note_id: item.source_note_id,
    decision: item.decision,
    request_marker_sha256: item.request_marker_sha256,
    expected_body_sha256: item.expected_body_sha256,
    expected_source_revision_id: item.expected_source_revision_id,
    next_body_sha256: item.next_body_sha256,
    next_labels: item.next_labels,
    interview_note_ids: item.interview_note_ids,
  }));
}

function blockedPlanItem(record, error) {
  const request = record.request || {};
  const item = {
    issue_number: Number(record.issue_number),
    transition_id: record.transition_id,
    source_note_id: request.source_note_id || null,
    decision: request.decision || null,
    expected_body_sha256: request.expected_body_sha256 || null,
    expected_source_revision_id: request.expected_source_revision_id || null,
    request_marker_sha256: record.request_marker_sha256 || null,
    current_body_sha256: null,
    next_body_sha256: null,
    next_body: null,
    current_labels: [],
    next_labels: null,
    interview_note_ids: [],
    interview_note_cases: [],
    existing_receipt: null,
    status: 'blocked',
    errors: [error],
  };
  item.item_digest = itemDigest(item);
  return item;
}

function appendBlockedItemErrors(errors, item) {
  const before = item.errors.length;
  if (item.status === 'blocked' && before === 0) item.errors.push('item is blocked without a reported error');
  if (!item.decision) item.errors.push('item has no decision; refusing to plan the batch');
  if (item.status === 'blocked' || item.errors.length > 0) item.status = 'blocked';
  if (item.errors.length) errors.push(`#${item.issue_number}: ${item.errors.join('; ')}`);
}

function buildPlan({ manifest, manifestFile, records, liveLoader }) {
  const errors = [];
  const items = [];
  for (const record of records) {
    let live;
    try { live = liveLoader(record.request); }
    catch (error) {
      const item = blockedPlanItem(record, `live read failed: ${error.message}`);
      items.push(item);
      appendBlockedItemErrors(errors, item);
      continue;
    }
    // A manifest's plan_digest is an upstream evidence-plan digest, not this
    // transition plan's canonical digest.  Never let it validate an existing
    // applied receipt during the first planning pass; that check happens once
    // this function has computed planDigestValue below.
    const planned = planItem({ ...record, manifest_digest: manifest.canonical_digest, plan_digest: null }, live);
    const item = {
      issue_number: Number(record.issue_number), transition_id: record.transition_id,
      source_note_id: record.request.source_note_id, decision: record.request.decision,
      expected_body_sha256: record.request.expected_body_sha256,
      expected_source_revision_id: record.request.expected_source_revision_id,
      request_marker_sha256: record.request_marker_sha256,
      current_body_sha256: planned.current_body_sha256 || bodySha256(live.issue),
      next_body_sha256: planned.next_body_sha256 || null,
      next_body: planned.next_body || null,
      current_labels: planned.current_labels || labelsOf(live.issue),
      next_labels: planned.next_labels || null,
      interview_note_ids: planned.interview_note_ids || [],
      interview_note_cases: planned.interview_note_cases || [],
      existing_receipt: planned.existing_receipt || null,
      status: planned.status || 'blocked', errors: planned.errors || [],
    };
    item.item_digest = itemDigest(item);
    appendBlockedItemErrors(errors, item);
    items.push(item);
  }
  const content = {
    schema_version: PLAN_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    manifest: { path: path.relative(process.cwd(), path.resolve(manifestFile)), digest: manifest.canonical_digest, plan_digest: manifest.plan_digest, item_count: manifest.items.length },
    mutation_count: 0, errors, items,
  };
  // The confirmation digest binds immutable requests and their intended
  // targets.  Mutable observation fields (pending/already-applied status,
  // current body digest, and existing receipt) are still checked live, but do
  // not make a safe idempotent resume require a new operator authorization.
  const digestContent = {
    ...content,
    errors: [],
    items: items.map((item) => ({
      issue_number: item.issue_number, transition_id: item.transition_id,
      source_note_id: item.source_note_id, decision: item.decision,
      expected_body_sha256: item.expected_body_sha256,
      expected_source_revision_id: item.expected_source_revision_id,
      request_marker_sha256: item.request_marker_sha256,
      next_body_sha256: item.next_body_sha256, next_labels: item.next_labels,
      interview_note_ids: item.interview_note_ids, interview_note_cases: item.interview_note_cases,
    })),
  };
  const planDigestValue = sha256Text(canonical(digestContent));
  for (const item of items) {
    if (!item.existing_receipt || item.errors.length) continue;
    const receiptPlan = {
      already_applied: item.status === 'already-applied',
      current_body_sha256: item.current_body_sha256,
      next_body_sha256: item.next_body_sha256,
      interview_note_ids: item.interview_note_ids,
      interview_note_cases: item.interview_note_cases || [],
    };
    const record = records.find((candidate) => Number(candidate.issue_number) === Number(item.issue_number));
    const validation = validateReceipt(item.existing_receipt, record.request, receiptPlan, manifest.canonical_digest, planDigestValue);
    if (!validation.ok) {
      item.errors.push(...validation.errors);
      errors.push(`#${item.issue_number}: existing applied receipt is not bound to this request/plan: ${validation.errors.join('; ')}`);
      item.status = 'blocked';
    }
  }
  return { ...content, ok: errors.length === 0, canonical_digest: planDigestValue };
}

function initialJournal(plan) {
  const content = {
    schema_version: JOURNAL_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE,
    manifest_digest: plan.manifest.digest, plan_digest: plan.canonical_digest,
    status: 'running', mutation_count: 0, items: plan.items.map((item) => ({
      issue_number: item.issue_number, transition_id: item.transition_id, item_digest: item.item_digest,
      phase: 'pending', mutation_count: 0, possibly_performed: false,
    })),
  };
  return { ...content, canonical_digest: sha256Text(canonical(content)) };
}

function validateJournal(journal, plan, maxMutations = null) {
  const errors = [];
  if (!journal || journal.schema_version !== JOURNAL_SCHEMA) errors.push('journal schema mismatch');
  if (journal?.manifest_digest !== plan.manifest.digest || journal?.plan_digest !== plan.canonical_digest) errors.push('journal belongs to another manifest/plan');
  if (!HEX64.test(String(journal?.canonical_digest || '')) || sha256Text(canonical(without(journal, 'canonical_digest'))) !== journal?.canonical_digest) errors.push('journal canonical_digest is invalid');
  if (!Number.isSafeInteger(journal?.mutation_count) || journal.mutation_count < 0) errors.push('journal mutation_count must be a safe non-negative integer');
  if (maxMutations != null && (!Number.isSafeInteger(maxMutations) || maxMutations < 1)) errors.push('journal validation requires a positive mutation ceiling');
  if (maxMutations != null && Number.isSafeInteger(journal?.mutation_count) && journal.mutation_count > maxMutations) errors.push('journal mutation_count exceeds max mutation ceiling');
  const expected = new Map(plan.items.map((item) => [item.issue_number, item]));
  const seen = new Set();
  let itemMutationTotal = 0;
  for (const item of journal?.items || []) {
    if (!expected.has(Number(item.issue_number))) errors.push(`journal contains unknown Issue #${item.issue_number}`);
    if (seen.has(Number(item.issue_number))) errors.push(`journal duplicates Issue #${item.issue_number}`);
    seen.add(Number(item.issue_number));
    if (expected.has(Number(item.issue_number)) && item.item_digest !== expected.get(Number(item.issue_number)).item_digest) errors.push(`journal item digest drifted for #${item.issue_number}`);
    if (!['pending', 'patch-pending', 'patched', 'receipt-pending', 'complete', 'uncertain'].includes(item.phase)) errors.push(`journal phase invalid for #${item.issue_number}`);
    if (!Number.isSafeInteger(item.mutation_count) || item.mutation_count < 0) errors.push(`journal mutation_count for #${item.issue_number} must be a safe non-negative integer`);
    else itemMutationTotal += item.mutation_count;
    if (typeof item.possibly_performed !== 'boolean') errors.push(`journal possibly_performed for #${item.issue_number} must be boolean`);
  }
  if (Number.isSafeInteger(journal?.mutation_count) && itemMutationTotal !== journal.mutation_count) errors.push('journal mutation_count must equal the sum of item mutation_count values');
  return { ok: errors.length === 0, errors };
}

function atomicWriteJson(file, value) {
  const target = path.resolve(file); fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directoryFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function acquireExclusiveLock(file) {
  const target = path.resolve(file); fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = { schema_version: LOCK_SCHEMA, lock_id: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), acquired_at: new Date().toISOString() };
  const parent = path.dirname(target);
  let fd;
  let inode;
  try {
    fd = fs.openSync(target, 'wx', 0o600);
    inode = fs.fstatSync(fd);
    lock.device = inode.dev;
    lock.inode = inode.ino;
    lock.dev = inode.dev;
    lock.ino = inode.ino;
    fs.writeFileSync(fd, `${JSON.stringify(lock)}\n`, 'utf8');
    fs.fsyncSync(fd);
  }
  catch (error) { throw new Error(`exclusive transition lock is held or unavailable: ${error.message}`); }
  finally { if (fd != null) fs.closeSync(fd); }
  const fsyncParent = () => {
    const directoryFd = fs.openSync(parent, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  };
  fsyncParent();
  const assertHeld = () => {
    let current;
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { throw new Error(`exclusive transition lock disappeared: ${error.message}`); }
    let currentStat;
    try { currentStat = fs.lstatSync(target); } catch (error) { throw new Error(`exclusive transition lock disappeared: ${error.message}`); }
    if (!currentStat.isFile() || currentStat.isSymbolicLink() || !current || current.lock_id !== lock.lock_id || current.device !== lock.device || current.inode !== lock.inode || current.dev !== lock.dev || current.ino !== lock.ino || currentStat.dev !== lock.device || currentStat.ino !== lock.inode) throw new Error('exclusive transition lock ownership or inode changed');
  };
  return { assertHeld, release() { assertHeld(); fs.unlinkSync(target); fsyncParent(); } };
}

function buildReceipt(request, planned, manifestDigestValue, planDigestValue, now = new Date().toISOString()) {
  return {
    ...buildAppliedReceipt(request, planned, now), parent_issue: PARENT_ISSUE,
    manifest_digest: manifestDigestValue, plan_digest: planDigestValue,
    expected_source_revision_id: request.expected_source_revision_id,
    expected_source_repository_ref: request.expected_source_repository_ref,
  };
}

function receiptMatchesComment(comment, expected) {
  const parsed = parseAppliedBoundaryReviewReceipts([comment]);
  return parsed.errors.length === 0 && parsed.receipts.length === 1 && same(parsed.receipts[0], { ...expected, comment_id: comment.id });
}

function applyBatch({ plan, records, liveLoader, patchIssue, postReceipt, readComments, sleep = () => {}, now = () => new Date().toISOString(), reconcileAttempts = DEFAULT_RECONCILE_ATTEMPTS, maxMutations, journalFile, lock, readJournal, writeJournal }) {
  if (!plan.ok) return { ok: false, errors: ['plan contains fail-closed errors'], plan, mutation_count: 0 };
  if (!Number.isInteger(maxMutations) || maxMutations < 1) throw new Error('apply requires a positive --max-mutations ceiling');
  if (!lock || typeof lock.assertHeld !== 'function') throw new Error('apply requires an exclusive lock');
  if (typeof writeJournal !== 'function') throw new Error('apply requires a durable journal writer');
  let journal = readJournal ? readJournal() : null;
  if (!journal) journal = initialJournal(plan);
  const journalValidation = validateJournal(journal, plan, maxMutations);
  if (!journalValidation.ok) throw new Error(`journal validation failed: ${journalValidation.errors.join('; ')}`);
  const byIssue = new Map(journal.items.map((item) => [Number(item.issue_number), item]));
  const byRecord = new Map(records.map((record) => [Number(record.issue_number), record]));
  let mutationCount = Number(journal.mutation_count || 0);
  const persist = () => {
    lock.assertHeld();
    journal.mutation_count = mutationCount; journal.items = [...byIssue.values()].sort((a, b) => a.issue_number - b.issue_number);
    journal.canonical_digest = sha256Text(canonical(without(journal, 'canonical_digest')));
    const validation = validateJournal(journal, plan, maxMutations);
    if (!validation.ok) throw new Error(`journal validation failed before durable write: ${validation.errors.join('; ')}`);
    writeJournal(journal);
  };
  const reconcileTarget = (record, expected) => {
    let lastError = null;
    for (let attempt = 1; attempt <= reconcileAttempts; attempt += 1) {
      lock.assertHeld();
      try {
        const live = liveLoader(record.request);
        const post = planItem({ ...record, manifest_digest: plan.manifest.digest, plan_digest: plan.canonical_digest }, live);
        if (post.ok && post.already_applied && post.current_body_sha256 === expected.next_body_sha256 && same(post.next_labels, expected.next_labels)) return { live, planned: post };
        lastError = new Error(`target did not converge to planned boundary state for #${record.issue_number}`);
      } catch (error) { lastError = error; }
      if (attempt < reconcileAttempts) sleep(attempt);
    }
    throw lastError || new Error('bounded target reconcile failed');
  };
  const reconcileReceipt = (record, expectedReceipt) => {
    let lastError = null;
    for (let attempt = 1; attempt <= reconcileAttempts; attempt += 1) {
      lock.assertHeld();
      try {
        const comments = readComments(record.request.issue_number);
        const matches = comments.filter((comment) => receiptMatchesComment(comment, expectedReceipt));
        if (matches.length === 1) return matches[0];
        lastError = new Error(`applied receipt reconcile found ${matches.length} exact comments`);
      } catch (error) { lastError = error; }
      if (attempt < reconcileAttempts) sleep(attempt);
    }
    throw lastError || new Error('bounded receipt reconcile failed');
  };
  for (const item of plan.items) {
    const state = byIssue.get(item.issue_number);
    const record = byRecord.get(item.issue_number);
    if (!state || !record) throw new Error(`#${item.issue_number}: journal/request ownership missing`);
    if (state.phase === 'complete') {
      lock.assertHeld();
      const resumed = planItem({ ...record, manifest_digest: plan.manifest.digest, plan_digest: plan.canonical_digest }, liveLoader(record.request));
      if (!resumed.ok || resumed.status !== 'already-applied' || resumed.current_body_sha256 !== item.next_body_sha256 || !same(resumed.next_labels, item.next_labels)) throw new Error(`#${item.issue_number}: complete journal item failed read-only target/receipt verification`);
      continue;
    }
    if (state.phase === 'uncertain') throw new Error(`#${item.issue_number}: journal is uncertain; refusing blind retry`);
    if (state.phase === 'patch-pending' || state.phase === 'receipt-pending') {
      throw new Error(`#${item.issue_number}: journal contains an in-flight mutation phase; refusing blind retry`);
    }
    lock.assertHeld();
    const fresh = planItem({ ...record, manifest_digest: plan.manifest.digest, plan_digest: plan.canonical_digest }, liveLoader(record.request));
    if (!fresh.ok) throw new Error(`#${item.issue_number}: fresh live CAS failed: ${fresh.errors.join('; ')}`);
    const compatibleStatus = fresh.status === item.status
      || (item.status === 'ready' && ['receipt-needed', 'already-applied'].includes(fresh.status))
      || (item.status === 'receipt-needed' && fresh.status === 'already-applied');
    if (!compatibleStatus) throw new Error(`#${item.issue_number}: live status drifted from confirmed plan`);
    if (fresh.next_body_sha256 !== item.next_body_sha256 || !same(fresh.next_labels, item.next_labels)) throw new Error(`#${item.issue_number}: live target body/label drifted from confirmed plan`);
    if (fresh.status === 'ready' && (fresh.current_body_sha256 !== item.current_body_sha256 || !same(fresh.current_labels, item.current_labels))) throw new Error(`#${item.issue_number}: live precondition body/label CAS drifted from confirmed plan`);
    const needsPatch = fresh.status === 'ready';
    const needsReceipt = needsPatch || fresh.status === 'receipt-needed';
    const required = (needsPatch ? 1 : 0) + (needsReceipt ? 1 : 0);
    if (mutationCount + required > maxMutations) { journal.status = 'partial'; persist(); break; }
    if (needsPatch) {
      state.phase = 'patch-pending'; persist();
      const payload = { body: fresh.next_body, labels: fresh.next_labels };
      try { lock.assertHeld(); patchIssue(record.request.issue_number, payload); mutationCount += 1; state.mutation_count += 1; }
      catch (error) {
        mutationCount += 1; state.mutation_count += 1; state.possibly_performed = true; state.error = `PATCH response unknown: ${error.message}`; persist();
        try { reconcileTarget(record, fresh); }
        catch (reconcileError) { state.phase = 'uncertain'; state.error += `; reconcile failed: ${reconcileError.message}`; persist(); throw new Error(`#${item.issue_number}: PATCH response unknown; refusing retry`); }
        state.phase = 'receipt-pending'; state.possibly_performed = false; persist();
      }
      try { reconcileTarget(record, fresh); }
      catch (error) { state.phase = 'uncertain'; state.possibly_performed = true; state.error = `post-PATCH validation/reconcile failed: ${error.message}`; persist(); throw new Error(`#${item.issue_number}: PATCH did not pass post-write validator/CAS`); }
      state.phase = 'receipt-pending'; persist();
    }
    if (needsReceipt) {
      const expectedReceipt = buildReceipt(record.request, fresh, plan.manifest.digest, plan.canonical_digest, now());
      state.phase = 'receipt-pending'; persist();
      let response;
      try { lock.assertHeld(); response = postReceipt(record.request.issue_number, renderAppliedReceiptComment(expectedReceipt)); mutationCount += 1; state.mutation_count += 1; }
      catch (error) {
        mutationCount += 1; state.mutation_count += 1; state.possibly_performed = true; state.error = `POST response unknown: ${error.message}`; persist();
        try { response = reconcileReceipt(record, expectedReceipt); }
        catch (reconcileError) { state.phase = 'uncertain'; state.error += `; reconcile failed: ${reconcileError.message}`; persist(); throw new Error(`#${item.issue_number}: applied receipt POST response unknown; refusing retry`); }
        state.possibly_performed = false; state.error = null;
      }
      let receiptComment = response;
      if (!receiptComment || !Number.isSafeInteger(Number(receiptComment.id)) || !receiptMatchesComment(receiptComment, expectedReceipt)) {
        try { receiptComment = reconcileReceipt(record, expectedReceipt); }
        catch (error) { state.phase = 'uncertain'; state.possibly_performed = true; state.error = `POST returned an untrusted response: ${error.message}`; persist(); throw new Error(`#${item.issue_number}: applied receipt response unknown; refusing retry`); }
      }
      state.phase = 'complete'; state.receipt_comment_id = Number(receiptComment.id); state.possibly_performed = false; state.error = null; persist();
    } else { state.phase = 'complete'; persist(); }
  }
  journal.status = journal.items.every((item) => item.phase === 'complete') ? 'complete' : journal.items.some((item) => item.phase === 'uncertain') ? 'uncertain' : 'partial';
  persist();
  return { ok: journal.status === 'complete', errors: [], plan, journal, mutation_count: mutationCount };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, PARENT_ISSUE, MANIFEST_SCHEMA, PLAN_SCHEMA,
  FULL_MANIFEST_ITEM_COUNT, FULL_MANIFEST_PLAN_DIGEST, FULL_MANIFEST_CANONICAL_DIGEST,
  AUTHORIZATION_SCHEMA, JOURNAL_SCHEMA, AUTHORIZATION_MARKER, sha256Text, canonical,
  manifestDigest, validateManifest, readRequestMarker, validateRequestBinding, requestFiles,
  validateAuthorization, stripBoundary, assertBoundaryOnly, validateReceipt, planItem,
  itemDigest, buildPlan, initialJournal, validateJournal, atomicWriteJson, acquireExclusiveLock,
  buildReceipt, renderAppliedReceiptComment, receiptMatchesComment, applyBatch, readRegularJson,
};
