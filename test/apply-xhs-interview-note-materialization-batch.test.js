'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sha256Text,
} = require('../scripts/lib/source-note-interview-materialization');
const {
  readAuthorizedReport,
  validateLiveDependencyGate,
  parseDependencyAcceptance,
  completedMaterializationIds,
  materializationReceipt,
  ghReadJson,
  blockedReviewBody,
  findBlockedReview,
  waitForOwnership,
} = require('../scripts/apply-xhs-interview-note-materialization-batch');

function report() {
  const value = {
    repository: 'liqiangcc/interview-lab',
    ready_for_apply: true,
    mutation_performed: false,
    dependency_gate: { ok: true, dependencies: {
      '917': { issue_number: 917, state: 'closed', acceptance: 'pass', evidence_schema: 'issue-dependency-acceptance.v1', evidence: 'https://github.com/liqiangcc/interview-lab/issues/917#issuecomment-917', acceptance_evidence: 'https://github.com/liqiangcc/interview-lab/issues/917#issuecomment-917' },
      '920': { issue_number: 920, state: 'closed', acceptance: 'pass', evidence_schema: 'issue-dependency-acceptance.v1', evidence: 'https://github.com/liqiangcc/interview-lab/issues/920#issuecomment-920', acceptance_evidence: 'https://github.com/liqiangcc/interview-lab/issues/920#issuecomment-920' },
      '921': { issue_number: 921, state: 'closed', acceptance: 'pass', evidence_schema: 'issue-dependency-acceptance.v1', evidence: 'https://github.com/liqiangcc/interview-lab/issues/921#issuecomment-921', acceptance_evidence: 'https://github.com/liqiangcc/interview-lab/issues/921#issuecomment-921' },
    } },
    apply_blocked: 0,
    materialization_candidates: 1,
    counts: { 'would-materialize': 1 },
    results: [{ action: 'would-materialize', request: { materialization_id: 'm-1' } }],
  };
  return { ...value, dry_run_sha256: sha256Text(JSON.stringify(value)) };
}

test('authorization preflight requires exact digest, ready flag, and row/count agreement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-922-'));
  const file = path.join(directory, 'report.json');
  const value = report();
  fs.writeFileSync(file, JSON.stringify(value));
  assert.deepEqual(readAuthorizedReport(file, value.dry_run_sha256), value);
  assert.throws(() => readAuthorizedReport(file, '0'.repeat(64)), /authorization digest/);
  const notReady = { ...value, ready_for_apply: false };
  const { dry_run_sha256: ignored, ...withoutDigest } = notReady;
  const changed = { ...notReady, dry_run_sha256: sha256Text(JSON.stringify(withoutDigest)) };
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => readAuthorizedReport(file, changed.dry_run_sha256), /ready_for_apply/);
});

test('blocked review marker binds the derived InterviewNote identity and is reusable', () => {
  const request = { materialization_id: 'm-child', case_key: 'process-a', source_note_issue_number: 33 };
  const body = blockedReviewBody(request, 'xhs:child:event:abc', 'evidence missing');
  const comment = { id: 12, body };
  assert.equal(findBlockedReview([comment], request, 'xhs:child:event:abc').id, 12);
  assert.throws(() => findBlockedReview([comment], request, 'xhs:other'), /identity mismatch/);
});

test('post-create ownership retry tolerates bounded index delay but fails after the bound', () => {
  let calls = 0;
  const waits = [];
  const found = waitForOwnership(() => {
    calls += 1;
    return calls < 3 ? [] : [{ number: 77 }];
  }, 77, (ms) => waits.push(ms));
  assert.deepEqual(found.map((item) => item.number), [77]);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.throws(() => waitForOwnership(() => [], 77, () => {}, { attempts: 3 }), /bounded retries/);
});

test('live dependency gate uses explicit anchors and structured acceptance', () => {
  const value = report();
  const reads = [];
  assert.equal(validateLiveDependencyGate(value, {
    readIssue: (number) => ({ number, state: 'closed' }),
    readEvidence: (anchor) => { reads.push(anchor); return { id: anchor.comment_id, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/' + anchor.issue_number, body: '<!-- issue-dependency-acceptance\n{"schema_version":"issue-dependency-acceptance.v1","issue_number":' + anchor.issue_number + ',"acceptance":"pass","accepted_by":"test","acceptance_evidence":"https://github.com/liqiangcc/interview-lab/issues/' + anchor.issue_number + '#issuecomment-' + anchor.issue_number + '"}\n-->' }; },
  }), true);
  assert.deepEqual(reads.map((item) => item.issue_number), [917, 917, 920, 920, 921, 921]);
  const malformed = JSON.parse(JSON.stringify(value));
  malformed.dependency_gate.dependencies['917'].acceptance = 'accepted';
  assert.throws(() => validateLiveDependencyGate(malformed, {
    readIssue: () => ({ state: 'closed' }),
    readEvidence: () => ({ id: 1 }),
  }), /structurally accepted/);
});

test('dependency acceptance marker is unique and strict', () => {
  const marker = '<!-- issue-dependency-acceptance\n{"schema_version":"issue-dependency-acceptance.v1","issue_number":917,"acceptance":"pass","accepted_by":"coordinating-codex","acceptance_evidence":"https://github.com/liqiangcc/interview-lab/issues/917#issuecomment-5539209153"}\n-->';
  assert.equal(parseDependencyAcceptance(marker, 'liqiangcc/interview-lab', 917).acceptance, 'pass');
  assert.throws(() => parseDependencyAcceptance(`${marker}\n${marker}`, 'liqiangcc/interview-lab', 917), /exactly one/);
  assert.throws(() => parseDependencyAcceptance(marker.replace('"acceptance":"pass"', '"acceptance":"accepted"'), 'liqiangcc/interview-lab', 917), /structured pass/);
});

test('failed progress records are never completed or used to skip recovery', () => {
  assert.deepEqual([...completedMaterializationIds([
    { materialization_id: 'failed', status: 'failed', interview_issue_number: 1 },
    { materialization_id: 'blocked', final_status: 'blocked', interview_issue_number: 2 },
    { materialization_id: 'ready', final_status: 'source-ready', interview_issue_number: 3 },
  ])].sort(), ['blocked', 'ready']);
});

test('apply read-only GitHub JSON retries, while mutation helpers remain separate', () => {
  let calls = 0;
  const waits = [];
  const value = ghReadJson(['api', 'read-only'], null, { attempts: 3, retryPauseMs: 10, sleep: (ms) => waits.push(ms), read: () => { calls += 1; if (calls < 3) throw new Error('transient'); return { ok: true }; } });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('multi materialization receipt is v2 and binds case_key', () => {
  const request = { schema_version: 'source-note-interview-materialization.v2', case_key: 'process-a', materialization_id: 'm-child', repository: 'liqiangcc/interview-lab', source_note_issue_number: 33, source_note_id: 'xhs-note:multi', expected_source_note_body_sha256: 'a'.repeat(64), expected_source_revision_id: 'xhs:multi:r1', expected_manifest_sha256: 'b'.repeat(64), expected_source_repository_ref: null };
  const receipt = materializationReceipt(request, { request_sha256: 'c'.repeat(64), interview_note_id: 'xhs:multi:event:child', projection: { body: 'body' } }, 123);
  assert.equal(receipt.schema_version, 'source-note-interview-materialized.v2');
  assert.equal(receipt.case_key, 'process-a');
});
