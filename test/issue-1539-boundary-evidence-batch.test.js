'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { gitBlobSha } = require('../scripts/lib/issue-1539-boundary-expansion');
const {
  EVIDENCE_SCHEMA_VERSION,
  buildPacketSet,
  validatePacketSet,
  evidenceBody,
  evidenceRecord,
  inspectEvidence,
  liveSourceValidation,
  livePostGate,
  preflightPacketSet,
  initialProgress,
  validateProgress,
  intentFor,
  requestSha256,
  validateReceipt,
  runBatch,
  applyOne,
  acquireProgressLock,
} = require('../scripts/lib/issue-1539-boundary-evidence-batch');
const { atomicWriteText, atomicWriteJson, loadOwnership } = require('../scripts/apply-issue-1539-boundary-evidence-batch');

const candidateManifest = JSON.parse(fs.readFileSync('data/pilot/issue-1539/boundary-expansion-candidates.json', 'utf8'));
const sourceFixture = fs.readFileSync('test/fixtures/source-note-issue.valid.md', 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function syntheticSet() {
  const manifest = clone(candidateManifest);
  for (const item of manifest.items) {
    const bytes = Buffer.from(`真实单场面试 #${item.issue_number}\n${item.artifact.anchor}\n问题：请介绍项目。\n`, 'utf8');
    const blobSha = gitBlobSha(bytes);
    item.expected_body_sha256 = '0'.repeat(64);
    item.artifact.git_blob_sha = blobSha;
  }
  const packetSet = buildPacketSet(manifest);
  const lives = new Map();
  for (const packet of packetSet.packets) {
    const parsed = parseSourceNoteIssue(sourceFixture);
    const record = clone(parsed.record);
    const externalId = packet.source_note_id.slice('xhs-note:'.length);
    record.source_note_id = packet.source_note_id;
    record.source.external_id = externalId;
    record.source_revision.id = packet.expected_source_revision_id;
    record.source_revision.source_repository_ref = packet.expected_source_repository_ref;
    record.boundary_review = { status: 'pending', reviewed_at: null, interview_note_ids: [] };
    const bytes = Buffer.from(`真实单场面试 #${packet.issue_number}\n${packet.artifact.anchor}\n问题：请介绍项目。\n`, 'utf8');
    record.artifacts.push({ kind: 'text_projection', ref: packet.artifact.ref, git_blob_sha: packet.artifact.git_blob_sha, sha256: null, provenance: 'source_projection', byte_size: bytes.length, integrity: 'present' });
    let body = sourceFixture.replace(/<!-- source-note: id=[^>]+ -->/, `<!-- source-note: id=${packet.source_note_id} schema=source-note-issue.v1 -->`);
    body = body.replace(/<!-- source-note-record\n[\s\S]*?\n-->/, `<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->`);
    const bodySha = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    manifest.items.find((item) => item.issue_number === packet.issue_number).expected_body_sha256 = bodySha;
    lives.set(packet.packet_id, { body, sourceIssue: { number: packet.issue_number, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'source-year:2022'] }, blob: { sha: packet.artifact.git_blob_sha, encoding: 'base64', content: bytes.toString('base64') }, comments: [], allIssues: [] });
  }
  // Rebuild after body SHA updates so packet facts and subject digests match the live fixtures.
  const rebuilt = buildPacketSet(manifest);
  for (const packet of rebuilt.packets) {
    const live = lives.get(packet.packet_id);
    live.sourceIssue.body = live.body;
  }
  return { manifest, packetSet: rebuilt, lives };
}

function loader(state) {
  return (packet) => {
    const live = state.lives.get(packet.packet_id);
    return { sourceIssue: live.sourceIssue, comments: live.comments, readBlob: () => live.blob, allIssues: live.allIssues };
  };
}

