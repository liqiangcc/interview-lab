'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const packetSet = require('../data/pilot/issue-1539/source-review-packets.json');
const pinnedManifest = require('../data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json');
const {
  BATCH_SCHEMA_VERSION,
  BATCH_ID,
  PACKET_SET_SHA256,
  PINNED_ARTIFACT_MANIFEST_SHA256,
  ISSUE_NUMBERS,
  initialProgress,
  validateProgress,
  issueSnapshot,
  lifecycleOperationPlan,
  applyLifecycleOperation,
  applyBatch,
  labelPendingIntent,
} = require('../scripts/lib/issue-1539-source-review-transition-batch');
const { requestSha256 } = require('../scripts/lib/interview-note-source-review-transition');
const { canonicalJson, sha256Text } = require('../scripts/lib/issue-1539-recovery-plan');
const {
  LEGACY_PLAN_SHA256,
  livePrefixSha256,
  validateLegacyPlanArtifact,
  recoverLegacyUncertain,
} = require('../scripts/lib/issue-1539-legacy-uncertain-recovery');
const { main: legacyMain } = require('../scripts/recover-issue-1539-legacy-uncertain');

function requests() {
  return packetSet.packets.map((packet) => ({
    ...packet.candidate_request,
    reviewed_at: '2026-09-05T00:00:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: {
      repository: packet.candidate_request.repository,
      issue_number: packet.candidate_request.issue_number,
      comment_id: 5547000000 + packet.candidate_request.issue_number,
    },
  }));
}
function replaceLifecycle(labels, status, task) {
  return [...new Set(labels.filter((label) => !label.startsWith('status:') && !['task:source-review', 'task:source-recovery'].includes(label)).concat([`status:${status}`, ...(task ? [task] : [])]))].sort();
}
function syntheticPlan(reqs) {
  const items = reqs.map((request) => {
    const beforeLabels = ['source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'];
    const issue = { number: request.issue_number, body: `interview-${request.issue_number}`, labels: beforeLabels, state: 'open' };
    return {
      issue_number: request.issue_number,
      source_note_issue_number: request.source_note_issue_number,
      transition_id: request.transition_id,
      request_sha256: requestSha256(request),
      action: 'begin-source-review-then-final',
      current_status: 'blocked',
      live_snapshot: issueSnapshot(issue),
      begin_labels: replaceLifecycle(beforeLabels, 'source-review', 'task:source-review'),
      final_labels: replaceLifecycle(beforeLabels, 'source-ready', null),
      receipt_mutation: 'receipt-after-transition',
      already_applied: false,
      needs_receipt_repair: false,
      needs_begin: true,
      pending_phase: null,
      pending_operation_index: null,
      pending_intent_sha256: null,
    };
  });
  const base = {
    schema_version: BATCH_SCHEMA_VERSION,
    batch_id: BATCH_ID,
    repository: 'liqiangcc/interview-lab',
    packet_set_sha256: PACKET_SET_SHA256,
    pinned_artifact_manifest_sha256: PINNED_ARTIFACT_MANIFEST_SHA256,
    total: 30,
    errors: [],
    items,
  };
  return { ...base, plan_sha256: sha256Text(canonicalJson(base)), mode: 'plan', mutation_attempted: false, mutation_performed: false, possibly_performed: false };
}
function legacyProgress(reqs) {
  const progress = initialProgress(reqs);
  progress.status = 'failed';
  progress.mutation_attempted = true;
  progress.mutation_performed = null;
  progress.possibly_performed = true;
  const item = progress.items['1509'];
  item.phase = 'uncertain';
  item.possibly_performed = true;
  item.intent = { ...item.intent, phase: 'uncertain', attempted_phase: 'begin-pending', error: 'legacy visibility timeout' };
  item.result = { status: 'uncertain', phase: 'begin-pending', mutation_attempted: true, mutation_performed: null, possibly_performed: true };
  return progress;
}
function legacyLive(plan, reqs, labels = null, receipts = []) {
  const request = reqs[0];
  return {
    interviewIssue: { number: 1509, body: 'interview-1509', state: 'open', labels: labels || ['source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note', 'status:source-review'] },
    receipts,
  };
}
function writeRequestSet(directory, reqs) {
  fs.mkdirSync(directory, { recursive: true });
  for (const request of reqs) {
    const marker = `<!-- interview-note-source-review-transition\n${JSON.stringify(request, null, 2)}\n-->\n`;
    fs.writeFileSync(path.join(directory, `issue-${request.issue_number}.json`), `${JSON.stringify(request, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, `issue-${request.issue_number}.md`), marker);
  }
}
function runQuiet(fn) {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = originalWrite; }
}

test('label convergence polling tolerates delayed GitHub visibility without repeating a sub-operation', () => {
  const reqs = requests();
  const state = new Map(ISSUE_NUMBERS.map((issue) => [issue, { labels: ['source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'], receipt: false }]));
  const patches = [];
  const sleeps = [];
  let staleReads = 0;
  let now = 0;
  const loadLive = (request) => {
    const item = state.get(request.issue_number);
    let labels = [...item.labels];
    if (request.issue_number === 1509 && patches.length > 0 && staleReads < 3) {
      labels = ['source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'];
      staleReads += 1;
    }
    return {
      interviewIssue: { number: request.issue_number, body: `interview-${request.issue_number}`, state: 'open', labels },
      sourceIssue: { number: request.source_note_issue_number, body: 'source', labels: [] },
      evidenceComment: { id: request.review_evidence.comment_id, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.issue_number}` },
      receipts: item.receipt ? [{ comment_id: 1 }] : [],
      allIssues: [],
    };
  };
  const planTransition = (request, issue, options) => {
    const status = issue.labels.find((label) => label.startsWith('status:')).slice(7);
    return { ok: true, errors: [], current_status: status, begin_labels: replaceLifecycle(issue.labels, 'source-review', 'task:source-review'), final_labels: replaceLifecycle(issue.labels, 'source-ready', null), already_applied: status === 'source-ready' && state.get(request.issue_number).receipt, needs_receipt_repair: status === 'source-ready' && !state.get(request.issue_number).receipt, needs_begin: status === 'blocked' };
  };
  const patchLabels = (request, labels, snapshot, operation) => {
    patches.push({ issue: request.issue_number, operation });
    const item = state.get(request.issue_number);
    item.labels = operation.kind === 'add' ? [...new Set([...item.labels, operation.label])].sort() : item.labels.filter((label) => label !== operation.label).sort();
  };
  const posts = [];
  const progress = initialProgress(reqs);
  const result = applyBatch(reqs, pinnedManifest, progress, {
    loadLive,
    planTransition,
    patchLabels,
    postReceipt(request) { posts.push(request.issue_number); state.get(request.issue_number).receipt = true; return { id: 9000 + request.issue_number }; },
    persistProgress() {},
    clock: () => now,
    sleep(ms) { sleeps.push(ms); now += ms; },
    labelConvergenceMaxAttempts: 4,
    labelConvergenceTimeoutMs: 1000,
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
  const operations = patches.filter((patch) => patch.issue === 1509).map((patch) => `${patch.operation.kind}:${patch.operation.label}`);
  assert.equal(new Set(operations).size, operations.length);
  assert.equal(staleReads, 3);
  assert.deepEqual(sleeps.slice(0, 2), [100, 200]);
  assert.equal(posts.filter((issue) => issue === 1509).length, 1);
});

