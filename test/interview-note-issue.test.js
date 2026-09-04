'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');
const { childInterviewNoteId } = require('../scripts/lib/interview-note-identity');

const validBody = fs.readFileSync(path.join(__dirname, 'fixtures/interview-note-issue.valid.md'), 'utf8');

test('valid InterviewNote Issue v2 projection passes', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'source:xhs', 'status:captured'],
    state: 'open',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('multi-interview child identity is valid only with matching SourceNote case metadata', () => {
  const source = { system: 'xhs', external_id: '630e2e22000000001103c490' };
  const childId = childInterviewNoteId(source, 'process-a');
  const childBody = validBody
    .replace('<!-- interview-note: id=xhs:630e2e22000000001103c490', `<!-- interview-note: id=${childId}`)
    .replace('"interview_note_id": "xhs:630e2e22000000001103c490",', `"interview_note_id": "${childId}",\n  "identity": {\n    "kind": "source-note-event",\n    "source_note_id": "xhs-note:${source.external_id}",\n    "case_key": "process-a"\n  },`);
  const result = validateInterviewNoteIssue({
    body: childBody,
    labels: ['type:interview-note', 'source:xhs', 'status:captured'],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('reviewed learning discovery label families are allowed only when source-ready', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: [
      'type:interview-note',
      'source:xhs',
      'status:source-ready',
      'company:kuaishou',
      'role:backend',
      'recruitment:campus',
      'round:2',
      'source-year:2023',
    ],
    state: 'closed',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
});

test('learning discovery projection requires source-year when publication year is known', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:source-ready', 'company:kuaishou'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must include source-year:2023/);
});

test('source-year must match source_published_at rather than another time field', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:source-ready', 'company:kuaishou', 'source-year:2022'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source-year label must match record\.source_published_at year \(2023\)/);
});

test('generic year label is forbidden now that time namespaces are explicit', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:source-ready', 'year:2023'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /ambiguous label prefix forbidden/);
});

test('year-bearing interview occurrence requires interview-year in learning discovery projection', () => {
  const body = validBody.replace(
    '"interview_occurred_at": {\n    "precision": "unknown",\n    "value": null\n  }',
    '"interview_occurred_at": {\n    "precision": "exact",\n    "value": "2022-08-02"\n  }',
  );
  const missing = validateInterviewNoteIssue({
    body,
    labels: ['type:interview-note', 'status:source-ready', 'company:baidu', 'source-year:2023'],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /must include interview-year:2022/);

  const present = validateInterviewNoteIssue({
    body,
    labels: ['type:interview-note', 'status:source-ready', 'company:baidu', 'source-year:2023', 'interview-year:2022'],
  });
  assert.equal(present.ok, true, JSON.stringify(present.errors));
});

test('source-review InterviewNote cannot enter learning pool through discovery labels', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'source:xhs', 'status:source-review', 'round:1'],
    state: 'open',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Learning Discovery Labels require status:source-ready/);
});

test('blocked InterviewNote cannot enter learning pool through discovery labels', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'source:xhs', 'status:blocked', 'company:alibaba'],
    state: 'open',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Learning Discovery Labels require status:source-ready/);
});

test('source-review without learning discovery labels remains valid workflow state', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'source:xhs', 'status:source-review', 'task:source-review'],
    state: 'open',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('duplicate learning discovery family values fail', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:source-ready', 'round:1', 'round:2'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /round:.*at most one value/);
});

test('outcome labels fail closed to avoid learning-list spoilers', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:captured', 'result:rejected'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /outcome label forbidden/);
});

test('company label requires normalized machine id', () => {
  const result = validateInterviewNoteIssue({
    body: validBody,
    labels: ['type:interview-note', 'status:source-ready', 'company:快手'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /company label must use normalized machine id/);
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

test('month_day preserves yearless source date without inventing year', () => {
  const body = validBody.replace(
    '"interview_occurred_at": {\n    "precision": "unknown",\n    "value": null\n  }',
    '"interview_occurred_at": {\n    "precision": "month_day",\n    "value": "09-18"\n  }',
  );
  const result = validateInterviewNoteIssue({ body, labels: ['type:interview-note', 'status:captured'] });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
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
