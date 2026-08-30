'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');

const validBody = fs.readFileSync(path.join(__dirname, 'fixtures/interview-note-issue.valid.md'), 'utf8');

test('valid InterviewNote Issue v2 projection passes', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'source:xhs', 'status:captured'],
    state: 'open',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('duplicate machine markers fail closed', () => {
  const body = `${validBody}\n<!-- interview-note: id=xhs:other schema=interview-note-issue.v2 -->\n`;
  const result = validateInterviewNoteIssue({ body, labels: ['type:interview-note', 'status:captured'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /exactly one interview-note machine marker/);
});

test('marker and record identity mismatch fails', () => {
  const body = validBody.replace(
    '"interview_note_id": "xhs:630e2e22000000001103c490"',
    '"interview_note_id": "xhs:wrong"',
  );
  const result = validateInterviewNoteIssue({ body, labels: ['type:interview-note', 'status:captured'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /marker id and record.interview_note_id differ/);
});

test('unknown interview occurrence time cannot carry invented value', () => {
  const body = validBody.replace(
    '"interview_occurred_at": {\n    "precision": "unknown",\n    "value": null\n  }',
    '"interview_occurred_at": {\n    "precision": "unknown",\n    "value": "2023-01-01"\n  }',
  );
  const result = validateInterviewNoteIssue({ body, labels: ['type:interview-note', 'status:captured'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unknown interview_occurred_at must use value=null/);
});

test('v2 rejects ambiguous source_time field', () => {
  const body = validBody.replace(
    '"source_published_at": {',
    '"source_time": {"precision": "year", "value": "2023"},\n  "source_published_at": {',
  );
  const result = validateInterviewNoteIssue({ body, labels: ['type:interview-note', 'status:captured'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /v2 record must not use ambiguous source_time/);
});

test('contradictory lifecycle labels fail', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:captured', 'status:source-ready'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /contradictory lifecycle labels/);
});

test('closed InterviewNote requires source-ready', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:captured'],
    state: 'closed',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /closed InterviewNote must carry status:source-ready/);
});

test('legacy v1 remains readable during migration', () => {
  const body = validBody
    .replaceAll('interview-note-issue.v2', 'interview-note-issue.v1')
    .replace(
      '"source_published_at": {\n    "precision": "year",\n    "value": "2023"\n  },\n  "source_edited_at": {\n    "precision": "unknown",\n    "value": null\n  },\n  "interview_occurred_at": {\n    "precision": "unknown",\n    "value": null\n  },',
      '"source_time": {\n    "precision": "year",\n    "value": "2023"\n  },',
    );
  const result = validateInterviewNoteIssue({ body, labels: ['type:interview-note', 'status:captured'] });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});
