'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ISSUE_NUMBERS,
  PACKET_SET_SHA256,
  planBatch,
  interviewNoteId,
  buildMaterializationRequest,
  validateFixedSet,
  targetPreflight,
  requestSha256,
  applyBatch,
  initialProgress,
  validateProgress,
  renderMaterializationReceipt,
  buildMaterializationReceipt,
  validateMaterializationReceipt,
  makeIntent,
  acquireProgressLock,
} = require('../scripts/lib/issue-1556-materialization-batch');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection } = require('../scripts/lib/source-note-interview-materialization');

const authorized = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-1556-authorized-batch.json'), 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeAuthorizedHarness({ owners = false } = {}) {
  const sourceIssues = new Map(authorized.source_issues.map((issue) => [issue.number, clone(issue)]));
  const ownersByIssue = new Map(ISSUE_NUMBERS.map((issueNumber) => [issueNumber, []]));
  const commentsByIssue = new Map(ISSUE_NUMBERS.map((issueNumber) => [issueNumber, []]));
  const calls = { create: [], receipt: [] };
  const snapshots = [];
  const transitions = new Map(authorized.transition_requests.map((request) => [request.issue_number, request]));
  const transitionReceipts = new Map(authorized.transition_receipts.map((receipt) => [receipt.issue_number, receipt]));

  for (const issueNumber of ISSUE_NUMBERS) {
    const sourceIssue = sourceIssues.get(issueNumber);
    const request = buildMaterializationRequest(transitions.get(issueNumber), transitionReceipts.get(issueNumber));
    const parsed = parseSourceNoteIssue(sourceIssue.body);
    const projection = buildInterviewProjection(sourceIssue, { ok: true, parsed });
    if (owners) ownersByIssue.set(issueNumber, [{ number: 20000 + issueNumber, state: 'open', body: projection.body, labels: projection.labels }]);
  }

  const loadLive = (request) => ({
    sourceIssue: sourceIssues.get(request.source_note_issue_number),
    comments: commentsByIssue.get(request.source_note_issue_number),
    allIssues: ownersByIssue.get(request.source_note_issue_number),
  });
  const readBlob = (sha) => {
    if (!authorized.blobs[sha]) throw new Error(`fixture blob missing ${sha}`);
    return clone(authorized.blobs[sha]);
  };
  const planResult = planBatch({
    packetSet: authorized.packet_set,
    manifest: authorized.manifest,
    transitionRequests: authorized.transition_requests,
    evidenceReceipts: authorized.evidence_receipts,
    transitionReceipts: authorized.transition_receipts,
    loadLive,
    readBlob,
  });
  assert.equal(planResult.ok, true, planResult.errors.join('; '));

  const apply = (progress = null, overrides = {}) => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1556-real-fixture-'));
    const lock = acquireProgressLock(path.join(lockDir, 'progress.lock'));
    try {
      return applyBatch({
        planResult,
        packetSet: authorized.packet_set,
        manifest: authorized.manifest,
        transitionRequests: authorized.transition_requests,
        transitionReceipts: authorized.transition_receipts,
        evidenceReceipts: authorized.evidence_receipts,
        progress,
      }, {
        expectedAuthorizationSha256: planResult.authorization_sha256,
        lock,
        loadLive,
        readBlob,
        persistProgress: (value) => snapshots.push(clone(value)),
        writeRequest: () => {},
        writeReceipt: () => {},
        beforeMutation: () => {},
        createInterviewIssue: (request, projection) => {
          calls.create.push(request.source_note_issue_number);
          ownersByIssue.set(request.source_note_issue_number, [{ number: 20000 + request.source_note_issue_number, state: 'open', body: projection.body, labels: projection.labels }]);
        },
        postReceipt: (request, receipt) => {
          calls.receipt.push(request.source_note_issue_number);
          commentsByIssue.set(request.source_note_issue_number, [{ id: 30000 + request.source_note_issue_number, body: renderMaterializationReceipt(receipt), issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.source_note_issue_number}` }]);
        },
        ...overrides,
      });
    } finally {
      try { lock.release(); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
    }
  };
  return { sourceIssues, ownersByIssue, commentsByIssue, calls, snapshots, planResult, loadLive, apply };
}

function pendingProgress(planResult, phase, issueNumber = 158, priorPhase = null) {
  const progress = initialProgress(planResult.items, planResult.plan_sha256, planResult.authorization_sha256);
  progress.status = 'failed';
  progress.mutation_attempted = true;
  progress.possibly_performed = true;
  const item = progress.items[String(issueNumber)];
  item.phase = phase;
  item.intent = makeIntent(planResult.items.find((candidate) => candidate.issue_number === issueNumber), phase, {
    prior_phase: priorPhase,
    mutation_attempted: true,
    mutation_performed: null,
    possibly_performed: true,
  });
  return progress;
}

test('fixed materialization scope is exactly the 17 ordered SourceNotes', () => {
  assert.deepEqual(authorized.issue_numbers, ISSUE_NUMBERS);
  assert.equal(authorized.packet_set.packet_set_sha256, PACKET_SET_SHA256);
  assert.equal(validateFixedSet(ISSUE_NUMBERS.map((issue_number) => ({ issue_number })), 'items').length, 0);
  assert.match(validateFixedSet(ISSUE_NUMBERS.slice(0, 16).map((issue_number) => ({ issue_number })), 'items')[0], /exactly the fixed 17/);
  assert.match(validateFixedSet([...ISSUE_NUMBERS].reverse().map((issue_number) => ({ issue_number })), 'items')[0], /fixed 17 Issue order/);
});

test('real authorized fixture passes module-local planBatch for all 17 fresh preflights', () => {
  const harness = makeAuthorizedHarness();
  assert.equal(harness.planResult.report.total, 17);
  assert.equal(harness.planResult.report.mutation_count, 0);
  assert.deepEqual(harness.planResult.items.map((item) => item.action), ISSUE_NUMBERS.map(() => 'would-create'));
  assert.deepEqual(harness.planResult.items.map((item) => item.ownership_count), ISSUE_NUMBERS.map(() => 0));
  assert.match(harness.planResult.plan_sha256, /^[0-9a-f]{64}$/);
  assert.match(harness.planResult.authorization_sha256, /^[0-9a-f]{64}$/);
  assert.equal(harness.planResult.report.source_ready_count, 0);
});

test('target preflight binds real target body, provenance, pinned blob, and forbidden labels', () => {
  const harness = makeAuthorizedHarness();
  const issueNumber = 158;
  const packet = authorized.packet_set.packets.find((item) => item.issue_number === issueNumber);
  const request = authorized.transition_requests.find((item) => item.issue_number === issueNumber);
  const transitionReceipt = authorized.transition_receipts.find((item) => item.issue_number === issueNumber);
  const materializationRequest = buildMaterializationRequest(request, transitionReceipt);
  const gate = targetPreflight(packet, request, transitionReceipt, harness.loadLive(materializationRequest), { readBlob: (sha) => clone(authorized.blobs[sha]) });
  assert.equal(gate.ok, true, gate.errors.join('; '));
  assert.equal(gate.projection.interview_note_id, interviewNoteId(request.source_note_id));
  const forbidden = clone(harness.sourceIssues.get(issueNumber));
  forbidden.labels.push('status:source-ready');
  harness.sourceIssues.set(issueNumber, forbidden);
  const forbiddenGate = targetPreflight(packet, request, transitionReceipt, harness.loadLive(materializationRequest), { readBlob: (sha) => clone(authorized.blobs[sha]) });
  assert.ok(forbiddenGate.errors.some((error) => /forbidden/.test(error)));
  const missingCommentsGate = targetPreflight(packet, request, transitionReceipt, { sourceIssue: forbidden, allIssues: [] }, { readBlob: (sha) => clone(authorized.blobs[sha]) });
  assert.ok(missingCommentsGate.errors.some((error) => /comments inventory/.test(error)));
});

test('projection is source-faithful and has no learning or source-ready labels', () => {
  const sourceIssue = authorized.source_issues[0];
  const parsed = parseSourceNoteIssue(sourceIssue.body);
  const projection = buildInterviewProjection(sourceIssue, { ok: true, parsed });
  assert.equal(projection.interview_note_id, interviewNoteId(authorized.manifest.items[0].source_note_id));
  assert.equal(projection.labels.includes('status:source-ready'), false);
  assert.equal(projection.labels.some((label) => label.startsWith('learning:')), false);
  assert.equal(requestSha256({ a: 1 }).length, 64);
});

test('fresh drift in the final item fails closed before any create or receipt mutation', () => {
  const harness = makeAuthorizedHarness();
  const last = ISSUE_NUMBERS.at(-1);
  harness.sourceIssues.get(last).labels.push('status:source-ready');
  const result = harness.apply();
  assert.equal(result.ok, false);
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.length, 0);
  assert.equal(harness.snapshots.length, 0);
});

test('real applyBatch reconciles create and receipt response loss without duplicate POSTs', () => {
  const harness = makeAuthorizedHarness();
  let createLosses = 0;
  let receiptLosses = 0;
  const result = harness.apply(null, {
    createInterviewIssue: (request, projection) => {
      harness.calls.create.push(request.source_note_issue_number);
      harness.ownersByIssue.set(request.source_note_issue_number, [{ number: 20000 + request.source_note_issue_number, state: 'open', body: projection.body, labels: projection.labels }]);
      if (createLosses++ === 0) throw new Error('create response lost');
    },
    postReceipt: (request, receipt) => {
      harness.calls.receipt.push(request.source_note_issue_number);
      harness.commentsByIssue.set(request.source_note_issue_number, [{ id: 30000 + request.source_note_issue_number, body: renderMaterializationReceipt(receipt), issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.source_note_issue_number}` }]);
      if (receiptLosses++ === 0) throw new Error('receipt response lost');
    },
  });
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(harness.calls.create.length, 17);
  assert.equal(new Set(harness.calls.create).size, 17);
  assert.equal(harness.calls.receipt.length, 17);
  assert.equal(new Set(harness.calls.receipt).size, 17);
  assert.equal(result.progress.status, 'complete');
  assert.equal(result.progress.possibly_performed, false);
});

