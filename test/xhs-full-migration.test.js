'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');
const {
  findNoteObject,
  epochToShanghaiTimeFact,
  sortByPublishedAt,
  buildIssueProjection,
  extractInterviewNoteId,
  summarize,
} = require('../scripts/migrate-xhs-all');

function candidate(overrides = {}) {
  return {
    note_id: '6508552c000000001303f499',
    original_title: '9.18快手五战二面凉经',
    readable_desc: '真实面经正文',
    source_published_at: { precision: 'exact', value: '2023-09-18T21:48:28+08:00' },
    source_edited_at: { precision: 'unknown', value: null },
    interview_occurred_at: { precision: 'unknown', value: null },
    artifacts: [{
      kind: 'html',
      ref: 'liqiangcc/xhs:note_detail/6508552c000000001303f499.html@abc123',
      git_blob_sha: 'a'.repeat(40),
      sha256: null,
      provenance: 'raw_capture',
    }],
    limitations: ['captured only'],
    ...overrides,
  };
}

test('recursively finds note object by exact noteId', () => {
  const root = { global: { note: { noteId: 'abc', time: 123, title: '面经' } } };
  assert.equal(findNoteObject(root, 'abc').title, '面经');
  assert.equal(findNoteObject(root, 'missing'), null);
});

test('XHS epoch milliseconds become explicit +08:00 source time', () => {
  const fact = epochToShanghaiTimeFact(1695044908000);
  assert.equal(fact.precision, 'exact');
  assert.match(fact.value, /^2023-09-18T/);
  assert.match(fact.value, /\+08:00$/);
});

test('full migration creation order is source_published_at ascending with unknown last', () => {
  const values = [
    candidate({ note_id: 'c', source_published_at: { precision: 'unknown', value: null } }),
    candidate({ note_id: 'b', source_published_at: { precision: 'exact', value: '2024-01-01T00:00:00+08:00' } }),
    candidate({ note_id: 'a', source_published_at: { precision: 'exact', value: '2022-01-01T00:00:00+08:00' } }),
  ];
  assert.deepEqual(sortByPublishedAt(values).map((item) => item.note_id), ['a', 'b', 'c']);
});

test('intake Issue title uses publication date and never raw spoiler title', () => {
  const projection = buildIssueProjection(candidate(), '95b77bb261048059846273688e4b90a2e108b437', '2026-09-03T12:00:00Z');
  assert.equal(projection.title, '[XHS] 2023-09-18 · 6508552c');
  assert.doesNotMatch(projection.title, /凉经|挂|拒绝|offer/i);
  assert.match(projection.body, /9\.18快手五战二面凉经/);
});

test('bulk intake keeps interview time unknown and remains captured', () => {
  const projection = buildIssueProjection(candidate(), '95b77bb261048059846273688e4b90a2e108b437', '2026-09-03T12:00:00Z');
  assert.deepEqual(projection.labels, ['type:interview-note', 'source:xhs', 'status:captured']);
  assert.match(projection.body, /"interview_occurred_at": \{\n    "precision": "unknown",\n    "value": null/);
  const validation = validateInterviewNoteIssue({ body: projection.body, labels: projection.labels, state: 'open' });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test('existing marker identity is stable idempotency key', () => {
  const projection = buildIssueProjection(candidate(), '95b77bb261048059846273688e4b90a2e108b437', '2026-09-03T12:00:00Z');
  assert.equal(extractInterviewNoteId(projection.body), 'xhs:6508552c000000001303f499');
});

test('migration summary preserves existing Issues and only creates missing identities', () => {
  const projections = [
    { interview_note_id: 'xhs:a', source_published_at: { precision: 'exact', value: '2022-01-01T00:00:00+08:00' } },
    { interview_note_id: 'xhs:b', source_published_at: { precision: 'exact', value: '2023-01-01T00:00:00+08:00' } },
  ];
  const existing = new Map([['xhs:a', 3]]);
  const result = summarize(projections, existing, '95b77bb261048059846273688e4b90a2e108b437');
  assert.equal(result.total_candidates, 2);
  assert.equal(result.existing_preserved, 1);
  assert.equal(result.to_create, 1);
  assert.equal(result.creation_order, 'source_published_at ASC, note_id ASC tie-breaker, unknown-time last');
});