test('packet set is deterministic, fixed to 17 items, and never source-ready', () => {
  const first = syntheticSet();
  const second = syntheticSet();
  assert.equal(validatePacketSet(first.packetSet, first.manifest).ok, true);
  assert.equal(first.packetSet.packet_set_sha256, second.packetSet.packet_set_sha256);
  assert.equal(first.packetSet.packets.length, 17);
  assert.equal(first.packetSet.source_ready_claimed, false);
  assert.equal(first.packetSet.packets[0].evidence_subject_sha256, second.packetSet.packets[0].evidence_subject_sha256);
});

test('evidence subject excludes comment locator and reviewed_at while body binds all packet facts', () => {
  const { packetSet } = syntheticSet();
  const packet = packetSet.packets[0];
  const subject = packet.evidence_subject_sha256;
  const body = evidenceBody(packet, packetSet.packet_set_sha256);
  assert.match(body, new RegExp(EVIDENCE_SCHEMA_VERSION));
  assert.match(body, new RegExp(packet.artifact.git_blob_sha));
  assert.match(body, new RegExp(subject));
  assert.doesNotMatch(body, /comment_id|reviewed_at/);
  assert.equal(evidenceRecord(packet, packetSet.packet_set_sha256).evidence_subject_sha256, subject);
});

test('exact evidence reentry accepts optional repository_url only when issue_url is exact', () => {
  const { packetSet } = syntheticSet();
  const packet = packetSet.packets[0];
  const exact = { id: 501, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body: evidenceBody(packet, packetSet.packet_set_sha256) };
  assert.equal(inspectEvidence([exact], packet, packetSet.packet_set_sha256).exact, true);
  const wrongRepo = { ...exact, repository_url: 'https://api.github.com/repos/other/repo' };
  assert.equal(inspectEvidence([wrongRepo], packet, packetSet.packet_set_sha256).ok, false);
  const wrongIssue = { ...exact, issue_url: `https://api.github.com/repos/${packet.repository}/issues/999` };
  assert.equal(inspectEvidence([wrongIssue], packet, packetSet.packet_set_sha256).ok, false);
  assert.equal(inspectEvidence([exact, { ...exact, id: 502 }], packet, packetSet.packet_set_sha256).ok, false);
});

test('preflight verifies all 17 live SourceNotes and predicts only evidence POSTs', () => {
  const state = syntheticSet();
  const result = preflightPacketSet(state.packetSet, state.manifest, loader(state));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.items.length, 17);
  assert.equal(result.items.filter((item) => item.action === 'would-post-evidence').length, 17);
  assert.equal(result.items.every((item) => item.ownership.count === 0), true);
});

test('initial exact marker is re-gated before request/receipt and rejects every fresh-read race', () => {
  const races = {
    body: (live) => { live.sourceIssue.body = 'changed before request'; },
    labels: (live) => { live.sourceIssue.labels = live.sourceIssue.labels.filter((label) => label !== 'task:boundary-review'); },
    revision: (live, packet) => { live.sourceIssue.body = live.sourceIssue.body.replace(packet.expected_source_revision_id, `${packet.expected_source_revision_id}-changed`); },
    artifact: (live) => { live.blob.content = Buffer.from('changed before request', 'utf8').toString('base64'); },
    ownership: (live, packet) => { live.allIssues = [{ number: 1100, pull_request: false, body: `<!-- interview-note: id=xhs:${packet.source_note_id.slice('xhs-note:'.length)} schema=interview-note-issue.v2 -->` }]; },
    duplicate: (live, packet, packetSetSha) => { live.comments.push({ id: 902, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body: evidenceBody(packet, packetSetSha) }); },
    comment_id: (live, packet, packetSetSha) => { live.comments = [{ id: 903, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body: evidenceBody(packet, packetSetSha) }]; },
  };
  for (const [name, mutate] of Object.entries(races)) {
    const state = syntheticSet();
    const packet = state.packetSet.packets[0];
    const statePacketSetSha = state.packetSet.packet_set_sha256;
    const initialComment = { id: 901, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body: evidenceBody(packet, statePacketSetSha) };
    state.lives.get(packet.packet_id).comments = [initialComment];
    const originalLoader = loader(state);
    let reads = 0;
    let posts = 0;
    let requests = 0;
    let receipts = 0;
    const progress = initialProgress(statePacketSetSha, state.packetSet.packets.map((item) => item.packet_id));
    const result = applyOne(packet, state.packetSet, progress, {
      liveLoader: (currentPacket) => {
        reads += 1;
        if (reads === 2) mutate(state.lives.get(currentPacket.packet_id), currentPacket, state.packetSet.packet_set_sha256);
        return originalLoader(currentPacket);
      },
      reviewedAt: '2026-09-05T00:00:00Z',
      persistProgress: () => {},
      createEvidenceComment: () => { posts += 1; },
      writeRequest: () => { requests += 1; },
      writeReceipt: () => { receipts += 1; },
    });
    assert.equal(result.ok, false, name);
    assert.equal(posts, 0, name);
    assert.equal(requests, 0, name);
    assert.equal(receipts, 0, name);
  }
});

