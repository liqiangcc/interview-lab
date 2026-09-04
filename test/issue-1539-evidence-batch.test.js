'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256Text } = require('../scripts/lib/issue-1539-recovery-plan');
const { parseRequest, evidenceSubjectSha256 } = require('../scripts/lib/interview-note-source-review-transition');
const {
  evidenceBody,
  inspectEvidence,
  buildFormalRequest,
  requestBody,
  validateLivePacket,
  validateEvidenceBodySize,
  initialProgress,
  intentFor,
  validateProgress,
  acquireProgressLock,
  lockIsStale,
  applyEvidenceItem,
} = require('../scripts/lib/issue-1539-evidence-batch');
const { writeFormalRequestFiles } = require('../scripts/apply-issue-1539-source-review-evidence-batch');

const packetSet = JSON.parse(fs.readFileSync('data/pilot/issue-1539/source-review-packets.json', 'utf8'));
const basePacket = packetSet.packets[0];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function testPacket() {
  const packet = copy(basePacket);
  packet.expected_interview_body_sha256 = sha256Text('interview-body');
  packet.expected_source_note_body_sha256 = sha256Text('source-body');
  packet.candidate_request.expected_interview_body_sha256 = packet.expected_interview_body_sha256;
  packet.candidate_request.expected_source_note_body_sha256 = packet.expected_source_note_body_sha256;
  packet.candidate_request.evidence_subject_sha256 = evidenceSubjectSha256(packet.candidate_request, packet.candidate_request.checks);
  packet.evidence_subject_sha256 = packet.candidate_request.evidence_subject_sha256;
  return packet;
}

function issue(packet, body, labels = ['type:interview-note', 'status:blocked', 'task:source-recovery']) {
  return { number: packet.interview_issue_number, body, labels };
}

function sourceIssue(packet, body) {
  return { number: packet.source_note_issue_number, body, labels: ['type:source-note', 'status:captured', 'boundary:single-interview'] };
}

function comment(packet, id = 42, packetSetSha256 = null) {
  return {
    id,
    repository_url: `https://api.github.com/repos/${packet.candidate_request.repository}`,
    issue_url: `https://api.github.com/repos/${packet.candidate_request.repository}/issues/${packet.interview_issue_number}`,
    body: evidenceBody(packet, packetSetSha256),
  };
}

function applyOptions(packet, comments, createEvidenceComment, progress = initialProgress('p'.repeat(64), [packet.packet_id])) {
  const writes = [];
  const persists = [];
  return {
    progress,
    options: {
      liveLoader: () => ({ interviewIssue: issue(packet, 'interview-body'), sourceIssue: sourceIssue(packet, 'source-body'), comments }),
      createEvidenceComment,
      planFormalRequest: () => ({ ok: true }),
      pinnedArtifactManifest: { digest: 'm'.repeat(64) },
      persistProgress: (value) => persists.push(copy(value)),
      writeRequest: (_packet, body, request) => writes.push({ body, request: copy(request) }),
      reviewedAt: '2026-09-05T00:00:00Z',
    },
    writes,
    persists,
  };
}

test('evidence marker and formal request bind all facts without lifecycle labels', () => {
  const packet = testPacket();
  const existing = comment(packet);
  assert.match(existing.body, new RegExp(packet.source_facts.source_revision.id));
  assert.match(existing.body, new RegExp(packet.interview_facts.interview_note_id));
  const inspected = inspectEvidence([existing], packet);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.exact, true);
  const request = buildFormalRequest(packet, existing.id, '2026-09-05T00:00:00Z');
  assert.equal(request.reviewer_kind, 'ai-assisted');
  assert.deepEqual(request.review_evidence, { repository: request.repository, issue_number: request.issue_number, comment_id: 42 });
  assert.equal(request.expected_source_note_body_sha256, packet.expected_source_note_body_sha256);
});

