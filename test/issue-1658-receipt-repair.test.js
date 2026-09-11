'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAIN_SHA,
  SCOPE,
  buildRow,
  validateCorrectionMarker,
} = require('../audit/issue-1658-receipt-repair/plan-receipt-repair');

const plan = JSON.parse(fs.readFileSync('audit/issue-1658-receipt-repair/repair-plan.json', 'utf8'));
const snapshot = JSON.parse(fs.readFileSync('audit/issue-1658-receipt-repair/current-live-snapshot.json', 'utf8'));
const ownerInventory = JSON.parse(fs.readFileSync('audit/issue-1658/owner-inventory.json', 'utf8'));

function validCorrection() {
  return JSON.parse(JSON.stringify(plan.rows[0].correction_template));
}

test('receipt repair proposal is fixed to main, scope, and read-only result', () => {
  assert.equal(plan.source_tree_sha, MAIN_SHA);
  assert.deepEqual(plan.scope, SCOPE);
  assert.equal(plan.authorization_present, false);
  assert.equal(plan.authorization_required, true);
  assert.deepEqual(plan.writes, { post: 0, patch: 0, create: 0, labels: 0, receipts: 0 });
  assert.deepEqual(plan.counts, { rows: 13, repair_eligible: 13, blocked: 0 });
});

test('strict correction marker accepts the exact first-row proposal', () => {
  const result = validateCorrectionMarker(validCorrection(), plan.rows[0]);
  assert.equal(result.ok, true, result.errors.join('; '));
});

for (const [label, mutate] of [
  ['source identity drift', (value) => { value.source_note_id = 'xhs-note:other'; }],
  ['source ref drift', (value) => { value.source_repository_ref = '1'.repeat(40); }],
  ['source body digest drift', (value) => { value.source_note_body_sha256 = '1'.repeat(64); }],
  ['original receipt comment binding drift', (value) => { value.original_receipt.comment_id += 1; }],
  ['evidence comment binding drift', (value) => { value.evidence_binding.comment_id += 1; }],
  ['owner identity drift', (value) => { value.owner_binding.interview_note_id = 'xhs:other'; }],
  ['materialization owner body drift', (value) => { value.materialization_binding.interview_issue_body_sha256 = '1'.repeat(64); }],
  ['bad digest', (value) => { value.materialization_binding.marker_sha256 = 'not-a-sha'; }],
  ['wrong corrected identity', (value) => { value.corrected_receipt.interview_note_ids = ['xhs:other']; }],
]) {
  test(`correction rejects ${label}`, () => {
    const value = validCorrection();
    mutate(value);
    assert.equal(validateCorrectionMarker(value, plan.rows[0]).ok, false);
  });
}

test('proposal row rejects a duplicate original applied marker', () => {
  const live = snapshot.rows[0];
  const expected = {
    source_issue: live.source_issue,
    owner_issue: live.owner_issue,
    identity: live.identity,
    applied_comment_id: live.applied_comment_id,
    materialization_comment_id: live.materialization_comment_id,
    applied_transition_id: live.applied_transition_id,
  };
  const duplicate = { ...live.comments.find((comment) => comment.id === live.applied_comment_id), id: live.applied_comment_id + 1 };
  const result = buildRow(expected, live.source, live.owner, [...live.comments, duplicate], live.comments_pagination);
  assert.equal(result.result, 'BLOCKED');
  assert.match(result.errors.join('\n'), /applied receipt count=2/);
});

test('proposal row rejects a missing evidence marker', () => {
  const live = snapshot.rows[0];
  const expected = {
    source_issue: live.source_issue,
    owner_issue: live.owner_issue,
    identity: live.identity,
    applied_comment_id: live.applied_comment_id,
    materialization_comment_id: live.materialization_comment_id,
    applied_transition_id: live.applied_transition_id,
  };
  const comments = live.comments.filter((comment) => !comment.body.includes('issue-1608-boundary-evidence.v1'));
  const result = buildRow(expected, live.source, live.owner, comments, live.comments_pagination);
  assert.equal(result.result, 'BLOCKED');
  assert.match(result.errors.join('\n'), /issue-1608 evidence count=0/);
});

test('proposal row rejects duplicate correction markers, duplicate materialization receipts, and duplicate owners', () => {
  const live = snapshot.rows[0];
  const expected = {
    source_issue: live.source_issue,
    owner_issue: live.owner_issue,
    identity: live.identity,
    applied_comment_id: live.applied_comment_id,
    materialization_comment_id: live.materialization_comment_id,
    applied_transition_id: live.applied_transition_id,
  };
  const correctionBody = `<!-- source-note-boundary-review-applied-correction.v1\n${JSON.stringify(plan.rows[0].correction_template)}\n-->`;
  const duplicateCorrection = { id: 900000001, body: correctionBody };
  const correctionResult = buildRow(expected, live.source, live.owner, [...live.comments, duplicateCorrection, { ...duplicateCorrection, id: 900000002 }], live.comments_pagination, ownerInventory);
  assert.equal(correctionResult.result, 'BLOCKED');
  assert.match(correctionResult.errors.join('\n'), /correction marker already exists \(2\)/);

  const materialization = live.comments.find((comment) => comment.id === live.materialization_comment_id);
  const materializationResult = buildRow(expected, live.source, live.owner, [...live.comments, { ...materialization, id: materialization.id + 1 }], live.comments_pagination, ownerInventory);
  assert.equal(materializationResult.result, 'BLOCKED');
  assert.match(materializationResult.errors.join('\n'), /materialization receipt count=2/);

  const duplicateOwnerInventory = { ...ownerInventory, entries: [...ownerInventory.entries, { ...ownerInventory.entries.find((entry) => entry.interview_note_id === live.identity) }] };
  const ownerResult = buildRow(expected, live.source, live.owner, live.comments, live.comments_pagination, duplicateOwnerInventory);
  assert.equal(ownerResult.result, 'BLOCKED');
  assert.match(ownerResult.errors.join('\n'), /owner inventory identity candidate count=2/);
});