test('create-pending resume reconciles owner and posts only its missing receipt', () => {
  const harness = makeAuthorizedHarness({ owners: true });
  const result = harness.apply(pendingProgress(harness.planResult, 'create-pending'));
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.length, 17);
  assert.equal(harness.calls.receipt.filter((issue) => issue === 158).length, 1);
  assert.equal(result.progress.items['158'].phase, 'complete');
});

test('uncertain create recovery keeps its root phase across a failed reconcile and later completes without recreating', () => {
  const harness = makeAuthorizedHarness();
  const first = harness.apply(pendingProgress(harness.planResult, 'create-pending'));
  assert.equal(first.ok, false);
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.length, 0);
  assert.equal(first.progress.items['158'].phase, 'uncertain');
  assert.equal(first.progress.items['158'].intent.prior_phase, 'create-pending');

  for (const issueNumber of ISSUE_NUMBERS) {
    const sourceIssue = harness.sourceIssues.get(issueNumber);
    const parsed = parseSourceNoteIssue(sourceIssue.body);
    const projection = buildInterviewProjection(sourceIssue, { ok: true, parsed });
    harness.ownersByIssue.set(issueNumber, [{ number: 20000 + issueNumber, state: 'open', body: projection.body, labels: projection.labels }]);
  }
  const second = harness.apply(first.progress);
  assert.equal(second.ok, true, second.errors?.join('; '));
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.filter((issue) => issue === 158).length, 1);
  assert.equal(second.progress.items['158'].phase, 'complete');
});

