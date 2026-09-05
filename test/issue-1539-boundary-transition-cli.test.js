'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { gitBlobSha } = require('../scripts/lib/issue-1539-boundary-expansion');
const { evidenceBody, buildFormalRequest, requestSha256 } = require('../scripts/lib/issue-1539-boundary-evidence-batch');
const {
  ISSUE_NUMBERS,
  buildPacketSet,
  renderAppliedReceiptComment,
} = require('../scripts/lib/issue-1539-boundary-transition-batch');
const { main, parseArgs } = require('../scripts/apply-issue-1539-boundary-transition-batch');

const sourceFixture = fs.readFileSync('test/fixtures/source-note-issue.valid.md', 'utf8');
const baseManifest = JSON.parse(fs.readFileSync('data/pilot/issue-1539/boundary-expansion-candidates.json', 'utf8'));
const realManifestPath = 'data/pilot/issue-1539/boundary-expansion-candidates.json';
const realRequestDir = 'data/pilot/issue-1549/boundary-review-requests';
const realEvidenceReceiptDir = 'data/pilot/issue-1549/boundary-evidence-receipts';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function syntheticState() {
  const manifest = clone(baseManifest);
  const lives = new Map();
  for (const item of manifest.items) {
    const bytes = Buffer.from(`合成单场面试 #${item.issue_number}\n${item.artifact.anchor}\n问题：请介绍项目。\n`, 'utf8');
    item.artifact.git_blob_sha = gitBlobSha(bytes);
    const record = clone(parseSourceNoteIssue(sourceFixture).record);
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
  return { manifest, packetSet, requests, evidenceReceipts, lives };
}

function liveLoader(state) {
  return (request) => {
    const live = state.lives.get(request.issue_number);
    return { sourceIssue: live.sourceIssue, comments: live.comments, allIssues: live.allIssues, readBlob: () => live.blob };
  };
}

function argsFor(directory, output, progress, extra = []) {
  return [
    '--candidate-manifest', realManifestPath,
    '--request-dir', realRequestDir,
    '--evidence-receipt-dir', realEvidenceReceiptDir,
    '--transition-receipt-dir', path.join(directory, 'receipts'),
    '--output', output,
    '--progress', progress,
    '--progress-lock', path.join(directory, 'progress.lock'),
    '--get-max-attempts', '3',
    '--get-backoff-ms', '0',
    ...extra,
  ];
}

test('CLI plan-only uses the fixed packet pipeline and does not create missing progress', () => {
  const state = syntheticState();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1554-plan-'));
  try {
    const output = path.join(directory, 'plan.json');
    const progress = path.join(directory, 'progress.json');
    const code = main(argsFor(directory, output, progress), {
      manifest: state.manifest,
      packetSet: state.packetSet,
      expectedPacketSetSha256: state.packetSet.packet_set_sha256,
      requests: state.requests,
      evidenceReceipts: state.evidenceReceipts,
      loadLive: liveLoader(state),
    });
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(code, 0);
    assert.equal(report.mode, 'plan');
    assert.equal(report.items.length, ISSUE_NUMBERS.length);
    assert.equal(report.items.every((item) => item.action === 'would-transition'), true);
    assert.match(report.plan_sha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(progress), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('CLI apply requires an explicit progress lock path', () => {
  assert.throws(() => parseArgs([
    '--candidate-manifest', 'manifest.json', '--request-dir', 'requests',
    '--evidence-receipt-dir', 'evidence', '--transition-receipt-dir', 'receipts',
    '--output', 'output.json', '--progress', 'progress.json', '--apply',
    '--confirm-plan-digest', 'a'.repeat(64),
  ]), /--apply requires --progress-lock/);
});

test('CLI apply requires the confirmed plan digest and writes durable progress/receipts after one mocked PATCH/POST each', () => {
  const state = syntheticState();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1554-apply-'));
  try {
    const planOutput = path.join(directory, 'plan.json');
    const progress = path.join(directory, 'progress.json');
    const baseRuntime = {
      manifest: state.manifest,
      packetSet: state.packetSet,
      expectedPacketSetSha256: state.packetSet.packet_set_sha256,
      requests: state.requests,
      evidenceReceipts: state.evidenceReceipts,
      loadLive: liveLoader(state),
    };
    assert.equal(main(argsFor(directory, planOutput, progress), baseRuntime), 0);
    const digest = JSON.parse(fs.readFileSync(planOutput, 'utf8')).plan_sha256;
    const patches = [];
    const posts = [];
    let clockNow = 0;
    const sleeps = [];
    const applyOutput = path.join(directory, 'apply.json');
    const code = main(argsFor(directory, applyOutput, progress, ['--apply', '--confirm-plan-digest', digest]), {
      ...baseRuntime,
      patchIssue(request, plan) {
        patches.push(request.issue_number);
        const live = state.lives.get(request.issue_number);
        live.sourceIssue = { ...live.sourceIssue, body: plan.next_body, labels: plan.next_labels.map((name) => ({ name })) };
      },
      postReceipt(request, receipt) {
        posts.push(request.issue_number);
        state.lives.get(request.issue_number).comments.push({ id: 900000 + request.issue_number, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, body: renderAppliedReceiptComment(receipt) });
        return null;
      },
      clock: () => clockNow,
      sleep(milliseconds) { sleeps.push(milliseconds); clockNow += milliseconds; },
    });
    const result = JSON.parse(fs.readFileSync(applyOutput, 'utf8'));
    assert.equal(code, 0);
    assert.equal(result.ok, true);
    assert.equal(patches.length, ISSUE_NUMBERS.length);
    assert.equal(posts.length, ISSUE_NUMBERS.length);
    assert.equal(JSON.parse(fs.readFileSync(progress, 'utf8')).status, 'complete');
    assert.equal(fs.readdirSync(path.join(directory, 'receipts')).filter((file) => file.endsWith('.json')).length, ISSUE_NUMBERS.length);
    assert.equal(result.possibly_performed, false);
    assert.equal(sleeps.length, ISSUE_NUMBERS.length * 2 - 1);
    assert.equal(sleeps.every((milliseconds) => milliseconds === 1000), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