test('fresh post-hook gate consumes a concurrent exact marker and skips POST', () => {
  const state = syntheticSet();
  const packet = state.packetSet.packets[0];
  const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((item) => item.packet_id));
  let hooks = 0;
  let posts = 0;
  const result = applyOne(packet, state.packetSet, progress, {
    liveLoader: loader(state),
    reviewedAt: '2026-09-05T00:00:00Z',
    persistProgress: () => {},
    beforeEvidencePost: () => {
      hooks += 1;
      state.lives.get(packet.packet_id).comments.push({ id: 801, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body: evidenceBody(packet, state.packetSet.packet_set_sha256) });
    },
    createEvidenceComment: () => { posts += 1; },
    writeRequest: () => {},
    writeReceipt: () => {},
  });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(hooks, 1);
  assert.equal(posts, 0);
  assert.equal(result.item.evidence_action, 'already-present-skip-post');
  assert.equal(progress.results[packet.packet_id].mutation_attempted, false);
});

test('fresh post-hook duplicate or conflicting marker fails closed without POST', () => {
  for (const mode of ['duplicate', 'conflict']) {
    const state = syntheticSet();
    const packet = state.packetSet.packets[0];
    const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((item) => item.packet_id));
    let posts = 0;
    const result = applyOne(packet, state.packetSet, progress, {
      liveLoader: loader(state),
      reviewedAt: '2026-09-05T00:00:00Z',
      persistProgress: () => {},
      beforeEvidencePost: () => {
        const body = mode === 'conflict'
          ? evidenceBody(packet, state.packetSet.packet_set_sha256).replace(packet.evidence_subject_sha256, '0'.repeat(64))
          : evidenceBody(packet, state.packetSet.packet_set_sha256);
        state.lives.get(packet.packet_id).comments.push({ id: mode === 'duplicate' ? 802 : 803, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body });
        if (mode === 'duplicate') state.lives.get(packet.packet_id).comments.push({ id: 804, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body });
      },
      createEvidenceComment: () => { posts += 1; },
      writeRequest: () => {},
      writeReceipt: () => {},
    });
    assert.equal(result.ok, false, mode);
    assert.equal(posts, 0, mode);
    assert.equal(progress.results[packet.packet_id].status, 'post-gate-failed', mode);
    assert.equal(validateProgress(progress, state.packetSet).ok, true, mode);
  }
});

