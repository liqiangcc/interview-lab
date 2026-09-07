'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TARGETS,
  BATCH_ID,
  inspectEvidence,
  replaceControlled,
  operations,
  validateRequests,
  validateEvidencePlan,
  evidencePlanSha256,
  preservesNonLifecycle,
  transitionReceipt,
  transitionReceiptBody,
  matchingTransitionReceipt,
  initialProgress,
  validateProgress,
  applyBatch,
} = require('../scripts/lib/issue-1577-source-review-transition-batch');
const { requestSha256 } = require('../scripts/lib/interview-note-source-review-transition');

const PACKET = 'p'.repeat(64);
const EVIDENCE_AUTH = 'e'.repeat(64);
const AUTH = 'a'.repeat(64);
const PLAN = 'b'.repeat(64);

function requests() {
  return TARGETS.map((issue) => ({
    schema_version: 'interview-note-source-review-transition.v1',
    transition_id: `issue-1577-source-review-${issue}`,
    repository: 'liqiangcc/interview-lab',
    issue_number: issue,
    interview_note_id: `xhs:test-${issue}`,
    expected_interview_body_sha256: 'i'.repeat(64),
    expected_initial_status: 'captured',
    expected_source_revision_id: `xhs-note:test-${issue}:revision`,
    source_note_issue_number: issue - 1400,
    expected_source_note_body_sha256: 's'.repeat(64),
    expected_source_repository_ref: '9'.repeat(40),
    provenance_mode: 'pinned-source-artifact',
    provenance_statement: 'pinned-source-artifact; raw-lineage-unproven',
    pinned_artifact_manifest_sha256: 'm'.repeat(64),
    decision: 'source-ready',
    limitations: ['test limitation'],
    checks: [
      { check_id: 'source_identity', result: 'pass' },
      { check_id: 'source_revision_binding', result: 'pass' },
      { check_id: 'artifact_reference_integrity', result: 'pass' },
      { check_id: 'raw_projection_traceability', result: 'fail' },
      { check_id: 'source_artifact_provenance', result: 'pass' },
      { check_id: 'known_limitations_recorded', result: 'pass' },
      { check_id: 'duplicate_ownership', result: 'pass' },
      { check_id: 'no_fabrication', result: 'pass' },
    ],
    evidence_subject_sha256: 'h'.repeat(64),
    reviewed_at: '2026-09-07T00:00:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: issue, comment_id: issue + 100000 },
  }));
}

function evidencePlan() {
  return {
    ok: true,
    mode: 'plan',
    preflight_ok: true,
    issue_number: 1577,
    fixed_item_count: 17,
    packet_set_sha256: PACKET,
    authorization_sha256: EVIDENCE_AUTH,
    pinned_artifact_manifest_sha256: 'm'.repeat(64),
    pinnedArtifactManifest: { items: [], digest: 'm'.repeat(64) },
    items: TARGETS.map((issue) => ({ interview_issue_number: issue, action: 'already-present', evidence_marker_count: 1, evidence_gate: { ok: true, exact: true }, evidence_comment_id: issue + 100000 })),
  };
}

