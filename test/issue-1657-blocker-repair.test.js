'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDigest } = require('../scripts/lib/aggregate-downstream-pipeline');
const { issueSourceRecord } = require('../scripts/lib/interview-note-materialization-batch');
const { TARGETS, MARKER_EXPECTATIONS, REQUIRED_ZERO_WRITES, receiptSnapshotDigest, planIssue1657BlockerRepair: planIssue1657BlockerRepairImpl } = require('../scripts/lib/issue-1657-blocker-repair-plan');
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
const boundaryReport = load('data/pilot/issue-1611/live-boundary.materialization-report.json');
const boundaryTransitionReport = load('data/pilot/issue-1605/boundary-transition-report.json');
const receiptSnapshot = load('data/pilot/issue-1657/owner-receipt-audit.snapshot.json');
const liveAuditSnapshot = load('data/pilot/issue-1657/live-reaudit.snapshot.json');

function planIssue1657BlockerRepair(input) {
  return planIssue1657BlockerRepairImpl({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot, boundaryReport, boundaryTransitionReport, ...input });
}

test('Issue #1657 schemas expose the reviewed fail-closed contract', () => {
  const receiptSchema = schema('issue-1657-owner-receipt-audit-snapshot.schema.json');
  const liveSchema = schema('issue-1657-live-reaudit-snapshot.schema.json');
  const planSchema = schema('issue-1657-blocker-repair-plan.schema.json');
  assert.deepEqual(receiptSchema.required, ['schema_version', 'repository', 'captured_at', 'read_policy', 'entries', 'canonical_digest']);
  assert.deepEqual(liveSchema.required, ['schema_version', 'repository', 'captured_at', 'read_policy', 'target_count', 'targets', 'canonical_digest']);
  assert.equal(planSchema.properties.mutation_performed.const, false);
  assert.equal(planSchema.properties.ok.const, false);
  assert.deepEqual(planSchema.required.slice(0, 9), ['schema_version', 'repository', 'parent_issue', 'mode', 'source_snapshot_digest', 'ownership_inventory_digest', 'materialization_plan_digest', 'boundary_report_digest', 'boundary_transition_report_digest']);
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

test('marker summary field substitution remains blocked after resealing', () => {
  const cases = [
    ['comment_id', (summary, source) => { summary.comment_id = source.boundary_applied_receipt.comment_id; }, /live boundary evidence marker count 1 comment_id must match comments\[0\].id and comment_ids\[0\]/],
    ['body_sha256', (summary, source) => { summary.body_sha256 = source.boundary_applied_receipt.body_sha256; }, /live boundary evidence marker count 1 body_sha256 must match comments\[0\].body_sha256/],
    ['payload', (summary, source) => { summary.payload = source.boundary_applied_receipt.payload; }, /live boundary evidence marker count 1 payload does not match comment marker source-note-boundary-review-evidence/],
  ];
  for (const [field, mutate, expected] of cases) {
    const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
    const source = tampered.targets.find((target) => target.source_note_issue_number === 904).source;
    mutate(source.boundary_evidence, source);
    tampered.canonical_digest = liveSnapshotDigest(tampered);
    const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
    const row = plan.results.find((result) => result.source_note_issue_number === 904);
    assert.equal(plan.ok, false, `${field} substitution must fail closed`);
    assert.match(row.errors.join('\n'), expected, field);
    assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  }
});

test('marker payload semantic substitution remains blocked after resealing', () => {
  const cases = [
    {
      name: 'boundary evidence repository', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.repository = 'attacker/repo'; }, expected: /live boundary evidence payload repository mismatch/,
    },
    {
      name: 'boundary evidence identity', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.source_note_id = 'xhs-note:tampered'; }, expected: /live boundary evidence payload source_note_id mismatch/,
    },
    {
      name: 'boundary evidence prior body', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload, source) => { payload.expected_body_sha256 = source.body_sha256; }, expected: /live boundary evidence payload expected_body_sha256 mismatch/,
    },
    {
      name: 'boundary evidence transition', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.transition_id = 'tampered-transition'; }, expected: /live boundary evidence payload transition_id mismatch/,
    },
    {
      name: 'boundary evidence source revision', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.expected_source_revision_id = 'xhs-note:tampered:r1'; }, expected: /live boundary evidence payload expected_source_revision_id mismatch/,
    },
    {
      name: 'boundary evidence source revision deletion', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { delete payload.expected_source_revision_id; }, expected: /live boundary evidence payload expected_source_revision_id is missing/,
    },
    {
      name: 'boundary evidence source ref', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.expected_source_repository_ref = null; }, expected: /live boundary evidence payload expected_source_repository_ref mismatch/,
    },
    {
      name: 'boundary evidence source ref deletion', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { delete payload.expected_source_repository_ref; }, expected: /live boundary evidence payload expected_source_repository_ref is missing/,
    },
    {
      name: 'boundary evidence artifact provenance', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.source_evidence.artifact.provenance = 'derived'; }, expected: /live boundary evidence payload source_evidence artifact provenance\/kind is invalid/,
    },
    {
      name: 'boundary evidence artifact kind', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.source_evidence.artifact.kind = 'json_projection'; }, expected: /live boundary evidence payload source_evidence artifact provenance\/kind is invalid/,
    },
    {
      name: 'boundary evidence artifact ref', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.source_evidence.artifact.ref = 'liqiangcc/xhs:note_desc/other.txt@95b77bb261048059846273688e4b90a2e108b437'; }, expected: /live boundary evidence payload source_evidence artifact ref is not bound/,
    },
    {
      name: 'boundary evidence checks', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.checks = []; }, expected: /live boundary evidence payload checks do not prove all required checks/,
    },
    {
      name: 'boundary evidence duplicate check', target: 904, side: 'source', summary: 'boundary_evidence', marker: 'source-note-boundary-review-evidence',
      mutate: (payload) => { payload.checks.push({ ...payload.checks[0] }); }, expected: /live boundary evidence payload checks do not prove all required checks/,
    },
    {
      name: 'boundary applied repository', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.repository = 'attacker/repo'; }, expected: /live boundary applied receipt payload repository mismatch/,
    },
    {
      name: 'boundary applied identity', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.source_note_id = 'xhs-note:tampered'; }, expected: /live boundary applied receipt payload source_note_id mismatch/,
    },
    {
      name: 'boundary applied transition', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.transition_id = 'tampered-transition'; }, expected: /live boundary applied receipt payload transition_id mismatch/,
    },
    {
      name: 'boundary applied prior body', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload, source) => { payload.previous_body_sha256 = source.body_sha256; }, expected: /live boundary applied receipt payload previous_body_sha256 mismatch/,
    },
    {
      name: 'boundary applied new body', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.new_body_sha256 = '0'.repeat(64); }, expected: /live boundary applied receipt payload new_body_sha256 mismatch/,
    },
    {
      name: 'boundary applied source revision', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.expected_source_revision_id = 'xhs-note:tampered:r1'; }, expected: /live boundary applied receipt payload expected_source_revision_id mismatch/,
    },
    {
      name: 'boundary applied source revision deletion', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { delete payload.expected_source_revision_id; }, expected: /live boundary applied receipt payload expected_source_revision_id is missing/,
    },
    {
      name: 'boundary applied source ref', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.expected_source_repository_ref = null; }, expected: /live boundary applied receipt payload expected_source_repository_ref mismatch/,
    },
    {
      name: 'boundary applied source ref deletion', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { delete payload.expected_source_repository_ref; }, expected: /live boundary applied receipt payload expected_source_repository_ref is missing/,
    },
    {
      name: 'boundary applied parent deletion', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { delete payload.parent_issue; }, expected: /live boundary applied receipt payload parent_issue is missing/,
    },
    {
      name: 'boundary applied manifest substitution', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.manifest_digest = '0'.repeat(64); }, expected: /live boundary applied receipt payload manifest_digest mismatch/,
    },
    {
      name: 'boundary applied plan deletion', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { delete payload.plan_digest; }, expected: /live boundary applied receipt payload plan_digest is missing/,
    },
    {
      name: 'boundary applied interview identity', target: 904, side: 'source', summary: 'boundary_applied_receipt', marker: 'source-note-boundary-review-applied',
      mutate: (payload) => { payload.interview_note_ids = ['xhs:tampered']; }, expected: /live boundary applied receipt payload interview_note_ids mismatch/,
    },
    {
      name: 'materialization repository', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.repository = 'attacker/repo'; }, expected: /live materialization receipt payload repository mismatch/,
    },
    {
      name: 'materialization identity', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.source_note_id = 'xhs-note:tampered'; }, expected: /live materialization receipt payload source_note_id mismatch/,
    },
    {
      name: 'materialization body', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.source_note_body_sha256 = '0'.repeat(64); }, expected: /live materialization receipt payload source_note_body_sha256 mismatch/,
    },
    {
      name: 'materialization revision', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.source_revision_id = 'xhs:tampered:r1'; }, expected: /live materialization receipt payload source_revision_id mismatch/,
    },
    {
      name: 'materialization runtime ref', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.source_repository_ref = '95b77bb261048059846273688e4b90a2e108b437'; }, expected: /live materialization receipt payload source_repository_ref mismatch/,
    },
    {
      name: 'materialization request', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.request_sha256 = '0'.repeat(64); }, expected: /live materialization receipt payload request_sha256 mismatch/,
    },
    {
      name: 'materialization id', target: 910, side: 'source', summary: 'materialization_receipt', marker: 'source-note-interview-materialized',
      mutate: (payload) => { payload.materialization_id = 'tampered-materialization'; }, expected: /live materialization receipt payload materialization_id mismatch/,
    },
    {
      name: 'owner review repository', target: 910, side: 'owner', summary: 'source_review_applied_receipt', marker: 'interview-note-source-review-applied',
      mutate: (payload) => { payload.repository = 'attacker/repo'; }, expected: /live owner source-review applied receipt payload repository mismatch/,
    },
    {
      name: 'owner review identity', target: 910, side: 'owner', summary: 'source_review_applied_receipt', marker: 'interview-note-source-review-applied',
      mutate: (payload) => { payload.interview_note_id = 'xhs:tampered'; }, expected: /live owner source-review applied receipt payload interview_note_id mismatch/,
    },
    {
      name: 'owner review issue', target: 910, side: 'owner', summary: 'source_review_applied_receipt', marker: 'interview-note-source-review-applied',
      mutate: (payload) => { payload.issue_number = 2; }, expected: /live owner source-review applied receipt payload issue_number mismatch/,
    },
    {
      name: 'owner review source body', target: 910, side: 'owner', summary: 'source_review_applied_receipt', marker: 'interview-note-source-review-applied',
      mutate: (payload) => { payload.source_note_body_sha256 = '0'.repeat(64); }, expected: /live owner source-review applied receipt payload source_note_body_sha256 mismatch/,
    },
    {
      name: 'owner review source revision', target: 910, side: 'owner', summary: 'source_review_applied_receipt', marker: 'interview-note-source-review-applied',
      mutate: (payload) => { payload.source_revision_id = 'xhs:tampered:r1'; }, expected: /live owner source-review applied receipt payload source_revision_id mismatch/,
    },
    {
      name: 'owner review manifest', target: 910, side: 'owner', summary: 'source_review_applied_receipt', marker: 'interview-note-source-review-applied',
      mutate: (payload) => { payload.manifest_sha256 = '0'.repeat(64); }, expected: /live owner source-review applied receipt payload manifest_sha256 mismatch/,
    },
  ];
  for (const { name, target, side, summary: summaryName, marker, mutate, expected } of cases) {
    const tampered = JSON.parse(JSON.stringify(liveAuditSnapshot));
    const audited = tampered.targets.find((item) => item.source_note_issue_number === target)[side];
    const summary = audited[summaryName];
    const payload = JSON.parse(JSON.stringify(summary.payload));
    mutate(payload, audited);
    summary.payload = payload;
    summary.comments[0].markers[marker] = payload;
    tampered.canonical_digest = liveSnapshotDigest(tampered);
    const plan = planIssue1657BlockerRepair({ sourceSnapshot, ownershipInventory, materializationPlan, receiptSnapshot, liveAuditSnapshot: tampered });
    const row = plan.results.find((result) => result.source_note_issue_number === target);
    assert.equal(plan.ok, false, `${name} must fail closed`);
    assert.match(row.errors.join('\n'), expected, name);
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

test('boundary reports are mandatory, sealed, and target-bound', () => {
  const missingCases = [
    ['live boundary materialization report', { boundaryReport: null }, /live boundary materialization report schema is invalid/],
    ['boundary transition report', { boundaryTransitionReport: null }, /boundary transition report schema is invalid/],
  ];
  for (const [label, input, expected] of missingCases) {
    const plan = planIssue1657BlockerRepair(input);
    assert.equal(plan.ok, false, `${label} must be mandatory`);
    assert.match(plan.errors.join('\n'), expected, label);
    assert.deepEqual(plan.write_operations, REQUIRED_ZERO_WRITES);
  }

  const reseal = (value, digestField) => {
    delete value[digestField];
    value[digestField] = canonicalDigest(value);
  };
  const boundaryTampered = JSON.parse(JSON.stringify(boundaryReport));
  const boundary904 = Object.values(boundaryTampered.items).find((item) => Number(item.issue_number) === 904);
  boundary904.evidence_body_sha256 = boundary904.live_source_note_body_sha256;
  reseal(boundaryTampered, 'dry_run_sha256');
  const boundaryPlan = planIssue1657BlockerRepair({ boundaryReport: boundaryTampered });
  assert.equal(boundaryPlan.ok, false);
  assert.match(boundaryPlan.results.find((row) => row.source_note_issue_number === 904).errors.join('\n'), /previous_body_sha256 mismatch|expected_body_sha256 mismatch/);
  assert.deepEqual(boundaryPlan.write_operations, REQUIRED_ZERO_WRITES);

  const transitionTampered = JSON.parse(JSON.stringify(boundaryTransitionReport));
  transitionTampered.boundary_manifest_digest = '0'.repeat(64);
  reseal(transitionTampered, 'report_sha256');
  const transitionPlan = planIssue1657BlockerRepair({ boundaryTransitionReport: transitionTampered });
  assert.equal(transitionPlan.ok, false);
  assert.match(transitionPlan.errors.join('\n'), /manifest digest is not the pinned boundary manifest/);
  assert.deepEqual(transitionPlan.write_operations, REQUIRED_ZERO_WRITES);
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
  assert.equal(DEFAULTS.boundaryReport, 'data/pilot/issue-1611/live-boundary.materialization-report.json');
  assert.equal(DEFAULTS.boundaryTransitionReport, 'data/pilot/issue-1605/boundary-transition-report.json');
  for (const flag of ['--patch', '--post', '--label', '--apply', '--interview-note']) {
    assert.throws(() => parseLiveArgs([flag]), new RegExp(`${flag.slice(2)}.*forbidden`));
  }
});
