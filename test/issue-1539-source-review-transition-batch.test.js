'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const packetSet = require('../data/pilot/issue-1539/source-review-packets.json');
const pinnedManifest = require('../data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json');
const { acquireProgressLock } = require('../scripts/lib/issue-1539-evidence-batch');
const { main: batchMain, patchLifecycleLabels, patchLifecycleLabelOperation } = require('../scripts/apply-issue-1539-source-review-transition-batch');
const { main: singleMain, isIssue1539BlockedRecoveryRequest } = require('../scripts/plan-interview-note-source-review-transition');
const { validateInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');
const {
  ISSUE_NUMBERS,
  initialProgress,
  validateProgress,
  planBatch,
  applyBatch,
  BATCH_ID,
  PROGRESS_SCHEMA_VERSION,
  INTENT_SCHEMA_VERSION,
  PACKET_SET_SHA256,
  PINNED_ARTIFACT_MANIFEST_SHA256,
  intentFor,
  isLifecycleLabel,
  lifecycleLabels,
  lifecycleOperationPlan,
  applyLifecycleOperation,
  labelPendingIntent,
  pendingOperationAssessment,
} = require('../scripts/lib/issue-1539-source-review-transition-batch');

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

function replaceLabels(labels, status, task = null) {
  return [...new Set(labels.filter((label) => !label.startsWith('status:') && !['task:source-review', 'task:source-recovery'].includes(label)).concat([`status:${status}`, ...(task ? [task] : [])]))].sort();
}

function fixturePlan(request, interviewIssue, options) {
  const labels = (interviewIssue.labels || []).map((x) => typeof x === 'string' ? x : x.name).filter(Boolean).sort();
  const currentStatus = (labels.find((label) => label.startsWith('status:')) || '').slice('status:'.length);
  const receipt = options.receipt ? { comment_id: options.receiptCommentId } : null;
  const finalLabels = replaceLabels(labels, request.decision);
  return {
    ok: true,
    errors: [],
    request,
    current_status: currentStatus,
    begin_labels: replaceLabels(labels, 'source-review', 'task:source-review'),
    final_labels: finalLabels,
    receipt,
    already_applied: currentStatus === 'source-ready' && Boolean(receipt),
    needs_receipt_repair: currentStatus === 'source-ready' && !receipt,
    needs_begin: currentStatus === 'blocked',
  };
}

function environment(options = {}) {
  const state = new Map(ISSUE_NUMBERS.map((issue) => [issue, {
    status: options.initialStatus || 'blocked',
    labels: ['source:xhs', 'type:interview-note', `status:${options.initialStatus || 'blocked'}`, options.initialStatus === 'blocked' || !options.initialStatus ? 'task:source-recovery' : null].filter(Boolean),
    receipt: Boolean(options.initialReceipt),
  }]));
  const reads = [];
  const patches = [];
  const posts = [];
  const loadLive = (request) => {
    const item = state.get(request.issue_number);
    reads.push(request.issue_number);
    const interviewIssue = { number: request.issue_number, body: `interview-${request.issue_number}`, labels: [...item.labels], state: 'open' };
    const live = {
      interviewIssue,
      sourceIssue: { number: request.source_note_issue_number, body: `source-${request.source_note_issue_number}`, labels: [] },
      evidenceComment: { id: request.review_evidence.comment_id, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.issue_number}`, body: 'evidence' },
      receipts: item.receipt ? [{ comment_id: 900000 + request.issue_number }] : [],
      allIssues: [interviewIssue],
    };
    if (typeof options.afterRead === 'function') options.afterRead(request, reads.length, state);
    return live;
  };
  const planTransition = (request, interviewIssue, plannerOptions) => {
    const item = state.get(request.issue_number);
    return fixturePlan(request, interviewIssue, { receipt: item.receipt, receiptCommentId: 900000 + request.issue_number });
  };
  const patchLabels = (request, labels, expectedSnapshot, operation) => {
    patches.push({ issue: request.issue_number, labels: [...labels], operation: operation && { ...operation } });
    const item = state.get(request.issue_number);
    if (!operation) item.labels = [...labels];
    else if (operation.kind === 'add') item.labels = [...new Set([...item.labels, operation.label])].sort();
    else item.labels = item.labels.filter((label) => label !== operation.label).sort();
    item.status = labels.find((label) => label.startsWith('status:')).slice('status:'.length);
  };
  const postReceipt = (request, receipt) => {
    posts.push(request.issue_number);
    const item = state.get(request.issue_number);
    if (Object.prototype.hasOwnProperty.call(options, 'postReceiptResponse')) {
      if (options.postReceiptConverges !== false) item.receipt = true;
      return options.postReceiptResponse;
    }
    if (options.responseLossIssue === request.issue_number) {
      if (options.responseLossConverges !== false) item.receipt = true;
      throw new Error('receipt response lost');
    }
    item.receipt = true;
    return { id: 900000 + request.issue_number };
  };
  return { state, reads, patches, posts, loadLive, planTransition, patchLabels, postReceipt };
}

function applyOptions(env, requestsValue, progress, persist = []) {
  return {
    loadLive: env.loadLive,
    planTransition: env.planTransition,
    patchLabels: env.patchLabels,
    postReceipt: env.postReceipt,
    persistProgress: (value) => persist.push(JSON.parse(JSON.stringify(value))),
  };
}

function pendingProgress(reqs, phase, planItem, pendingIssueNumber = reqs[0].issue_number) {
  const progress = initialProgress(reqs);
  const request = reqs.find((value) => value.issue_number === pendingIssueNumber);
  const item = progress.items[String(request.issue_number)];
  item.phase = phase;
  item.intent = intentFor(request, phase, phase === 'receipt-pending'
    ? { receipt_request_sha256: requestSha256ForTest(request) }
    : (() => {
      const stage = phase === 'begin-pending' ? 'begin' : 'final';
      const desired = stage === 'begin' ? planItem.begin_labels : planItem.final_labels;
      const operations = lifecycleOperationPlan(planItem.live_snapshot.labels, desired);
      return labelPendingIntent(stage, desired, planItem.live_snapshot, operations, 0);
    })());
  progress.status = 'running';
  progress.mutation_attempted = true;
  progress.mutation_performed = null;
  progress.possibly_performed = true;
  return progress;
}

function requestSha256ForTest(request) {
  return require('../scripts/lib/interview-note-source-review-transition').requestSha256(request);
}

function requestMarker(request) {
  return `<!-- interview-note-source-review-transition\n${JSON.stringify(request, null, 2)}\n-->`;
}

function writeRequestSet(directory, reqs) {
  fs.mkdirSync(directory, { recursive: true });
  for (const request of reqs) {
    fs.writeFileSync(path.join(directory, `issue-${request.issue_number}.json`), `${JSON.stringify(request, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, `issue-${request.issue_number}.md`), `${requestMarker(request)}\n`);
  }
}

function applyWithCrashAfterPatch(reqs, pinned, env, progress, stage) {
  let crash = true;
  let durable = null;
  const loadLive = (request) => {
    const patched = env.patches.some((patch) => patch.issue === 1509 && patch.operation && patch.operation.label === `status:${stage === 'begin' ? 'source-review' : 'source-ready'}`);
    if (crash && patched) {
      crash = false;
      throw new Error(`simulated crash after ${stage} PATCH before applied journal`);
    }
    return env.loadLive(request);
  };
  const first = applyBatch(reqs, pinned, progress, {
    ...applyOptions(env, reqs, progress, []),
    loadLive,
    persistProgress: (value) => { durable = JSON.parse(JSON.stringify(value)); },
  });
  return { first, durable };
}

function applyWithCrashAfterOperation(reqs, pinned, env, progress, crashAfter) {
  let crash = true;
  let durable = null;
  const loadLive = (request) => {
    const live = env.loadLive(request);
    if (crash && request.issue_number === 1509 && env.patches.filter((patch) => patch.issue === 1509).length >= crashAfter) {
      crash = false;
      throw new Error(`simulated crash after lifecycle operation ${crashAfter}`);
    }
    return live;
  };
  const first = applyBatch(reqs, pinned, progress, {
    ...applyOptions(env, reqs, progress, []),
    loadLive,
    persistProgress: (value) => { durable = JSON.parse(JSON.stringify(value)); },
  });
  return { first, durable };
}

test('transition batch plan is fixed to all 30 requests and is mutation-free', () => {
  const reqs = requests();
  const env = environment();
  const result = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.items.length, 30);
  assert.equal(result.items.every((item) => item.action === 'begin-source-review-then-final'), true);
  assert.equal(result.items.every((item) => item.current_status === 'blocked'), true);
  assert.equal(result.items.every((item) => item.receipt_mutation === 'receipt-after-transition'), true);
  assert.deepEqual(result.items[0].begin_labels, ['source:xhs', 'status:source-review', 'task:source-review', 'type:interview-note']);
  assert.deepEqual(result.items[0].final_labels, ['source:xhs', 'status:source-ready', 'type:interview-note']);
  assert.equal(env.patches.length, 0);
  assert.equal(env.posts.length, 0);
  assert.match(result.report.plan_sha256, /^[0-9a-f]{64}$/);
});

test('batch rejects extra/missing request identities and wrong fixed digest before live reads', () => {
  const reqs = requests();
  const env = environment();
  const result = planBatch(reqs.slice(0, 29), pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /exactly 30/);
  assert.equal(env.reads.length, 0);
  const wrong = requests();
  wrong[0] = { ...wrong[0], pinned_artifact_manifest_sha256: '0'.repeat(64) };
  const wrongResult = planBatch(wrong, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  assert.equal(wrongResult.ok, false);
  assert.match(wrongResult.errors.join('\n'), /pinned artifact manifest digest mismatch/);
});

test('apply batch performs begin/final/receipt with durable phases and resumes exactly', () => {
  const reqs = requests();
  const env = environment();
  const progress = initialProgress(reqs);
  const writes = [];
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, writes));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.items.length, 30);
  assert.equal(env.patches.length, 210);
  assert.equal(env.posts.length, 30);
  assert.equal(progress.status, 'complete');
  assert.equal(Object.values(progress.items).every((item) => item.phase === 'complete'), true);
  assert.equal(writes.some((value) => Object.values(value.items).some((item) => item.phase === 'begin-pending')), true);
  assert.equal(writes.some((value) => Object.values(value.items).some((item) => item.phase === 'receipt-pending')), true);
  const reentryEnv = environment({ initialStatus: 'source-ready', initialReceipt: true });
  const reentryProgress = initialProgress(reqs);
  const reentry = applyBatch(reqs, pinnedManifest, reentryProgress, applyOptions(reentryEnv, reqs, reentryProgress, []));
  assert.equal(reentry.ok, true, reentry.errors.join('\n'));
  assert.equal(reentryEnv.patches.length, 0);
  assert.equal(reentryEnv.posts.length, 0);
});

