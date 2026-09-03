'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MUTATING_ACTIONS,
  buildProjection,
  planActions,
  validateProjection,
  summarizeAnomalies,
} = require('../scripts/reconcile-xhs-source-notes');

const sourceRef = '95b77bb261048059846273688e4b90a2e108b437';

function candidate(overrides = {}) {
  return {
    note_id: '625564d70000000001025e46',
    original_title: '阿里蚂蚁金服Java中间件6轮面试题! 总结',
    readable_desc: '这些都是不断面试积累来的经验。',
    source_published_at: { precision: 'exact', value: '2022-04-12T19:39:03.000+08:00' },
    source_edited_at: { precision: 'exact', value: '2022-04-15T19:36:11.000+08:00' },
    artifacts: [{
      kind: 'image',
      ref: `liqiangcc/xhs:downloaded_images/625564d70000000001025e46/1.webp@${sourceRef}`,
      git_blob_sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      sha256: null,
      provenance: 'raw_capture',
      byte_size: 0,
      integrity: 'zero-byte',
    }],
    anomalies: [{ code: 'zero-byte-artifacts', detail: '1 artifact(s) are zero-byte in the pinned source snapshot' }],
    limitations: ['SourceNote intake 不判断该帖子是否等于一次真实面试事件。'],
    ...overrides,
  };
}

function existingSourceNote(number, labels) {
  return { number, labels: labels.map((name) => ({ name })) };
}

test('XHS candidate projects to SourceNote, not InterviewNote', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.equal(projection.source_note_id, 'xhs-note:625564d70000000001025e46');
  assert.match(projection.body, /<!-- source-note:/);
  assert.doesNotMatch(projection.body, /<!-- interview-note:/);
  assert.deepEqual(projection.labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022',
  ]);
  const result = validateProjection(projection);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('unknown publication year does not invent source-year label', () => {
  const projection = buildProjection(candidate({
    source_published_at: { precision: 'unknown', value: null },
  }), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.equal(projection.labels.some((label) => label.startsWith('source-year:')), false);
  const result = validateProjection(projection);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('projection preserves zero-byte evidence without pretending it is healthy', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.match(projection.body, /zero-byte/);
  assert.match(projection.body, /zero-byte-artifacts/);
});

test('legacy bulk InterviewNote is converted in place', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map([[projection.external_id, { number: 20 }]]),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'convert-bulk-interview-note-in-place');
  assert.equal(actions[0].issue_number, 20);
});

test('formal non-bulk InterviewNote is preserved while its SourceNote is still backfilled', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map(),
    protectedInterview: new Map([[projection.external_id, { number: 3 }]]),
  });
  assert.equal(actions[0].action, 'create-source-note-alongside-formal-interview-note');
  assert.equal(actions[0].issue_number, null);
  assert.equal(actions[0].protected_interview_issue_number, 3);
});

test('existing SourceNote with correct source-year is current and idempotent', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(600, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map([[projection.external_id, { number: 3 }]]),
  });
  assert.equal(actions[0].action, 'source-note-current');
  assert.equal(actions[0].issue_number, 600);
  assert.equal(MUTATING_ACTIONS.has(actions[0].action), false);
});

test('existing SourceNote missing source-year gets a labels-only discovery reconciliation action', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(20, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.equal(actions[0].issue_number, 20);
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022',
  ]);
  assert.equal(MUTATING_ACTIONS.has(actions[0].action), true);
});

test('wrong source-year is replaced without changing unrelated labels or boundary state', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(601, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview', 'custom:keep-me', 'source-year:2023',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview', 'custom:keep-me', 'source-year:2022',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'title'), false);
});

test('unknown publication time removes stale source-year while preserving other labels', () => {
  const projection = buildProjection(candidate({
    source_published_at: { precision: 'unknown', value: null },
  }), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(602, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:not-interview', 'source-year:2022', 'custom:keep-me',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:not-interview', 'custom:keep-me',
  ]);
});

test('duplicate stale source-year values collapse to the single authoritative source year', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(603, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'source-year:2022', 'source-year:2023',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'source-year:2022',
  ]);
});

test('missing source identity becomes a new SourceNote, not an InterviewNote', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'create-source-note');
});

test('anomaly summary counts affected SourceNotes by anomaly code', () => {
  const counts = summarizeAnomalies([
    candidate(),
    candidate({
      note_id: 'another',
      anomalies: [
        { code: 'zero-byte-artifacts', detail: '2 zero-byte artifacts' },
        { code: 'edited-before-published', detail: 'source order anomaly' },
      ],
    }),
  ]);
  assert.deepEqual(counts, {
    'zero-byte-artifacts': 2,
    'edited-before-published': 1,
  });
});