test('receipt-pending resume remains uncertain and never repeats receipt POST', () => {
  const harness = makeAuthorizedHarness({ owners: true });
  const result = harness.apply(pendingProgress(harness.planResult, 'receipt-pending'));
  assert.equal(result.ok, false);
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.length, 0);
  assert.equal(result.progress.items['158'].phase, 'uncertain');
  assert.equal(result.progress.possibly_performed, true);
});

test('uncertain after prior create reconciles owner and posts one missing receipt', () => {
  const harness = makeAuthorizedHarness({ owners: true });
  const result = harness.apply(pendingProgress(harness.planResult, 'uncertain', 158, 'create-pending'));
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.filter((issue) => issue === 158).length, 1);
  assert.equal(result.progress.items['158'].phase, 'complete');
});

test('uncertain after prior receipt remains uncertain without matching receipt', () => {
  const harness = makeAuthorizedHarness({ owners: true });
  const result = harness.apply(pendingProgress(harness.planResult, 'uncertain', 158, 'receipt-pending'));
  assert.equal(result.ok, false);
  assert.equal(harness.calls.create.length, 0);
  assert.equal(harness.calls.receipt.length, 0);
  assert.equal(result.progress.items['158'].phase, 'uncertain');
  assert.equal(result.progress.possibly_performed, true);
});

test('v2 materialization receipts bind manifest and null repository ref', () => {
  const request = {
    schema_version: 'source-note-interview-materialization.v2', materialization_id: 'm-v2', repository: 'liqiangcc/interview-lab',
    source_note_issue_number: 158, source_note_id: 'xhs-note:625564d70000000001025e46', expected_source_note_body_sha256: 'a'.repeat(64),
    expected_boundary_status: 'single-interview', expected_source_revision_id: 'xhs-note:625564d70000000001025e46:r2',
    expected_manifest_sha256: 'b'.repeat(64), expected_source_repository_ref: null,
  };
  const projection = { body: 'source-faithful v2 projection' };
  const receipt = buildMaterializationReceipt(request, { number: 777 }, projection);
  assert.equal(receipt.manifest_sha256, request.expected_manifest_sha256);
  assert.equal(receipt.source_repository_ref, null);
  assert.equal(validateMaterializationReceipt(receipt, request, projection).ok, true);
  assert.equal(validateMaterializationReceipt({ ...receipt, manifest_sha256: 'c'.repeat(64) }, request, projection).ok, false);
  assert.equal(validateMaterializationReceipt({ ...receipt, source_repository_ref: 'd'.repeat(40) }, request, projection).ok, false);
});

test('pending progress phases remain readable and preserve intent identity', () => {
  const harness = makeAuthorizedHarness();
  const progress = pendingProgress(harness.planResult, 'create-pending');
  assert.equal(validateProgress(progress, harness.planResult.items, harness.planResult.authorization_sha256).ok, true);
  progress.items['158'].phase = 'uncertain';
  progress.items['158'].intent = makeIntent(harness.planResult.items[0], 'uncertain', { prior_phase: 'receipt-pending', mutation_attempted: true, mutation_performed: null, possibly_performed: true });
  assert.equal(validateProgress(progress, harness.planResult.items, harness.planResult.authorization_sha256).ok, true);
});

test('apply requires a real lock API with owner-token assertion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1556-lock-'));
  const lock = acquireProgressLock(path.join(directory, 'progress.lock'));
  assert.doesNotThrow(() => lock.assertHeld());
  lock.release();
  assert.throws(() => lock.assertHeld(), /missing/);
  fs.rmSync(directory, { recursive: true, force: true });
});