test('begin-pending recovery advances a converged label write without repeating PATCH', () => {
  const reqs = requests();
  const env = environment();
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  env.state.get(1509).labels = replaceLabels(env.state.get(1509).labels, 'source-review', 'task:source-review');
  env.state.get(1509).status = 'source-review';
  const progress = pendingProgress(reqs, 'begin-pending', preflight.items[0]);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 3);
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).some((patch) => patch.operation.kind === 'add' && patch.operation.label === 'status:source-review'), false);
  assert.equal(progress.items['1509'].phase, 'complete');
});

test('pending recovery normalizes REST label objects and preserves string-label behavior', () => {
  const reqs = requests();
  const env = environment();
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'begin-pending', preflight.items[0]);
  const originalLabels = [...env.state.get(1509).labels];
  const firstOperation = progress.items['1509'].intent.operation_plan[0];
  const prefix = applyLifecycleOperation(lifecycleLabels(originalLabels), firstOperation);
  env.state.get(1509).labels = [...new Set([...originalLabels.filter((label) => !isLifecycleLabel(label)), ...prefix])].sort();
  env.state.get(1509).status = 'source-review';
  const stringAssessment = pendingOperationAssessment(progress.items['1509'], { labels: [...env.state.get(1509).labels] });
  assert.equal(stringAssessment.ok, true, stringAssessment.error || 'string labels were rejected');
  const originalLoadLive = env.loadLive;
  env.loadLive = (request) => {
    const live = originalLoadLive(request);
    live.interviewIssue.labels = live.interviewIssue.labels.map((name) => ({ name }));
    return live;
  };
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(progress.items['1509'].phase, 'complete');
  assert.equal(env.patches.filter((patch) => patch.issue === 1509 && patch.operation.kind === firstOperation.kind && patch.operation.label === firstOperation.label).length, 0);
});

