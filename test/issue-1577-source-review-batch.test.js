'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const manifest = require('../data/issue-1577/source-review-manifest.json');
const {
  FIXED_ITEMS,
  validateFixedManifest,
  finalizePacketSet,
  initialProgress,
  validateProgress,
  buildReceipt,
  validateReceipt,
  applyBatch,
  evidenceBody,
} = require('../scripts/lib/issue-1577-source-review-batch');
const { requestSha256, evidenceSubjectSha256 } = require('../scripts/lib/interview-note-source-review-transition');
const { sha256Text } = require('../scripts/lib/issue-1539-recovery-plan');
const {
  atomicWriteJson,
  atomicWriteText,
  createMutationIntervalHook,
  main: runCli,
  readReceiptFile,
} = require('../scripts/plan-issue-1577-source-review');

test('Issue #1577 fixed manifest binds all 17 text projections to the pinned source commit', () => {
  const validation = validateFixedManifest(manifest);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(manifest.items.length, FIXED_ITEMS.length);
  for (const item of manifest.items) {
    assert.match(item.text_projection_ref, /@95b77bb261048059846273688e4b90a2e108b437$/);
  }
});

test('Issue #1577 fixed manifest rejects a missing or incorrect explicit scope', () => {
  const missing = { ...manifest };
  delete missing.scope;
  assert.equal(validateFixedManifest(missing).ok, false);
  const incorrect = { ...manifest, scope: 'issue-1577-unbounded' };
  assert.equal(validateFixedManifest(incorrect).ok, false);
});

test('packet set finalization binds the same reproducible digest to the set and every packet', () => {
  const base = {
    schema_version: 'issue-1577-source-review-batch.v1',
    scope: 'issue-1577-fixed-17',
    packets: [{ packet_id: 'one', value: 'stable', packet_set_sha256: undefined }, { packet_id: 'two', value: 'stable', packet_set_sha256: undefined }],
  };
  const packetSet = finalizePacketSet(base);
  assert.match(packetSet.packet_set_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(packetSet.packets.map((packet) => packet.packet_set_sha256), [packetSet.packet_set_sha256, packetSet.packet_set_sha256]);
  const withoutHashes = { ...packetSet, packet_set_sha256: undefined, packets: packetSet.packets.map(({ packet_set_sha256, ...packet }) => packet) };
  delete withoutHashes.packet_set_sha256;
  const { canonicalJson, sha256Text } = require('../scripts/lib/issue-1539-recovery-plan');
  assert.equal(sha256Text(canonicalJson(withoutHashes)), packetSet.packet_set_sha256);
});

test('progress validation rejects unknown packet ids and tampered intent phases', () => {
  const packetSet = {
    packet_set_sha256: 'p'.repeat(64),
    packets: [{ packet_id: 'packet-1', source_note_issue_number: 1, interview_issue_number: 2, interview_note_id: 'xhs:one', evidence_subject_sha256: 'e'.repeat(64) }],
  };
  const progress = initialProgress(packetSet, 'a'.repeat(64));
  assert.equal(validateProgress(progress, packetSet, 'a'.repeat(64)).ok, true);
  progress.intents.unknown = null;
  progress.intents['packet-1'] = { ...progress.intents['packet-1'], phase: 'unexpected' };
  const validation = validateProgress(progress, packetSet, 'a'.repeat(64));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /unknown intent|phase invalid/);
});

test('complete progress cannot hide unresolved intents or incomplete receipt results', () => {
  const packetSet = {
    packet_set_sha256: 'p'.repeat(64),
    packets: [{ packet_id: 'packet-1', source_note_issue_number: 1, interview_issue_number: 2, interview_note_id: 'xhs:one', evidence_subject_sha256: 'e'.repeat(64) }],
  };
  const progress = initialProgress(packetSet, 'a'.repeat(64));
  progress.status = 'complete';
  progress.possibly_performed = true;
  const validation = validateProgress(progress, packetSet, 'a'.repeat(64));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /unresolved intent|no result|possibly_performed/);
});

