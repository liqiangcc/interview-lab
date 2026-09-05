'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { gitBlobSha } = require('../scripts/lib/issue-1539-boundary-expansion');
const { evidenceBody, buildFormalRequest, requestSha256 } = require('../scripts/lib/issue-1539-boundary-evidence-batch');
const {
  ISSUE_NUMBERS, buildPacketSet, initialProgress, planBatch, applyBatch,
  validateProgress, renderAppliedReceiptComment, validateInputs, targetRevisionBinding,
} = require('../scripts/lib/issue-1539-boundary-transition-batch');

const sourceFixture = fs.readFileSync('test/fixtures/source-note-issue.valid.md', 'utf8');
const sourceV2Fixture = fs.readFileSync('test/fixtures/source-note-issue-v2.valid.md', 'utf8');
const baseManifest = JSON.parse(fs.readFileSync('data/pilot/issue-1539/boundary-expansion-candidates.json', 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function syntheticState() {
  const manifest = clone(baseManifest);
  const lives = new Map();
  for (const item of manifest.items) {
    const bytes = Buffer.from(`真实单场面试 #${item.issue_number}\n${item.artifact.anchor}\n问题：请介绍项目。\n`, 'utf8');
    item.artifact.git_blob_sha = gitBlobSha(bytes);
    const parsed = parseSourceNoteIssue(sourceFixture);
    const record = clone(parsed.record);
    record.source_note_id = item.source_note_id;
    record.source.external_id = item.source_note_id.slice('xhs-note:'.length);
    record.source_revision.id = item.expected_source_revision_id;
    record.source_revision.source_repository_ref = item.artifact.ref.split('@')[1];
    record.boundary_review = { status: 'pending', reviewed_at: null, interview_note_ids: [] };
    record.artifacts.push({ kind: 'text_projection', ref: item.artifact.ref, git_blob_sha: item.artifact.git_blob_sha, sha256: null, provenance: 'source_projection', byte_size: bytes.length, integrity: 'present' });
    let body = sourceFixture.replace(/<!-- source-note: id=[^>]+ -->/, `<!-- source-note: id=${item.source_note_id} schema=source-note-issue.v1 -->`);
    body = body.replace(/<!-- source-note-record\n[\s\S]*?\n-->/, `<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->`);
    item.expected_body_sha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    lives.set(item.issue_number, {
      sourceIssue: { number: item.issue_number, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'source-year:2022', 'status:captured', 'boundary:pending', 'task:boundary-review'].map((name) => ({ name })) },
      comments: [],
      allIssues: [],
      blob: { sha: item.artifact.git_blob_sha, encoding: 'base64', content: bytes.toString('base64') },
    });
  }
  const packetSet = buildPacketSet(manifest);
  const requests = packetSet.packets.map((packet) => buildFormalRequest(packet, 7000 + packet.issue_number, '2026-09-05T04:37:00Z'));
  const evidenceReceipts = requests.map((request, index) => ({
    schema_version: 'issue-1549-boundary-review-evidence-receipt.v1',
    packet_set_sha256: packetSet.packet_set_sha256,
    packet_id: packetSet.packets[index].packet_id,
    transition_id: request.transition_id,
    repository: request.repository,
    issue_number: request.issue_number,
    source_note_issue_number: request.issue_number,
    source_note_id: request.source_note_id,
    expected_body_sha256: request.expected_body_sha256,
    expected_source_revision_id: request.expected_source_revision_id,
    evidence_subject_sha256: packetSet.packets[index].evidence_subject_sha256,
    evidence_comment_id: request.review_evidence.comment_id,
    request_sha256: requestSha256(request),
  }));
  for (const [index, request] of requests.entries()) {
    const packet = packetSet.packets[index];
    lives.get(request.issue_number).comments.push({ id: request.review_evidence.comment_id, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: evidenceBody(packet, packetSet.packet_set_sha256) });
  }
  return { manifest, packetSet, requests, evidenceReceipts, lives, transitionReceipts: new Map() };
}

function liveLoader(state) {
  return (request) => {
    const live = state.lives.get(request.issue_number);
    return { sourceIssue: live.sourceIssue, comments: live.comments, allIssues: live.allIssues, readBlob: () => live.blob };
  };
}

function optionsFor(state, extra = {}) {
  return {
    manifest: state.manifest,
    evidenceReceipts: state.evidenceReceipts,
    expectedPacketSetSha256: state.packetSet.packet_set_sha256,
    loadLive: liveLoader(state),
    readTransitionReceipt: (request) => state.transitionReceipts.get(request.issue_number) || null,
    persistProgress: () => {},
    ...extra,
  };
}

test('fixed 17-item preflight consumes #1549 receipts and produces a deterministic plan digest', () => {
  const state = syntheticState();
  const result = planBatch(state.requests, state.packetSet, optionsFor(state));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.match(state.packetSet.packet_set_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.items.length, 17);
  assert.deepEqual(result.items.map((item) => item.issue_number), ISSUE_NUMBERS);
  assert.equal(result.items.every((item) => item.action === 'would-transition'), true);
  assert.equal(result.report.plan_sha256, result.report.plan_sha256.toLowerCase());
  assert.equal(result.report.items.every((item) => item.next_labels.includes('boundary:single-interview')), true);
  assert.equal(result.report.items.some((item) => item.next_labels.includes('status:source-ready')), false);
  assert.equal(validateInputs(state.requests, state.evidenceReceipts, state.packetSet, state.manifest, state.packetSet.packet_set_sha256).ok, true);
});

test('fresh SourceNote body/CAS drift blocks planning before any mutation', () => {
  const state = syntheticState();
  const packet = state.packetSet.packets[3];
  state.lives.get(packet.issue_number).sourceIssue.body += '\nexternal drift\n';
  let patches = 0;
  const result = planBatch(state.requests, state.packetSet, optionsFor(state, { patchIssue: () => { patches += 1; } }));
  assert.equal(result.ok, false);
  assert.equal(patches, 0);
  assert.match(result.errors.join('\n'), /body SHA|stale SourceNote body/);
});

test('pre-PATCH gate/CAS drift records a resumable block without possibly-performed mutation', () => {
  const state = syntheticState();
  const progress = initialProgress(state.requests, state.packetSet.packet_set_sha256);
  const first = state.requests[0];
  const original = clone(state.lives.get(first.issue_number).sourceIssue);
  const baseLoader = liveLoader(state);
  let reads = 0;
  let patches = 0;
  const firstAttempt = applyBatch(state.requests, state.packetSet, progress, optionsFor(state, {
    loadLive(request) {
      const live = baseLoader(request);
      if (request.issue_number === first.issue_number && ++reads === 3) {
        const current = state.lives.get(first.issue_number);
        current.sourceIssue = { ...current.sourceIssue, body: `${current.sourceIssue.body}\nexternal CAS drift\n` };
        return baseLoader(request);
      }
      return live;
    },
    patchIssue: () => { patches += 1; },
  }));
  assert.equal(firstAttempt.ok, false);
  assert.equal(patches, 0);
  assert.equal(progress.possibly_performed, false);
  assert.equal(progress.items[String(first.issue_number)].phase, 'planned');
  assert.equal(progress.items[String(first.issue_number)].result.status, 'blocked-before-mutation');
  assert.equal(validateProgress(progress, state.requests, state.packetSet.packet_set_sha256).ok, true);

  state.lives.get(first.issue_number).sourceIssue = original;
  const resumed = applyBatch(state.requests, state.packetSet, progress, optionsFor(state, {
    patchIssue(request, plan) {
      patches += 1;
      const live = state.lives.get(request.issue_number);
      live.sourceIssue = { ...live.sourceIssue, body: plan.next_body, labels: plan.next_labels };
    },
    postReceipt(request, receipt) {
      state.lives.get(request.issue_number).comments.push({ id: 990000 + request.issue_number, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: renderAppliedReceiptComment(receipt) });
    },
    writeReceipt: () => {},
  }));
  assert.equal(resumed.ok, true, resumed.errors?.join('\n'));
  assert.equal(patches, ISSUE_NUMBERS.length);
});

test('PATCH response loss reconciles the live target before creating exactly one receipt', () => {
  const state = syntheticState();
  const patches = [];
  const posts = [];
  const result = applyBatch(state.requests, state.packetSet, initialProgress(state.requests, state.packetSet.packet_set_sha256), optionsFor(state, {
    patchIssue(request, plan) {
      patches.push(request.issue_number);
      const live = state.lives.get(request.issue_number);
      live.sourceIssue = { ...live.sourceIssue, body: plan.next_body, labels: plan.next_labels };
      if (request.issue_number === state.requests[0].issue_number) throw new Error('PATCH response lost');
    },
    postReceipt(request, receipt) {
      posts.push(request.issue_number);
      state.lives.get(request.issue_number).comments.push({ id: 980000 + request.issue_number, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: renderAppliedReceiptComment(receipt) });
    },
    writeReceipt: () => {},
  }));
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(patches.length, ISSUE_NUMBERS.length);
  assert.equal(posts.length, ISSUE_NUMBERS.length);
  assert.equal(new Set(patches).size, ISSUE_NUMBERS.length);
  assert.equal(result.progress.possibly_performed, false);
});

function rewriteLiveRecord(live, transform) {
  const parsed = parseSourceNoteIssue(live.sourceIssue.body);
  const record = clone(parsed.record);
  transform(record);
  live.sourceIssue = {
    ...live.sourceIssue,
    body: live.sourceIssue.body.replace(
      /<!--\s*source-note-record\s*\n[\s\S]*?\n-->/,
      `<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->`,
    ),
  };
}

function moveLiveToTarget(state, request, plan) {
  const live = state.lives.get(request.issue_number);
  live.sourceIssue = { ...live.sourceIssue, body: plan.next_body, labels: plan.next_labels };
  return live;
}

test('target fast path rejects SourceRevision ref drift and cannot bypass the single-item planner', () => {
  const state = syntheticState();
  const first = state.requests[0];
  const firstPlan = planBatch(state.requests, state.packetSet, optionsFor(state)).items[0].plan;
  moveLiveToTarget(state, first, firstPlan);
  rewriteLiveRecord(state.lives.get(first.issue_number), (record) => { record.source_revision.source_repository_ref = '0'.repeat(40); });
  let plannerCalls = 0;
  let targetPlannerCalls = 0;
  const result = planBatch(state.requests, state.packetSet, optionsFor(state, {
    planTransition(request, issue, options) {
      plannerCalls += 1;
      if (request.issue_number === first.issue_number) targetPlannerCalls += 1;
      return { ok: true, already_applied: true, next_labels: issue.labels, evidenceComment: options.evidenceComment };
    },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /SourceRevision repository ref/);
  assert.equal(targetPlannerCalls, 0);
  assert.equal(plannerCalls, ISSUE_NUMBERS.length - 1);
});

test('target fast path delegates a valid target to the single-item planner, including its manifest/version rules', () => {
  const state = syntheticState();
  const first = state.requests[0];
  const firstPlan = planBatch(state.requests, state.packetSet, optionsFor(state)).items[0].plan;
  moveLiveToTarget(state, first, firstPlan);
  let plannerCalls = 0;
  const result = planBatch(state.requests, state.packetSet, optionsFor(state, {
    planTransition(request, issue, options) {
      if (request.issue_number === first.issue_number) {
        plannerCalls += 1;
        assert.equal(parseSourceNoteIssue(issue.body).record.schema_version, 'source-note-issue.v1');
        assert.equal(request.expected_manifest_sha256, null);
        assert.equal(options.evidenceComment.id, request.review_evidence.comment_id);
        return { ok: true, already_applied: true };
      }
      return planBatch(state.requests, state.packetSet, optionsFor(state)).items.find((item) => item.issue_number === request.issue_number).plan;
    },
  }));
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(plannerCalls, 1);
  assert.equal(result.items[0].action, 'receipt-needed');
});

test('target revision binding covers v2 manifest semantics and rejects contradictory declarations', () => {
  const v2 = parseSourceNoteIssue(sourceV2Fixture).record;
  const request = { expected_source_repository_ref: null, expected_manifest_sha256: v2.source_revision.manifest_sha256 };
  assert.equal(targetRevisionBinding(v2, request).ok, true);
  const wrongManifest = targetRevisionBinding(v2, { ...request, expected_manifest_sha256: '0'.repeat(64) });
  assert.equal(wrongManifest.ok, false);
  assert.match(wrongManifest.errors.join('\n'), /manifest/);
  const wrongRef = targetRevisionBinding(v2, { ...request, expected_source_repository_ref: 'a'.repeat(40) });
  assert.equal(wrongRef.ok, false);
  assert.match(wrongRef.errors.join('\n'), /repository ref|null/);
});

test('normal PATCH fresh reconcile rejects concurrent body drift before receipt POST', () => {
  const state = syntheticState();
  const first = state.requests[0];
  const progress = initialProgress(state.requests, state.packetSet.packet_set_sha256);
  let patches = 0;
  let posts = 0;
  const result = applyBatch(state.requests, state.packetSet, progress, optionsFor(state, {
    patchIssue(request, plan) {
      patches += 1;
      const live = moveLiveToTarget(state, request, plan);
      live.sourceIssue.body += '\nconcurrent body drift\n';
    },
    postReceipt: () => { posts += 1; },
    writeReceipt: () => {},
  }));
  assert.equal(result.ok, false);
  assert.equal(patches, 1);
  assert.equal(posts, 0);
  assert.equal(progress.possibly_performed, true);
  assert.equal(progress.items[String(first.issue_number)].phase, 'uncertain');
  assert.match(result.errors.join('\n'), /body or labels drifted/);
});

test('PATCH response-loss fresh reconcile rejects concurrent label drift before receipt POST', () => {
  const state = syntheticState();
  const first = state.requests[0];
  const progress = initialProgress(state.requests, state.packetSet.packet_set_sha256);
  let patches = 0;
  let posts = 0;
  const result = applyBatch(state.requests, state.packetSet, progress, optionsFor(state, {
    patchIssue(request, plan) {
      patches += 1;
      const live = moveLiveToTarget(state, request, plan);
      live.sourceIssue.labels = [...live.sourceIssue.labels, { name: 'external:concurrent' }];
      throw new Error('PATCH response lost');
    },
    postReceipt: () => { posts += 1; },
    writeReceipt: () => {},
  }));
  assert.equal(result.ok, false);
  assert.equal(patches, 1);
  assert.equal(posts, 0);
  assert.equal(progress.possibly_performed, true);
  assert.equal(progress.items[String(first.issue_number)].phase, 'uncertain');
  assert.match(result.errors.join('\n'), /target facts drifted/);
});

test('receipt-only POST path accounts for attempted/performed/possibly globally', () => {
  const state = syntheticState();
  for (const request of state.requests) {
    const plan = planBatch(state.requests, state.packetSet, optionsFor(state)).items.find((item) => item.issue_number === request.issue_number).plan;
    moveLiveToTarget(state, request, plan);
  }
  let patches = 0;
  let posts = 0;
  const result = applyBatch(state.requests, state.packetSet, initialProgress(state.requests, state.packetSet.packet_set_sha256), optionsFor(state, {
    patchIssue: () => { patches += 1; },
    postReceipt(request, receipt) {
      posts += 1;
      const live = state.lives.get(request.issue_number);
      live.comments.push({ id: 1000000 + request.issue_number, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: renderAppliedReceiptComment(receipt) });
    },
    writeReceipt: () => {},
  }));
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(patches, 0);
  assert.equal(posts, ISSUE_NUMBERS.length);
  assert.equal(result.progress.mutation_attempted, true);
  assert.equal(result.progress.mutation_performed, true);
  assert.equal(result.progress.possibly_performed, false);
  assert.equal(validateProgress(result.progress, state.requests, state.packetSet.packet_set_sha256).ok, true);
});

test('apply uses one PATCH and one receipt POST per item, reconciles response loss, and never creates InterviewNotes', () => {
  const state = syntheticState();
  const progress = initialProgress(state.requests, state.packetSet.packet_set_sha256);
  const snapshots = [];
  const patches = [];
  const posts = [];
  const writes = [];
  const result = applyBatch(state.requests, state.packetSet, progress, optionsFor(state, {
    patchIssue: (request, plan) => {
      patches.push(request.issue_number);
      const live = state.lives.get(request.issue_number);
      live.sourceIssue = { ...live.sourceIssue, body: plan.next_body, labels: plan.next_labels.map((name) => ({ name })) };
    },
    postReceipt: (request, receipt) => {
      posts.push(request.issue_number);
      const live = state.lives.get(request.issue_number);
      live.comments.push({ id: 900000 + request.issue_number, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: renderAppliedReceiptComment(receipt) });
      return null;
    },
    writeReceipt: (request, receipt) => { writes.push(request.issue_number); state.transitionReceipts.set(request.issue_number, clone(receipt)); },
    persistProgress: (value) => snapshots.push(clone(value)),
  }));
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(patches.length, 17);
  assert.equal(posts.length, 17);
  assert.equal(writes.length, 17);
  assert.equal(new Set(patches).size, 17);
  assert.equal(result.progress.status, 'complete');
  assert.equal(result.progress.possibly_performed, false);
  assert.equal(validateProgress(result.progress, state.requests, state.packetSet.packet_set_sha256).ok, true);
  assert.equal(snapshots.some((value) => Object.values(value.items).some((item) => item.phase === 'patch-pending')), true);
  assert.equal(snapshots.some((value) => Object.values(value.items).some((item) => item.phase === 'receipt-pending')), true);
  for (const live of state.lives.values()) {
    assert.equal(live.allIssues.length, 0);
    assert.equal(live.sourceIssue.labels.some((label) => (label.name || label) === 'status:source-ready'), false);
    assert.equal(live.sourceIssue.labels.some((label) => (label.name || label) === 'boundary:single-interview'), true);
  }
});

test('resume skips an already-targeted item with its matching receipt and applies only remaining items', () => {
  const state = syntheticState();
  const first = state.requests[0];
  const firstPlan = planBatch(state.requests, state.packetSet, optionsFor(state)).items[0].plan;
  const live = state.lives.get(first.issue_number);
  live.sourceIssue = { ...live.sourceIssue, body: firstPlan.next_body, labels: firstPlan.next_labels };
  const receipt = {
    schema_version: 'source-note-boundary-review-applied.v1', transition_id: first.transition_id, repository: first.repository, issue_number: first.issue_number, source_note_id: first.source_note_id, decision: 'single-interview', reviewed_at: first.reviewed_at, applied_at: '2026-09-05T05:00:00Z', previous_body_sha256: first.expected_body_sha256, new_body_sha256: crypto.createHash('sha256').update(firstPlan.next_body, 'utf8').digest('hex'), interview_note_ids: [`xhs:${first.source_note_id.slice('xhs-note:'.length)}`], interview_note_cases: null,
  };
  live.comments.push({ id: 910000 + first.issue_number, issue_url: `https://api.github.com/repos/${first.repository}/issues/${first.issue_number}`, body: renderAppliedReceiptComment(receipt) });
  state.transitionReceipts.set(first.issue_number, receipt);
  const patches = []; const posts = [];
  const result = applyBatch(state.requests, state.packetSet, initialProgress(state.requests, state.packetSet.packet_set_sha256), optionsFor(state, {
    patchIssue: (request, plan) => { patches.push(request.issue_number); const item = state.lives.get(request.issue_number); item.sourceIssue = { ...item.sourceIssue, body: plan.next_body, labels: plan.next_labels }; },
    postReceipt: (request, nextReceipt) => { posts.push(request.issue_number); state.lives.get(request.issue_number).comments.push({ id: 920000 + request.issue_number, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: renderAppliedReceiptComment(nextReceipt) }); },
    writeReceipt: (request, nextReceipt) => state.transitionReceipts.set(request.issue_number, clone(nextReceipt)),
  }));
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(patches.includes(first.issue_number), false);
  assert.equal(posts.includes(first.issue_number), false);
  assert.equal(patches.length, 16);
  assert.equal(posts.length, 16);
});

test('source-ready is outside the Boundary transition scope and blocks before PATCH', () => {
  const state = syntheticState();
  const first = state.lives.get(state.requests[0].issue_number);
  first.sourceIssue = { ...first.sourceIssue, labels: [...first.sourceIssue.labels, { name: 'status:source-ready' }] };
  let patches = 0;
  const result = planBatch(state.requests, state.packetSet, optionsFor(state, { patchIssue: () => { patches += 1; } }));
  assert.equal(result.ok, false);
  assert.equal(patches, 0);
  assert.match(result.errors.join('\n'), /source-ready|source review/);
});

test('receipt conflicts and malformed live labels fail closed', () => {
  const state = syntheticState();
  const first = state.requests[0];
  state.lives.get(first.issue_number).sourceIssue.labels = [...state.lives.get(first.issue_number).sourceIssue.labels, null];
  const result = planBatch(state.requests, state.packetSet, optionsFor(state));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /labels|boundary/);
});