test('pending recovery fails closed for malformed labels and lost unrelated labels', () => {
  const reqs = requests();
  const env = environment();
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'begin-pending', preflight.items[0]);
  const validLabels = [...preflight.items[0].live_snapshot.labels];
  const malformed = pendingOperationAssessment(progress.items['1509'], {
    labels: validLabels.map((name, index) => index === 0 ? { name } : { malformed: name }),
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /malformed labels/);
  const lostUncontrolled = pendingOperationAssessment(progress.items['1509'], {
    labels: validLabels.filter((label) => label !== 'source:xhs'),
  });
  assert.equal(lostUncontrolled.ok, false);
  assert.match(lostUncontrolled.error, /lost unrelated labels/);
});

test('begin-pending recovery safely retries when PATCH was not sent', () => {
  const reqs = requests();
  const env = environment();
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'begin-pending', preflight.items[0]);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 7);
});

test('final-pending recovery advances a converged label write without repeating PATCH', () => {
  const reqs = requests();
  const env = environment({ initialStatus: 'source-review' });
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  env.state.get(1509).labels = replaceLabels(env.state.get(1509).labels, 'source-ready');
  env.state.get(1509).status = 'source-ready';
  const progress = pendingProgress(reqs, 'final-pending', preflight.items[0]);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 0);
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
  assert.equal(progress.items['1509'].phase, 'complete');
});

test('final-pending plan-only and apply reconcile REST object labels before ordinary validation', () => {
  const reqs = requests();
  const env = environment({ initialStatus: 'source-review' });
  const initial = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'final-pending', initial.items.find((item) => item.issue_number === 1535), 1535);
  const pendingItem = progress.items['1535'];
  const firstOperation = pendingItem.intent.operation_plan[0];
  assert.deepEqual(firstOperation, { kind: 'add', label: 'status:source-ready' });
  env.state.get(1535).labels = [...new Set([...env.state.get(1535).labels, firstOperation.label])].sort();
  const originalLoadLive = env.loadLive;
  env.loadLive = (request) => {
    const live = originalLoadLive(request);
    if (request.issue_number === 1535) live.interviewIssue.labels = live.interviewIssue.labels.map((name) => ({ name }));
    return live;
  };
  const originalPlanTransition = env.planTransition;
  const planTransition = (request, interviewIssue, options) => {
    const labels = (interviewIssue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
    if (request.issue_number === 1535 && labels.filter((label) => label.startsWith('status:')).length > 1) {
      throw new Error('contradictory lifecycle labels');
    }
    return originalPlanTransition(request, interviewIssue, options);
  };
  const planned = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition, progress });
  assert.equal(planned.ok, true, planned.errors.join('\n'));
  assert.equal(planned.items.find((item) => item.issue_number === 1535).plan.pending_assessment.next_index, 1);
  assert.equal(env.patches.length, 0);
  assert.equal(env.posts.length, 0);
  const resumed = applyBatch(reqs, pinnedManifest, progress, {
    ...applyOptions(env, reqs, progress, []),
    loadLive: env.loadLive,
    planTransition,
  });
  assert.equal(resumed.ok, true, resumed.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1535 && patch.operation.kind === 'add' && patch.operation.label === 'status:source-ready').length, 0);
  assert.equal(progress.items['1535'].phase, 'complete');
});