test('formal request Markdown is written as text and round-trips through parseRequest', () => {
  const packet = testPacket();
  const request = buildFormalRequest(packet, 42, '2026-09-05T00:00:00Z');
  const body = requestBody(request);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-request-'));
  try {
    writeFormalRequestFiles(directory, packet, body, request);
    const written = fs.readFileSync(path.join(directory, `issue-${packet.interview_issue_number}.md`), 'utf8');
    assert.equal(written, body);
    assert.notEqual(written[0], '"');
    const parsed = parseRequest(written);
    assert.equal(parsed.errors.length, 0, parsed.errors.join('; '));
    assert.equal(parsed.request.review_evidence.comment_id, 42);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('conflicting or multiple evidence markers fail closed', () => {
  const packet = testPacket();
  const exact = comment(packet, 42);
  const conflict = { ...comment(packet, 43), body: evidenceBody(packet).replace(packet.evidence_subject_sha256, '0'.repeat(64)) };
  assert.equal(inspectEvidence([conflict], packet).ok, false);
  const multiple = inspectEvidence([exact, comment(packet, 43)], packet);
  assert.equal(multiple.ok, false);
  assert.match(multiple.errors.join('\n'), /multiple/);
});

test('live CAS requires exact body SHAs, blocked status, and recovery task', () => {
  const packet = testPacket();
  assert.equal(validateLivePacket(packet, issue(packet, 'interview-body'), sourceIssue(packet, 'source-body')).ok, true);
  assert.equal(validateLivePacket(packet, issue(packet, 'interview-body', ['type:interview-note', 'status:source-ready', 'task:source-recovery']), sourceIssue(packet, 'source-body')).ok, false);
  assert.equal(validateLivePacket(packet, issue(packet, 'changed'), sourceIssue(packet, 'source-body')).ok, false);
});

test('exact re-entry skips POST and still generates the formal request', () => {
  const packet = testPacket();
  const comments = [comment(packet, 42, 'p'.repeat(64))];
  let postCount = 0;
  const setup = applyOptions(packet, comments, () => { postCount += 1; throw new Error('must not post'); });
  const result = applyEvidenceItem(packet, setup.progress.packet_set_sha256, setup.progress, setup.options);
  assert.equal(result.ok, true);
  assert.equal(result.mutation_performed, false);
  assert.equal(postCount, 0);
  assert.equal(setup.writes[0].request.review_evidence.comment_id, 42);
  assert.equal(setup.progress.results[packet.packet_id].lifecycle_transition_performed, false);
});

test('formal request generation requires the production planner dry-run and pinned manifest', () => {
  const packet = testPacket();
  const comments = [];
  const setup = applyOptions(packet, comments, (_packet, body) => {
    const created = { ...comment(packet, 77, setup.progress.packet_set_sha256), body };
    comments.push(created);
    return created;
  });
  let plannerCall = null;
  setup.options.planFormalRequest = (request, interviewIssue, plannerOptions) => {
    plannerCall = { request, interviewIssue, plannerOptions };
    return { ok: true };
  };
  const result = applyEvidenceItem(packet, setup.progress.packet_set_sha256, setup.progress, setup.options);
  assert.equal(result.ok, true);
  assert.equal(plannerCall.plannerOptions.planningOnly, true);
  assert.equal(plannerCall.plannerOptions.evidenceComment.id, 77);
  assert.equal(plannerCall.plannerOptions.pinnedArtifactManifest.digest, 'm'.repeat(64));
  assert.equal(plannerCall.request.review_evidence.comment_id, 77);
});

test('lost POST response recovers exact live comment and never retries', () => {
  const packet = testPacket();
  const comments = [];
  let postCount = 0;
  const setup = applyOptions(packet, comments, (_packet, body) => {
    postCount += 1;
    comments.push({ ...comment(packet, 99), body });
    throw new Error('response lost');
  });
  const result = applyEvidenceItem(packet, setup.progress.packet_set_sha256, setup.progress, setup.options);
  assert.equal(result.ok, true);
  assert.equal(postCount, 1);
  assert.equal(result.item.transition_request.review_evidence.comment_id, 99);
  assert.equal(setup.progress.intents[packet.packet_id].phase, 'request-generated');
});

test('unconfirmed POST is reported as attempted and possibly performed, never as not performed', () => {
  const packet = testPacket();
  const comments = [];
  const setup = applyOptions(packet, comments, () => { throw new Error('response lost'); });
  const result = applyEvidenceItem(packet, setup.progress.packet_set_sha256, setup.progress, setup.options);
  assert.equal(result.ok, false);
  assert.equal(result.mutation_attempted, true);
  assert.equal(result.mutation_performed, null);
  assert.equal(result.possibly_performed, true);
  assert.equal(setup.progress.mutation_attempted, true);
  assert.equal(setup.progress.mutation_performed, null);
  assert.equal(setup.progress.possibly_performed, true);
  assert.deepEqual(setup.progress.results[packet.packet_id], {
    evidence_comment_id: null,
    mutation_attempted: true,
    mutation_performed: null,
    possibly_performed: true,
    status: 'uncertain-post',
  });
});

test('evidence identity includes the packet-set digest', () => {
  const packet = testPacket();
  const exact = comment(packet, 42, 'p'.repeat(64));
  assert.equal(inspectEvidence([exact], packet, 'p'.repeat(64)).exact, true);
  const stale = inspectEvidence([exact], packet, 'q'.repeat(64));
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join('\n'), /packet_set_sha256 mismatch/);
});

test('progress rejects a tampered immutable item identity', () => {
  const packet = testPacket();
  const progress = initialProgress('p'.repeat(64), [packet.packet_id]);
  progress.intents[packet.packet_id] = {
    schema_version: 'issue-1539-evidence-apply-intent.v1',
    intent_id: 'i'.repeat(64),
    packet_set_sha256: 'p'.repeat(64),
    packet_id: packet.packet_id,
    issue_number: packet.interview_issue_number,
    source_note_issue_number: packet.source_note_issue_number,
    interview_note_id: packet.interview_note_id,
    evidence_subject_sha256: '0'.repeat(64),
    phase: 'evidence-post-pending',
  };
  const validation = validateProgress(progress, { packet_set_sha256: 'p'.repeat(64), packets: [packet] });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /fact binding/);
});

test('progress phase and intent id are fail-closed and cannot bypass duplicate POST protection', () => {
  const packet = testPacket();
  const progress = initialProgress('p'.repeat(64), [packet.packet_id]);
  progress.intents[packet.packet_id] = { ...intentFor(progress.packet_set_sha256, packet, 'tampered') };
  const validation = validateProgress(progress, { packet_set_sha256: progress.packet_set_sha256, packets: [packet] });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /phase is not allowed/);
  const setup = applyOptions(packet, [], () => { throw new Error('must not post'); }, progress);
  const result = applyEvidenceItem(packet, progress.packet_set_sha256, progress, setup.options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /refusing duplicate POST/);
});