test('receipt validation binds evidence comment, request, packet set, and authorization', () => {
  const packet = {
    packet_set_sha256: 'p'.repeat(64),
    evidence_subject_sha256: 'e'.repeat(64),
    source_note_issue_number: 158,
  };
  const request = {
    repository: 'liqiangcc/interview-lab',
    issue_number: 1558,
    source_note_issue_number: 158,
    interview_note_id: 'xhs:6615074a000000001b01318f',
    expected_source_note_body_sha256: 's'.repeat(64),
    expected_interview_body_sha256: 'i'.repeat(64),
    expected_source_revision_id: 'xhs-note:revision',
    pinned_artifact_manifest_sha256: 'm'.repeat(64),
    evidence_subject_sha256: packet.evidence_subject_sha256,
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 1558, comment_id: 123 },
  };
  const authorization = 'a'.repeat(64);
  const receipt = buildReceipt(packet, request, 123, authorization);
  assert.equal(receipt.request_sha256, requestSha256(request));
  assert.equal(validateReceipt(receipt, packet, request, authorization).ok, true);
  receipt.evidence_comment_id = 124;
  assert.equal(validateReceipt(receipt, packet, request, authorization).ok, false);
});

test('Issue #1577 Markdown request writer writes raw marker text, not a JSON string', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-request-'));
  try {
    const file = path.join(directory, 'issue-1558.md');
    atomicWriteText(file, '<!-- marker -->\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '<!-- marker -->\n');
    assert.notEqual(fs.readFileSync(file, 'utf8')[0], '"');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI mutation interval waits only between evidence POSTs, not before the first one', () => {
  let now = 1000;
  const waits = [];
  const beforeEvidencePost = createMutationIntervalHook(50, {
    now: () => now,
    sleep: (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  });
  const postTimes = [];
  beforeEvidencePost(); postTimes.push(now);
  now += 7;
  beforeEvidencePost(); postTimes.push(now);
  now += 10;
  beforeEvidencePost(); postTimes.push(now);
  assert.deepEqual(waits, [43, 40]);
  assert.deepEqual(postTimes, [1000, 1050, 1100]);
});

test('CLI apply uses a secure local receipt reader, recovers response loss, and does not duplicate on resume', () => {
  const fixture = applyFixture(17);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-cli-'));
  const progressFile = path.join(directory, 'progress.json');
  const outputFile = path.join(directory, 'output.json');
  const lockFile = path.join(directory, 'progress.lock');
  const requestDir = path.join(directory, 'requests');
  const receiptDir = path.join(directory, 'receipts');
  const posts = [];
  const receiptWrites = [];
  const issues = new Map();
  for (const packet of fixture.packets) {
    issues.set(packet.source_note_issue_number, { number: packet.source_note_issue_number, body: `source-${packet.source_note_issue_number - 1000}`, state: 'open', labels: [] });
    issues.set(packet.interview_issue_number, { number: packet.interview_issue_number, body: `interview-${packet.interview_issue_number - 2000}`, state: 'open', labels: [{ name: 'status:captured' }] });
  }
  const comments = new Map(fixture.packets.map((packet) => [packet.interview_issue_number, []]));
  const mockGh = (args, input) => {
    const endpoint = args.find((value) => typeof value === 'string' && (value.startsWith('repos/') || value.startsWith('search/')));
    if (endpoint.includes('/git/trees/')) return { tree: [] };
    const issueMatch = endpoint.match(/\/issues\/(\d+)(?:$|\/)/);
    if (args.includes('--method') && args.includes('POST')) {
      const number = Number(issueMatch[1]);
      const comment = { id: 8000 + posts.length, body: input.body, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${number}` };
      comments.get(number).push(comment);
      posts.push({ number, body: input.body });
      return comment;
    }
    if (endpoint.startsWith('search/issues?')) {
      const match = decodeURIComponent(endpoint).match(/"(xhs:[^"]+)"/);
      const sourceId = match && match[1];
      const packet = fixture.packets.find((candidate) => candidate.interview_note_id === sourceId);
      return { incomplete_results: false, total_count: 1, items: [{ number: packet.interview_issue_number }] };
    }
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      if (endpoint.endsWith('/comments?per_page=100&page=1')) return comments.get(number) || [];
      if (endpoint.endsWith('/comments?per_page=100&page=2')) return [];
      return issues.get(number);
    }
    throw new Error(`unexpected mock gh endpoint: ${endpoint}`);
  };
  const cliArgs = [
    '--manifest', path.resolve('data/issue-1577/source-review-manifest.json'),
    '--output', outputFile,
    '--progress', progressFile,
    '--progress-lock', lockFile,
    '--request-dir', requestDir,
    '--receipt-dir', receiptDir,
    '--apply',
    '--confirm-plan-sha256', 'b'.repeat(64),
    '--confirm-authorization-sha256', fixture.authorization,
    '--reviewed-at', '2026-09-07T00:00:00Z',
    '--get-backoff-ms', '0',
    '--min-mutation-interval-ms', '0',
  ];
  fs.writeFileSync(progressFile, `${JSON.stringify(initialProgress(fixture.packetSet, fixture.authorization))}\n`);
  const injected = {
    ghJson: mockGh,
    planBatch: () => ({ ...fixture.planBatch(), plan_sha256: 'b'.repeat(64) }),
    planFormalRequest: () => ({ ok: true }),
    writeReceipt: (packet, receipt) => {
      receiptWrites.push(packet.interview_issue_number);
      atomicWriteJson(path.join(receiptDir, `issue-${packet.interview_issue_number}.json`), receipt);
      throw new Error('receipt response lost after local durable write');
    },
  };
  try {
    const firstExit = runCli(cliArgs, injected);
    assert.equal(firstExit, 0, fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : 'no CLI output');
    const first = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(first.create_attempt_count, 17);
    assert.equal(first.receipt_attempt_count, 17);
    assert.equal(first.mutation_count, 34);
    assert.equal(posts.length, 17);
    assert.equal(receiptWrites.length, 17);
    assert.equal(fs.readdirSync(receiptDir).length, 17);

    const resume = runCli(cliArgs, { ...injected, writeReceipt: () => { throw new Error('resume must not write receipt'); } });
    assert.equal(resume, 0);
    const second = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(second.mutation_count, 34);
    assert.equal(posts.length, 17);
    assert.equal(receiptWrites.length, 17);

    const absentProgress = path.join(directory, 'absent-progress.json');
    const absentOutput = path.join(directory, 'absent-output.json');
    const absentLock = path.join(directory, 'absent-progress.lock');
    const absentRequestDir = path.join(directory, 'absent-requests');
    const absentReceiptDir = path.join(directory, 'absent-receipts');
    fs.writeFileSync(absentProgress, `${JSON.stringify(initialProgress(fixture.packetSet, fixture.authorization))}\n`);
    const absentArgs = [...cliArgs];
    for (const [flag, value] of [['--output', absentOutput], ['--progress', absentProgress], ['--progress-lock', absentLock], ['--request-dir', absentRequestDir], ['--receipt-dir', absentReceiptDir]]) absentArgs[absentArgs.indexOf(flag) + 1] = value;
    const absentExit = runCli(absentArgs, { ...injected, writeReceipt: () => { throw new Error('receipt was not durably written'); } });
    if (absentExit !== 1) throw new Error(`absent run unexpectedly succeeded: ${fs.readFileSync(absentOutput, 'utf8')}`);
    const absent = JSON.parse(fs.readFileSync(absentOutput, 'utf8'));
    assert.equal(absent.ok, false);
    assert.equal(absent.possibly_performed, true);
    assert.equal(absent.receipt_attempt_count, 1, JSON.stringify(absent));
    assert.equal(absent.mutation_count, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI receipt reader rejects traversal-shaped packets and malformed receipts, and returns null when absent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-reader-'));
  try {
    assert.equal(readReceiptFile(directory, { interview_issue_number: 1558 }), null);
    assert.throws(() => readReceiptFile(directory, { interview_issue_number: '../1558' }), /invalid/);
    const file = path.join(directory, 'issue-1558.json');
    fs.writeFileSync(file, '[]\n');
    assert.throws(() => readReceiptFile(directory, { interview_issue_number: 1558 }), /one JSON object/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function applyFixture(count = 1) {
  const base = require('../data/pilot/issue-1539/source-review-packets.json').packets[0];
  const packets = Array.from({ length: count }, (_, index) => {
    const issueNumber = 2000 + index;
    const sourceNumber = 1000 + index;
    const interviewBody = `interview-${index}`;
    const sourceBody = `source-${index}`;
    const request = {
      ...base.candidate_request,
      transition_id: `issue-1577-test-${index}`,
      issue_number: issueNumber,
      interview_note_id: `xhs:test-${index}`,
      expected_interview_body_sha256: sha256Text(interviewBody),
      expected_source_revision_id: `xhs-note:test-${index}:revision`,
      source_note_issue_number: sourceNumber,
      expected_source_note_body_sha256: sha256Text(sourceBody),
      expected_initial_status: 'captured',
    };
    delete request.recovery_mode;
    request.evidence_subject_sha256 = evidenceSubjectSha256(request, request.checks);
    return {
      ...base,
      packet_id: `issue-1577-test-${index}`,
      interview_issue_number: issueNumber,
      source_note_issue_number: sourceNumber,
      source_note_id: `xhs-note:test-${index}`,
      interview_note_id: request.interview_note_id,
      expected_interview_body_sha256: request.expected_interview_body_sha256,
      expected_source_note_body_sha256: request.expected_source_note_body_sha256,
      source_revision_id: request.expected_source_revision_id,
      evidence_subject_sha256: request.evidence_subject_sha256,
      candidate_request: request,
      packet_set_sha256: 'p'.repeat(64),
    };
  });
  const states = new Map(packets.map((packet) => [packet.packet_id, {
    packet,
    comments: [],
    receipt: null,
  }]));
  const packetSet = { packet_set_sha256: 'p'.repeat(64), packets };
  const authorization = 'a'.repeat(64);
  const pinnedArtifactManifest = { digest: 'm'.repeat(64) };
  const liveLoader = (item) => {
    const state = states.get(item.packet_id);
    return {
      interviewIssue: { number: state.packet.interview_issue_number, body: `interview-${state.packet.interview_issue_number - 2000}`, labels: ['status:captured'] },
      sourceIssue: { number: state.packet.source_note_issue_number, body: `source-${state.packet.source_note_issue_number - 1000}`, labels: [] },
      comments: state.comments,
      sourceComments: [],
      allIssues: [],
    };
  };
  const planBatch = () => ({
    ok: true,
    plan_sha256: 'q'.repeat(64),
    authorization_sha256: authorization,
    packetSet,
    pinnedArtifactManifest,
  });
  return { packets, states, packetSet, authorization, pinnedArtifactManifest, liveLoader, planBatch };
}

function applyFixtureOptions(fixture, progress, { writeReceipt, readReceipt, ...overrides } = {}) {
  const persists = [];
  const requests = [];
  let evidencePosts = 0;
  const options = {
    ...overrides,
    lock: overrides.lock || { assertHeld() {} },
    planBatch: fixture.planBatch,
    liveLoader: fixture.liveLoader,
    reviewedAt: '2026-09-07T00:00:00Z',
    persistProgress: (value) => persists.push(JSON.parse(JSON.stringify(value))),
    createEvidenceComment: (packet, body) => {
      evidencePosts += 1;
      const state = fixture.states.get(packet.packet_id);
      const comment = { id: 5000 + evidencePosts, body, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${packet.interview_issue_number}` };
      state.comments.push(comment);
      return comment;
    },
    planFormalRequest: () => ({ ok: true }),
    writeRequest: (packet, body, request) => requests.push({ packet, body, request }),
    writeReceipt: writeReceipt || ((packet, receipt) => { fixture.states.get(packet.packet_id).receipt = receipt; }),
    readReceipt: readReceipt || ((packet) => fixture.states.get(packet.packet_id).receipt),
  };
  return { options, persists, requests, get evidencePosts() { return evidencePosts; } };
}

test('17 evidence POSTs and 17 durable receipt writes count as 34 mutations', () => {
  const fixture = applyFixture(17);
  const progress = initialProgress(fixture.packetSet, fixture.authorization);
  const setup = applyFixtureOptions(fixture, progress);
  const result = applyBatch({ fixedManifest: {}, treeEntries: [], liveLoader: fixture.liveLoader, progress, expectedPlanSha256: 'q'.repeat(64), expectedAuthorizationSha256: fixture.authorization }, setup.options);
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(result.create_attempt_count, 17);
  assert.equal(result.receipt_attempt_count, 17);
  assert.equal(result.mutation_count, 34);
  assert.equal(setup.evidencePosts, 17);
  assert.equal(setup.requests.length, 17);
});

test('receipt writer failure after an uncertain outcome is recovered by exact read without a second write or counter increment', () => {
  const fixture = applyFixture(1);
  const progress = initialProgress(fixture.packetSet, fixture.authorization);
  let plannedReceipt = null;
  let writeCount = 0;
  const first = applyFixtureOptions(fixture, progress, {
    writeReceipt: (_packet, receipt) => { plannedReceipt = receipt; writeCount += 1; throw new Error('writer response lost'); },
  });
  const firstResult = applyBatch({ fixedManifest: {}, treeEntries: [], liveLoader: fixture.liveLoader, progress, expectedPlanSha256: 'q'.repeat(64), expectedAuthorizationSha256: fixture.authorization }, first.options);
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.possibly_performed, true);
  assert.equal(progress.intents[fixture.packets[0].packet_id].phase, 'receipt-uncertain');
  assert.deepEqual([progress.create_attempt_count, progress.receipt_attempt_count, progress.mutation_count], [1, 1, 2]);

  fixture.states.get(fixture.packets[0].packet_id).receipt = plannedReceipt;
  const second = applyFixtureOptions(fixture, progress, {
    writeReceipt: () => { writeCount += 1; throw new Error('must not retry receipt'); },
  });
  const secondResult = applyBatch({ fixedManifest: {}, treeEntries: [], liveLoader: fixture.liveLoader, progress, expectedPlanSha256: 'q'.repeat(64), expectedAuthorizationSha256: fixture.authorization }, second.options);
  assert.equal(secondResult.ok, true, secondResult.errors && secondResult.errors.join('; '));
  assert.equal(writeCount, 1);
  assert.deepEqual([progress.create_attempt_count, progress.receipt_attempt_count, progress.mutation_count], [1, 1, 2]);
  assert.equal(progress.intents[fixture.packets[0].packet_id].phase, 'complete');
  assert.equal(progress.results[fixture.packets[0].packet_id].receipt_written, true);
});

test('receipt response loss with no exact durable receipt remains uncertain and refuses a blind resume', () => {
  const fixture = applyFixture(1);
  const progress = initialProgress(fixture.packetSet, fixture.authorization);
  const setup = applyFixtureOptions(fixture, progress, {
    writeReceipt: () => { throw new Error('no response and no durable file'); },
  });
  const args = { fixedManifest: {}, treeEntries: [], liveLoader: fixture.liveLoader, progress, expectedPlanSha256: 'q'.repeat(64), expectedAuthorizationSha256: fixture.authorization };
  const first = applyBatch(args, setup.options);
  assert.equal(first.ok, false);
  const writesBeforeResume = setup.requests.length;
  const receiptWritesBeforeResume = progress.receipt_attempt_count;
  const second = applyBatch(args, { ...setup.options, writeReceipt: () => { throw new Error('blind retry'); } });
  assert.equal(second.ok, false);
  assert.equal(progress.possibly_performed, true);
  assert.equal(progress.receipt_attempt_count, receiptWritesBeforeResume);
  assert.equal(setup.requests.length, writesBeforeResume);
  assert.match(second.errors.join('\n'), /refusing retry|not exactly recoverable/);
});

test('evidence response-loss reconcile polls read-only until eventual consistency, without reposting', () => {
  const fixture = applyFixture(1);
  const progress = initialProgress(fixture.packetSet, fixture.authorization);
  const originalLoader = fixture.liveLoader;
  let reads = 0;
  fixture.liveLoader = (item) => {
    reads += 1;
    const snapshot = originalLoader(item);
    if (reads < 4) snapshot.comments = [];
    return snapshot;
  };
  const sleeps = [];
  const setup = applyFixtureOptions(fixture, progress, { evidenceReconcileAttempts: 3, evidenceReconcileBackoffMs: 10, sleep: (milliseconds) => sleeps.push(milliseconds) });
  const result = applyBatch({ fixedManifest: {}, treeEntries: [], liveLoader: fixture.liveLoader, progress, expectedPlanSha256: 'q'.repeat(64), expectedAuthorizationSha256: fixture.authorization }, setup.options);
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(setup.evidencePosts, 1);
  assert.equal(reads, 5);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(progress.create_attempt_count, 1);
  assert.equal(progress.receipt_attempt_count, 1);
});

test('lock loss during evidence reconcile stops without another POST', () => {
  const fixture = applyFixture(1);
  const progress = initialProgress(fixture.packetSet, fixture.authorization);
  const originalLoader = fixture.liveLoader;
  let reads = 0;
  fixture.liveLoader = (item) => { reads += 1; return originalLoader(item); };
  const lock = { assertHeld() { if (reads >= 2) throw new Error('lock lost during reconcile'); } };
  const setup = applyFixtureOptions(fixture, progress, { lock, evidenceReconcileAttempts: 3, evidenceReconcileBackoffMs: 0 });
  assert.throws(() => applyBatch({ fixedManifest: {}, treeEntries: [], liveLoader: fixture.liveLoader, progress, expectedPlanSha256: 'q'.repeat(64), expectedAuthorizationSha256: fixture.authorization }, setup.options), /lock lost during reconcile/);
  assert.equal(setup.evidencePosts, 1);
  assert.equal(reads, 2);
  assert.equal(progress.create_attempt_count, 1);
  assert.equal(progress.receipt_attempt_count, 0);
  assert.equal(progress.intents[fixture.packets[0].packet_id].phase, 'post-pending');
});
