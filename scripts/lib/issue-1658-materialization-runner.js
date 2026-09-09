'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalDigest,
} = require('./aggregate-downstream-pipeline');
const {
  canonicalJson,
  requestSha256,
  sha256Text,
  parseMaterializationReceipts,
  planMaterialization,
  findOwnershipMatches,
} = require('./source-note-interview-materialization');
const {
  validateLiveManifestBindings,
  validateBoundaryManifest,
  liveSourceSnapshotDigest,
  LIVE_BOUNDARY_REPORT_SCHEMA,
  LIVE_BOUNDARY_MANIFEST_SCHEMA,
} = require('./issue-1605-materialization-plan');
const {
  validateInterviewNoteIssue,
} = require('./interview-note-issue');
const { issueSourceRecord } = require('./interview-note-materialization-batch');
const {
  childInterviewNoteId,
} = require('./interview-note-identity');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1611;
const CONTROLLER_ISSUE = 1658;
const BOUNDARY_PARENT_ISSUE = 1605;
const RUNNER_SCHEMA = 'issue-1658-interview-note-materialization-runner.v1';
const AUTH_SCHEMA = 'issue-1658-interview-note-materialization-authorization.v1';
const JOURNAL_SCHEMA = 'issue-1658-interview-note-materialization-journal.v1';
const INTENT_SCHEMA = 'issue-1658-interview-note-materialization-intent.v1';
const LOCK_SCHEMA = 'issue-1658-interview-note-materialization-lock.v1';
const RECEIPT_MARKER = 'source-note-interview-materialized';
const AUTH_MARKER = 'issue-1658-interview-note-materialization-authorization';
const HEX64 = /^[0-9a-f]{64}$/;
const ZERO_WRITES = Object.freeze({ patch: 0, post: 0, create: 0, label: 0, interview_note: 0 });
const ALLOWED_PLAN_ACTIONS = new Set(['skip-not-interview', 'already-materialized', 'would-materialize']);
const MUTATION_ACTIONS = new Set(['would-materialize']);

function without(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter((label) => typeof label === 'string' && label.trim()))].sort();
}

function digestWithout(value, field) {
  return canonicalDigest(without(value, field));
}

function exactDigest(value, field) {
  return HEX64.test(String(value && value[field] || '')) && digestWithout(value, field) === value[field];
}

