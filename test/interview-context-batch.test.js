'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256Text, planBatch, receiptFor } = require('../scripts/lib/interview-context-batch');
const { parseInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');

const body = fs.readFileSync(path.join(__dirname, 'fixtures/interview-note-issue.valid.md'), 'utf8');
const parsed = parseInterviewNoteIssue(body);
const dependencies = [917, 920, 921, 922].map((number) => ({ number, state: 'closed' }));

function context(overrides = {}) {
  return {
    schema_version: 'interview-context.v1',
    context_id: `${parsed.record.interview_note_id}:context-v1`,
    interview_note_id: parsed.record.interview_note_id,
    source_revision_id: parsed.record.source_revision.id,
    review_status: 'reviewed',
    reviewed_at: '2026-09-04T04:00:00Z',
    company: { id: 'kuaishou', display_name: '快手', basis: 'source-explicit', evidence_refs: ['raw-title:快手'] },
    role: { family: 'backend', title: '后端开发', basis: 'reviewed-inference', evidence_refs: ['raw:backend'] },
    recruitment_type: { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    round: { value: '2', basis: 'source-explicit', evidence_refs: ['raw-title:二面'] },
    interview_occurred_at: { precision: 'unknown', value: null, basis: 'unknown', evidence_refs: [] },
    outcome_visibility: 'sealed-until-source-reveal',
    ...overrides,
  };
}

function request(itemContext = context()) {
  return {
    schema_version: 'interview-context-batch-review.v1',
    batch_id: 'issue-923-fixture-1',
    repository: 'liqiangcc/interview-lab',
    dependency_issues: [917, 920, 921, 922],
    pilot_size: 1,
    items: [{ issue_number: 915, expected_body_sha256: sha256Text(body), context: itemContext }],
  };
}

function issue(overrides = {}) {
  return {
    number: 915,
    state: 'open',
    title: '原始标题含结果：凉经',
    body,
    labels: ['type:interview-note', 'source:xhs', 'status:source-ready', 'task:question-review'],
    ...overrides,
  };
}

function plan(itemContext = context(), issueOverrides = {}, receiptMap = new Map()) {
  return planBatch(request(itemContext), { dependencies, issues: [issue(issueOverrides)], receiptsByIssue: receiptMap });
}

test('batch planner projects only reviewed source-ready InterviewNotes', () => {
  const result = plan();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.summary, {
    pilot_size: 1,
    ready_count: 1,
    unknown_count: 2,
    unknown_item_count: 1,
    needs_review_count: 0,
    already_applied_count: 0,
    proposed_mutation_count: 1,
    mutation_count: 1,
  });
  assert.deepEqual(result.items[0].projection.labels, [
    'company:kuaishou',
    'role:backend',
    'round:2',
    'source:xhs',
    'status:source-ready',
    'task:question-review',
    'type:interview-note',
    'source-year:2023',
  ].sort());
  assert.equal(result.items[0].projection.title, '[快手] 后端 · 二面 · 630e2e22');
});

test('unmet dependency gate blocks the batch before candidate planning', () => {
  const result = planBatch(request(), {
    dependencies: [{ number: 917, state: 'open' }],
    issues: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.errors.join('\n'), /Issue #917 is not closed/);
  assert.equal(result.summary.mutation_count, 0);
});

test('SourceNote body is never accepted as an InterviewNote candidate', () => {
  const sourceBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
  const sourceIssue = issue({ body: sourceBody, title: 'SourceNote', labels: ['type:source-note', 'source:xhs', 'status:source-ready'] });
  const result = planBatch(request(), { dependencies, issues: [sourceIssue] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /SourceNote cannot be used as InterviewNote/);
});

test('stale body CAS fails closed without a proposed mutation', () => {
  const result = plan(context(), { body: `${body}\nchanged` });
  assert.equal(result.ok, false);
  assert.equal(result.items[0].action, 'needs_review');
  assert.match(result.errors.join('\n'), /stale InterviewNote body digest/);
});

test('source year and interview year remain independent', () => {
  const result = plan(context({
    interview_occurred_at: {
      precision: 'exact', value: '2022-08-02', basis: 'source-explicit', evidence_refs: ['raw:date'],
    },
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.items[0].projection.labels.includes('source-year:2023'));
  assert.ok(result.items[0].projection.labels.includes('interview-year:2022'));
});

test('outcome wording in derived title fails closed', () => {
  const result = plan(context({ company: { id: 'offer-company', display_name: 'offer', basis: 'source-explicit', evidence_refs: ['raw'] } }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /non-spoiler title contains forbidden outcome wording/);
});

test('matching projection receipt makes retry idempotent', () => {
  const first = plan();
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const second = plan(undefined, {
    title: first.items[0].projection.title,
    labels: first.items[0].projection.labels,
  }, new Map([[915, [{ ...receipt, comment_id: 123 }]]]));
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.items[0].action, 'already_applied');
  assert.equal(second.summary.mutation_count, 0);
});
