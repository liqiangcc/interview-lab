'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest } = require('../scripts/lib/interview-note-source-review-transition');
const { validateManifest: validatePinnedArtifactManifest } = require('../scripts/lib/issue-1539-pinned-artifact-manifest');
const { validatePacketSet, digestWithoutField, CANDIDATE_STATUS, PACKET_SCHEMA_VERSION } = require('../scripts/lib/issue-1539-source-review-packets');

const manifest = JSON.parse(fs.readFileSync('data/pilot/issue-1539/plan-manifest.json', 'utf8'));
const report = JSON.parse(fs.readFileSync('data/pilot/issue-1539/recovery.dry-run.json', 'utf8'));
const pinnedArtifactManifest = JSON.parse(fs.readFileSync('data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json', 'utf8'));
const packetSet = JSON.parse(fs.readFileSync('data/pilot/issue-1539/source-review-packets.json', 'utf8'));

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function redigest(value) {
  value.packet_set_sha256 = digestWithoutField(value, 'packet_set_sha256');
  return value;
}

test('Issue #1539 packet artifact is a complete 30-item planning-only set', () => {
  assert.equal(packetSet.schema_version, PACKET_SCHEMA_VERSION);
  assert.equal(packetSet.candidate_status, CANDIDATE_STATUS);
  assert.equal(packetSet.mutation_performed, false);
  assert.equal(packetSet.packets.length, 30);
  assert.equal(pinnedArtifactManifest.items.length, 30);
  assert.equal(validatePinnedArtifactManifest(pinnedArtifactManifest).ok, true);
  const validation = validatePacketSet(packetSet, { manifest, report, pinnedArtifactManifest });
  assert.equal(validation.ok, true, validation.errors.join('; '));
  for (const packet of packetSet.packets) {
    const requestValidation = validateRequest(packet.candidate_request, { planningOnly: true });
    assert.equal(requestValidation.ok, true, `#${packet.interview_issue_number}: ${requestValidation.errors.join('; ')}`);
    assert.equal(packet.live_status, 'blocked');
    assert.equal(packet.independent_evidence, 'missing');
    assert.equal(packet.boundary_review_evidence_reused, false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.candidate_request, 'review_evidence'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.candidate_request, 'reviewed_at'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.candidate_request, 'reviewer_kind'), false);
    assert.equal(packet.pinned_artifact_manifest_item_verified, true);
    assert.equal(packet.decision_fields.current_status, 'blocked');
    assert.equal(packet.decision_fields.action, 'await-independent-source-review-evidence');
    assert.equal(packet.decision_fields.candidate_decision, 'blocked');
    assert.deepEqual(packet.decision_fields.source_ready_gate, packet.source_ready_gate);
  }
});

test('packet validation requires all three external anchors', () => {
  for (const missing of ['manifest', 'report', 'pinnedArtifactManifest']) {
    const anchors = { manifest, report, pinnedArtifactManifest };
    delete anchors[missing];
    const validation = validatePacketSet(packetSet, anchors);
    assert.equal(validation.ok, false, `${missing} anchor unexpectedly accepted`);
    assert.match(validation.errors.join('\n'), new RegExp(`${missing === 'pinnedArtifactManifest' ? 'pinned artifact manifest' : missing}`));
  }
});

test('report item lookup requires the exact InterviewNote and SourceNote pair', () => {
  const staleReport = copy(report);
  staleReport.source_review.items[0].source_note_issue_number = staleReport.source_review.items[1].source_note_issue_number;
  staleReport.dry_run_sha256 = digestWithoutField(staleReport, 'dry_run_sha256');
  const validation = validatePacketSet(packetSet, { manifest, report: staleReport, pinnedArtifactManifest });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /absent from recovery dry-run|SourceNote body SHA|source revision evidence/);
});

test('every displayed and decision field remains bound after packet digest recomputation', () => {
  for (const field of ['source_revision_evidence', 'provenance', 'failed_check_ids', 'source_ready_gate', 'decision_fields']) {
    const stale = copy(packetSet);
    if (field === 'failed_check_ids') stale.packets[0][field] = [];
    else if (field === 'source_ready_gate') stale.packets[0][field].reason = 'tampered';
    else if (field === 'decision_fields') stale.packets[0][field].action = 'source-review-ready-for-authorized-transition';
    else if (field === 'provenance') stale.packets[0][field].status = 'derived-from-raw';
    else stale.packets[0][field].source_repository_ref = '0'.repeat(40);
    redigest(stale);
    const validation = validatePacketSet(stale, { manifest, report, pinnedArtifactManifest });
    assert.equal(validation.ok, false, `${field} tampering unexpectedly passed`);
  }
});

test('packet validation rejects a stale evidence subject even when packet digest is recomputed', () => {
  const stale = copy(packetSet);
  stale.packets[0].candidate_request.evidence_subject_sha256 = '0'.repeat(64);
  stale.packets[0].evidence_subject_sha256 = '0'.repeat(64);
  redigest(stale);
  const validation = validatePacketSet(stale, { manifest, report, pinnedArtifactManifest });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /evidence subject/);
});

test('packet validation rejects a request body SHA or manifest item that no longer binds its facts', () => {
  const stale = copy(packetSet);
  stale.packets[0].candidate_request.expected_interview_body_sha256 = '0'.repeat(64);
  stale.packets[0].pinned_artifact_manifest_item.artifacts[0].git_blob_sha = '0'.repeat(40);
  redigest(stale);
  const validation = validatePacketSet(stale, { manifest, report, pinnedArtifactManifest });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /body SHA|manifest item/);
});