test('exhausted label polling marks uncertain while preserving the complete prior pending sub-intent', () => {
  const reqs = requests();
  const state = new Map(ISSUE_NUMBERS.map((issue) => [issue, { labels: ['source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'] }]));
  const patches = [];
  const loadLive = (request) => ({ interviewIssue: { number: request.issue_number, body: `interview-${request.issue_number}`, state: 'open', labels: [...state.get(request.issue_number).labels] }, sourceIssue: { number: request.source_note_issue_number, body: 'source', labels: [] }, evidenceComment: { id: request.review_evidence.comment_id }, receipts: [], allIssues: [] });
  const planTransition = (request, issue) => ({ ok: true, errors: [], current_status: issue.labels.find((label) => label.startsWith('status:')).slice(7), begin_labels: replaceLifecycle(issue.labels, 'source-review', 'task:source-review'), final_labels: replaceLifecycle(issue.labels, 'source-ready', null), already_applied: false, needs_receipt_repair: false, needs_begin: true });
  const patchLabels = (request, labels, snapshot, operation) => { patches.push(operation); };
  const progress = initialProgress(reqs);
  let now = 0;
  const result = applyBatch(reqs, pinnedManifest, progress, { loadLive, planTransition, patchLabels, postReceipt() { throw new Error('must not post'); }, persistProgress() {}, clock: () => now, sleep(ms) { now += ms; }, labelConvergenceMaxAttempts: 2, labelConvergenceTimeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(progress.items['1509'].phase, 'uncertain');
  assert.equal(progress.items['1509'].intent.prior_pending_sub_intent.stage, 'begin');
  assert.deepEqual(progress.items['1509'].intent.prior_pending_sub_intent.operation, { kind: 'add', label: 'status:source-review' });
  assert.equal(patches.length, 1);
});

test('legacy uncertain recovery accepts only the bound #1509 legal prefix and produces local pending progress', () => {
  const reqs = requests();
  const plan = syntheticPlan(reqs);
  const progress = legacyProgress(reqs);
  const result = recoverLegacyUncertain({ plan, progress, requests: reqs, live: legacyLive(plan, reqs), receipts: [], expectedPlanSha256: plan.plan_sha256 });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.prefix_index, 1);
  assert.deepEqual(result.next_operation, { kind: 'add', label: 'task:source-review' });
  assert.equal(result.recovery_progress.items['1509'].phase, 'begin-pending');
  assert.equal(result.recovery_progress.items['1509'].intent.operation_index, 1);
  assert.equal(result.recovery_progress.items['1509'].intent.legacy_plan_sha256, plan.plan_sha256);
  assert.equal(result.recovery_progress.items['1509'].intent.live_prefix_sha256, result.live_prefix_sha256);
  assert.equal(validateProgress(result.recovery_progress, reqs).ok, true);
});

test('legacy uncertain recovery rejects wrong issue, digest, prefix, receipt, and non-planned peer', () => {
  const reqs = requests();
  const plan = syntheticPlan(reqs);
  const progress = legacyProgress(reqs);
  const wrongIssue = recoverLegacyUncertain({ plan, progress, requests: reqs, live: { interviewIssue: { number: 1510, body: 'interview-1509', state: 'open', labels: ['source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'] }, receipts: [] }, receipts: [] });
  assert.equal(wrongIssue.ok, false);
  const wrongDigestPlan = { ...plan, plan_sha256: '0'.repeat(64) };
  assert.equal(recoverLegacyUncertain({ plan: wrongDigestPlan, progress, requests: reqs, live: legacyLive(plan, reqs), receipts: [], expectedPlanSha256: plan.plan_sha256 }).ok, false);
  const wrongPrefix = recoverLegacyUncertain({ plan, progress, requests: reqs, live: legacyLive(plan, reqs, ['source:xhs', 'status:source-review', 'task:source-recovery', 'type:interview-note']), receipts: [], expectedPlanSha256: plan.plan_sha256 });
  assert.equal(wrongPrefix.ok, false);
  assert.match(wrongPrefix.errors.join('\n'), /original plan prefix/);
  assert.equal(recoverLegacyUncertain({ plan, progress, requests: reqs, live: legacyLive(plan, reqs), receipts: [{ comment_id: 1 }], expectedPlanSha256: plan.plan_sha256 }).ok, false);
  const peer = legacyProgress(reqs);
  peer.items['1510'].phase = 'begin-pending';
  assert.equal(recoverLegacyUncertain({ plan, progress: peer, requests: reqs, live: legacyLive(plan, reqs), receipts: [], expectedPlanSha256: plan.plan_sha256 }).ok, false);
});

test('legacy recovery CLI plan is read-only and apply writes only the local progress after live-prefix confirmation', () => {
  const reqs = requests();
  const plan = syntheticPlan(reqs);
  const progress = legacyProgress(reqs);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-legacy-recovery-'));
  const requestDir = path.join(directory, 'requests');
  const planPath = path.join(directory, 'plan.json');
  const progressPath = path.join(directory, 'progress.json');
  const lockPath = path.join(directory, 'progress.lock');
  const manifestPath = path.resolve('data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json');
  try {
    writeRequestSet(requestDir, reqs);
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    fs.writeFileSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
    const live = legacyLive(plan, reqs);
    const args = (apply, digest = null) => [
      '--request-dir', requestDir, '--plan', planPath, '--progress', progressPath,
      '--progress-lock', lockPath, '--pinned-artifact-manifest', manifestPath,
      ...(digest ? ['--confirm-live-prefix-sha256', digest] : []), ...(apply ? ['--apply'] : []),
    ];
    let writes = 0;
    assert.equal(runQuiet(() => legacyMain(args(false), { expectedPlanSha256: plan.plan_sha256, loadLive: () => live, persistProgress: () => { writes += 1; } })), 0);
    assert.equal(writes, 0);
    assert.equal(JSON.parse(fs.readFileSync(progressPath, 'utf8')).items['1509'].phase, 'uncertain');
    const digest = livePrefixSha256(live.interviewIssue);
    assert.equal(runQuiet(() => legacyMain(args(true, digest), { expectedPlanSha256: plan.plan_sha256, loadLive: () => live, persistProgress: (value) => { writes += 1; assert.equal(value.items['1509'].phase, 'begin-pending'); } })), 0);
    assert.equal(writes, 1);
    assert.equal(fs.existsSync(lockPath), false);
    assert.throws(() => runQuiet(() => legacyMain(args(true, '0'.repeat(64)), { expectedPlanSha256: plan.plan_sha256, loadLive: () => live, persistProgress: () => { throw new Error('must not write'); } })), /live-prefix confirmation mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