test('final-pending recovery safely retries when PATCH was not sent', () => {
  const reqs = requests();
  const env = environment({ initialStatus: 'source-review' });
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'final-pending', preflight.items[0]);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 2);
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
});

test('pending label recovery treats an unrecognized live drift as uncertain', () => {
  const reqs = requests();
  const env = environment();
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  env.state.get(1509).labels = replaceLabels(env.state.get(1509).labels, 'source-ready');
  const progress = pendingProgress(reqs, 'begin-pending', preflight.items[0]);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /pending label recovery|pending begin/);
  assert.equal(progress.items['1509'].phase, 'uncertain');
  assert.equal(env.patches.length, 0);
  assert.equal(env.posts.length, 0);
});

test('pending sub-intent cannot change the authoritative stage target', () => {
  const reqs = requests();
  const env = environment();
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'begin-pending', preflight.items[0]);
  const intent = progress.items['1509'].intent;
  intent.desired_controlled_labels = ['status:source-ready'];
  intent.operation_plan = lifecycleOperationPlan(intent.before_controlled_labels, intent.desired_controlled_labels);
  intent.expected_labels = ['source:xhs', 'status:source-ready', 'type:interview-note'];
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /desired lifecycle labels conflict/);
  assert.equal(progress.items['1509'].phase, 'uncertain');
  assert.equal(env.patches.length, 0);
});

test('persisted begin-pending crash window reconciles after the process stops', () => {
  const reqs = requests();
  const env = environment();
  const progress = initialProgress(reqs);
  const crashed = applyWithCrashAfterPatch(reqs, pinnedManifest, env, progress, 'begin');
  assert.equal(crashed.first.ok, false);
  assert.equal(crashed.durable.items['1509'].phase, 'begin-pending');
  const resumed = applyBatch(reqs, pinnedManifest, crashed.durable, applyOptions(env, reqs, crashed.durable, []));
  assert.equal(resumed.ok, true, resumed.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 7);
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
});

test('persisted final-pending crash window reconciles after the process stops', () => {
  const reqs = requests();
  const env = environment({ initialStatus: 'source-review' });
  const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
  const progress = pendingProgress(reqs, 'final-pending', preflight.items[0]);
  const crashed = applyWithCrashAfterPatch(reqs, pinnedManifest, env, progress, 'final');
  assert.equal(crashed.first.ok, false);
  assert.equal(crashed.durable.items['1509'].phase, 'final-pending');
  const resumed = applyBatch(reqs, pinnedManifest, crashed.durable, applyOptions(env, reqs, crashed.durable, []));
  assert.equal(resumed.ok, true, resumed.errors.join('\n'));
  assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 2);
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
});

test('every lifecycle sub-operation crash resumes from its legal prefix without repeating a PATCH', () => {
  const reqs = requests();
  for (const [stage, count] of [['begin', 4], ['final', 2]]) {
    for (let crashAfter = 1; crashAfter <= count; crashAfter += 1) {
      const env = environment({ initialStatus: stage === 'final' ? 'source-review' : 'blocked' });
      const preflight = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
      const progress = stage === 'final'
        ? pendingProgress(reqs, 'final-pending', preflight.items[0])
        : initialProgress(reqs);
      const crashed = applyWithCrashAfterOperation(reqs, pinnedManifest, env, progress, crashAfter);
      assert.equal(crashed.first.ok, false, `${stage} operation ${crashAfter} did not crash`);
      assert.equal(crashed.durable.items['1509'].phase, `${stage}-pending`);
      const resumed = applyBatch(reqs, pinnedManifest, crashed.durable, applyOptions(env, reqs, crashed.durable, []));
      assert.equal(resumed.ok, true, `${stage} operation ${crashAfter}: ${resumed.errors.join('\n')}`);
      const operations = env.patches.filter((patch) => patch.issue === 1509).map((patch) => patch.operation);
      assert.equal(new Set(operations.map((operation) => `${operation.kind}:${operation.label}`)).size, operations.length);
      assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
    }
  }
});

