'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const selection = require('../data/issue-1610/recovery-selection.json');
const { parseArgs, checkResults } = require('../scripts/plan-issue-1610-recovery');
const { validateSelection, attemptsDigest, buildEvidencePacket } = require('../scripts/lib/issue-1610-recovery');
const {
  buildManifest,
  validateManifest,
} = require('../scripts/lib/issue-1610-pinned-artifact-manifest');

function sourceRecord(item) {
  return {
    source_note_id: item.source_note_id,
    source: { system: 'xhs', external_id: item.interview_note_id.slice(4) },
    source_revision: { id: item.source_revision_id, source_repository: 'liqiangcc/xhs', source_repository_ref: selection.source_snapshot.ref },
    artifacts: item.artifacts,
    limitations: ['source limitation'],
    boundary_review: { status: 'pending', reviewed_at: null, interview_note_ids: [] },
  };
}

function interviewRecord(item) {
  return {
    interview_note_id: item.interview_note_id,
    source: { system: 'xhs', external_id: item.interview_note_id.slice(4), url: null },
    source_revision: { id: item.interview_source_revision_id },
    source_published_at: { precision: 'exact', value: '2022-08-30' },
    interview_occurred_at: { precision: 'unknown', value: null },
    artifacts: item.artifacts.map(({ ref, git_blob_sha, kind, provenance }) => ({
      ref: ref.replace(`@${selection.source_snapshot.ref}`, ''), git_blob_sha, kind, provenance,
    })),
    limitations: [],
  };
}

function failedAttempts() {
  return [1, 2].map((sequence) => ({
    sequence,
    method: 'GET',
    url: `http://fixture.invalid/${sequence}`,
    requested_at: `2026-09-08T00:00:0${sequence}.000Z`,
    completed_at: `2026-09-08T00:00:0${sequence}.100Z`,
    curl_exit: 0,
    http_code: 403,
    content_type: null,
    effective_url: `http://fixture.invalid/${sequence}`,
    time_total_seconds: 0.1,
    response_headers: {},
    bytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    stderr: null,
    accepted_artifact: false,
  }));
}

test('fixed selection is exactly #1/#2 and pins the required source ref', () => {
  const result = validateSelection(selection);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(selection.items.map((item) => item.issue_number), [1, 2]);
  assert.equal(selection.source_snapshot.ref, '95b77bb261048059846273688e4b90a2e108b437');
  assert.deepEqual(selection.items.map((item) => item.source_note_issue_number), [903, 904]);
});

test('selection rejects scope expansion and source ref drift', () => {
  const extra = { ...selection, items: [...selection.items, { ...selection.items[0], issue_number: 3 }] };
  assert.equal(validateSelection(extra).ok, false);
  const wrongRef = { ...selection, source_snapshot: { ...selection.source_snapshot, ref: 'a'.repeat(40) } };
  assert.match(validateSelection(wrongRef).errors.join('\n'), /source ref/);
});

test('pinned artifact manifest accepts the fixed two-item scope and verifies every path/blob', () => {
  const entries = selection.items.map((item) => ({
    interview_issue_number: item.issue_number,
    source_note_issue_number: item.source_note_issue_number,
    source_note_id: item.source_note_id,
    source_revision_id: item.source_revision_id,
    artifacts: item.artifacts,
  }));
  const treeEntries = entries.flatMap((entry) => entry.artifacts.map((artifact) => {
    const path = artifact.ref.slice(artifact.ref.indexOf(':') + 1, -41);
    return { type: 'blob', path, sha: artifact.git_blob_sha, size: artifact.byte_size };
  }));
  const manifest = buildManifest({ repository: 'liqiangcc/interview-lab', scope: 'issue-1610-fixed-2', sourceSnapshot: selection.source_snapshot, entries, treeEntries });
  assert.equal(manifest.verified, true, manifest.errors.join('; '));
  assert.equal(manifest.items.length, 2);
  assert.equal(validateManifest(manifest).ok, true);
});

test('403/zero-byte attempts are stable evidence but never accepted artifacts', () => {
  const first = failedAttempts();
  const second = first.map((attempt) => ({ ...attempt, requested_at: 'later', completed_at: 'later', time_total_seconds: 9 }));
  assert.equal(attemptsDigest(first), attemptsDigest(second));
  const item = selection.items[0];
  const attempts = first;
  const checks = checkResults({
    item,
    interviewRecord: interviewRecord(item),
    sourceRecord: sourceRecord(item),
    pinnedArtifactVerified: true,
    ownership: [{ number: item.issue_number }],
    attempts,
  });
  const failed = new Set(checks.filter((entry) => entry.result === 'fail').map((entry) => entry.check_id));
  assert.ok(failed.has('source_revision_binding'));
  assert.ok(failed.has('boundary_disposition'));
  assert.ok(failed.has('image_recovery'));
  assert.equal(attempts.every((attempt) => attempt.accepted_artifact), false);
});

test('independent evidence packet is blocked, unposted, and cannot authorize Raw overwrite', () => {
  const item = selection.items[0];
  const attempts = failedAttempts();
  const live = { interview: { record: interviewRecord(item) } };
  const checks = checkResults({ item, interviewRecord: live.interview.record, sourceRecord: sourceRecord(item), pinnedArtifactVerified: true, ownership: [{ number: 1 }], attempts });
  const packet = buildEvidencePacket({ selection, item, live, pinnedArtifactManifestSha256: 'a'.repeat(64), checks, attempts, ownership: [{ number: 1 }] });
  assert.equal(packet.decision, 'blocked');
  assert.equal(packet.final_status, 'blocked');
  assert.equal(packet.independent_review.status, 'candidate-only-unposted');
  assert.equal(packet.independent_review.live_comment_id, null);
  assert.equal(packet.no_raw_overwrite, true);
  assert.equal(packet.mutation_performed, false);
  assert.match(packet.evidence_subject_sha256, /^[0-9a-f]{64}$/);
});

test('planner rejects an apply flag instead of exposing a mutation path', () => {
  assert.throws(() => parseArgs(['--selection', 'selection.json', '--apply']), /no apply entrypoint/);
});

test('recovery stays isolated from issue-1539 library and package wiring', () => {
  const planner = fs.readFileSync(path.join(__dirname, '..', 'scripts/plan-issue-1610-recovery.js'), 'utf8');
  const recovery = fs.readFileSync(path.join(__dirname, '..', 'scripts/lib/issue-1610-recovery.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.doesNotMatch(planner, /issue-1539/);
  assert.doesNotMatch(recovery, /issue-1539/);
  assert.equal(packageJson.scripts['plan:issue-1610-recovery'], undefined);
});
