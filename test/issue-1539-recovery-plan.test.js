'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, parseIndependentEvidence, reviewAction } = require('../scripts/lib/issue-1539-recovery-plan');
const { analyzeSourceProvenance, sourceReadyGate } = require('../scripts/lib/source-note-provenance');
const { buildManifest: buildPinnedArtifactManifest, validateManifest: validatePinnedArtifactManifest, verifyManifestDigest, verifyManifestItem } = require('../scripts/lib/issue-1539-pinned-artifact-manifest');
const { buildSourceReviewRequest } = require('../scripts/plan-xhs-issue-1539-recovery');
const { evidenceSubjectSha256, validateRequest } = require('../scripts/lib/interview-note-source-review-transition');

function manifest() {
  return {
    schema_version: 'issue-1539-recovery-plan.v1',
    repository: 'liqiangcc/interview-lab',
    source_snapshot: { repository: 'liqiangcc/xhs', ref: 'a'.repeat(40) },
    source_review: { batch_id: 'source-review-1', items: [{ interview_issue_number: 1509, source_note_issue_number: 30 }, { interview_issue_number: 1510, source_note_issue_number: 30 }] },
    boundary_expansion: { batch_id: 'boundary-1', selection_policy: 'pending-source-note-issue-number-ascending', issue_numbers: [477, 478] },
  };
}

test('Issue #1539 manifest requires strict deterministic boundary ordering', () => {
  assert.equal(validateManifest(manifest()).ok, true);
  const invalid = manifest();
  invalid.boundary_expansion.issue_numbers = [478, 477];
  assert.match(validateManifest(invalid).errors.join('\n'), /strictly ascending/);
});

test('ref-only recovery request omits null expected_manifest_sha256 and passes runtime validation', () => {
  const request = buildSourceReviewRequest(
    { repository: 'liqiangcc/interview-lab', source_review: { batch_id: 'source-review-1' } },
    { interview_issue_number: 1509, source_note_issue_number: 30, source_note_body: 'source body' },
    { number: 1509, body: 'interview body' },
    { interview_note_id: 'xhs:ref-only', source_revision: { id: 'revision-ref-only', source_repository_ref: 'a'.repeat(40), manifest_sha256: null } },
    { source_revision: { id: 'revision-ref-only', source_repository_ref: 'a'.repeat(40), manifest_sha256: null }, limitations: [] },
    { digest: 'd'.repeat(64) },
  );
  request.reviewed_at = '2026-09-05T00:00:00Z';
  request.reviewer_kind = 'ai-assisted';
  request.review_evidence = { repository: request.repository, issue_number: request.issue_number, comment_id: 1 };
  request.checks = [
    'source_identity', 'source_revision_binding', 'artifact_reference_integrity', 'raw_projection_traceability',
    'source_artifact_provenance', 'known_limitations_recorded', 'duplicate_ownership', 'no_fabrication',
  ].map((check_id) => ({ check_id, result: check_id === 'raw_projection_traceability' ? 'fail' : 'pass' }));
  request.evidence_subject_sha256 = evidenceSubjectSha256(request, request.checks);
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'expected_manifest_sha256'), false);
  assert.equal(request.expected_source_repository_ref, 'a'.repeat(40));
  assert.equal(validateRequest(request).ok, true);
});

test('Boundary Review evidence is not accepted as InterviewNote Source Review evidence', () => {
  const comments = [{ id: 1, body: '<!-- issue-921-pilot-evidence\n{"interview_note_id":"xhs:1"}\n-->' }];
  assert.equal(parseIndependentEvidence(comments, { interview_note_id: 'xhs:1' }).evidence, null);
});

test('independent evidence binds exact InterviewNote, SourceNote, and revision', () => {
  const evidence = { schema_version: 'interview-note-source-review-evidence.v1', repository: 'liqiangcc/interview-lab', interview_note_id: 'xhs:1', source_note_issue_number: 30, source_revision_id: 'rev-1', transition_id: 'batch-1-1', evidence_subject_sha256: 'a'.repeat(64), expected_interview_body_sha256: 'b'.repeat(64), expected_source_note_body_sha256: 'c'.repeat(64), provenance_mode: 'raw-lineage', pinned_artifact_manifest_sha256: 'd'.repeat(64), checks: [{ check_id: 'source_identity', result: 'pass' }] };
  const body = `<!-- interview-note-source-review-evidence.v1\n${JSON.stringify(evidence)}\n-->`;
  assert.equal(parseIndependentEvidence([{ id: 9, body }], evidence).evidence.comment_id, 9);
  assert.equal(parseIndependentEvidence([{ id: 9, body }], { ...evidence, interview_note_id: 'xhs:2' }).evidence, null);
  assert.equal(parseIndependentEvidence([{ id: 9, body }], { ...evidence, transition_id: 'batch-1-old' }).evidence, null);
  assert.equal(parseIndependentEvidence([{ id: 9, body }], { ...evidence, evidence_subject_sha256: 'e'.repeat(64) }).evidence, null);
  assert.equal(parseIndependentEvidence([{ id: 9, body }], { ...evidence, checks: [{ check_id: 'source_identity', result: 'fail' }] }).evidence, null);
});

