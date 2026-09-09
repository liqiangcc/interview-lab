'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyPlan,
  bodySha,
  buildPlanOnly,
  createFakeApi,
  digestPlan,
} = require('../scripts/lib/issue-1656-boundary-only-writer');

const fixture = require('../data/pilot/issue-1656/boundary-transition.plan.json');

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-boundary-only-'));
  return { dir, journalPath: path.join(dir, 'journal.json'), lockPath: path.join(dir, 'lock') };
}

function makePlan(issueNumbers = [101, 102]) {
  const rows = issueNumbers.map((number, index) => {
    const body = `source body ${number}`;
    const labels = ['boundary:pending', `type:source-note-${index}`];
    const nextLabels = ['boundary:complete', `type:source-note-${index}`];
    return {
      issue_number: number,
      transition_request: { transition_id: `transition-${number}` },
      cas: {
        issue_number: number,
        expected_body_sha256: bodySha({ body }),
        expected_boundary_status: 'pending',
        expected_source_revision_id: `revision-${number}`,
        source_note_id: `note-${number}`,
        source_projection_ref: `projection-${number}`,
        source_projection_blob_sha: `blob-${number}`,
        source_projection_content_sha256: `content-${number}`,
        expected_source_repository_ref: 'source-ref',
        expected_title: `Source ${number}`,
        expected_labels: labels,
      },
      patch: { labels: nextLabels },
    };
  });
  return {
    schema_version: 'issue-1656-boundary-transition-plan.v1',
    repository: 'liqiangcc/interview-lab',
    issue: 1656,
    scope: { proposal_count: rows.length, blocked_count: 4 },
    rows,
    blocked: [972, 1266, 1326, 1349].map((issue_number) => ({ issue_number, status: 'blocked', mutation_count: 0 })),
    mutation_guard: { patch: 0, post: 0, label: 0, mutation: 0, read_only: true, live_mutation: false },
  };
}

function makeIssues(plan) {
  return Object.fromEntries(plan.rows.map((row) => [row.issue_number, {
    number: row.issue_number,
    title: row.cas.expected_title,
    body: `source body ${row.issue_number}`,
    labels: [...row.cas.expected_labels],
    boundary_status: row.cas.expected_boundary_status,
    source_note_id: row.cas.source_note_id,
    source_revision_id: row.cas.expected_source_revision_id,
    source_repository_ref: row.cas.expected_source_repository_ref,
    source_projection_ref: row.cas.source_projection_ref,
    source_projection_blob_sha: row.cas.source_projection_blob_sha,
    source_projection_content_sha256: row.cas.source_projection_content_sha256,
  }]));
}

test('default boundary fixture is plan-only and never reads the four blocked rows', () => {
  const report = buildPlanOnly(fixture);
  assert.equal(report.plan_only, true);
  assert.equal(report.proposal_count, 13);
  assert.equal(report.blocked_count, 4);
  assert.equal(report.blocked_reads, 0);
  assert.equal(report.mutation, 0);
});

test('apply requires explicit auth, exact digest, and exact ceiling', async () => {
  const plan = makePlan([101]);
  const paths = tempPaths();
  const api = createFakeApi(makeIssues(plan));
  await assert.rejects(() => applyPlan({
    plan, api, journalPath: paths.journalPath, lockPath: paths.lockPath,
    authorization: { allow_live_github: false, plan_digest: digestPlan(plan), ceiling: 1 },
    ceiling: 1,
  }), /explicit authorization/);
  assert.equal(api.calls.length, 0);
});

test('fake apply only PATCHes and posts receipts; blocked rows are never read', async () => {
  const plan = makePlan();
  const paths = tempPaths();
  const api = createFakeApi(makeIssues(plan));
  const digest = digestPlan(plan);
  const result = await applyPlan({
    plan, api, journalPath: paths.journalPath, lockPath: paths.lockPath,
    authorization: { allow_live_github: true, plan_digest: digest, ceiling: 2 },
    ceiling: 2,
  });
  assert.deepEqual(result.patched, [101, 102]);
  assert.equal(result.receipts.length, 2);
  assert.equal(api.calls.some((call) => [972, 1266, 1326, 1349].includes(call.number)), false);
  assert.deepEqual([...new Set(api.calls.map((call) => call.method))].sort(), ['patchIssue', 'postReceipt', 'readIssue'].sort());
  assert.equal(fs.existsSync(paths.lockPath), false);
  const journal = JSON.parse(fs.readFileSync(paths.journalPath, 'utf8'));
  assert.equal(journal.filter((entry) => entry.event === 'patch-converged').length, 2);
  assert.equal(journal.filter((entry) => entry.event === 'receipt-posted').length, 2);
});

test('fresh CAS failure prevents PATCH', async () => {
  const plan = makePlan([101]);
  const paths = tempPaths();
  const issues = makeIssues(plan);
  issues[101].body = 'changed';
  const api = createFakeApi(issues);
  await assert.rejects(() => applyPlan({
    plan, api, journalPath: paths.journalPath, lockPath: paths.lockPath,
    authorization: { allow_live_github: true, plan_digest: digestPlan(plan), ceiling: 1 }, ceiling: 1,
  }), /body CAS mismatch/);
  assert.equal(api.calls.some((call) => call.method === 'patchIssue'), false);
  const journal = JSON.parse(fs.readFileSync(paths.journalPath, 'utf8'));
  assert.equal(journal.at(-1).event, 'precondition-failed');
});

test('lock deletion during PATCH fails closed and journals patch-unknown', async () => {
  const plan = makePlan([101]);
  const paths = tempPaths();
  const api = createFakeApi(makeIssues(plan), {
    onPatch: async () => fs.unlinkSync(paths.lockPath),
  });
  await assert.rejects(() => applyPlan({
    plan, api, journalPath: paths.journalPath, lockPath: paths.lockPath,
    authorization: { allow_live_github: true, plan_digest: digestPlan(plan), ceiling: 1 }, ceiling: 1,
  }), /exclusive lock/);
  const journal = JSON.parse(fs.readFileSync(paths.journalPath, 'utf8'));
  assert.equal(journal.at(-1).event, 'patch-unknown');
  assert.equal(journal.at(-1).status, 'uncertain');
  assert.equal(api.calls.some((call) => call.method === 'postReceipt'), false);
});

test('post-PATCH GET drift fails closed and journals patch-unknown', async () => {
  const plan = makePlan([101]);
  const paths = tempPaths();
  const api = createFakeApi(makeIssues(plan), {
    onRead: async (number, callCount) => {
      if (callCount === 3) api.issues.get(number).labels = ['boundary:drifted'];
    },
  });
  await assert.rejects(() => applyPlan({
    plan, api, journalPath: paths.journalPath, lockPath: paths.lockPath,
    authorization: { allow_live_github: true, plan_digest: digestPlan(plan), ceiling: 1 }, ceiling: 1,
  }), /labels mismatch/);
  const journal = JSON.parse(fs.readFileSync(paths.journalPath, 'utf8'));
  assert.equal(journal.at(-1).event, 'patch-unknown');
  assert.equal(api.calls.some((call) => call.method === 'postReceipt'), false);
});