test('post-hook ownership recheck blocks a POST when an owner appears after preflight', () => {
  const state = syntheticSet();
  const packet = state.packetSet.packets[0];
  const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((item) => item.packet_id));
  let posts = 0;
  const externalId = packet.source_note_id.slice('xhs-note:'.length);
  const result = runBatch(state.packetSet, state.manifest, {
    apply: true,
    progress,
    liveLoader: loader(state),
    reviewedAt: '2026-09-05T00:00:00Z',
    beforeEvidencePost: () => {
      state.lives.get(packet.packet_id).allIssues = [{ number: 999, pull_request: false, body: `<!-- interview-note: id=xhs:${externalId} schema=interview-note-issue.v2 -->` }];
    },
    persistProgress: () => {},
    createEvidenceComment: () => { posts += 1; },
    writeRequest: () => {},
    writeReceipt: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(posts, 0);
  assert.match(result.errors.join('\n'), /ownership/);
});

test('post-POST fresh source/artifact/ownership drift never writes request or receipt', () => {
  const drifts = {
    body: (live) => { live.sourceIssue.body = 'changed after evidence POST'; },
    labels: (live) => { live.sourceIssue.labels = live.sourceIssue.labels.filter((label) => label !== 'task:boundary-review'); },
    revision: (live, packet) => { live.sourceIssue.body = live.sourceIssue.body.replace(packet.expected_source_revision_id, `${packet.expected_source_revision_id}-changed`); },
    artifact: (live) => { live.blob.content = Buffer.from('different pinned content', 'utf8').toString('base64'); },
    ownership: (live, packet) => { live.allIssues = [{ number: 1000, pull_request: false, body: `<!-- interview-note: id=xhs:${packet.source_note_id.slice('xhs-note:'.length)} schema=interview-note-issue.v2 -->` }]; },
  };
  for (const [name, mutate] of Object.entries(drifts)) {
    const state = syntheticSet();
    const packet = state.packetSet.packets[0];
    const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((item) => item.packet_id));
    let posts = 0;
    let requests = 0;
    let receipts = 0;
    const result = applyOne(packet, state.packetSet, progress, {
      liveLoader: loader(state),
      reviewedAt: '2026-09-05T00:00:00Z',
      persistProgress: () => {},
      createEvidenceComment: (currentPacket, body) => {
        posts += 1;
        state.lives.get(currentPacket.packet_id).comments.push({ id: 805, issue_url: `https://api.github.com/repos/${currentPacket.repository}/issues/${currentPacket.issue_number}`, body });
        mutate(state.lives.get(currentPacket.packet_id), currentPacket);
      },
      writeRequest: () => { requests += 1; },
      writeReceipt: () => { receipts += 1; },
    });
    assert.equal(result.ok, false, name);
    assert.equal(posts, 1, name);
    assert.equal(requests, 0, name);
    assert.equal(receipts, 0, name);
    assert.equal(progress.results[packet.packet_id].status, 'published-validation-failed', name);
    assert.equal(progress.results[packet.packet_id].mutation_performed, true, name);
    assert.equal(progress.possibly_performed, false, name);
  }
});

test('successful POST builds the formal plan from the fresh SourceNote reread', () => {
  const state = syntheticSet();
  const packet = state.packetSet.packets[0];
  const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((item) => item.packet_id));
  let plannedIssue = null;
  const result = applyOne(packet, state.packetSet, progress, {
    liveLoader: loader(state),
    reviewedAt: '2026-09-05T00:00:00Z',
    persistProgress: () => {},
    createEvidenceComment: (currentPacket, body) => {
      const live = state.lives.get(currentPacket.packet_id);
      live.comments.push({ id: 806, issue_url: `https://api.github.com/repos/${currentPacket.repository}/issues/${currentPacket.issue_number}`, body });
      live.sourceIssue = { ...live.sourceIssue, labels: [...live.sourceIssue.labels, 'concurrent:unrelated-label'] };
    },
    planTransition: (_request, sourceIssue) => {
      plannedIssue = sourceIssue;
      return { ok: true };
    },
    writeRequest: () => {},
    writeReceipt: () => {},
  });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.ok(plannedIssue);
  assert.equal(plannedIssue.labels.includes('concurrent:unrelated-label'), true);
});

test('live SourceNote labels use strict normalization and reject malformed REST values', () => {
  const state = syntheticSet();
  const packet = state.packetSet.packets[0];
  for (const labels of [null, [null], [{ name: null }], [42]]) {
    const issue = { ...state.lives.get(packet.packet_id).sourceIssue, labels };
    const result = liveSourceValidation(packet, issue);
    assert.equal(result.ok, false, JSON.stringify(labels));
    assert.match(result.errors.join('\n'), /labels|missing/);
  }
  assert.equal(livePostGate(packet, state.packetSet, loader(state)(packet)).ok, true);
});

test('ownership loader requires exact non-negative totals and complete pagination', () => {
  const issue = (number) => ({ number, pull_request: false, body: '<!-- interview-note: id=xhs:test schema=interview-note-issue.v2 -->' });
  assert.throws(() => loadOwnership('liqiangcc/interview-lab', 'xhs:test', { readPage: () => ({ incomplete_results: false, items: [] }), readIssue: issue }), /total_count|malformed/);
  assert.throws(() => loadOwnership('liqiangcc/interview-lab', 'xhs:test', { readPage: () => ({ incomplete_results: false, total_count: 2, items: [{ number: 1 }] }), readIssue: issue }), /short page/);
  assert.throws(() => loadOwnership('liqiangcc/interview-lab', 'xhs:test', { readPage: (page) => page === 1
    ? { incomplete_results: false, total_count: 101, items: Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) }
    : { incomplete_results: false, total_count: 102, items: [{ number: 101 }] }, readIssue: issue }), /total_count/);
  const pages = [
    { incomplete_results: false, total_count: 101, items: Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) },
    { incomplete_results: false, total_count: 101, items: [{ number: 101 }] },
  ];
  assert.equal(loadOwnership('liqiangcc/interview-lab', 'xhs:test', { readPage: (page) => pages[page - 1], readIssue: issue }).length, 101);
});

test('boundary evidence writers round-trip durable text and JSON outputs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1549-durable-'));
  try {
    const textPath = path.join(directory, 'request.md');
    const jsonPath = path.join(directory, 'progress.json');
    atomicWriteText(textPath, 'plain marker text');
    atomicWriteJson(jsonPath, { status: 'running' });
    assert.equal(fs.readFileSync(textPath, 'utf8'), 'plain marker text');
    assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), { status: 'running' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('apply response loss recovers a live exact comment once, writes requests/receipts, and reentry posts zero', () => {
  const state = syntheticSet();
  const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((packet) => packet.packet_id));
  const persisted = [];
  const requests = [];
  const receipts = [];
  let postCount = 0;
  let hookCount = 0;
  const events = [];
  const options = {
    apply: true,
    manifest: state.manifest,
    progress,
    liveLoader: loader(state),
    reviewedAt: '2026-09-05T00:00:00Z',
    persistProgress: (value) => {
      persisted.push(clone(value));
      events.push(`persist:${value.mutation_attempted}:${value.mutation_performed}:${value.possibly_performed}`);
      if (value.mutation_attempted === true
        && value.mutation_performed === null
        && value.possibly_performed === true
        && Object.values(value.intents).some((intent) => intent?.phase === 'evidence-post-pending')) {
        assert.match(events.at(-2), /^hook:/);
      }
    },
    beforeEvidencePost: (packet) => {
      hookCount += 1;
      events.push(`hook:${packet.packet_id}`);
    },
    createEvidenceComment: (packet, body) => {
      postCount += 1;
      assert.equal(events.at(-1), 'persist:true:null:true');
      events.push(`post:${packet.packet_id}`);
      assert.equal(events.at(-2), 'persist:true:null:true');
      const live = state.lives.get(packet.packet_id);
      live.comments.push({ id: 700 + postCount, issue_url: `https://api.github.com/repos/${packet.repository}/issues/${packet.issue_number}`, body });
      return null;
    },
    writeRequest: (packet, body, request) => requests.push({ packet: packet.packet_id, body, request }),
    writeReceipt: (packet, receipt) => receipts.push({ packet: packet.packet_id, receipt }),
  };
  const applied = runBatch(state.packetSet, state.manifest, options);
  assert.equal(applied.ok, true, applied.errors?.join('\n'));
  assert.equal(postCount, 17);
  assert.equal(hookCount, 17);
  const firstPacketId = state.packetSet.packets[0].packet_id;
  assert.deepEqual(events.slice(0, 4), [
    'persist:false:false:false',
    `hook:${firstPacketId}`,
    'persist:true:null:true',
    `post:${firstPacketId}`,
  ]);
  assert.deepEqual(persisted[0].intents[firstPacketId].phase, 'evidence-post-pending');
  assert.equal(persisted[0].mutation_attempted, false);
  assert.equal(persisted[0].mutation_performed, false);
  assert.equal(persisted[0].possibly_performed, false);
  const prePostSnapshot = persisted.find((snapshot) => snapshot.intents[firstPacketId].phase === 'evidence-post-pending' && snapshot.mutation_attempted === true);
  assert.equal(prePostSnapshot.mutation_performed, null);
  assert.equal(prePostSnapshot.possibly_performed, true);
  assert.equal(requests.length, 17);
  assert.equal(receipts.length, 17);
  assert.equal(applied.progress.status, 'complete');
  const reentry = runBatch(state.packetSet, state.manifest, { ...options, progress: applied.progress, createEvidenceComment: () => { throw new Error('duplicate POST'); } });
  assert.equal(reentry.ok, true, reentry.errors?.join('\n'));
  assert.equal(reentry.items.every((item) => item.evidence_action === 'already-present-skip-post'), true);
  assert.equal(postCount, 17);
  assert.equal(hookCount, 17);
});