test('missing independent evidence keeps an otherwise valid item out of mutation candidates', () => {
  const result = reviewAction({ currentStatus: 'blocked', checks: [{ check_id: 'source_identity', result: 'pass' }], evidence: null });
  assert.equal(result.action, 'await-independent-source-review-evidence');
  assert.equal(result.candidate_decision, 'blocked');
  assert.equal(result.mutation_performed, false);
});

test('planner errors remain blocked even when independent evidence is missing', () => {
  const result = reviewAction({
    currentStatus: 'blocked',
    checks: [{ check_id: 'source_identity', result: 'pass' }],
    evidence: null,
    errors: ['SourceNote source_revision is stale'],
  });
  assert.equal(result.action, 'remain-blocked');
  assert.equal(result.candidate_decision, 'blocked');
  assert.deepEqual(result.errors, ['SourceNote source_revision is stale']);
  assert.equal(result.mutation_performed, false);
});

test('legacy minimal evidence is rejected as incomplete rather than reused across transitions', () => {
  const body = `<!-- interview-note-source-review-evidence.v1\n${JSON.stringify({ schema_version: 'interview-note-source-review-evidence.v1', interview_note_id: 'xhs:1', source_note_issue_number: 30, source_revision_id: 'rev-1' })}\n-->`;
  const result = parseIndependentEvidence([{ id: 9, body }], { interview_note_id: 'xhs:1', source_note_issue_number: 30, source_revision_id: 'rev-1' });
  assert.equal(result.evidence, null);
  assert.match(result.errors.join('\n'), /evidence missing (transition_id|evidence_subject_sha256)/);
});

test('legacy v1 projection is classified as a pinned Source artifact without invented Raw lineage', () => {
  const ref = 'a'.repeat(40);
  const raw = { ref: `liqiangcc/xhs:note_detail/x.html@${ref}`, git_blob_sha: 'b'.repeat(40), provenance: 'raw_capture' };
  const projection = { ref: `liqiangcc/xhs:note_desc/x.txt@${ref}`, git_blob_sha: 'c'.repeat(40), provenance: 'source_projection' };
  const result = analyzeSourceProvenance({ source_revision: { source_repository: 'liqiangcc/xhs', source_repository_ref: ref }, artifacts: [raw, projection] });
  assert.equal(result.status, 'pinned-source-artifact');
  assert.equal(result.pinned_source_artifact, true);
  assert.equal(result.raw_lineage_proven, false);
  assert.equal(result.raw_lineage_claim, 'not-claimed');
  assert.equal(result.details[0].derived_from_present, false);
});

test('same filename/id and commit do not infer derived_from', () => {
  const ref = 'a'.repeat(40);
  const result = analyzeSourceProvenance({
    source_revision: { source_repository: 'liqiangcc/xhs', source_repository_ref: ref },
    artifacts: [
      { ref: `liqiangcc/xhs:note_detail/x.html@${ref}`, git_blob_sha: 'b'.repeat(40), provenance: 'raw_capture' },
      { ref: `liqiangcc/xhs:note_json/x.json@${ref}`, git_blob_sha: 'c'.repeat(40), provenance: 'source_projection' },
    ],
  });
  assert.equal(result.raw_lineage_proven, false);
  assert.equal(result.details[0].status, 'pinned-source-artifact');
});

test('declared provenance status must match the artifact-derived assessment', () => {
  const ref = 'a'.repeat(40);
  const result = analyzeSourceProvenance({
    source_revision: { source_repository: 'liqiangcc/xhs', source_repository_ref: ref },
    provenance_status: { status: 'pinned-source-artifact', raw_lineage_claim: 'not-claimed' },
    artifacts: [
      { ref: `liqiangcc/xhs:note_detail/x.html@${ref}`, git_blob_sha: 'b'.repeat(40), provenance: 'raw_capture' },
      { ref: `liqiangcc/xhs:note_desc/x.txt@${ref}`, git_blob_sha: 'c'.repeat(40), provenance: 'source_projection', derived_from: ['liqiangcc/xhs:missing/raw.html@' + ref] },
    ],
  });
  assert.equal(result.status, 'unproven');
  assert.equal(result.declaration_consistent, false);
  assert.match(result.declaration_errors.join('\n'), /declared provenance status/);
});

