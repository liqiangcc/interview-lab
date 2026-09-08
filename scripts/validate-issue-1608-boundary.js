#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { canonicalJson, evidenceDecisionConsistent, sha256Text, PARENT_DEPENDENCY, PARENT_LIVE_PROGRESS } = require('./prepare-issue-1608-boundary');

const ROOT = path.resolve(__dirname, '..', 'data', 'issue-1608');
const FIRST_ISSUE = 766;
const LAST_ISSUE = 1138;
const INTERVAL_TOTAL = 373;
const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const LABELS = ['type:source-note', 'status:captured', 'boundary:pending'];
const RETRIEVAL_METHODS = ['note-desc-cache', 'frozen-source-snapshot', 'github-git-blob'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateDigest(value, field) {
  const given = value[field];
  const withoutDigest = { ...value };
  delete withoutDigest[field];
  assert.match(given, /^[0-9a-f]{64}$/, `${field} format`);
  assert.strictEqual(given, sha256Text(canonicalJson(withoutDigest)), `${field} mismatch`);
}

function parseIntent(file) {
  const body = fs.readFileSync(file, 'utf8');
  const match = body.match(/<!-- issue-1608-boundary-review-intent\n([\s\S]+)\n-->/);
  assert(match, `malformed request marker: ${file}`);
  return JSON.parse(match[1]);
}

function validateDirectory(root = ROOT) {
  const selection = readJson(path.join(root, 'selection.json'));
  validateDigest(selection, 'selection_sha256');
  assert.strictEqual(selection.schema_version, 'issue-1608-boundary-selection.v1');
  assert.strictEqual(selection.repository, REPOSITORY);
  assert.strictEqual(selection.issue, 1608);
  assert.deepStrictEqual(selection.scope, {
    first_issue: FIRST_ISSUE,
    last_issue: LAST_ISSUE,
    expected_pending_count: selection.scope.expected_pending_count,
    membership_policy: 'open issues in the exact interval carrying type:source-note + status:captured + boundary:pending',
    no_out_of_scope_reads: true,
  });
  assert.deepStrictEqual(selection.source_snapshot, { repository: SOURCE_REPOSITORY, ref: SOURCE_REF });
  assert(selection.live_issue_snapshot && selection.live_issue_snapshot.path && /^[0-9a-f]{64}$/.test(selection.live_issue_snapshot.sha256));
  assert(selection.source_artifact_snapshot && selection.source_artifact_snapshot.path && /^[0-9a-f]{64}$/.test(selection.source_artifact_snapshot.sha256));
  assert.deepStrictEqual(selection.parent_dependency, PARENT_DEPENDENCY);
  assert.deepStrictEqual(selection.parent_live_progress, PARENT_LIVE_PROGRESS);
  assert.deepStrictEqual(readJson(path.join(root, 'parent-dependency.json')), PARENT_DEPENDENCY);
  assert.strictEqual(PARENT_DEPENDENCY.pending_count, 1397);
  assert.strictEqual(PARENT_DEPENDENCY.union.count, 1397);
  assert.strictEqual(PARENT_DEPENDENCY.union.pairwise_disjoint, true);
  assert.strictEqual(PARENT_DEPENDENCY.union.equals_parent_inventory, true);
  assert.strictEqual(PARENT_DEPENDENCY.partitions.reduce((sum, item) => sum + item.pending_count, 0), 1397);
  for (let index = 1; index < PARENT_DEPENDENCY.partitions.length; index += 1) {
    assert(PARENT_DEPENDENCY.partitions[index - 1].last_issue < PARENT_DEPENDENCY.partitions[index].first_issue, 'parent partitions overlap');
  }
  const ownPartition = PARENT_DEPENDENCY.partitions.find((item) => item.child_issue === 1608);
  assert(ownPartition);
  assert.strictEqual(ownPartition.pending_count, 337);
  const total = selection.scope.expected_pending_count;
  assert(Number.isInteger(total) && total >= 0 && total <= INTERVAL_TOTAL);
  assert.strictEqual(selection.total, total);
  assert.strictEqual(selection.items.length, total);

  const numbers = selection.items.map((item) => item.issue_number);
  assert.strictEqual(new Set(numbers).size, total, 'duplicate selected issue');
  assert(numbers.every((number) => number >= FIRST_ISSUE && number <= LAST_ISSUE), 'selected issue outside scope');
  const rejectedNumbers = selection.rejected_in_range.map((item) => item.issue_number);
  assert.strictEqual(new Set(rejectedNumbers).size, rejectedNumbers.length, 'duplicate rejected issue');
  assert.deepStrictEqual(
    [...numbers, ...rejectedNumbers].sort((left, right) => left - right),
    Array.from({ length: INTERVAL_TOTAL }, (_, i) => FIRST_ISSUE + i),
    'selection/rejection does not cover the exact enumerated interval',
  );
  const counts = selection.items.reduce((out, item) => {
    const key = item.disposition === 'blocked' ? 'blocked' : item.decision;
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
  assert.deepStrictEqual(selection.counts, counts);

  let decided = 0;
  let blocked = 0;
  for (const item of selection.items) {
    assert.strictEqual(item.live_state, 'open');
    for (const label of LABELS) assert(item.labels.includes(label), `missing ${label} on #${item.issue_number}`);
    assert.strictEqual(item.source_repository_ref, SOURCE_REF);
    assert(item.source_external_id, `missing source external id on #${item.issue_number}`);
    assert(item.source_retrieval && RETRIEVAL_METHODS.includes(item.source_retrieval.method), `invalid source retrieval on #${item.issue_number}`);
    assert.match(item.source_retrieval.git_blob_sha, /^[0-9a-f]{40}$/);
    assert.strictEqual(item.source_retrieval.byte_size, item.artifact.byte_size);
    assert.match(item.body_sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(item.artifact.provenance, 'source_projection');
    assert.strictEqual(item.artifact.kind, 'text_projection');
    assert.match(item.artifact.git_blob_sha, /^[0-9a-f]{40}$/);
    assert.match(item.artifact.content_sha256, /^[0-9a-f]{64}$/);
    assert(Array.isArray(item.source_artifacts) && item.source_artifacts.length >= 3, `missing complete Source artifacts on #${item.issue_number}`);
    const artifactKinds = new Set(item.source_artifacts.map((artifact) => artifact.kind));
    for (const kind of ['html', 'json', 'text_projection']) {
      const sourceArtifact = item.source_artifacts.find((artifact) => artifact.kind === kind);
      assert(sourceArtifact, `missing ${kind} Source artifact on #${item.issue_number}`);
      assert(sourceArtifact.ref.endsWith(`@${SOURCE_REF}`));
      assert.match(sourceArtifact.git_blob_sha, /^[0-9a-f]{40}$/);
      assert(Number.isInteger(sourceArtifact.byte_size) && sourceArtifact.byte_size > 0);
      assert.match(sourceArtifact.content_sha256, /^[0-9a-f]{64}$/);
      assert.strictEqual(sourceArtifact.complete_content_read, true);
    }
    assert.strictEqual(artifactKinds.size, 3);

    const evidence = readJson(path.join(root, item.evidence_file));
    assert.strictEqual(evidence.issue_number, item.issue_number);
    assert.strictEqual(evidence.source_note_id, item.source_note_id);
    assert.strictEqual(evidence.source_repository_ref, SOURCE_REF);
    assert.strictEqual(evidence.artifact.provenance, 'source_projection');
    assert.strictEqual(evidence.artifact.git_blob_sha, item.artifact.git_blob_sha);
    assert.deepStrictEqual(evidence.source_retrieval, item.source_retrieval);
    assert.deepStrictEqual(evidence.source_artifacts, item.source_artifacts);
    assert.strictEqual(evidence.evidence_comment, undefined);
    const intent = parseIntent(path.join(root, item.request_file));
    assert.strictEqual(intent.issue_number, item.issue_number);
    assert.strictEqual(intent.expected_body_sha256, item.body_sha256);
    assert.strictEqual(intent.expected_boundary_status, 'pending');
    assert.strictEqual(intent.expected_source_repository_ref, SOURCE_REF);
    assert.deepStrictEqual(intent.source_retrieval, item.source_retrieval);
    assert.deepStrictEqual(intent.source_artifacts, item.source_artifacts);
    assert.deepStrictEqual(intent.evidence_comment, { status: 'not-created', comment_id: null });
    assert.deepStrictEqual(intent.case_evidence, evidence.case_evidence || []);
    assert.match(intent.apply_authorization, /controller-only/);
    if (item.disposition === 'blocked') {
      blocked += 1;
      assert.strictEqual(evidence.evidence_status, 'insufficient-blocked');
      assert.strictEqual(intent.decision, null);
      assert.strictEqual(intent.transition_status, 'blocked-insufficient-source-evidence');
    } else {
      decided += 1;
      assert.strictEqual(evidence.evidence_status, 'sufficient-for-controller-review');
      assert.strictEqual(intent.transition_status, 'staged-awaiting-independent-live-evidence-comment');
      assert(['not-interview', 'single-interview', 'multi-interview'].includes(item.decision));
      assert.strictEqual(intent.decision, item.decision);
      if (item.decision === 'single-interview') {
        const explicitOneInterviewOutcome = evidence.excerpts.length === 1
          && /一次面试.*(?:通知\s*oc|oc|offer)/i.test(evidence.excerpts[0].excerpt);
        assert((evidence.excerpts.length >= 3 || explicitOneInterviewOutcome)
          && evidenceDecisionConsistent(item.decision, evidence.excerpts), `single evidence does not support decision on #${item.issue_number}`);
        const locators = evidence.excerpts.map((excerpt) => excerpt.locator);
        assert.strictEqual(new Set(locators).size, locators.length, `duplicate single evidence locator on #${item.issue_number}`);
        for (const excerpt of evidence.excerpts) {
          assert(excerpt.artifact_ref, `missing artifact ref on #${item.issue_number}`);
          assert(item.source_artifacts.some((artifact) => artifact.ref === excerpt.artifact_ref), `excerpt artifact is not pinned on #${item.issue_number}`);
          assert(excerpt.excerpt && excerpt.locator, `incomplete excerpt on #${item.issue_number}`);
        }
      }
      if (item.decision === 'multi-interview') {
        assert(item.case_keys.length >= 2);
        assert.strictEqual(evidence.case_evidence.length, item.case_keys.length);
        const locators = evidence.case_evidence.map((caseItem) => caseItem.evidence && caseItem.evidence.locator);
        assert.strictEqual(new Set(locators).size, locators.length, `duplicate case locator on #${item.issue_number}`);
        for (const caseItem of evidence.case_evidence) {
          assert(caseItem.anchor && caseItem.evidence && caseItem.evidence.locator && caseItem.detail_evidence && caseItem.detail_evidence.locator);
          assert(!caseItem.evidence.excerpt.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim().startsWith('#'), `case evidence is hashtag-only on #${item.issue_number}`);
          assert(!caseItem.detail_evidence.excerpt.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim().startsWith('#'), `case detail is hashtag-only on #${item.issue_number}`);
          assert(caseItem.evidence.locator !== caseItem.detail_evidence.locator || /(面试|提问|手撕|问|拷打|聊了|分钟|offer|一面|二面|三面|技术面|HR面)/i.test(`${caseItem.evidence.excerpt} ${caseItem.detail_evidence.excerpt}`), `multi case lacks process detail on #${item.issue_number}`);
        }
      }
    }
  }
  assert.strictEqual(decided + blocked, total);

  const batch = readJson(path.join(root, 'boundary-batch.json'));
  assert.strictEqual(batch.mutation_allowed, false);
  assert.deepStrictEqual(batch.live_issue_snapshot, selection.live_issue_snapshot);
  assert.deepStrictEqual(batch.source_artifact_snapshot, selection.source_artifact_snapshot);
  assert.deepStrictEqual(batch.parent_dependency, PARENT_DEPENDENCY);
  assert.deepStrictEqual(batch.parent_live_progress, PARENT_LIVE_PROGRESS);
  assert.strictEqual(batch.items.length, decided);
  assert(batch.items.every((item) => selection.items.find((selected) => selected.issue_number === item.issue_number).disposition === 'decided'));

  const plan = readJson(path.join(root, 'dry-run-plan.json'));
  validateDigest(plan, 'dry_run_sha256');
  assert.strictEqual(plan.selection_sha256, selection.selection_sha256);
  assert.deepStrictEqual(plan.live_issue_snapshot, selection.live_issue_snapshot);
  assert.deepStrictEqual(plan.source_artifact_snapshot, selection.source_artifact_snapshot);
  assert.deepStrictEqual(plan.parent_dependency, PARENT_DEPENDENCY);
  assert.deepStrictEqual(plan.parent_live_progress, PARENT_LIVE_PROGRESS);
  assert.strictEqual(plan.mutation_allowed, false);
  assert.strictEqual(plan.mutation_count, 0);
  assert.strictEqual(plan.live_evidence_comments_created, 0);
  assert.strictEqual(plan.items.length, total);

  const journal = readJson(path.join(root, 'apply-journal.json'));
  validateDigest(journal, 'journal_sha256');
  assert.strictEqual(journal.mode, 'not-authorized');
  assert.strictEqual(journal.mutation_allowed, false);
  assert.deepStrictEqual(journal.parent_dependency, PARENT_DEPENDENCY);
  assert.deepStrictEqual(journal.live_issue_snapshot, selection.live_issue_snapshot);
  assert.deepStrictEqual(journal.source_artifact_snapshot, selection.source_artifact_snapshot);
  assert.deepStrictEqual(journal.parent_live_progress, PARENT_LIVE_PROGRESS);
  assert(journal.entries.every((entry) => entry.mutation_performed === false && entry.evidence_comment_id === null));

  const audit = readJson(path.join(root, 'audit.json'));
  validateDigest(audit, 'audit_sha256');
  assert.deepStrictEqual(audit.out_of_scope_issue_numbers_read, []);
  assert.deepStrictEqual(audit.parent_dependency, PARENT_DEPENDENCY);
  assert.deepStrictEqual(audit.live_issue_snapshot, selection.live_issue_snapshot);
  assert.deepStrictEqual(audit.source_artifact_snapshot, selection.source_artifact_snapshot);
  assert.deepStrictEqual(audit.parent_live_progress, PARENT_LIVE_PROGRESS);
  assert.strictEqual(audit.checks.no_mutations, true);
  assert.strictEqual(audit.checks.no_live_evidence_comments, true);

  return { total, decided, blocked, selection_sha256: selection.selection_sha256, dry_run_sha256: plan.dry_run_sha256 };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(validateDirectory(process.argv[2] ? path.resolve(process.argv[2]) : ROOT), null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateDirectory };
