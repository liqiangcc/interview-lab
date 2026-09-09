'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDigest } = require('../scripts/lib/aggregate-downstream-pipeline');
const { issueSourceRecord } = require('../scripts/lib/interview-note-materialization-batch');
const { TARGETS, MARKER_EXPECTATIONS, REQUIRED_ZERO_WRITES, receiptSnapshotDigest, planIssue1657BlockerRepair } = require('../scripts/lib/issue-1657-blocker-repair-plan');
const { sourceSnapshotDigest } = require('../scripts/plan-issue-1611-live-materialization');
const { DEFAULTS, parseArgs } = require('../scripts/plan-issue-1657-blocker-repair');
const { snapshotDigest: liveSnapshotDigest, parseArgs: parseLiveArgs } = require('../scripts/audit-issue-1657-live');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
}

function schema(name) { return load(`schemas/${name}`); }

const sourceSnapshot = load('data/pilot/issue-1611/source-note-live.snapshot.json');
const ownershipInventory = load('data/pilot/issue-1611/interview-note-ownership.inventory.json');
const materializationPlan = load('data/pilot/issue-1611/materialization.live.dry-run.json');
const receiptSnapshot = load('data/pilot/issue-1657/owner-receipt-audit.snapshot.json');
const liveAuditSnapshot = load('data/pilot/issue-1657/live-reaudit.snapshot.json');

test('Issue #1657 schemas expose the reviewed fail-closed contract', () => {
  const receiptSchema = schema('issue-1657-owner-receipt-audit-snapshot.schema.json');
  const liveSchema = schema('issue-1657-live-reaudit-snapshot.schema.json');
  const planSchema = schema('issue-1657-blocker-repair-plan.schema.json');
  assert.deepEqual(receiptSchema.required, ['schema_version', 'repository', 'captured_at', 'read_policy', 'entries', 'canonical_digest']);
  assert.deepEqual(liveSchema.required, ['schema_version', 'repository', 'captured_at', 'read_policy', 'target_count', 'targets', 'canonical_digest']);
  assert.equal(planSchema.properties.mutation_performed.const, false);
  assert.equal(planSchema.properties.ok.const, false);
  assert.deepEqual(planSchema.properties.write_operations.required, ['patch', 'post', 'label', 'interview_note', 'create']);
  assert.deepEqual(liveSchema.$defs.source.required, ['issue_number', 'state', 'updated_at', 'body_sha256', 'labels', 'validation', 'source_note_id', 'source_revision', 'boundary_review', 'boundary_evidence', 'boundary_applied_receipt', 'materialization_receipt', 'human_boundary_evidence_comment_ids', 'comments']);
  assert.deepEqual(liveSchema.$defs.owner.required, ['issue_number', 'state', 'updated_at', 'body_sha256', 'labels', 'validation', 'interview_note_id', 'source_revision', 'source', 'source_review_evidence', 'source_review_evidence_comment_ids', 'source_review_applied_receipt', 'materialization_receipt', 'comments']);
  assert.deepEqual(liveSchema.$defs.marker_summary.properties.count.enum, [0, 1, '>1']);
});

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

test('real live re-audit fixture binds current comments and receipts', () => {
  assert.equal(liveSnapshotDigest(liveAuditSnapshot), liveAuditSnapshot.canonical_digest);
  assert.deepEqual(liveAuditSnapshot.targets.map((target) => target.source_note_issue_number), [904, 907, 910]);
  assert.deepEqual(liveAuditSnapshot.targets.map((target) => target.source.boundary_evidence && target.source.boundary_evidence.comment_id), [5579824204, 5579824470, null]);
  assert.deepEqual(liveAuditSnapshot.targets.map((target) => target.source.boundary_evidence.count), [1, 1, 0]);
  assert.deepEqual(liveAuditSnapshot.targets.map((target) => target.source.materialization_receipt.count), [0, 0, 1]);
  assert.deepEqual(liveAuditSnapshot.targets.map((target) => target.owner.source_review_applied_receipt.count), [0, 0, 1]);
  assert.deepEqual(liveAuditSnapshot.targets.map((target) => target.source.boundary_applied_receipt && target.source.boundary_applied_receipt.comment_id), [5584606650, 5584607734, 5535553800]);
  assert.equal(liveAuditSnapshot.targets[2].source.materialization_receipt.comment_id, 5535863537);
  assert.equal(liveAuditSnapshot.targets[2].owner.source_review_evidence_comment_ids.includes(5536381793), true);
});