test('pending raw reconciler accepts every legal prefix while the ordinary validator rejects only API multi-status windows', () => {
  const body = fs.readFileSync(path.resolve('test/fixtures/interview-note-issue.valid.md'), 'utf8');
  const cases = [
    {
      before: ['source:xhs', 'type:interview-note', 'status:blocked', 'task:source-recovery'],
      desired: ['source:xhs', 'type:interview-note', 'status:source-review', 'task:source-review'],
    },
    {
      before: ['source:xhs', 'type:interview-note', 'status:source-review', 'task:source-review'],
      desired: ['source:xhs', 'type:interview-note', 'status:source-ready'],
    },
  ];
  for (const value of cases) {
    const operations = lifecycleOperationPlan(value.before, value.desired);
    const state = {
      phase: 'begin-pending',
      intent: labelPendingIntent('begin', value.desired, { labels: value.before }, operations, 0),
    };
    let prefix = [...value.before];
    for (let index = 0; index <= operations.length; index += 1) {
      if (index > 0) prefix = applyLifecycleOperation(prefix, operations[index - 1]);
      state.intent.operation_index = Math.min(index, operations.length - 1);
      const assessment = pendingOperationAssessment(state, { labels: prefix });
      assert.equal(assessment.ok, true, `prefix ${index} was not accepted: ${assessment.error || 'unknown'}`);
      const ordinary = validateInterviewNoteIssue({ body, labels: prefix, state: 'open' });
      const hasMultipleStatuses = prefix.filter((label) => label.startsWith('status:')).length > 1;
      assert.equal(ordinary.ok, !hasMultipleStatuses, `ordinary validator result mismatch at prefix ${index}`);
    }
  }
});

test('ordered lifecycle recovery preserves unrelated labels added between sub-operations', () => {
  const reqs = requests();
  const env = environment();
  const originalPatch = env.patchLabels;
  const patchLabels = (request, labels, expectedSnapshot, operation) => {
    originalPatch(request, labels, expectedSnapshot, operation);
    if (request.issue_number === 1509 && !env.state.get(1509).labels.includes('external:concurrent')) env.state.get(1509).labels.push('external:concurrent');
  };
  const progress = initialProgress(reqs);
  const result = applyBatch(reqs, pinnedManifest, progress, { ...applyOptions(env, reqs, progress, []), patchLabels });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.state.get(1509).labels.includes('external:concurrent'), true);
  assert.equal(env.state.get(1509).labels.includes('source:xhs'), true);
});

test('receipt-pending recovery accepts a matching live receipt and refuses an ambiguous retry', () => {
  const reqs = requests();
  const convergedEnv = environment({ initialStatus: 'source-ready', initialReceipt: true });
  const convergedPreflight = planBatch(reqs, pinnedManifest, { loadLive: convergedEnv.loadLive, planTransition: convergedEnv.planTransition });
  const convergedProgress = pendingProgress(reqs, 'receipt-pending', convergedPreflight.items[0]);
  const converged = applyBatch(reqs, pinnedManifest, convergedProgress, applyOptions(convergedEnv, reqs, convergedProgress, []));
  assert.equal(converged.ok, true, converged.errors.join('\n'));
  assert.equal(convergedEnv.posts.length, 0);
  assert.equal(convergedProgress.items['1509'].phase, 'complete');

  const ambiguousEnv = environment({ initialStatus: 'source-ready' });
  const ambiguousPreflight = planBatch(reqs, pinnedManifest, { loadLive: ambiguousEnv.loadLive, planTransition: ambiguousEnv.planTransition });
  const ambiguousProgress = pendingProgress(reqs, 'receipt-pending', ambiguousPreflight.items[0]);
  const ambiguous = applyBatch(reqs, pinnedManifest, ambiguousProgress, applyOptions(ambiguousEnv, reqs, ambiguousProgress, []));
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.errors.join('\n'), /receipt-pending has no matching live receipt/);
  assert.equal(ambiguousEnv.posts.length, 0);
  assert.equal(ambiguousProgress.items['1509'].phase, 'uncertain');
});

test('partial resume continues a failed item without repeating completed mutations', () => {
  const reqs = requests();
  let fail = true;
  const env = environment({ afterRead(request, count, state) {
    if (fail && request.issue_number === 1510 && count > 30) state.get(1510).labels.push('drifted-label');
  }});
  const progress = initialProgress(reqs);
  const first = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(first.ok, false);
  assert.equal(progress.items['1509'].phase, 'complete');
  assert.equal(progress.status, 'failed');
  assert.equal(env.posts.includes(1509), true);
  const patchesBefore = env.patches.length;
  fail = false;
  const second = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(env.patches.length - patchesBefore, 203);
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
  assert.equal(progress.status, 'complete');
});

test('label drift after full preflight fails before the first label mutation', () => {
  const reqs = requests();
  const env = environment({ afterRead(request, count, state) {
    if (count === 30) state.get(1509).labels.push('external-drift');
  }});
  const progress = initialProgress(reqs);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /CAS changed/);
  assert.equal(env.patches.length, 0);
  assert.equal(env.posts.length, 0);
});

