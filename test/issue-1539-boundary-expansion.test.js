'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_ISSUES,
  REPOSITORY,
  SOURCE_REF,
  canonicalJson,
  sha256Text,
  canonicalSourceProjectionRef,
  normalizeLabels,
  validateCandidateManifest,
  gitBlobSha,
  verifyPinnedArtifact,
  buildBoundaryRequest,
  buildMaterializationRequest,
  exactOwnership,
  planBoundaryExpansion,
} = require('../scripts/lib/issue-1539-boundary-expansion');

const manifestPath = path.join(__dirname, '../data/pilot/issue-1539/boundary-expansion-candidates.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('fixed candidate manifest is exactly 17 ordered SourceNote Issues', () => {
  const result = validateCandidateManifest(manifest);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(manifest.items.map((item) => item.issue_number), FIXED_ISSUES);
  assert.equal(new Set(manifest.items.map((item) => item.source_note_id)).size, 17);
});

test('candidate schema is closed and runtime validation remains the authoritative fixed-set gate', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas/issue-1539-boundary-expansion-candidates.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema_version', 'repository', 'parent_issue', 'epic_issue', 'source_repository', 'source_repository_ref', 'minimum_candidates', 'items']);
  assert.equal(schema.properties.items.minItems, 17);
  assert.equal(schema.properties.items.maxItems, 17);
  const changed = structuredClone(manifest);
  changed.items[0].issue_number = 1509;
  assert.equal(validateCandidateManifest(changed).ok, false);
});

test('candidate set rejects an added or reordered Issue before live reads', () => {
  const reordered = structuredClone(manifest);
  reordered.items[0] = reordered.items[1];
  const result = validateCandidateManifest(reordered);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /fixed candidate|duplicated|fixed issue-scoped/);
});

test('label normalization accepts REST objects and fails malformed labels closed', () => {
  assert.deepEqual(normalizeLabels([{ name: 'type:source-note' }, 'boundary:pending']).labels, ['type:source-note', 'boundary:pending']);
  const malformed = normalizeLabels([{ color: 'fff' }]);
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors[0], /non-empty string/);
});

test('pinned artifact verification proves Git blob content, SHA and anchor', () => {
  const content = Buffer.from('真实面试时间：2026-01-01\n问题：请介绍项目\n', 'utf8');
  const blobSha = gitBlobSha(content);
  const item = { artifact: {
    ref: `liqiangcc/xhs:note_desc/test.txt@${SOURCE_REF}`,
    git_blob_sha: blobSha,
    anchor: '请介绍项目',
  }, source_note_id: 'xhs-note:test' };
  const sourceRecord = { source_note_id: 'xhs-note:test', source: { external_id: 'test' }, artifacts: [{ provenance: 'source_projection', kind: 'text_projection', ref: item.artifact.ref, git_blob_sha: blobSha }] };
  const good = verifyPinnedArtifact(item, sourceRecord, () => ({ sha: blobSha, encoding: 'base64', content: content.toString('base64') }));
  assert.equal(good.ok, true, good.errors.join('\n'));
  const tampered = verifyPinnedArtifact(item, sourceRecord, () => ({ sha: blobSha, encoding: 'base64', content: Buffer.from('不相干', 'utf8').toString('base64') }));
  assert.equal(tampered.ok, false);
  assert.match(tampered.errors.join('\n'), /SHA|anchor/);
});

test('a different candidate valid ref/blob/anchor and path/id mismatch fail closed', () => {
  const first = manifest.items[0];
  const second = manifest.items[1];
  const borrowed = structuredClone(manifest);
  borrowed.items[0].artifact = structuredClone(second.artifact);
  assert.equal(validateCandidateManifest(borrowed).ok, false);
  assert.match(validateCandidateManifest(borrowed).errors.join('\n'), /canonical SourceNote projection ref/);
  const pathMismatch = structuredClone(first);
  pathMismatch.artifact.ref = `liqiangcc/xhs:note_desc/not-${first.source_note_id.slice('xhs-note:'.length)}.txt@${SOURCE_REF}`;
  assert.equal(validateCandidateManifest({ ...manifest, items: [pathMismatch, ...manifest.items.slice(1)] }).ok, false);
  assert.equal(canonicalSourceProjectionRef(first.source_note_id), first.artifact.ref);
});

test('ownership ignores SourceNote false positives and rejects duplicate exact InterviewNote owners', () => {
  const id = 'xhs:abc';
  assert.deepEqual(exactOwnership([{ number: 10, body: '<!-- source-note: id=xhs-note:abc schema=source-note-issue.v1 -->' }], id), { count: 0, issue_numbers: [] });
  const owner = '<!-- interview-note: id=xhs:abc schema=interview-note-issue.v2 -->';
  assert.deepEqual(exactOwnership([{ number: 11, body: owner }], id), { count: 1, issue_numbers: [11] });
  assert.equal(exactOwnership([{ number: 11, body: owner }, { number: 12, body: owner }], id).count, 2);
});

test('requests are bound to the fixed facts but remain non-executable without independent evidence', () => {
  const item = manifest.items[0];
  const boundary = buildBoundaryRequest(item);
  assert.equal(boundary.executable, false);
  assert.equal(boundary.request.review_evidence, null);
  assert.equal(boundary.request.reviewed_at, null);
  assert.equal(boundary.request.issue_number, item.issue_number);
  const materialization = buildMaterializationRequest(item);
  assert.equal(materialization.expected_boundary_status, 'single-interview');
  assert.equal(materialization.expected_source_repository_ref, SOURCE_REF);
  assert.equal(materialization.source_note_id, item.source_note_id);
});

test('planner is all-or-nothing and produces no mutation when any live candidate is unavailable', () => {
  const calls = [];
  const result = planBoundaryExpansion(manifest, {
    readIssue: (number) => { calls.push(number); throw new Error(`simulated stale read #${number}`); },
    readBlob: () => { throw new Error('must not read blob without issue'); },
    readComments: () => [],
    findOwnership: () => [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.report.total, 17);
  assert.equal(result.report.mutation_count, 0);
  assert.equal(result.report.source_ready_claimed, 0);
  assert.equal(result.report.blocked.length, 17);
  assert.equal(calls.length, 17);
  assert.match(result.report.execution_contract.sequencing, /Boundary Review.*materialization.*independent Source Review/);
});

test('report digest is deterministic and changes when an immutable candidate fact changes', () => {
  const first = sha256Text(canonicalJson(manifest));
  const changed = structuredClone(manifest);
  changed.items[0].artifact.anchor = `${changed.items[0].artifact.anchor}!`;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, sha256Text(canonicalJson(changed)));
});

test('repository is fixed to the issue-scoped parent workflow', () => {
  assert.equal(REPOSITORY, 'liqiangcc/interview-lab');
});