test('real #1657 blocker plan preserves all three target facts and stays fail-closed', () => {
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot });
  assert.equal(plan.ok, false, 'the live blockers must not be reported ready');
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  assert.equal(plan.mutation_performed, false);
  assert.equal(plan.owner_receipt_snapshot_digest, receiptSnapshot.canonical_digest);
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
  assert.deepEqual(plan.results.map((result) => result.decision_class), [
    'repairable-after-independent-owner-review-and-CAS',
    'repairable-after-independent-owner-review-and-CAS',
    'must-manually-confirm-boundary-evidence-and-runtime-provenance',
  ]);
  assert.deepEqual(plan.results.map((result) => ({
    source: result.live_audit.expected_source_marker_counts,
    owner: result.live_audit.expected_owner_marker_counts,
  })), TARGETS.map((target) => MARKER_EXPECTATIONS[target.source_note_issue_number]));
  assert.equal(plan.results.some((result) => result.errors.some((error) => /marker count/.test(error))), false, 'expected zero markers must not be reported as errors');
  assert.deepEqual(plan.results.map((result) => result.errors), [
    ['existing owner SourceRevision differs from current SourceNote'],
    ['existing owner SourceRevision differs from current SourceNote'],
    [],
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
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot: tampered, liveAuditSnapshot });
  assert.equal(plan.ok, false);
  assert.match(plan.results.find((result) => result.source_note_issue_number === 910).errors.join('\n'), /source repository ref mismatch/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('receipt snapshot canonical digest is JSON-safe and excludes its own digest field', () => {
  assert.match(receiptSnapshot.canonical_digest, /^[0-9a-f]{64}$/);
  assert.equal(receiptSnapshotDigest(receiptSnapshot), receiptSnapshot.canonical_digest);
  const tampered = JSON.parse(JSON.stringify(receiptSnapshot));
  tampered.entries[0].owner_issue_number = 9999;
  assert.notEqual(receiptSnapshotDigest(tampered), receiptSnapshot.canonical_digest);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot: tampered, liveAuditSnapshot });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /canonical_digest drifted/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('receipt field tampering remains blocked even when the audit snapshot is resealed', () => {
  const tampered = JSON.parse(JSON.stringify(receiptSnapshot));
  tampered.entries.find((entry) => entry.source_note_issue_number === 910).materialization_receipt.source_revision_id = 'xhs:tampered:r1';
  tampered.canonical_digest = receiptSnapshotDigest(tampered);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot: tampered, liveAuditSnapshot });
  const row = plan.results.find((result) => result.source_note_issue_number === 910);
  assert.equal(plan.ok, false);
  assert.match(row.errors.join('\n'), /materialization receipt SourceRevision mismatch/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('owner field tampering remains blocked even when the ownership inventory is resealed', () => {
  const tampered = JSON.parse(JSON.stringify(ownershipInventory));
  tampered.entries.find((entry) => entry.issue_number === 915).body_sha256 = '0'.repeat(64);
  const { canonical_digest: ignored, ...digestInput } = tampered;
  tampered.canonical_digest = canonicalDigest(digestInput);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory: tampered, materializationPlan, receiptSnapshot, liveAuditSnapshot });
  const row = plan.results.find((result) => result.source_note_issue_number === 910);
  assert.equal(plan.ok, false);
  assert.match(row.errors.join('\n'), /owner body digest disagrees with receipt audit|materialization receipt owner body digest mismatch/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('live re-audit SourceNote tampering remains blocked even when the audit snapshot is resealed', () => {
  const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
  tampered.targets.find((target) => target.source_note_issue_number === 907).source.body_sha256 = '0'.repeat(64);
  tampered.canonical_digest = liveSnapshotDigest(tampered);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
  const row = plan.results.find((result) => result.source_note_issue_number === 907);
  assert.equal(plan.ok, false);
  assert.match(row.errors.join('\n'), /live audit SourceNote body digest mismatch/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('live re-audit owner revision tampering remains blocked even when the audit snapshot is resealed', () => {
  const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
  tampered.targets.find((target) => target.source_note_issue_number === 904).owner.source_revision.id = 'xhs:63ecd286000000001303fd16:tampered';
  tampered.canonical_digest = liveSnapshotDigest(tampered);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
  const row = plan.results.find((result) => result.source_note_issue_number === 904);
  assert.equal(plan.ok, false);
  assert.match(row.errors.join('\n'), /live audit owner SourceRevision mismatch/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('deleting an expected live marker remains a target blocker after resealing', () => {
  const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
  const summary = tampered.targets.find((target) => target.source_note_issue_number === 904).source.boundary_evidence;
  Object.assign(summary, { count: 0, match_count: 0, comment_ids: [], comments: [], comment_id: null, body_sha256: null, payload: null });
  tampered.canonical_digest = liveSnapshotDigest(tampered);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
  const row = plan.results.find((result) => result.source_note_issue_number === 904);
  assert.equal(plan.ok, false);
  assert.match(row.errors.join('\n'), /live boundary evidence marker count must equal expected 1 \(got 0\)/);
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('duplicating a live marker remains a target blocker after resealing', () => {
  const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
  const source = tampered.targets.find((target) => target.source_note_issue_number === 907).source;
  const original = source.comments.find((comment) => comment.id === source.boundary_applied_receipt.comment_id);
  const duplicate = { ...original, id: 9999999999 };
  source.comments.push(duplicate);
  const summary = source.boundary_applied_receipt;
  Object.assign(summary, { count: '>1', match_count: 2, comment_ids: [original.id, duplicate.id], comments: [original, duplicate], comment_id: null, body_sha256: null, payload: null });
  tampered.canonical_digest = liveSnapshotDigest(tampered);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
  const row = plan.results.find((result) => result.source_note_issue_number === 907);
  assert.equal(plan.ok, false);
  assert.match(row.errors.join('\n'), /live boundary applied receipt marker count must equal expected 1 \(got >1\)/);
  assert.equal(row.live_audit.source_marker_counts.boundary_applied_receipt, '>1');
  assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
});

test('forged marker count and arrays remain blocked after resealing', () => {
  const cases = [
    {
      label: 'zero marker fields',
      mutate(snapshot) {
        const summary = snapshot.targets.find((target) => target.source_note_issue_number === 904).owner.materialization_receipt;
        Object.assign(summary, { match_count: 1, comment_ids: [123456789], comments: [{ id: 123456789 }], comment_id: 123456789, body_sha256: 'a'.repeat(64), payload: { forged: true } });
      },
      expected: /live owner materialization receipt marker count 0 requires match_count 0|live owner materialization receipt marker count 0 requires empty comment_ids\/comments|live owner materialization receipt marker count 0 requires null comment_id\/body_sha256\/payload/,
    },
    {
      label: 'optional zero-to-one count',
      mutate(snapshot) {
        const summary = snapshot.targets.find((target) => target.source_note_issue_number === 904).owner.materialization_receipt;
        summary.count = 1;
      },
      expected: /live owner materialization receipt marker count must equal expected 0 (got 1)|live owner materialization receipt marker count 1 requires match_count 1/,
    },
    {
      label: 'single marker arrays',
      mutate(snapshot) {
        const summary = snapshot.targets.find((target) => target.source_note_issue_number === 904).source.boundary_evidence;
        Object.assign(summary, { match_count: 0, comment_ids: [], comments: [], comment_id: null, body_sha256: null, payload: null });
      },
      expected: /live boundary evidence marker count 1 requires match_count 1|live boundary evidence marker count 1 requires exactly one comment_id\/comment/,
    },
    {
      label: 'duplicate comment ids',
      mutate(snapshot) {
        const summary = snapshot.targets.find((target) => target.source_note_issue_number === 907).source.boundary_applied_receipt;
        summary.count = '>1';
        summary.match_count = 2;
        summary.comment_ids = [summary.comment_id, summary.comment_id];
        summary.comments = [summary.comments[0], summary.comments[0]];
        summary.comment_id = null;
        summary.body_sha256 = null;
        summary.payload = null;
      },
      expected: /live boundary applied receipt marker comment_ids must be unique/,
    },
    {
      label: 'multiple marker array length',
      mutate(snapshot) {
        const summary = snapshot.targets.find((target) => target.source_note_issue_number === 907).source.boundary_applied_receipt;
        summary.count = '>1';
        summary.match_count = 2;
        summary.comment_ids = [summary.comment_id];
        summary.comments = [summary.comments[0]];
        summary.comment_id = null;
        summary.body_sha256 = null;
        summary.payload = null;
      },
      expected: /live boundary applied receipt marker count >1 requires arrays matching match_count/,
    },
  ];
  for (const { label, mutate, expected } of cases) {
    const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
    mutate(tampered);
    tampered.canonical_digest = liveSnapshotDigest(tampered);
    const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
    const row = plan.results.find((result) => result.source_note_issue_number === (label === 'duplicate comment ids' || label === 'multiple marker array length' ? 907 : 904));
    assert.equal(plan.ok, false, `${label} must fail closed`);
    assert.match(row.errors.join('\n'), expected, label);
    assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  }
});

test('missing live source or owner object remains a target blocker after resealing', () => {
  for (const field of ['source', 'owner']) {
    const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
    delete tampered.targets.find((target) => target.source_note_issue_number === 910)[field];
    tampered.canonical_digest = liveSnapshotDigest(tampered);
    const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
    const row = plan.results.find((result) => result.source_note_issue_number === 910);
    assert.equal(plan.ok, false, `${field} must fail closed`);
    assert.match(row.errors.join('\n'), new RegExp(`live audit (SourceNote|InterviewNote owner) object is missing`));
    assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  }
});

test('receipt snapshot schema, repository, entries, and canonical digest are mandatory', () => {
  const cases = [
    ['schema', (value) => { value.schema_version = 'tampered'; }, /schema is invalid/],
    ['repository', (value) => { value.repository = 'attacker/repo'; }, /repository mismatch/],
    ['entries', (value) => { value.entries = value.entries.slice(0, 2); }, /exactly 3 target entries/],
    ['canonical digest', (value) => { delete value.canonical_digest; }, /canonical_digest is required/],
  ];
  for (const [label, mutate, expected] of cases) {
    const tampered = JSON.parse(JSON.stringify(receiptSnapshot));
    mutate(tampered);
    const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot: tampered, liveAuditSnapshot });
    assert.equal(plan.ok, false, `${label} must fail closed`);
    assert.match([...plan.errors, ...plan.results.flatMap((result) => result.errors)].join('\n'), expected, label);
    assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  }
});

test('malformed SourceNote record remains a row-level blocker even with a recomputed snapshot digest', () => {
  const tampered = JSON.parse(JSON.stringify(sourceSnapshot));
  tampered.issues.find((issue) => Number(issue.number) === 904).body = 'not a SourceNote';
  tampered.canonical_digest = sourceSnapshotDigest(tampered.issues);
  const plan = planIssue1657BlockerRepair({ sourceSnapshot: tampered, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot });
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
  for (const flag of ['--patch', '--post', '--label', '--apply', '--interview-note']) {
    assert.throws(() => parseLiveArgs([flag]), new RegExp(`${flag.slice(2)}.*forbidden`));
  }
});
