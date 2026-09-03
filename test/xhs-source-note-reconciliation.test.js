'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProjection, planActions, validateProjection } = require('../scripts/reconcile-xhs-source-notes');

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

test('XHS candidate projects to SourceNote, not InterviewNote', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.equal(projection.source_note_id, 'xhs-note:625564d70000000001025e46');
  assert.match(projection.body, /<!-- source-note:/);
  assert.doesNotMatch(projection.body, /<!-- interview-note:/);
  assert.deepEqual(projection.labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk',
  ]);
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

test('formal non-bulk InterviewNote is protected from conversion', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map(),
    protectedInterview: new Map([[projection.external_id, { number: 3 }]]),
  });
  assert.equal(actions[0].action, 'protected-formal-interview-note');
  assert.equal(actions[0].issue_number, 3);
});

test('existing SourceNote wins idempotently', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, { number: 20 }]]),
    bulkLegacy: new Map([[projection.external_id, { number: 20 }]]),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'source-note-exists');
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