test('beforeEvidencePost failure is durable fail-closed and does not attempt POST', () => {
  const state = syntheticSet();
  const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((packet) => packet.packet_id));
  const persisted = [];
  let hookCount = 0;
  let postCount = 0;
  const first = runBatch(state.packetSet, state.manifest, {
    apply: true,
    progress,
    liveLoader: loader(state),
    reviewedAt: '2026-09-05T00:00:00Z',
    persistProgress: (value) => persisted.push(clone(value)),
    beforeEvidencePost: () => {
      hookCount += 1;
      throw new Error('interval clock unavailable');
    },
    createEvidenceComment: () => { postCount += 1; },
    writeRequest: () => {},
    writeReceipt: () => {},
  });
  const packetId = state.packetSet.packets[0].packet_id;
  assert.equal(first.ok, false);
  assert.equal(hookCount, 1);
  assert.equal(postCount, 0);
  assert.equal(first.mutation_attempted, false);
  assert.equal(first.mutation_performed, false);
  assert.equal(first.possibly_performed, false);
  assert.equal(progress.intents[packetId].phase, 'evidence-post-hook-failed');
  assert.deepEqual(progress.results[packetId], {
    status: 'post-hook-failed',
    evidence_comment_id: null,
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    error: 'interval clock unavailable',
  });
  assert.equal(persisted.at(-1).intents[packetId].phase, 'evidence-post-hook-failed');
  assert.equal(persisted.every((snapshot) => snapshot.mutation_attempted === false && snapshot.mutation_performed === false && snapshot.possibly_performed === false), true);
  assert.equal(validateProgress(progress, state.packetSet).ok, true);
});

test('unconfirmed POST is uncertain and recovery refuses a second POST', () => {
  const state = syntheticSet();
  const progress = initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((packet) => packet.packet_id));
  let postCount = 0;
  const options = { apply: true, manifest: state.manifest, progress, liveLoader: loader(state), reviewedAt: '2026-09-05T00:00:00Z', persistProgress: () => {}, createEvidenceComment: () => { postCount += 1; throw new Error('response lost'); }, writeRequest: () => {}, writeReceipt: () => {} };
  const first = runBatch(state.packetSet, state.manifest, options);
  assert.equal(first.ok, false);
  assert.equal(first.mutation_attempted, true);
  assert.equal(first.mutation_performed, null);
  assert.equal(first.possibly_performed, true);
  const packetId = state.packetSet.packets[0].packet_id;
  assert.equal(progress.intents[packetId].phase, 'evidence-post-uncertain');
  const second = runBatch(state.packetSet, state.manifest, { ...options, progress, createEvidenceComment: () => { postCount += 1; throw new Error('must not retry'); } });
  assert.equal(second.ok, false);
  assert.equal(postCount, 1);
});