function validateFreshArtifacts({ sourceSnapshot, boundaryReport, boundaryManifest, ownershipInventory, materializationPlan }) {
  const errors = [];
  if (!sourceSnapshot || sourceSnapshot.schema_version !== 'issue-1611-live-source-note-snapshot.v1') errors.push('fresh source snapshot schema mismatch');
  if (sourceSnapshot && (sourceSnapshot.repository !== REPOSITORY || sourceSnapshot.source_repository !== SOURCE_REPOSITORY || sourceSnapshot.source_ref !== SOURCE_REF)) errors.push('fresh source snapshot binding mismatch');
  if (!Array.isArray(sourceSnapshot && sourceSnapshot.issues) || sourceSnapshot.count !== sourceSnapshot.issues.length) errors.push('fresh source snapshot count/issues mismatch');
  if (sourceSnapshot && sourceSnapshot.count !== 1460) errors.push('fresh source snapshot must cover all 1460 SourceNotes');
  if (sourceSnapshot && sourceSnapshot.issues && sourceSnapshot.canonical_digest !== liveSourceSnapshotDigest(sourceSnapshot.issues)) errors.push('fresh source snapshot canonical digest drifted');

  if (!boundaryReport || boundaryReport.schema_version !== LIVE_BOUNDARY_REPORT_SCHEMA) errors.push('fresh live boundary report schema mismatch');
  if (boundaryReport && !exactDigest(boundaryReport, 'dry_run_sha256')) errors.push('fresh live boundary report digest drifted');
  if (boundaryReport && (boundaryReport.repository !== REPOSITORY || boundaryReport.parent_issue !== BOUNDARY_PARENT_ISSUE || boundaryReport.source_repository !== SOURCE_REPOSITORY || boundaryReport.source_ref !== SOURCE_REF)) errors.push('fresh live boundary report binding mismatch');

  const manifestValidation = validateBoundaryManifest(boundaryManifest);
  errors.push(...manifestValidation.errors.map((error) => `boundary manifest: ${error}`));
  if (boundaryManifest && !exactDigest(boundaryManifest, 'canonical_digest')) errors.push('fresh boundary manifest digest drifted');
  if (boundaryManifest && boundaryReport && sourceSnapshot) {
    const binding = validateLiveManifestBindings(
      boundaryManifest,
      [boundaryReport],
      sourceSnapshot.issues,
      { digest: sourceSnapshot.canonical_digest },
    );
    errors.push(...binding.errors.map((error) => `boundary live binding: ${error}`));
    const reportTransitions = new Map((boundaryReport.items || []).map((item) => [Number(item.issue_number), item.transition_id]));
    const manifestTransitions = new Map((boundaryManifest.items || []).map((item) => [Number(item.issue_number), item.transition_id]));
    if (reportTransitions.size !== manifestTransitions.size || [...reportTransitions].some(([number, transition]) => manifestTransitions.get(number) !== transition)) errors.push('fresh boundary manifest items do not exactly bind to the boundary report');
  }

  if (!ownershipInventory || ownershipInventory.schema_version !== 'aggregate-interview-note-ownership-inventory.v1') errors.push('fresh ownership inventory schema mismatch');
  if (ownershipInventory && (ownershipInventory.repository !== REPOSITORY || ownershipInventory.coverage !== 'all-repository-interview-note-issues' || ownershipInventory.complete !== true)) errors.push('fresh ownership inventory coverage/binding mismatch');
  if (ownershipInventory && (!Array.isArray(ownershipInventory.entries) || ownershipInventory.count !== ownershipInventory.entries.length)) errors.push('fresh ownership inventory count/entries mismatch');
  if (ownershipInventory && !exactDigest(ownershipInventory, 'canonical_digest')) errors.push('fresh ownership inventory canonical digest drifted');

  if (!materializationPlan || materializationPlan.schema_version !== 'issue-1605-interview-note-materialization-plan.v1') errors.push('fresh materialization plan schema mismatch');
  if (materializationPlan && !exactDigest(materializationPlan, 'dry_run_sha256')) errors.push('fresh materialization plan digest drifted');
  if (materializationPlan && (materializationPlan.repository !== REPOSITORY || materializationPlan.parent_issue !== BOUNDARY_PARENT_ISSUE)) errors.push('fresh materialization plan parent binding mismatch');
  if (materializationPlan && materializationPlan.mutation_performed !== false) errors.push('fresh materialization plan claims a mutation');
  if (materializationPlan && canonicalDigest(materializationPlan.write_operations || {}) !== canonicalDigest({ patch: 0, post: 0, create: 0 })) errors.push('fresh materialization plan write counters are non-zero');
  const sourceByNumber = new Map((sourceSnapshot && sourceSnapshot.issues || []).map((issue) => [Number(issue.number), issue]));
  for (const result of materializationPlan && materializationPlan.results || []) {
    if (!result.request) continue;
    const source = sourceByNumber.get(Number(result.request.source_note_issue_number));
    const parsed = source && issueSourceRecord(source).parsed;
    if (!source || !parsed) { errors.push(`materialization request source binding is missing for #${result.request.source_note_issue_number}`); continue; }
    if (result.request.source_note_id !== parsed.source_note_id || result.request.expected_source_note_body_sha256 !== sha256Text(source.body || '') || result.request.expected_source_revision_id !== parsed.source_revision.id || result.request.expected_boundary_status !== parsed.boundary_review.status) errors.push(`materialization request SourceNote CAS binding drifted for #${result.request.source_note_issue_number}`);
    if (result.request.expected_source_repository_ref !== (parsed.source_revision.source_repository_ref ?? null)) errors.push(`materialization request source ref binding drifted for #${result.request.source_note_issue_number}`);
    const expectedIdentity = result.request.case_key == null ? `${parsed.source.system}:${parsed.source.external_id}` : childInterviewNoteId(parsed.source, result.request.case_key);
    if (result.derived_interview_note_id && result.derived_interview_note_id !== expectedIdentity) errors.push(`materialization request identity binding drifted for #${result.request.source_note_issue_number}`);
  }
  return { ok: errors.length === 0, errors };
}

function resultRequestSha(result) {
  if (!result || !result.request) return null;
  return requestSha256(result.request);
}

