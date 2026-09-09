'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDigest } = require('../scripts/lib/aggregate-downstream-pipeline');
const { issueSourceRecord } = require('../scripts/lib/interview-note-materialization-batch');
const { TARGETS, REQUIRED_ZERO_WRITES, planIssue1657BlockerRepair } = require('../scripts/lib/issue-1657-blocker-repair-plan');
const { sourceSnapshotDigest } = require('../scripts/plan-issue-1611-live-materialization');
const { DEFAULTS, parseArgs } = require('../scripts/plan-issue-1657-blocker-repair');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
}

const sourceSnapshot = load('data/pilot/issue-1611/source-note-live.snapshot.json');
const ownershipInventory = load('data/pilot/issue-1611/interview-note-ownership.inventory.json');
const materializationPlan = load('data/pilot/issue-1611/materialization.live.dry-run.json');
const receiptSnapshot = load('data/pilot/issue-1657/owner-receipt-audit.snapshot.json');

test('real #1611 fixture parses all three #1657 SourceNote targets with identity and revision intact', () => {
  for (const target of TARGETS) {
    const issue = sourceSnapshot.issues.find((candidate) => Number(candidate.number) === target.source_note_issue_number);
    assert.ok(issue, `SourceNote #${target.source_note_issue_number} must be present`);
    const parsed = issueSourceRecord(issue);
    assert.equal(parsed.validation.ok, true, parsed.validation.errors.join('; '));
    assert.equal(parsed.parsed.source_note_id, `xhs-note:${target.interview_note_id.slice(4)}`);
    assert.equal(parsed.parsed.source_revision.id.length > 0, true);
    assert.equal(parsed.parsed.boundary_review.status, 'single-interview');
    assert.deepEqual(parsed.parsed.boundary_review.interview_note_ids, [target.interview_note_id]);
  }
});

test('real #1657 blocker plan preserves all three target facts and stays fail-closed', () => {
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot });
  assert.equal(plan.ok, false, 'the live blockers must not be reported ready');
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  assert.equal(plan.mutation_performed, false);
  assert.deepEqual(plan.results.map((result) => result.source_note_issue_number), [904, 907, 910]);
  assert.deepEqual(plan.results.map((result) => result.interview_note_id), TARGETS.map((target) => target.interview_note_id));
  assert.deepEqual(plan.results.map((result) => result.owner_issue_number), [2, 4, 915]);
  assert.deepEqual(plan.results.map((result) => result.source_revision_id), [
    'xhs-note:63ecd286000000001303fd16:snapshot-95b77bb26104',
    'xhs-note:656861da000000000f024258:snapshot-95b77bb26104',
    'xhs:6a8abe2d000000001602b26e:r1',
  ]);
  assert.deepEqual(plan.results.map((result) => result.action), [
    'blocked-owner-source-revision-cas',
    'blocked-owner-source-revision-cas',
    'blocked-boundary-evidence-and-runtime-provenance',
  ]);
  assert.match(plan.results[0].errors.join('\n'), /existing owner SourceRevision/);
  assert.match(plan.results[1].errors.join('\n'), /existing owner SourceRevision/);
  assert.deepEqual(plan.results[2].reason_codes, ['boundary-evidence-missing-or-ambiguous', 'runtime-source-repository-ref-unavailable']);
  assert.equal(plan.results.every((result) => result.mutation_performed === false), true);
  assert.equal(plan.results.every((result) => canonicalDigest(result.write_operations) === canonicalDigest(REQUIRED_ZERO_WRITES)), true);
  const { plan_digest: ignored, ...withoutDigest } = plan;
  assert.equal(canonicalDigest(withoutDigest), plan.plan_digest);
});

test('runtime #910 receipt cannot be upgraded into a Git-ref claim', () => {
  const tampered = JSON.parse(JSON.stringify(receiptSnapshot));
  tampered.entries.find((entry) => entry.source_note_issue_number === 910).materialization_receipt.source_repository_ref = '95b77bb261048059846273688e4b90a2e108b437';
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot: tampered });
  assert.equal(plan.ok, false);
  assert.match(plan.results.find((result) => result.source_note_issue_number === 910).errors.join('\n'), /source repository ref mismatch/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('malformed SourceNote record remains a row-level blocker even with a recomputed snapshot digest', () => {
  const tampered = JSON.parse(JSON.stringify(sourceSnapshot));
  tampered.issues.find((issue) => Number(issue.number) === 904).body = 'not a SourceNote';
  tampered.canonical_digest = sourceSnapshotDigest(tampered.issues);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot: tampered, ownershipInventory, materializationPlan, receiptSnapshot });
  assert.equal(plan.ok, false);
  const row = plan.results.find((result) => result.source_note_issue_number === 904);
  assert.match(row.errors.join('\n'), /SourceNote invalid|SourceNote record is missing/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('CLI rejects every mutation-shaped argument before planning', () => {
  for (const flag of ['--apply', '--patch', '--post', '--label', '--create', '--interview-note']) {
    assert.throws(() => parseArgs([flag]), new RegExp(`${flag.slice(2)}.*forbidden`));
  }
  assert.equal(DEFAULTS.output, 'data/pilot/issue-1657/blocker-repair.plan.json');
});