test('apply rejects a changed full-preflight digest before any mutation', () => {
  const reqs = requests();
  const env = environment();
  const progress = initialProgress(reqs);
  const result = applyBatch(reqs, pinnedManifest, progress, {
    ...applyOptions(env, reqs, progress, []),
    expectedPlanSha256: '0'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /plan confirmation mismatch/);
  assert.equal(env.patches.length, 0);
  assert.equal(env.posts.length, 0);
  assert.equal(progress.status, 'planned');
});

test('receipt response loss recovers only when live receipt converges and otherwise becomes unrecoverable', () => {
  const reqs = requests();
  const env = environment({ responseLossIssue: 1509 });
  const progress = initialProgress(reqs);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
  assert.equal(progress.items['1509'].phase, 'complete');

  const uncertainEnv = environment({ responseLossIssue: 1509, responseLossConverges: false });
  const uncertainProgress = initialProgress(reqs);
  const uncertain = applyBatch(reqs, pinnedManifest, uncertainProgress, applyOptions(uncertainEnv, reqs, uncertainProgress, []));
  assert.equal(uncertain.ok, false);
  assert.equal(uncertainProgress.possibly_performed, true);
  assert.equal(uncertainProgress.items['1509'].phase, 'uncertain');
  const retry = applyBatch(reqs, pinnedManifest, uncertainProgress, applyOptions(uncertainEnv, reqs, uncertainProgress, []));
  assert.equal(retry.ok, false);
  assert.match(retry.errors.join('\n'), /uncertain mutation/);
  assert.equal(uncertainEnv.posts.filter((issue) => issue === 1509).length, 1);
});

test('null, zero, empty, and invalid receipt responses recover only from a matching live receipt', () => {
  for (const response of [null, 0, '', {}, { id: 0 }]) {
    const reqs = requests();
    const env = environment({ initialStatus: 'source-ready', postReceiptResponse: response });
    const progress = initialProgress(reqs);
    const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
    assert.equal(result.ok, true, `${JSON.stringify(response)}: ${result.errors.join('\n')}`);
    assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
    assert.equal(progress.items['1509'].phase, 'complete');
  }
  for (const response of [null, 0, '', {}, { id: 0 }]) {
    const reqs = requests();
    const env = environment({ initialStatus: 'source-ready', postReceiptResponse: response, postReceiptConverges: false });
    const progress = initialProgress(reqs);
    const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
    assert.equal(result.ok, false, `${JSON.stringify(response)} unexpectedly recovered`);
    assert.match(result.errors.join('\n'), /no valid comment id and live receipt was not recoverable/);
    assert.equal(progress.items['1509'].phase, 'uncertain');
    assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
  }
});

test('receipt repair performs only the receipt mutation and exact reentry performs none', () => {
  const reqs = requests();
  const env = environment({ initialStatus: 'source-ready' });
  const progress = initialProgress(reqs);
  const result = applyBatch(reqs, pinnedManifest, progress, applyOptions(env, reqs, progress, []));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.patches.length, 0);
  assert.equal(env.posts.length, 30);
  const reentryEnv = environment({ initialStatus: 'source-ready', initialReceipt: true });
  const reentry = applyBatch(reqs, pinnedManifest, initialProgress(reqs), applyOptions(reentryEnv, reqs, initialProgress(reqs), []));
  assert.equal(reentry.ok, true, reentry.errors.join('\n'));
  assert.equal(reentryEnv.patches.length, 0);
  assert.equal(reentryEnv.posts.length, 0);
});