function buildRunnerPlan({ sourceSnapshot, boundaryReport, boundaryManifest, ownershipInventory, materializationPlan, generatedAt = new Date().toISOString() }) {
  const inputValidation = validateFreshArtifacts({ sourceSnapshot, boundaryReport, boundaryManifest, ownershipInventory, materializationPlan });
  const results = (materializationPlan && materializationPlan.results || []).map((result) => {
    const copy = { ...result };
    if (copy.request) copy.request_sha256 = resultRequestSha(copy);
    return copy;
  });
  const errors = [...inputValidation.errors];
  for (const result of results) {
    if (!ALLOWED_PLAN_ACTIONS.has(result.action) && result.action !== 'blocked') errors.push(`unsupported materialization action ${result.action || 'missing'} for SourceNote #${result.source_note_issue_number}`);
    if (MUTATION_ACTIONS.has(result.action) && (!result.request || result.request_sha256 !== requestSha256(result.request))) errors.push(`request SHA mismatch for SourceNote #${result.source_note_issue_number}`);
    if (result.action === 'already-materialized' && (!result.request || result.request_sha256 !== requestSha256(result.request))) errors.push(`already-materialized reconciliation lacks a valid request SHA for SourceNote #${result.source_note_issue_number}`);
    if (result.action === 'blocked' && (!Array.isArray(result.errors) || result.errors.length === 0)) errors.push(`blocked result for SourceNote #${result.source_note_issue_number} lacks an error`);
  }
  const counts = { 'skip-not-interview': 0, 'already-materialized': 0, 'would-materialize': 0, blocked: 0 };
  for (const result of results) counts[result.action] = (counts[result.action] || 0) + 1;
  if (materializationPlan && materializationPlan.errors && materializationPlan.errors.length) errors.push(...materializationPlan.errors.map((error) => `upstream plan: ${error}`));
  if (materializationPlan && canonicalDigest(counts) !== canonicalDigest({
    'skip-not-interview': materializationPlan.counts && materializationPlan.counts['skip-not-interview'] || 0,
    'already-materialized': materializationPlan.counts && materializationPlan.counts['already-materialized'] || 0,
    'would-materialize': materializationPlan.counts && materializationPlan.counts['would-materialize'] || 0,
    blocked: materializationPlan.counts && materializationPlan.counts.blocked || 0,
  })) errors.push('runner action counts disagree with upstream plan');

  const content = {
    schema_version: RUNNER_SCHEMA,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    controller_issue: CONTROLLER_ISSUE,
    boundary_parent_issue: BOUNDARY_PARENT_ISSUE,
    mode: 'fresh-get-only-replan',
    source_snapshot: { schema_version: sourceSnapshot && sourceSnapshot.schema_version, count: sourceSnapshot && sourceSnapshot.count, digest: sourceSnapshot && sourceSnapshot.canonical_digest, source_repository: SOURCE_REPOSITORY, source_ref: SOURCE_REF },
    boundary_report: { schema_version: boundaryReport && boundaryReport.schema_version, digest: boundaryReport && boundaryReport.dry_run_sha256 },
    boundary_manifest: { schema_version: boundaryManifest && boundaryManifest.schema_version, digest: boundaryManifest && boundaryManifest.canonical_digest, boundary_report_digest: boundaryManifest && boundaryManifest.boundary_report_digest, source_snapshot_digest: boundaryManifest && boundaryManifest.source_snapshot_digest },
    ownership: { schema_version: ownershipInventory && ownershipInventory.schema_version, count: ownershipInventory && ownershipInventory.count, digest: ownershipInventory && ownershipInventory.canonical_digest },
    upstream_materialization_plan_digest: materializationPlan && materializationPlan.dry_run_sha256,
    counts,
    allowed_actions: ['skip-not-interview', 'already-materialized', 'would-materialize'],
    mutation_performed: false,
    write_operations: { ...ZERO_WRITES },
    results,
    errors,
  };
  content.ok = errors.length === 0 && counts.blocked === 0;
  content.ready_for_apply = content.ok && counts['would-materialize'] + counts['already-materialized'] > 0;
  return { ...content, plan_digest: canonicalDigest(content) };
}