test('stale body or label drift blocks the whole batch before any POST', () => {
  const state = syntheticSet();
  const packet = state.packetSet.packets[3];
  state.lives.get(packet.packet_id).sourceIssue.labels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview', 'task:boundary-review'];
  let posts = 0;
  const result = runBatch(state.packetSet, state.manifest, { apply: true, progress: initialProgress(state.packetSet.packet_set_sha256, state.packetSet.packets.map((item) => item.packet_id)), liveLoader: loader(state), persistProgress: () => {}, createEvidenceComment: () => { posts += 1; }, writeRequest: () => {}, writeReceipt: () => {}, reviewedAt: '2026-09-05T00:00:00Z' });
  assert.equal(result.ok, false);
  assert.equal(posts, 0);
  assert.match(result.errors.join('\n'), /boundary|missing/);
});

test('progress and receipt identities are strict and lock is exclusive', () => {
  const { packetSet } = syntheticSet();
  const progress = initialProgress(packetSet.packet_set_sha256, packetSet.packets.map((packet) => packet.packet_id));
  progress.intents[packetSet.packets[0].packet_id] = { ...intentFor(packetSet.packet_set_sha256, packetSet.packets[0], 'evidence-post-pending'), packet_set_sha256: '0'.repeat(64) };
  assert.equal(validateProgress(progress, packetSet).ok, false);
  const packet = packetSet.packets[0];
  const receipt = { schema_version: 'wrong', packet_set_sha256: packetSet.packet_set_sha256, packet_id: packet.packet_id };
  assert.equal(validateReceipt(receipt, packet, packetSet.packet_set_sha256).ok, false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1549-lock-'));
  const lockPath = path.join(directory, 'progress.lock');
  const first = acquireProgressLock(lockPath);
  try { assert.throws(() => acquireProgressLock(lockPath), /progress lock is held/); } finally { first.release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('formal request receipt binds request digest and no lifecycle mutation is included', () => {
  const state = syntheticSet();
  const packet = state.packetSet.packets[0];
  const request = { schema_version: 'source-note-boundary-review-transition.v1', transition_id: packet.transition_id, repository: packet.repository, issue_number: packet.issue_number, source_note_id: packet.source_note_id, expected_body_sha256: packet.expected_body_sha256, expected_boundary_status: 'pending', expected_source_revision_id: packet.expected_source_revision_id, expected_manifest_sha256: null, expected_source_repository_ref: packet.expected_source_repository_ref, decision: 'single-interview', reviewed_at: '2026-09-05T00:00:00Z', reviewer_kind: 'ai-assisted', review_evidence: { repository: packet.repository, issue_number: packet.issue_number, comment_id: 1 }, checks: packet.checks, limitations: packet.limitations };
  const receipt = { schema_version: 'issue-1549-boundary-review-evidence-receipt.v1', packet_set_sha256: state.packetSet.packet_set_sha256, packet_id: packet.packet_id, transition_id: packet.transition_id, repository: packet.repository, issue_number: packet.issue_number, source_note_issue_number: packet.source_note_issue_number, source_note_id: packet.source_note_id, expected_body_sha256: packet.expected_body_sha256, expected_source_revision_id: packet.expected_source_revision_id, evidence_subject_sha256: packet.evidence_subject_sha256, evidence_comment_id: 1, request_sha256: requestSha256(request) };
  assert.equal(validateReceipt(receipt, packet, state.packetSet.packet_set_sha256, request).ok, true);
  assert.equal(Object.keys(request).includes('labels'), false);
});