test('preflight evidence body size check measures UTF-8 bytes against the GitHub limit', () => {
  const packet = testPacket();
  packet.source_facts.padding = '字'.repeat(22000);
  const result = validateEvidenceBodySize(packet, 'p'.repeat(64));
  assert.equal(result.ok, false);
  assert.ok(result.bytes > 65536);
  assert.match(result.errors.join('\n'), /UTF-8 bytes/);
});

test('two concurrent processes cannot both enter the evidence POST critical section', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-lock-'));
  const lockPath = path.join(directory, 'progress.lock');
  const counterPath = path.join(directory, 'posts.log');
  const libraryPath = path.resolve(__dirname, '../scripts/lib/issue-1539-evidence-batch.js');
  const childCode = `
    const fs = require('node:fs');
    const { acquireProgressLock } = require(${JSON.stringify(libraryPath)});
    try {
      const lock = acquireProgressLock(${JSON.stringify(lockPath)}, { staleAfterMs: 60000 });
      fs.appendFileSync(${JSON.stringify(counterPath)}, 'POST\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      lock.release();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(error.message);
      process.exitCode = 2;
    }
  `;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map((result) => result.code).sort((a, b) => a - b), [0, 2]);
    assert.equal(fs.readFileSync(counterPath, 'utf8').trim().split('\n').filter(Boolean).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('progress lock stale policy only reclaims an explicitly dead same-host owner', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-lock-policy-'));
  const lockPath = path.join(directory, 'progress.lock');
  const movedPath = path.join(directory, 'moved.lock');
  try {
    const owner = acquireProgressLock(lockPath);
    const complete = owner.lock;
    assert.equal(lockIsStale(complete, lockPath), false);

    const missingField = { ...complete, pid: 99999999 };
    delete missingField.device;
    fs.writeFileSync(lockPath, JSON.stringify(missingField));
    assert.equal(lockIsStale(missingField, lockPath), false);

    fs.writeFileSync(lockPath, 'malformed lock');
    assert.equal(lockIsStale(null, lockPath), false);

    const deadSameHost = { ...complete, pid: 99999999 };
    fs.writeFileSync(lockPath, JSON.stringify(deadSameHost));
    assert.equal(lockIsStale(deadSameHost, lockPath), true);

    const foreign = { ...deadSameHost, hostname: 'other-host', expires_at: '2000-01-01T00:00:00.000Z' };
    fs.writeFileSync(lockPath, JSON.stringify(foreign));
    assert.equal(lockIsStale(foreign, lockPath), false);

    const unknownPid = { ...complete, pid: 0 };
    fs.writeFileSync(lockPath, JSON.stringify(unknownPid));
    assert.equal(lockIsStale(unknownPid, lockPath), false);

    const inodeMismatch = { ...deadSameHost, inode: deadSameHost.inode + 1 };
    fs.writeFileSync(lockPath, JSON.stringify(inodeMismatch));
    assert.equal(lockIsStale(inodeMismatch, lockPath), false);

    fs.renameSync(lockPath, movedPath);
    assert.equal(lockIsStale(deadSameHost, lockPath), false);
    fs.renameSync(movedPath, lockPath);
    fs.writeFileSync(lockPath, JSON.stringify(complete));
    owner.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('progress lock release refuses an owner-token or inode replacement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-lock-release-'));
  const lockPath = path.join(directory, 'progress.lock');
  const movedPath = path.join(directory, 'moved.lock');
  try {
    const lock = acquireProgressLock(lockPath);
    fs.renameSync(lockPath, movedPath);
    fs.writeFileSync(lockPath, JSON.stringify({ schema_version: 'issue-1539-evidence-apply-lock.v1', lock_id: lock.lock.lock_id }));
    assert.throws(() => lock.release(), /owner token or inode changed/);
    fs.unlinkSync(lockPath);
    fs.renameSync(movedPath, lockPath);
    lock.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('acquireProgressLock quarantines a complete same-host dead-PID lock only when inode matches', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-lock-recovery-'));
  const lockPath = path.join(directory, 'progress.lock');
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    const stat = fs.fstatSync(fd);
    fs.closeSync(fd);
    const stale = {
      schema_version: 'issue-1539-evidence-apply-lock.v1',
      lock_id: crypto.randomUUID(),
      pid: 99999999,
      hostname: os.hostname(),
      acquired_at: new Date().toISOString(),
      device: stat.dev,
      inode: stat.ino,
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));
    const acquired = acquireProgressLock(lockPath);
    try {
      assert.notEqual(acquired.lock.lock_id, stale.lock_id);
      assert.equal(fs.statSync(lockPath).ino, acquired.lock.inode);
      assert.ok(fs.readdirSync(directory).some((name) => name.startsWith('progress.lock.stale-')));
    } finally {
      acquired.release();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('acquireProgressLock rejects malformed lock content instead of quarantining it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1539-lock-malformed-'));
  const lockPath = path.join(directory, 'progress.lock');
  try {
    fs.writeFileSync(lockPath, 'not-json');
    assert.throws(() => acquireProgressLock(lockPath), /active or unreadable owner/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'not-json');
    assert.deepEqual(fs.readdirSync(directory), ['progress.lock']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unrecoverable POST response persists uncertain intent and second run refuses duplicate POST', () => {
  const packet = testPacket();
  const comments = [];
  let postCount = 0;
  const setup = applyOptions(packet, comments, () => { postCount += 1; throw new Error('response lost'); });
  const first = applyEvidenceItem(packet, setup.progress.packet_set_sha256, setup.progress, setup.options);
  assert.equal(first.ok, false);
  assert.equal(postCount, 1);
  assert.equal(setup.progress.intents[packet.packet_id].phase, 'evidence-post-uncertain');
  const second = applyEvidenceItem(packet, setup.progress.packet_set_sha256, setup.progress, setup.options);
  assert.equal(second.ok, false);
  assert.equal(postCount, 1);
  assert.match(second.errors.join('\n'), /refusing duplicate POST/);
});