function validateRunnerPlan(plan) {
  const errors = [];
  if (!plan || plan.schema_version !== RUNNER_SCHEMA) errors.push('runner plan schema mismatch');
  if (plan && (plan.repository !== REPOSITORY || plan.parent_issue !== PARENT_ISSUE || plan.controller_issue !== CONTROLLER_ISSUE || plan.boundary_parent_issue !== BOUNDARY_PARENT_ISSUE)) errors.push('runner plan issue binding mismatch');
  if (plan && !HEX64.test(String(plan.plan_digest || ''))) errors.push('runner plan digest is required');
  else if (plan && canonicalDigest(without(plan, 'plan_digest')) !== plan.plan_digest) errors.push('runner plan digest drifted');
  if (plan && plan.mutation_performed !== false) errors.push('runner plan claims a mutation');
  if (plan && canonicalDigest(plan.write_operations || {}) !== canonicalDigest(ZERO_WRITES)) errors.push('runner plan write counters are non-zero');
  if (plan && (!Array.isArray(plan.errors) || plan.errors.length > 0)) errors.push('runner plan contains top-level errors');
  if (plan && (!plan.ready_for_apply || plan.counts.blocked !== 0)) errors.push('runner plan is not apply-ready: blocked rows or errors remain');
  for (const result of plan && plan.results || []) {
    if (!ALLOWED_PLAN_ACTIONS.has(result.action) && result.action !== 'blocked') errors.push(`runner plan contains forbidden action ${result.action}`);
    if (result.action === 'would-materialize' || result.action === 'already-materialized') {
      if (!result.request || result.request_sha256 !== requestSha256(result.request)) errors.push(`runner plan request SHA mismatch for ${result.source_note_issue_number}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function markerValues(body, marker) {
  const matches = [...String(body || '').matchAll(new RegExp(`<!--\\s*${marker}\\n([\\s\\S]*?)\\n-->`, 'g'))];
  return matches.map((match) => JSON.parse(match[1].trim()));
}

function parseAuthorizationComment(comment, plan, options = {}) {
  const errors = [];
  const values = markerValues(comment && comment.body, AUTH_MARKER);
  if (values.length !== 1) errors.push(`authorization comment must contain exactly one ${AUTH_MARKER} marker`);
  const marker = values[0];
  if (!marker) return { ok: false, errors, marker: null };
  const allowed = new Set(['schema_version', 'repository', 'parent_issue', 'controller_issue', 'boundary_parent_issue', 'action', 'allow_live_github', 'comment_id', 'authorized_by', 'authorized_at', 'plan_digest', 'source_snapshot_digest', 'boundary_report_digest', 'boundary_manifest_digest', 'ownership_digest', 'max_create', 'max_receipts']);
  for (const key of Object.keys(marker)) if (!allowed.has(key)) errors.push(`authorization marker has unsupported field ${key}`);
  if (!plan || plan.ok !== true || plan.ready_for_apply !== true || plan.counts?.blocked !== 0 || !Array.isArray(plan.errors) || plan.errors.length > 0) errors.push('authorization requires an apply-ready runner plan with no blocked rows or errors');
  const expectedCommentId = Number(options.authorizationCommentId);
  if (!Number.isSafeInteger(expectedCommentId) || expectedCommentId < 1) errors.push('authorization comment_id must be explicitly supplied');
  if (Number(comment && comment.id) !== expectedCommentId || marker.comment_id !== expectedCommentId) errors.push('authorization marker/comment_id mismatch');
  if (marker.schema_version !== AUTH_SCHEMA || marker.repository !== REPOSITORY || marker.parent_issue !== PARENT_ISSUE || marker.controller_issue !== CONTROLLER_ISSUE || marker.boundary_parent_issue !== BOUNDARY_PARENT_ISSUE || marker.action !== 'materialize-interview-notes') errors.push('authorization marker binding/schema mismatch');
  if (marker.allow_live_github !== true || options.allowLiveGithub !== true) errors.push('allow_live_github=true must be present in both marker and explicit CLI authorization');
  const digestFields = ['plan_digest', 'source_snapshot_digest', 'boundary_report_digest', 'boundary_manifest_digest', 'ownership_digest'];
  const expected = { plan_digest: plan && plan.plan_digest, source_snapshot_digest: plan && plan.source_snapshot && plan.source_snapshot.digest, boundary_report_digest: plan && plan.boundary_report && plan.boundary_report.digest, boundary_manifest_digest: plan && plan.boundary_manifest && plan.boundary_manifest.digest, ownership_digest: plan && plan.ownership && plan.ownership.digest };
  for (const field of digestFields) if (marker[field] !== expected[field]) errors.push(`authorization ${field} does not match fresh runner plan`);
  const createCount = Number(plan && plan.counts && plan.counts['would-materialize'] || 0);
  if (!Number.isSafeInteger(marker.max_create) || marker.max_create !== createCount || Number(options.maxCreate) !== marker.max_create) errors.push('max_create ceiling does not exactly match the fresh would-materialize selection');
  if (!Number.isSafeInteger(marker.max_receipts) || marker.max_receipts !== createCount || Number(options.maxReceipts) !== marker.max_receipts) errors.push('max_receipts ceiling does not exactly match the fresh would-materialize selection');
  return { ok: errors.length === 0, errors, marker };
}

function receiptObject(request, plan, issueNumber, now = new Date().toISOString()) {
  return {
    schema_version: request.case_key == null ? 'source-note-interview-materialized.v1' : 'source-note-interview-materialized.v2',
    materialization_id: request.materialization_id,
    request_sha256: requestSha256(request),
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256 ?? null,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    interview_note_id: plan.interview_note_id,
    ...(request.case_key == null ? {} : { case_key: request.case_key }),
    interview_issue_number: Number(issueNumber),
    interview_issue_body_sha256: sha256Text(plan.projection.body),
    materialized_at: now,
  };
}

function receiptBody(receipt) {
  return `<!-- ${RECEIPT_MARKER}\n${JSON.stringify(receipt, null, 2)}\n-->\n\nInterviewNote materialization receipt.`;
}

function matchingReceipts(comments, expected) {
  const receipts = parseMaterializationReceipts(comments || []).filter((receipt) => receipt.materialization_id === expected.materialization_id);
  const matching = receipts.filter((receipt) => receipt.request_sha256 === expected.request_sha256 && receipt.interview_note_id === expected.interview_note_id && Number(receipt.interview_issue_number) === Number(expected.interview_issue_number));
  return { receipts, matching };
}

function reconcileReceipt(readComments, request, expected, attempts = 3) {
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = matchingReceipts(readComments(), expected);
    last = result.receipts;
    if (result.receipts.length > 1) throw new Error(`receipt reconcile found duplicate ${RECEIPT_MARKER} markers`);
    if (result.matching.length === 1) return result.matching[0];
    if (result.receipts.length === 1) throw new Error('receipt reconcile found a conflicting machine marker');
  }
  throw new Error(`receipt response is unknown and no exact marker was observed after ${attempts} bounded GET attempts (observed ${last.length})`);
}

function reconcileOwner(readOwners, interviewNoteId, attempts = 3) {
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = readOwners(interviewNoteId);
    if (!Array.isArray(last)) throw new Error('owner reconcile response was not an array');
    if (last.length > 1) throw new Error(`owner reconcile found duplicate InterviewNote owners: ${last.map((issue) => issue.number).join(',')}`);
    if (last.length === 1) return last[0];
  }
  throw new Error(`create response is unknown and no exact owner was observed after ${attempts} bounded GET attempts`);
}

function reconcileAlreadyMaterialized({ planResult, api }) {
  if (!planResult || planResult.action !== 'already-materialized') throw new Error('only an already-materialized row can enter read-only reconciliation');
  const request = planResult.request;
  const source = api.readIssue(request.source_note_issue_number);
  const owners = api.readOwners(planResult.derived_interview_note_id);
  const receipts = parseMaterializationReceipts(api.readComments(request.source_note_issue_number));
  const checked = planMaterialization(request, { repository: REPOSITORY, sourceIssue: source, issues: owners, receipts });
  if (!checked.ok || !checked.already_materialized || checked.existing_issue_number !== Number(planResult.ownership && planResult.ownership.issue_numbers && planResult.ownership.issue_numbers[0])) throw new Error(`already-materialized reconciliation failed for ${request.materialization_id}`);
  return { materialization_id: request.materialization_id, request_sha256: requestSha256(request), interview_note_id: checked.interview_note_id, interview_issue_number: checked.existing_issue_number, action: 'already-materialized', mutation_performed: false };
}

function fsyncParent(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  fsyncParent(path.dirname(target));
}

function acquireExclusiveLock(file, planDigest) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = { schema_version: LOCK_SCHEMA, lock_id: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), plan_digest: planDigest, acquired_at: new Date().toISOString() };
  let fd;
  try {
    fd = fs.openSync(target, 'wx', 0o600);
    const stat = fs.fstatSync(fd);
    lock.device = stat.dev; lock.inode = stat.ino;
    fs.writeFileSync(fd, `${JSON.stringify(lock)}\n`, 'utf8'); fs.fsyncSync(fd);
  } catch (error) {
    throw new Error(`exclusive materialization lock is held or unavailable: ${error.message}`);
  } finally { if (fd != null) fs.closeSync(fd); }
  fsyncParent(path.dirname(target));
  const assertHeld = () => {
    let current;
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { throw new Error(`exclusive materialization lock disappeared: ${error.message}`); }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || current.lock_id !== lock.lock_id || current.device !== lock.device || current.inode !== lock.inode || stat.dev !== lock.device || stat.ino !== lock.inode) throw new Error('exclusive materialization lock ownership or inode changed');
  };
  return { assertHeld, release() { assertHeld(); fs.unlinkSync(target); fsyncParent(path.dirname(target)); } };
}

function initialIntent(request, plan, phase = 'create-pending', now = new Date().toISOString()) {
  return { schema_version: INTENT_SCHEMA, materialization_id: request.materialization_id, request_sha256: requestSha256(request), repository: request.repository, source_note_issue_number: request.source_note_issue_number, source_note_id: request.source_note_id, interview_note_id: plan.interview_note_id, case_key: request.case_key == null ? null : request.case_key, projection_body_sha256: sha256Text(plan.projection.body), phase, created_at: now, updated_at: now };
}

function initialJournal(plan, maxCreate, maxReceipts, now = new Date().toISOString()) {
  const items = (plan.results || []).filter((item) => item.action === 'would-materialize').map((item) => ({ materialization_id: item.request.materialization_id, request_sha256: item.request_sha256, phase: 'pending', mutation_attempted: false, mutation_performed: false, possibly_performed: false, mutation_count: 0 }));
  const journal = { schema_version: JOURNAL_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE, controller_issue: CONTROLLER_ISSUE, boundary_parent_issue: BOUNDARY_PARENT_ISSUE, plan_digest: plan.plan_digest, max_create: maxCreate, max_receipts: maxReceipts, create_count: 0, receipt_count: 0, mutation_count: 0, possibly_performed: false, status: 'planned', created_at: now, updated_at: now, items, intents: {} };
  return { ...journal, canonical_digest: digestWithout(journal, 'canonical_digest') };
}

function validateJournal(journal, plan, maxCreate, maxReceipts) {
  const errors = [];
  if (!journal || journal.schema_version !== JOURNAL_SCHEMA) errors.push('journal schema mismatch');
  if (journal && (journal.plan_digest !== plan.plan_digest || journal.parent_issue !== PARENT_ISSUE || journal.controller_issue !== CONTROLLER_ISSUE || journal.boundary_parent_issue !== BOUNDARY_PARENT_ISSUE)) errors.push('journal plan/controller binding mismatch');
  if (journal && (!HEX64.test(String(journal.canonical_digest || '')) || digestWithout(journal, 'canonical_digest') !== journal.canonical_digest)) errors.push('journal canonical digest drifted');
  if (journal && (journal.max_create !== maxCreate || journal.max_receipts !== maxReceipts)) errors.push('journal mutation ceilings drifted');
  if (journal && (!Number.isSafeInteger(journal.create_count) || journal.create_count < 0 || !Number.isSafeInteger(journal.receipt_count) || journal.receipt_count < 0)) errors.push('journal create/receipt counters are invalid');
  if (journal && (journal.create_count > maxCreate || journal.receipt_count > maxReceipts)) errors.push('journal create/receipt counters exceed their ceilings');
  if (journal && (!Number.isSafeInteger(journal.mutation_count) || journal.mutation_count < 0)) errors.push('journal mutation_count is invalid');
  const expected = new Map((plan.results || []).filter((item) => item.action === 'would-materialize').map((item) => [item.request.materialization_id, item.request_sha256]));
  const seen = new Set(); let sum = 0;
  for (const item of journal && journal.items || []) {
    if (!expected.has(item.materialization_id)) errors.push(`journal contains unknown materialization ${item.materialization_id}`);
    if (seen.has(item.materialization_id)) errors.push(`journal duplicates materialization ${item.materialization_id}`);
    seen.add(item.materialization_id);
    if (expected.has(item.materialization_id) && item.request_sha256 !== expected.get(item.materialization_id)) errors.push(`journal request SHA drifted for ${item.materialization_id}`);
    if (!['pending', 'create-pending', 'create-unknown', 'receipt-pending', 'complete', 'uncertain'].includes(item.phase)) errors.push(`journal phase invalid for ${item.materialization_id}`);
    if (!Number.isSafeInteger(item.mutation_count) || item.mutation_count < 0) errors.push(`journal mutation count invalid for ${item.materialization_id}`); else sum += item.mutation_count;
    if (typeof item.mutation_attempted !== 'boolean' || typeof item.mutation_performed !== 'boolean' || typeof item.possibly_performed !== 'boolean') errors.push(`journal mutation flags invalid for ${item.materialization_id}`);
  }
  if (seen.size !== expected.size) errors.push('journal does not contain exactly one item for every would-materialize row');
  if (journal && sum !== journal.mutation_count) errors.push('journal mutation_count does not equal item total');
  if (journal && journal.mutation_count !== journal.create_count + journal.receipt_count) errors.push('journal mutation_count does not equal create plus receipt counters');
  if (journal && journal.mutation_count > maxCreate + maxReceipts) errors.push('journal mutation_count exceeds create plus receipt ceiling');
  return { ok: errors.length === 0, errors };
}

function updateJournal(journal, file, lock, plan, maxCreate, maxReceipts) {
  lock.assertHeld();
  const next = { ...journal, updated_at: new Date().toISOString() };
  next.canonical_digest = digestWithout(next, 'canonical_digest');
  const validation = validateJournal(next, plan, maxCreate, maxReceipts);
  if (!validation.ok) throw new Error(`journal validation failed: ${validation.errors.join('; ')}`);
  atomicWriteJson(file, next);
  return next;
}

function buildCreateProjection(planResult) {
  if (!planResult || planResult.action !== 'would-materialize' || !planResult.request || !planResult.projection) throw new Error('only a would-materialize row can reach InterviewNote create');
  if (typeof planResult.projection.body !== 'string') throw new Error('create projection body is not available from a public plan row');
  return planResult.projection;
}

function assertNoExistingMutation(target, before, after) {
  if (before && after && sha256Text(before.body || '') !== sha256Text(after.body || '')) throw new Error(`${target} existing InterviewNote body changed; refusing existing-owner modification`);
  if (before && after && JSON.stringify(labelsOf(before)) !== JSON.stringify(labelsOf(after))) throw new Error(`${target} existing InterviewNote labels changed; refusing existing-owner modification`);
}

function applyOne({ planResult, api, journalItem, journal, journalFile, lock, maxCreate, maxReceipts, now = () => new Date().toISOString(), reconcileAttempts = 3 }) {
  const request = planResult.request;
  const expectedRequestSha = requestSha256(request);
  if (planResult.request_sha256 !== expectedRequestSha) throw new Error('row request SHA does not match request before apply');
  if (planResult.action !== 'would-materialize') throw new Error(`applyOne cannot mutate action ${planResult.action}`);
  lock.assertHeld();
  const source = api.readIssue(request.source_note_issue_number);
  const owners = api.readOwners(planResult.derived_interview_note_id || planResult.projection.interview_note_id);
  const receipts = parseMaterializationReceipts(api.readComments(request.source_note_issue_number));
  const preflight = planMaterialization(request, { repository: REPOSITORY, sourceIssue: source, issues: owners, receipts });
  if (!preflight.ok) throw new Error(`pre-write CAS failed: ${preflight.errors.join('; ')}`);
  if (preflight.action !== 'create' || preflight.ownership_count !== 0) throw new Error('pre-write CAS found an owner; no duplicate create is permitted');
  if (!preflight.projection || typeof preflight.projection.body !== 'string') throw new Error('pre-write CAS did not produce a complete create projection');
  if (planResult.projection && planResult.projection.projected_body_sha256 !== sha256Text(preflight.projection.body)) throw new Error('pre-write projection body digest differs from the fresh plan');
  if (planResult.projection && planResult.projection.projected_title !== preflight.projection.title) throw new Error('pre-write projection title differs from the fresh plan');
  const projection = preflight.projection;
  const intent = initialIntent(request, preflight);
  journal.intents[request.materialization_id] = intent;
  journalItem.phase = 'create-pending';
  if (journal.create_count >= maxCreate) throw new Error('create mutation ceiling is exhausted');
  journalItem.mutation_attempted = true; journalItem.mutation_count += 1; journal.mutation_count += 1;
  journal.create_count += 1;
  updateJournal(journal, journalFile, lock, api.plan, maxCreate, maxReceipts);
  let created;
  try {
    lock.assertHeld();
    created = api.createInterviewNote(projection);
    if (!created || !Number.isInteger(Number(created.number))) throw new Error('create POST response was not a trusted Issue object');
  } catch (error) {
    journalItem.phase = 'create-unknown'; journalItem.possibly_performed = true; journal.possibly_performed = true;
    updateJournal(journal, journalFile, lock, api.plan, maxCreate, maxReceipts);
    created = reconcileOwner(api.readOwners, projection.interview_note_id, reconcileAttempts);
  }
  if (!created || !Number.isInteger(Number(created.number))) throw new Error('create response/reconcile lacked a valid InterviewNote Issue number');
  const ownerNumber = Number(created.number);
  const owner = api.readIssue(ownerNumber);
  const ownerValidation = validateInterviewNoteIssue({ body: owner.body, labels: labelsOf(owner), state: String(owner.state || 'open').toLowerCase() });
  if (!ownerValidation.ok || sha256Text(owner.body || '') !== sha256Text(projection.body)) throw new Error('created InterviewNote failed exact body/label validation');
  const ownerMatches = api.readOwners(projection.interview_note_id);
  if (ownerMatches.length !== 1 || Number(ownerMatches[0].number) !== ownerNumber) throw new Error('created InterviewNote ownership CAS did not converge exactly once');
  const receipt = receiptObject(request, preflight, ownerNumber, now());
  journalItem.phase = 'receipt-pending'; journal.intents[request.materialization_id] = { ...intent, phase: 'receipt-pending', interview_issue_number: ownerNumber, receipt_sha256: sha256Text(receiptBody(receipt)), updated_at: now() };
  if (journal.receipt_count >= maxReceipts) throw new Error('receipt mutation ceiling is exhausted');
  journalItem.mutation_attempted = true; journalItem.mutation_count += 1; journal.mutation_count += 1;
  journal.receipt_count += 1;
  updateJournal(journal, journalFile, lock, api.plan, maxCreate, maxReceipts);
  try { lock.assertHeld(); const posted = api.addReceipt(request.source_note_issue_number, receiptBody(receipt)); if (!posted || !Number.isInteger(Number(posted.id))) throw new Error('receipt POST response was not a trusted comment object'); }
  catch (error) {
    journalItem.possibly_performed = true; journal.possibly_performed = true;
    updateJournal(journal, journalFile, lock, api.plan, maxCreate, maxReceipts);
    reconcileReceipt(() => api.readComments(request.source_note_issue_number), request, { ...receipt, request_sha256: expectedRequestSha }, reconcileAttempts);
  }
  const finalSource = api.readIssue(request.source_note_issue_number);
  const finalOwners = api.readOwners(projection.interview_note_id);
  const finalReceipts = parseMaterializationReceipts(api.readComments(request.source_note_issue_number));
  const final = planMaterialization(request, { repository: REPOSITORY, sourceIssue: finalSource, issues: finalOwners, receipts: finalReceipts });
  if (!final.ok || !final.already_materialized || final.existing_issue_number !== ownerNumber) throw new Error('final materialization CAS did not converge');
  journalItem.phase = 'complete'; journalItem.mutation_performed = true; journalItem.possibly_performed = false; journal.possibly_performed = false; journal.status = 'running';
  updateJournal(journal, journalFile, lock, api.plan, maxCreate, maxReceipts);
  return { materialization_id: request.materialization_id, request_sha256: expectedRequestSha, interview_note_id: projection.interview_note_id, interview_issue_number: ownerNumber, created: true, receipt_machine_marker: RECEIPT_MARKER, mutation_performed: true };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, PARENT_ISSUE, CONTROLLER_ISSUE, BOUNDARY_PARENT_ISSUE,
  RUNNER_SCHEMA, AUTH_SCHEMA, JOURNAL_SCHEMA, INTENT_SCHEMA, LOCK_SCHEMA, AUTH_MARKER, RECEIPT_MARKER,
  ZERO_WRITES, ALLOWED_PLAN_ACTIONS, MUTATION_ACTIONS, labelsOf, digestWithout, exactDigest,
  validateFreshArtifacts, buildRunnerPlan, validateRunnerPlan, markerValues, parseAuthorizationComment,
  receiptObject, receiptBody, matchingReceipts, reconcileReceipt, reconcileOwner, atomicWriteJson,
  acquireExclusiveLock, initialIntent, initialJournal, validateJournal, updateJournal, assertNoExistingMutation,
  buildCreateProjection, applyOne,
  reconcileAlreadyMaterialized,
};
