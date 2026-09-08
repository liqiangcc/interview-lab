'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const completedManifest = require('../data/pilot/issue-1605/full-boundary-manifest.json');
const frozenSnapshot = require('../data/pilot/issue-1605/pending-inventory.snapshot.json');
const boundaryBEvidence = require('../data/issue-1607/evidence-ledger.json');
const {
  buildPlan, deriveBoundaryBCases, pendingInventory, remainingInventory, parseArgs,
} = require('../scripts/issue-1605-full-boundary-coordinator');

test('full boundary coordinator excludes the completed manifest and covers every remaining audit', () => {
  // CI intentionally has no live GitHub cache.  Use the frozen inventory's
  // already-verified body digests and labels as a read-only cache fixture;
  // production runs still read the full GitHub body cache.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-coordinator-'));
  const cacheFile = path.join(directory, 'source-notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify(frozenSnapshot.items.map((item) => ({
    number: item.issue_number,
    body_sha256: item.body_sha256,
    labels: item.labels,
  }))));
  const plan = buildPlan({ cache: cacheFile });
  assert.equal(plan.frozen_inventory.count, 1397);
  assert.equal(plan.pending_inventory.count, 978);
  assert.equal(plan.completed_exclusion.count, 419);
  assert.equal(plan.scope.remaining_total, 978);
  assert.equal(plan.coverage.audited_total, 978);
  assert.equal(plan.coverage.actionable_total + plan.coverage.blocked_total, 978);
  assert.deepEqual(plan.coverage.uncovered_issue_numbers, []);
  assert.equal(plan.mutation_count, 0);
  assert.equal(plan.live_evidence_comments, 0);
  assert.equal(plan.live_transitions, 0);

  const completed = new Set(completedManifest.items.map((item) => item.issue_number));
  assert.equal(plan.items.some((item) => completed.has(item.issue_number)), false);
  for (const item of plan.items) {
    assert.equal(item.expected_source_repository_ref, '95b77bb261048059846273688e4b90a2e108b437');
    if (item.decision === 'multi-interview') assert.ok(item.cases.length >= 2, `#${item.issue_number} needs at least two case anchors`);
  }
  // #735 says that there were “many” interviews but does not enumerate them;
  // the controller must keep it blocked instead of inventing an N.
  assert.ok(plan.coverage.invalid_decision_issue_numbers.includes(735));
  assert.ok(plan.errors.some((error) => /#735/.test(error)));
});

test('remaining and frozen inventory validators reject a digest or scope drift', () => {
  const frozen = pendingInventory();
  const remaining = remainingInventory(undefined, frozen);
  assert.equal(frozen.numbers.size, 1397);
  assert.equal(remaining.numbers.size, 978);
  assert.throws(() => remainingInventory('/tmp/does-not-exist.json', frozen), /ENOENT/);
});

test('boundary B case derivation keeps exact source refs and unique locators', () => {
  const evidence = {
    source_evidence: {
      ref: 'liqiangcc/xhs:note_desc/example.txt@95b77bb261048059846273688e4b90a2e108b437',
      locator: 'note_desc:1-2',
      text: '一面：项目深挖\n二面：系统设计',
    },
  };
  const cases = deriveBoundaryBCases(evidence);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map((item) => item.case_key), ['round-1', 'round-2']);
  assert.equal(new Set(cases.flatMap((item) => item.evidence.map((ref) => ref.locator))).size, 2);
  assert.ok(cases.every((item) => item.evidence[0].ref === evidence.source_evidence.ref));
});

test('boundary B ignores question-count wording and summary recaps', () => {
  for (const issueNumber of [504, 578]) {
    const evidence = boundaryBEvidence.items.find((item) => item.issue_number === issueNumber);
    assert.ok(evidence, `missing Boundary B evidence for #${issueNumber}`);
    const cases = deriveBoundaryBCases(evidence);
    assert.equal(cases.length, 2, `#${issueNumber} should have exactly two interview cases`);
    assert.equal(new Set(cases.map((item) => item.case_key)).size, 2);
    assert.equal(new Set(cases.flatMap((item) => item.evidence.map((ref) => ref.locator))).size, 2);
  }
});

test('remaining coordinator defaults never target the completed 419-row artifacts', () => {
  const args = parseArgs([]);
  assert.match(args.output, /remaining-boundary-evidence-plan\.json$/);
  assert.match(args.journal, /remaining-boundary-evidence-progress\.json$/);
  assert.match(args.requestDir, /remaining-boundary-evidence-requests$/);
});
