'use strict';
// Read-only replay of this fixed review; no GitHub or mutation path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const { validateInterviewContext, buildLearningDiscovery } = require(path.join(root, 'scripts/lib/interview-context'));
const { parseInterviewNoteIssue } = require(path.join(root, 'scripts/lib/interview-note-issue'));
const { computeChecks } = require(path.join(root, 'scripts/lib/interview-note-source-review-transition'));
const review = JSON.parse(fs.readFileSync(path.join(__dirname, 'review.json')));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const expectedScope = [1309,1325,1333,1363,1375,1376,1380,1401,1406,1418,1428,1447,1458];
assert.deepEqual(review.scope, expectedScope);
assert.deepEqual(review.rows.map(r => r.source_issue), expectedScope);
assert.equal(review.saved_owner_snapshot.commit, '4aec350d402f667458282bb36be124e12f978e0a');
const snapshot = JSON.parse(execFileSync('git', ['show', `${review.saved_owner_snapshot.commit}:audit/issue-1658-receipt-repair/current-live-snapshot.json`], {cwd:root, maxBuffer:4*1024*1024, encoding:'utf8'}));
for (const row of review.rows) {
  const old = snapshot.rows.find(r => r.source_issue === row.source_issue);
  assert.equal(old.owner.number, row.owner_issue);
  assert.equal(sha(old.owner.body), row.owner_body_sha256);
  assert.equal(sha(old.source.body), row.source_body_sha256);
  const raw = fs.readFileSync(path.join(root, row.context_file), 'utf8');
  assert.equal(sha(raw), row.context_sha256);
  const context = JSON.parse(raw);
  const valid = validateInterviewContext(context);
  assert.equal(valid.ok, true, valid.errors.join('; '));
  assert.equal(context.interview_note_id, row.identity);
  assert.equal(context.source_revision_id, row.source_revision_id);
  const excerpt = old.owner.body.slice(old.owner.body.indexOf('## 原始标题'), old.owner.body.indexOf('## 原始附件'));
  assert.equal(row.reviewed_excerpt, excerpt);
  for (const fact of [context.company, context.role, context.recruitment_type, context.round, context.interview_occurred_at]) {
    for (const ref of fact.evidence_refs) assert.ok(excerpt.includes(ref.slice(ref.indexOf(':')+1)), ref);
  }
  assert.deepEqual(row.projection, buildLearningDiscovery(context, parseInterviewNoteIssue(old.owner.body).record.source_published_at));
  assert.deepEqual(row.source_review_preflight, computeChecks({interview_note_id:row.identity,issue_number:row.owner_issue,expected_source_revision_id:row.source_revision_id,expected_source_repository_ref:review.source_ref},old.owner,old.source,snapshot.rows.map(r => r.owner)));
  assert.equal(row.learning_apply, 'BLOCKED');
}
console.log('PASS: 13 context schemas, identity/revision/body bindings, exact evidence excerpts, discovery projections and scoped Source Review preflight; live writes=0');