test('batch CLI main apply mock writes a successful mutation result and exits zero', () => {
  const reqs = requests();
  const env = environment();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-transition-cli-'));
  const requestDir = path.join(directory, 'requests');
  const output = path.join(directory, 'result.json');
  const progress = path.join(directory, 'progress.json');
  const lock = path.join(directory, 'progress.lock');
  try {
    writeRequestSet(requestDir, reqs);
    const plan = planBatch(reqs, pinnedManifest, { loadLive: env.loadLive, planTransition: env.planTransition });
    const exitCode = batchMain([
      '--request-dir', requestDir,
      '--pinned-artifact-manifest', path.resolve('data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json'),
      '--output', output,
      '--progress', progress,
      '--progress-lock', lock,
      '--confirm-plan-sha256', plan.report.plan_sha256,
      '--min-mutation-interval-ms', '0',
      '--apply',
    ], { loadLive: env.loadLive, planTransition: env.planTransition, patchLabels: env.patchLabels, postReceipt: env.postReceipt });
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.mutation_attempted, true);
    assert.equal(result.mutation_performed, true);
    assert.equal(env.patches.length, 210);
    assert.equal(env.posts.length, 30);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI plan-only rebinds a crashed pending journal and only the new recovery digest can resume', () => {
  const reqs = requests();
  const env = environment();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-transition-recovery-cli-'));
  const requestDir = path.join(directory, 'requests');
  const manifestPath = path.resolve('data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json');
  const output = path.join(directory, 'result.json');
  const progress = path.join(directory, 'progress.json');
  const lock = path.join(directory, 'progress.lock');
  const cliArgs = (apply, digest = null) => [
    '--request-dir', requestDir,
    '--pinned-artifact-manifest', manifestPath,
    '--output', output,
    '--progress', progress,
    '--progress-lock', lock,
    '--min-mutation-interval-ms', '0',
    ...(digest ? ['--confirm-plan-sha256', digest] : []),
    ...(apply ? ['--apply'] : []),
  ];
  try {
    writeRequestSet(requestDir, reqs);
    assert.equal(batchMain(cliArgs(false), { loadLive: env.loadLive, planTransition: env.planTransition }), 0);
    const initialDigest = JSON.parse(fs.readFileSync(output, 'utf8')).plan_sha256;

    let crash = true;
    const crashingLoadLive = (request) => {
      const live = env.loadLive(request);
      if (crash && request.issue_number === 1509 && env.patches.filter((patch) => patch.issue === 1509).length >= 1) {
        crash = false;
        throw new Error('simulated process crash after first lifecycle sub-operation');
      }
      return live;
    };
    assert.equal(batchMain(cliArgs(true, initialDigest), { loadLive: crashingLoadLive, planTransition: env.planTransition, patchLabels: env.patchLabels, postReceipt: env.postReceipt }), 1);
    const pending = JSON.parse(fs.readFileSync(progress, 'utf8'));
    assert.equal(pending.items['1509'].phase, 'begin-pending');
    const mutationsAfterCrash = { patches: env.patches.length, posts: env.posts.length };

    assert.equal(batchMain(cliArgs(false), { loadLive: env.loadLive, planTransition: env.planTransition }), 0);
    const recoveryPlan = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.notEqual(recoveryPlan.plan_sha256, initialDigest);
    assert.equal(env.patches.length, mutationsAfterCrash.patches);
    assert.equal(env.posts.length, mutationsAfterCrash.posts);

    assert.throws(() => batchMain(cliArgs(true, initialDigest), { loadLive: env.loadLive, planTransition: env.planTransition, patchLabels: env.patchLabels, postReceipt: env.postReceipt }), /plan confirmation mismatch/);
    assert.equal(env.patches.length, mutationsAfterCrash.patches);
    assert.equal(env.posts.length, mutationsAfterCrash.posts);

    assert.equal(batchMain(cliArgs(true, recoveryPlan.plan_sha256), { loadLive: env.loadLive, planTransition: env.planTransition, patchLabels: env.patchLabels, postReceipt: env.postReceipt }), 0);
    assert.equal(env.patches.filter((patch) => patch.issue === 1509).length, 7);
    assert.equal(new Set(env.patches.filter((patch) => patch.issue === 1509).map((patch) => `${patch.operation.kind}:${patch.operation.label}`)).size, 7);
    assert.equal(env.posts.length, 30);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('single-item CLI refuses apply for the fixed Issue #1539 blocked recovery range before any GitHub call', () => {
  const request = requests()[0];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-single-cli-'));
  const requestPath = path.join(directory, 'request.md');
  try {
    fs.writeFileSync(requestPath, `${requestMarker(request)}\n`);
    assert.equal(isIssue1539BlockedRecoveryRequest(request), true);
    assert.equal(isIssue1539BlockedRecoveryRequest({ ...request, expected_initial_status: 'source-review', recovery_mode: 'ordinary' }), true);
    assert.equal(isIssue1539BlockedRecoveryRequest({ ...request, issue_number: 1538, expected_initial_status: 'source-ready', recovery_mode: 'none' }), true);
    assert.equal(singleMain(['--request', requestPath, '--apply']), 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle label mutation uses only controlled add/remove operations and preserves unrelated labels', () => {
  const request = requests()[0];
  const before = { number: 1509, body: 'body', state: 'open', updated_at: null, labels: ['external:keep', 'source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'] };
  const state = { issue: JSON.parse(JSON.stringify(before)), calls: [] };
  const desired = ['external:keep', 'source:xhs', 'status:source-review', 'task:source-review', 'type:interview-note'];
  patchLifecycleLabels(request, desired, {
    number: before.number,
    body_sha256: require('../scripts/lib/issue-1539-recovery-plan').sha256Text(before.body),
    labels: [...before.labels].sort(),
    state: before.state,
    updated_at: before.updated_at,
  }, {
    loadIssue() { return state.issue; },
    addLabels(_repository, _issueNumber, labels) {
      state.calls.push({ method: 'add', labels });
      state.issue.labels = [...new Set([...state.issue.labels, ...labels])];
    },
    removeLabel(_repository, _issueNumber, label) {
      state.calls.push({ method: 'remove', label });
      state.issue.labels = state.issue.labels.filter((value) => value !== label);
    },
  });
  assert.deepEqual(state.calls, [
    { method: 'add', labels: ['status:source-review'] },
    { method: 'add', labels: ['task:source-review'] },
    { method: 'remove', label: 'status:blocked' },
    { method: 'remove', label: 'task:source-recovery' },
  ]);
  assert.equal(state.issue.labels.includes('external:keep'), true);
  assert.equal(state.issue.labels.includes('status:source-review'), true);
});

test('production lifecycle adapter uses the GitHub add/delete endpoints and batch recovery handles response loss', () => {
  const request = requests()[0];
  const before = { number: 1509, body: 'body', state: 'open', updated_at: null, labels: ['external:keep', 'source:xhs', 'status:blocked', 'task:source-recovery', 'type:interview-note'] };
  const state = { issue: JSON.parse(JSON.stringify(before)), calls: [] };
  const expected = {
    number: before.number,
    body_sha256: require('../scripts/lib/issue-1539-recovery-plan').sha256Text(before.body),
    labels: [...before.labels].sort(),
    state: before.state,
    updated_at: before.updated_at,
  };
  patchLifecycleLabelOperation(request, { kind: 'add', label: 'status:source-review' }, expected, {
    loadIssue: () => state.issue,
    ghJson(args, input) {
      state.calls.push({ args, input });
      assert.deepEqual(args, ['api', '--method', 'POST', 'repos/liqiangcc/interview-lab/issues/1509/labels', '--input', '-']);
      assert.deepEqual(input, { labels: ['status:source-review'] });
      state.issue.labels.push(...input.labels);
      return null;
    },
  });
  const afterAdd = { ...expected, labels: [...state.issue.labels].sort() };
  patchLifecycleLabelOperation(request, { kind: 'remove', label: 'status:blocked' }, afterAdd, {
    loadIssue: () => state.issue,
    ghJson(args) {
      state.calls.push({ args });
      assert.deepEqual(args, ['api', '--method', 'DELETE', 'repos/liqiangcc/interview-lab/issues/1509/labels/status%3Ablocked']);
      state.issue.labels = state.issue.labels.filter((label) => label !== 'status:blocked');
      return null;
    },
  });
  assert.equal(state.calls.length, 2);

  const env = environment();
  let loss = true;
  const patchLabels = (value, labels, snapshot, operation) => patchLifecycleLabelOperation(value, operation, snapshot, {
    loadIssue() {
      const item = env.state.get(value.issue_number);
      return { number: value.issue_number, body: `interview-${value.issue_number}`, labels: [...item.labels], state: 'open' };
    },
    ghJson(args, input) {
      const item = env.state.get(value.issue_number);
      if (args[2] === 'POST') item.labels.push(...input.labels);
      else item.labels = item.labels.filter((label) => label !== decodeURIComponent(args[3].split('/').pop()));
      if (loss && value.issue_number === 1509 && args[2] === 'POST') { loss = false; throw new Error('simulated adapter response loss'); }
      return null;
    },
  });
  const progress = initialProgress(requests());
  const result = applyBatch(requests(), pinnedManifest, progress, { ...applyOptions(env, requests(), progress, []), patchLabels });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(env.state.get(1509).labels.includes('status:source-ready'), true);
  assert.equal(env.posts.filter((issue) => issue === 1509).length, 1);
});

test('label CAS conflict fails closed while a concurrent unrelated label is never discarded', () => {
  const reqs = requests();
  const env = environment();
  const progress = initialProgress(reqs);
  const originalPatch = env.patchLabels;
  let conflict = true;
  const patchLabels = (request, labels) => {
    if (conflict && request.issue_number === 1509 && labels.some((label) => label === 'status:source-review')) {
      conflict = false;
      env.state.get(1509).labels.push('external:keep');
      env.state.get(1509).labels = replaceLabels(env.state.get(1509).labels, 'source-review', 'task:source-recovery');
      throw new Error('simulated lifecycle CAS conflict');
    }
    originalPatch(request, labels);
  };
  const result = applyBatch(reqs, pinnedManifest, progress, { ...applyOptions(env, reqs, progress, []), patchLabels });
  assert.equal(result.ok, false);
  assert.equal(progress.items['1509'].phase, 'uncertain');
  assert.equal(env.state.get(1509).labels.includes('external:keep'), true);
  assert.equal(env.posts.length, 0);
});

test('progress identity, phase, and uncertain state are fail-closed', () => {
  const reqs = requests();
  const progress = initialProgress(reqs);
  assert.equal(validateProgress(progress, reqs).ok, true);
  progress.items['1509'].intent.phase = 'receipt-pending';
  assert.equal(validateProgress(progress, reqs).ok, false);
  const uncertain = initialProgress(reqs);
  uncertain.status = 'failed';
  uncertain.possibly_performed = true;
  uncertain.items['1509'].phase = 'uncertain';
  uncertain.items['1509'].intent.phase = 'uncertain';
  assert.equal(validateProgress(uncertain, reqs).ok, false);
  assert.equal(PROGRESS_SCHEMA_VERSION, 'issue-1539-source-review-transition-progress.v1');
  assert.equal(INTENT_SCHEMA_VERSION, 'issue-1539-source-review-transition-intent.v1');
  assert.equal(BATCH_ID, 'issue-1539-source-review-transition-001');
  assert.equal(PACKET_SET_SHA256.length, 64);
  assert.equal(PINNED_ARTIFACT_MANIFEST_SHA256.length, 64);
});

test('two concurrent lock contenders cannot both enter the batch critical section', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-transition-lock-'));
  const lockPath = path.join(directory, 'batch.lock');
  const modulePath = path.resolve(__dirname, '../scripts/lib/issue-1539-evidence-batch.js');
  const script = `const { acquireProgressLock } = require(${JSON.stringify(modulePath)}); try { const lock = acquireProgressLock(process.argv[1]); process.stdout.write('entered\\n'); setTimeout(() => lock.release(), 500); } catch (error) { process.stderr.write(error.message); process.exitCode = 2; }`;
  const first = spawn(process.execPath, ['-e', script, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { first.stdout.once('data', resolve); first.once('error', reject); });
  const second = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(second.code, 2);
  assert.match(second.stderr, /progress lock is held/);
  await new Promise((resolve) => first.once('close', resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});