test('pinned artifact alternate gate remains explicit and never reports Raw lineage as pass', () => {
  const checks = [
    { check_id: 'source_identity', result: 'pass' },
    { check_id: 'artifact_reference_integrity', result: 'pass' },
    { check_id: 'raw_projection_traceability', result: 'fail' },
    { check_id: 'source_artifact_provenance', result: 'pass' },
    { check_id: 'known_limitations_recorded', result: 'pass' },
    { check_id: 'duplicate_ownership', result: 'pass' },
    { check_id: 'no_fabrication', result: 'pass' },
  ];
  const provenance = { status: 'pinned-source-artifact', pinned_source_artifact: true, raw_lineage_proven: false };
  const manifestDigest = 'd'.repeat(64);
  assert.equal(sourceReadyGate({ provenance_mode: 'pinned-source-artifact', provenance_statement: 'pinned-source-artifact; raw-lineage-unproven' }, checks, { ...provenance, declaration_consistent: true }, null).ok, false);
  const result = sourceReadyGate({ provenance_mode: 'pinned-source-artifact', provenance_statement: 'pinned-source-artifact; raw-lineage-unproven', pinned_artifact_manifest_sha256: manifestDigest }, checks, { ...provenance, declaration_consistent: true }, { verified: true, item_verified: true, digest: manifestDigest });
  assert.equal(result.ok, true);
  assert.equal(result.raw_lineage_claim, 'not-claimed');
});

test('pinned artifact manifest is full-width and verifies every recorded path/blob against the commit tree', () => {
  const ref = 'a'.repeat(40);
  const entries = Array.from({ length: 30 }, (_, index) => {
    const path = `note_desc/${index + 1}.txt`;
    const blob = String(index + 1).padStart(40, '0');
    return {
      interview_issue_number: 1509 + index,
      source_note_issue_number: 30 + index,
      source_note_id: `xhs-note:${index + 1}`,
      source_revision_id: `revision-${index + 1}`,
      artifacts: [{ kind: 'text_projection', ref: `liqiangcc/xhs:${path}@${ref}`, git_blob_sha: blob, byte_size: 10, provenance: 'source_projection', integrity: 'present' }],
    };
  });
  const manifest = buildPinnedArtifactManifest({
    repository: 'liqiangcc/interview-lab',
    sourceSnapshot: { repository: 'liqiangcc/xhs', ref },
    entries,
    treeEntries: entries.map((entry) => ({ type: 'blob', path: entry.artifacts[0].ref.split(':')[1].split('@')[0], sha: entry.artifacts[0].git_blob_sha })),
    treeSha: 'e'.repeat(40),
  });
  assert.equal(manifest.verified, true);
  assert.equal(manifest.items.length, 30);
  assert.equal(validatePinnedArtifactManifest(manifest).ok, true);
  assert.equal(verifyManifestDigest(manifest, manifest.digest).ok, true);
  const multiSourceManifest = buildPinnedArtifactManifest({
    repository: 'liqiangcc/interview-lab', sourceSnapshot: { repository: 'liqiangcc/xhs', ref },
    entries: entries.map((entry, index) => index < 2 ? { ...entry, source_note_issue_number: 33, source_note_id: 'xhs-note:shared', source_revision_id: 'revision-shared', artifacts: entries[0].artifacts } : entry),
    treeEntries: entries.map((entry) => ({ type: 'blob', path: entry.artifacts[0].ref.split(':')[1].split('@')[0], sha: entry.artifacts[0].git_blob_sha })),
    treeSha: 'e'.repeat(40),
  });
  assert.equal(validatePinnedArtifactManifest(multiSourceManifest).ok, true);
  const duplicatePair = buildPinnedArtifactManifest({
    repository: 'liqiangcc/interview-lab', sourceSnapshot: { repository: 'liqiangcc/xhs', ref },
    entries: [...entries.slice(0, 29), entries[0]],
    treeEntries: entries.map((entry) => ({ type: 'blob', path: entry.artifacts[0].ref.split(':')[1].split('@')[0], sha: entry.artifacts[0].git_blob_sha })),
    treeSha: 'e'.repeat(40),
  });
  assert.match(validatePinnedArtifactManifest(duplicatePair).errors.join('\n'), /duplicate manifest item/);
  assert.equal(buildPinnedArtifactManifest({
    repository: 'liqiangcc/interview-lab', sourceSnapshot: { repository: 'liqiangcc/xhs', ref }, entries,
    treeEntries: [{ type: 'blob', path: 'note_desc/1.txt', sha: 'f'.repeat(40) }], treeSha: 'e'.repeat(40),
  }).verified, false);

  const item = manifest.items[0];
  const request = {
    issue_number: item.interview_issue_number,
    source_note_issue_number: item.source_note_issue_number,
    expected_source_revision_id: item.source_revision_id,
    pinned_artifact_manifest_sha256: manifest.digest,
  };
  const sourceRecord = { artifacts: item.artifacts };
  assert.equal(verifyManifestItem(manifest, request, sourceRecord).ok, true);
  assert.equal(verifyManifestItem(manifest, { ...request, issue_number: item.interview_issue_number + 1 }, sourceRecord).ok, false);
  assert.equal(verifyManifestItem(manifest, request, { artifacts: [{ ...item.artifacts[0], git_blob_sha: 'f'.repeat(40) }] }).ok, false);
});
