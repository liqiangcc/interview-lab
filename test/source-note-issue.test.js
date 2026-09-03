'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('../scripts/lib/source-note-issue');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');
const labels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022'];

test('valid pending SourceNote intake passes', () => {
  const result = validateSourceNoteIssue({ body: fixture, labels, state: 'open' });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('SourceNote cannot also claim InterviewNote type', () => {
  const result = validateSourceNoteIssue({ body: fixture, labels: [...labels, 'type:interview-note'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must not also carry type:interview-note/);
});

test('SourceNote cannot carry InterviewNote-only labels', () => {
  const result = validateSourceNoteIssue({ body: fixture, labels: [...labels, 'company:alibaba'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must not carry InterviewNote-only labels/);
});

test('SourceNote requires source-year when source_published_at proves the year', () => {
  const result = validateSourceNoteIssue({ body: fixture, labels: labels.filter((label) => !label.startsWith('source-year:')) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must include source-year:2022/);
});

test('SourceNote source-year must match source_published_at', () => {
  const result = validateSourceNoteIssue({
    body: fixture,
    labels: labels.map((label) => label === 'source-year:2022' ? 'source-year:2023' : label),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must match record.source_published_at year \(2022\)/);
});

test('pending boundary review cannot predeclare InterviewNote identities', () => {
  const parsed = parseSourceNoteIssue(fixture);
  const mutated = JSON.parse(JSON.stringify(parsed.record));
  mutated.boundary_review.interview_note_ids = ['xhs:fake:event-1'];
  const body = fixture.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(mutated, null, 2));
  const result = validateSourceNoteIssue({ body, labels });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must not predeclare InterviewNote ids/);
});

test('zero-byte artifact must be explicitly marked zero-byte', () => {
  const parsed = parseSourceNoteIssue(fixture);
  const mutated = JSON.parse(JSON.stringify(parsed.record));
  mutated.artifacts[1].integrity = 'present';
  const body = fixture.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(mutated, null, 2));
  const result = validateSourceNoteIssue({ body, labels });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /byte_size=0 must use integrity=zero-byte/);
});

test('closed pending SourceNote fails closed', () => {
  const result = validateSourceNoteIssue({ body: fixture, labels, state: 'closed' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /pending SourceNote must not be closed/);
});