function applyFixture() {
  const reqs = requests();
  const ep = evidencePlan();
  const plan = { ok: true, mode: 'plan', plan_sha256: PLAN, authorization_sha256: AUTH, packet_set_sha256: PACKET, items: reqs.map((request) => ({ issue_number: request.issue_number, request_sha256: requestSha256(request), live_snapshot: { number: request.issue_number, body_sha256: 'x'.repeat(64), labels: ['learning:keep', 'source:xhs', 'type:interview-note', 'status:captured'], state: 'open' } })) };
  const progress = initialProgress(plan);
  const states = new Map(reqs.map((request) => [request.issue_number, { labels: ['source:xhs', 'type:interview-note', 'learning:keep', 'status:captured'], receipt: null, nextComment: 700000 + request.issue_number }]));
  const calls = { labels: [], receipts: [], localWrites: 0, waits: [] };
  const controls = { strictIntermediate: false, reconcileReadFailure: false };
  const liveLoader = (request) => {
    if (controls.reconcileReadFailure) throw new Error('bounded reconcile GET exhausted');
    const state = states.get(request.issue_number);
    return { interviewIssue: { number: request.issue_number, body: 'unchanged', state: 'open', labels: [...state.labels] }, sourceIssue: { number: request.source_note_issue_number, body: 'unchanged', state: 'open', labels: [] }, comments: [], allIssues: [{ number: request.issue_number, body: `<!-- interview-note: id=${request.interview_note_id} schema=interview-note-issue.v2 -->` }], sourceComments: [] };
  };
  const validateLive = (request, live) => {
    const state = states.get(request.issue_number);
    const labels = [...live.interviewIssue.labels];
    if (controls.strictIntermediate && labels.filter((label) => label.startsWith('status:')).length > 1) return { ok: false, errors: ['intermediate double status is not a settled live state'] };
    const current = labels.find((label) => label.startsWith('status:')).slice(7);
    return { ok: true, current_status: current, live_snapshot: { number: request.issue_number, body_sha256: 'x'.repeat(64), labels, state: 'open' }, begin_labels: replaceControlled(labels, 'source-review', 'task:source-review'), final_labels: replaceControlled(labels, 'source-ready'), evidence: { marker_count: 1, exact: true, comment: { id: request.review_evidence.comment_id, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.issue_number}` } }, transition_receipt: state.receipt };
  };
  const planFn = () => plan;
  return { reqs, ep, plan, progress, states, calls, controls, liveLoader, validateLive, planFn };
}

function run(fixture, extra = {}) {
  return applyBatch({ requests: fixture.reqs, evidencePlan: fixture.ep, pinnedArtifactManifest: fixture.ep.pinnedArtifactManifest, liveLoader: fixture.liveLoader, progress: fixture.progress, expectedPlanSha256: PLAN, expectedAuthorizationSha256: AUTH }, {
    lock: { assertHeld() {} }, planBatch: fixture.planFn, validateLive: fixture.validateLive,
    persistProgress: () => {}, patchLabel: (request, operation) => { fixture.calls.labels.push({ issue: request.issue_number, operation }); if (extra.ambiguousLabelPatch && !extra.ambiguous) { extra.ambiguous = true; throw new Error('label PATCH response was ambiguous'); } const state = fixture.states.get(request.issue_number); if (operation.kind === 'add') state.labels.push(operation.label); else state.labels = state.labels.filter((label) => label !== operation.label); if (extra.reconcileReadFailure && !extra.reconcileFailureSet) { extra.reconcileFailureSet = true; fixture.controls.reconcileReadFailure = true; } },
    postReceipt: (request, receipt) => { fixture.calls.receipts.push(request.issue_number); const state = fixture.states.get(request.issue_number); if (extra.receiptAbsent) throw new Error('receipt response lost and receipt absent'); state.receipt = { comment_id: state.nextComment++, request_sha256: requestSha256(request), final_status: 'source-ready', applied_at: receipt.applied_at }; if (extra.responseLoss) throw new Error('response lost'); return { id: state.receipt.comment_id }; },
    readReceipt: (request) => fixture.states.get(request.issue_number).localReceipt || null,
    writeReceipt: (request, receipt) => { fixture.calls.localWrites += 1; if (extra.localReceiptFailure && !extra.localFailed) { extra.localFailed = true; throw new Error('local receipt write failed'); } fixture.states.get(request.issue_number).localReceipt = receipt; },
    beforeMutation: extra.beforeMutation || (() => {}), afterLabelReconcile: extra.crashAfterFirstLabel && !extra.crashed ? () => { extra.crashed = true; throw new Error('simulated process crash'); } : undefined, sleep: (ms) => fixture.calls.waits.push(ms), now: () => '2026-09-07T00:00:00Z',
  });
}

test('transition profile is fixed to exactly #1558, #1559, and #1562-#1576', () => {
  assert.deepEqual(TARGETS, [1558, 1559, ...Array.from({ length: 15 }, (_, i) => 1562 + i)]);
  const invalid = requests().slice(0, 16);
  assert.equal(validateRequests(invalid, evidencePlan()).ok, false);
  assert.equal(BATCH_ID, 'issue-1577-source-review-transition-001');
});

test('evidence plan requires successful exact already-present evidence for all 17 items', () => {
  const plan = evidencePlan();
  assert.equal(validateEvidencePlan(plan).ok, false, 'synthetic manifest is intentionally not a production manifest');
  plan.pinnedArtifactManifest = undefined;
  assert.match(validateEvidencePlan(plan).errors.join('\n'), /pinned artifact manifest/);
});

test('evidence plan digest is reproducible and content-bound', () => {
  const plan = evidencePlan();
  plan.plan_sha256 = evidencePlanSha256(plan);
  assert.equal(plan.plan_sha256, evidencePlanSha256(plan));
  const swapped = { ...plan, items: [...plan.items].reverse() };
  assert.notEqual(swapped.plan_sha256, evidencePlanSha256(swapped));
  assert.equal(validateEvidencePlan({ ...plan, items: swapped.items }).ok, false);
});

test('non-lifecycle baseline is exact, rejecting additions as well as removals', () => {
  const baseline = ['learning:keep', 'source:xhs', 'type:interview-note'];
  assert.equal(preservesNonLifecycle(['status:captured', ...baseline], baseline), true);
  assert.equal(preservesNonLifecycle(['status:captured', ...baseline, 'learning:drift'], baseline), false);
  assert.equal(preservesNonLifecycle(['status:captured', 'learning:keep'], baseline), false);
});

test('evidence marker inspection rejects missing, duplicate, and hash-conflicting evidence', () => {
  const request = requests()[0];
  const marker = { schema_version: 'interview-note-source-review-evidence.v1', repository: request.repository, issue_number: request.issue_number, interview_note_id: request.interview_note_id, source_note_issue_number: request.source_note_issue_number, source_revision_id: request.expected_source_revision_id, transition_id: request.transition_id, evidence_subject_sha256: request.evidence_subject_sha256, expected_interview_body_sha256: request.expected_interview_body_sha256, expected_source_note_body_sha256: request.expected_source_note_body_sha256, provenance_mode: request.provenance_mode, provenance_statement: request.provenance_statement, pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256, decision: request.decision, packet_set_sha256: PACKET, checks: request.checks };
  const body = `<!-- interview-note-source-review-evidence.v1\n${JSON.stringify(marker)}\n-->`;
  const comment = { id: request.review_evidence.comment_id, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body };
  assert.equal(inspectEvidence([comment], request, PACKET, comment.id).exact, true);
  assert.equal(inspectEvidence([], request, PACKET, comment.id).ok, false);
  assert.equal(inspectEvidence([comment, comment], request, PACKET, comment.id).ok, false);
  marker.evidence_subject_sha256 = '0'.repeat(64);
  assert.equal(inspectEvidence([{ ...comment, body: `<!-- interview-note-source-review-evidence.v1\n${JSON.stringify(marker)}\n-->` }], request, PACKET, comment.id).ok, false);
});

test('remote transition receipts bind every request field and the live comment id', () => {
  const request = { ...requests()[0], expected_interview_body_sha256: 'a'.repeat(64), expected_source_note_body_sha256: 'b'.repeat(64), pinned_artifact_manifest_sha256: 'c'.repeat(64), evidence_subject_sha256: 'd'.repeat(64) };
  const receipt = transitionReceipt(request, 812345, '2026-09-07T00:01:00Z');
  const comment = { id: 812345, body: transitionReceiptBody(receipt) };
  const matching = matchingTransitionReceipt([comment], request);
  assert.deepEqual(matching.receipts, [receipt], matching.errors.join('; '));
  for (const field of ['schema_version', 'transition_id', 'request_sha256', 'repository', 'issue_number', 'interview_note_id', 'case_key', 'source_note_issue_number', 'source_note_body_sha256', 'interview_body_sha256', 'source_revision_id', 'manifest_sha256', 'source_repository_ref', 'decision', 'final_status', 'provenance_mode', 'provenance_statement', 'pinned_artifact_manifest_sha256', 'evidence_subject_sha256', 'reviewed_at', 'applied_at']) {
    const changed = { ...receipt, [field]: field === 'issue_number' ? receipt[field] + 1 : field === 'applied_at' ? 'not-a-timestamp' : `wrong-${field}` };
    const result = matchingTransitionReceipt([{ id: 812345, body: transitionReceiptBody(changed) }], request);
    assert.equal(result.receipts.length, 0, `receipt field ${field} must be bound`);
    assert.ok(result.errors.length, `receipt field ${field} mismatch must fail closed`);
  }
  const wrongCommentId = { ...receipt, comment_id: 999999 };
  const idResult = matchingTransitionReceipt([{ id: 812345, body: transitionReceiptBody(wrongCommentId) }], request);
  assert.deepEqual(idResult.receipts.map((value) => value.comment_id), [812345]);
});

test('apply performs two controlled label phases, preserves non-lifecycle labels, and writes one receipt per target', () => {
  const fixture = applyFixture();
  const result = run(fixture);
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(fixture.calls.labels.length, 102);
  assert.equal(fixture.calls.receipts.length, 17);
  assert.equal(fixture.calls.localWrites.length || fixture.calls.localWrites, 17);
  assert.equal(fixture.progress.label_attempt_count, 102);
  assert.equal(fixture.progress.receipt_attempt_count, 17);
  assert.equal(fixture.progress.mutation_count, 119);
  assert.equal(fixture.progress.status, 'complete');
  for (const state of fixture.states.values()) assert.deepEqual(state.labels.sort(), ['learning:keep', 'source:xhs', 'status:source-ready', 'type:interview-note']);
  assert.equal(validateProgress(fixture.progress, fixture.plan).ok, true);
});

test('receipt response loss is recovered by exact read without a second POST', () => {
  const fixture = applyFixture();
  const result = run(fixture, { responseLoss: true });
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(fixture.calls.receipts.length, 17);
  assert.equal(fixture.progress.possibly_performed, false);
});

test('absent receipt after a POST stays possibly and refuses blind resend on resume', () => {
  const fixture = applyFixture();
  const first = run(fixture, { receiptAbsent: true });
  assert.equal(first.ok, false);
  assert.equal(fixture.calls.receipts.length, 1);
  assert.equal(fixture.progress.possibly_performed, true);
  assert.equal(fixture.progress.intents['issue-1577-source-review-1558'].phase, 'receipt-uncertain');
  const second = run(fixture);
  assert.equal(second.ok, false);
  assert.match(second.errors.join('\n'), /refusing duplicate POST/);
  assert.equal(fixture.calls.receipts.length, 1);
  assert.equal(fixture.progress.possibly_performed, true);
});

test('label write convergence is resumable after crash before operation index advance', () => {
  const fixture = applyFixture();
  fixture.controls.strictIntermediate = true;
  const first = run(fixture, { crashAfterFirstLabel: true });
  assert.equal(first.ok, false);
  assert.equal(fixture.calls.labels.length, 1);
  assert.equal(fixture.progress.possibly_performed, true);
  const second = run(fixture);
  assert.equal(second.ok, true, second.errors && second.errors.join('; '));
  assert.deepEqual(fixture.calls.labels.filter((call) => call.issue === 1558).map((call) => `${call.operation.kind}:${call.operation.label}`), ['add:status:source-review', 'add:task:source-review', 'remove:status:captured', 'add:status:source-ready', 'remove:status:source-review', 'remove:task:source-review']);
  assert.equal(fixture.calls.labels.length, 102, 'resume must skip the already-applied first label operation');
  assert.equal(fixture.calls.receipts.length, 17);
});

test('uncertain label PATCH is permanently fail-closed on resume', () => {
  const fixture = applyFixture();
  const first = run(fixture, { ambiguousLabelPatch: true });
  assert.equal(first.ok, false);
  assert.equal(fixture.calls.labels.length, 1);
  assert.equal(fixture.calls.receipts.length, 0);
  const uncertain = fixture.progress.intents['issue-1577-source-review-1558'];
  assert.equal(uncertain.phase, 'uncertain');
  assert.equal(uncertain.attempted_phase, 'begin-pending');
  assert.match(uncertain.error, /ambiguous/);
  assert.ok(Array.isArray(uncertain.operation_plan));
  assert.deepEqual(uncertain.operation_prefix, []);
  assert.equal(uncertain.operation_index, 0);
  assert.ok(uncertain.cas && uncertain.cas.number === 1558);
  assert.equal(validateProgress(fixture.progress, fixture.plan).ok, false);
  const second = run(fixture);
  assert.equal(second.ok, false);
  assert.match(second.errors.join('\n'), /permanently uncertain|explicit replan/);
  assert.equal(fixture.calls.labels.length, 1, 'resume must not retry a label PATCH');
  assert.equal(fixture.calls.receipts.length, 0, 'resume must not reach receipt mutation');
  assert.equal(fixture.progress.intents['issue-1577-source-review-1558'].phase, 'uncertain');
  assert.equal(fixture.progress.possibly_performed, true);
});

test('reconcile GET exhaustion after a mutating label PATCH persists uncertainty and blocks resume', () => {
  const fixture = applyFixture();
  const first = run(fixture, { reconcileReadFailure: true });
  assert.equal(first.ok, false);
  assert.equal(fixture.calls.labels.length, 1);
  assert.equal(fixture.calls.receipts.length, 0);
  const uncertain = fixture.progress.intents['issue-1577-source-review-1558'];
  assert.equal(uncertain.phase, 'uncertain');
  assert.equal(uncertain.attempted_phase, 'begin-pending');
  assert.match(uncertain.error, /bounded reconcile GET exhausted/);
  assert.equal(uncertain.operation_index, 0);
  assert.equal(uncertain.operation_prefix.length, 0);
  assert.equal(uncertain.operation_plan.length, 3);
  assert.equal(uncertain.cas.number, 1558);
  assert.equal(fixture.progress.possibly_performed, true);
  const labelsAfterFirst = [...fixture.states.get(1558).labels];
  const second = run(fixture);
  assert.equal(second.ok, false);
  assert.match(second.errors.join('\n'), /permanently uncertain|explicit replan/);
  assert.equal(fixture.calls.labels.length, 1);
  assert.equal(fixture.calls.receipts.length, 0);
  assert.deepEqual(fixture.states.get(1558).labels, labelsAfterFirst);
  assert.equal(fixture.progress.intents['issue-1577-source-review-1558'].phase, 'uncertain');
});

test('non-lifecycle drift fails closed after a lifecycle write', () => {
  const fixture = applyFixture();
  const result = run(fixture, { beforeMutation: () => fixture.states.get(1558).labels.push('learning:drift') });
  assert.equal(result.ok, false);
  assert.equal(fixture.calls.labels.length, 1);
  assert.equal(fixture.progress.possibly_performed, true);
});

test('fresh preflight non-lifecycle baseline blocks drift before the first label write', () => {
  const fixture = applyFixture();
  fixture.planFn = () => {
    fixture.states.get(1558).labels.push('learning:drift');
    return fixture.plan;
  };
  const result = run(fixture);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /changed non-lifecycle labels/);
  assert.equal(fixture.calls.labels.length, 0);
  assert.equal(fixture.progress.label_attempt_count, 0);
});

test('fresh transition plan digest drift blocks apply before any mutation', () => {
  const fixture = applyFixture();
  fixture.planFn = () => ({ ...fixture.plan, plan_sha256: 'c'.repeat(64) });
  const result = run(fixture);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /fresh transition plan digest mismatch/);
  assert.equal(fixture.calls.labels.length, 0);
  assert.equal(fixture.calls.receipts.length, 0);
});

test('local receipt loss is repaired from exact remote receipt without a second POST', () => {
  const fixture = applyFixture();
  const first = run(fixture, { localReceiptFailure: true });
  assert.equal(first.ok, false);
  assert.equal(fixture.calls.receipts.length, 1);
  assert.equal(fixture.progress.possibly_performed, true);
  const second = run(fixture);
  assert.equal(second.ok, true, second.errors && second.errors.join('; '));
  assert.equal(fixture.calls.receipts.filter((issue) => issue === 1558).length, 1, 'resume must never repost an uncertain receipt');
  assert.equal(fixture.calls.receipts.length, 17);
  assert.equal(fixture.calls.localWrites, 18, 'the failed local write is recorded, then all 17 exact receipts are durable');
});

test('resume and idempotence skip already source-ready targets and never rewrite labels or receipts', () => {
  const fixture = applyFixture();
  assert.equal(run(fixture).ok, true);
  const before = { labels: fixture.calls.labels.length, receipts: fixture.calls.receipts.length, local: fixture.calls.localWrites };
  const result = run(fixture);
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.deepEqual({ labels: fixture.calls.labels.length, receipts: fixture.calls.receipts.length, local: fixture.calls.localWrites }, before);
});

test('label drift and lost lock fail closed before another lifecycle mutation', () => {
  const fixture = applyFixture();
  fixture.validateLive = (request, live) => request.issue_number === 1558 ? { ok: false, errors: ['controlled label CAS drift'], current_status: 'captured', live_snapshot: null, evidence: { marker_count: 1, exact: true } } : { ok: false, errors: ['stop'], current_status: 'captured', live_snapshot: null, evidence: { marker_count: 1, exact: true } };
  const result = run(fixture);
  assert.equal(result.ok, false);
  assert.equal(fixture.calls.labels.length, 0);
  const lockFixture = applyFixture();
  let asserts = 0;
  const lock = { assertHeld() { asserts += 1; if (asserts > 4) throw new Error('lock lost'); } };
  assert.throws(() => applyBatch({ requests: lockFixture.reqs, evidencePlan: lockFixture.ep, pinnedArtifactManifest: lockFixture.ep.pinnedArtifactManifest, liveLoader: lockFixture.liveLoader, progress: lockFixture.progress, expectedPlanSha256: PLAN, expectedAuthorizationSha256: AUTH }, { lock, planBatch: lockFixture.planFn, validateLive: lockFixture.validateLive, persistProgress: () => {}, patchLabel: () => {}, postReceipt: () => ({}), readReceipt: () => null, writeReceipt: () => {} }), /lock lost/);
});

test('progress intent and complete result bindings reject tampering', () => {
  const pendingFixture = applyFixture();
  assert.equal(run(pendingFixture, { crashAfterFirstLabel: true }).ok, false);
  pendingFixture.progress.intents['issue-1577-source-review-1558'].issue_number = 1559;
  assert.equal(validateProgress(pendingFixture.progress, pendingFixture.plan).ok, false);
  const completeFixture = applyFixture();
  assert.equal(run(completeFixture).ok, true);
  completeFixture.progress.results['issue-1577-source-review-1558'].request_sha256 = 'd'.repeat(64);
  assert.equal(validateProgress(completeFixture.progress, completeFixture.plan).ok, false);
});
