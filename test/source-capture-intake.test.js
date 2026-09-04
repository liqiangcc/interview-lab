'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAndVerifySourceCapture, buildSourceNoteProjection } = require('../scripts/intake-source-capture');
const { validateSourceNoteIssue } = require('../scripts/lib/source-note-issue');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createCapture({ accessBoundary = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-capture-intake-'));
  const files = {
    'raw/page.a11y.txt': Buffer.from('raw accessibility evidence\n', 'utf8'),
    'raw/images/1.webp': Buffer.from('RIFFfixtureWEBPraw-image', 'utf8'),
    'projection/readable.txt': Buffer.from('Fixture runtime title\n\n第一题\n第二题\n', 'utf8'),
    'projection/observed.json': Buffer.from('{"title":"Fixture runtime title"}\n', 'utf8'),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
  const artifact = (ref, kind, provenance, extra = {}) => ({
    ref,
    sha256: sha256(files[ref]),
    size: files[ref].length,
    kind,
    provenance,
    ...extra,
  });
  const manifest = {
    schema_version: 'source-capture.v1',
    source_id: 'xhs:runtime-test-1',
    source_revision_id: 'xhs:runtime-test-1:r1',
    source_system: 'xhs',
    external_id: 'runtime-test-1',
    original_url: 'https://www.xiaohongshu.com/explore/runtime-test-1',
    captured_at: '2026-09-04T00:00:00Z',
    artifacts: [
      artifact('raw/page.a11y.txt', 'page_a11y_snapshot', 'raw_capture', { content_type: 'text/plain; charset=utf-8' }),
      artifact('raw/images/1.webp', 'image', 'raw_capture', { sequence: 1, content_type: 'image/webp' }),
      artifact('projection/readable.txt', 'text_projection', 'source_projection', {
        content_type: 'text/plain; charset=utf-8',
        derived_from: ['raw/page.a11y.txt'],
      }),
      artifact('projection/observed.json', 'metadata_projection', 'source_projection', {
        content_type: 'application/json',
        derived_from: ['raw/page.a11y.txt'],
      }),
    ],
    metadata: {
      title: 'Fixture runtime title',
      author: 'fixture-author',
      published_at: null,
      source_display_time: '1天前 上海',
      gallery_count: 1,
    },
    limitations: ['Exact source publication timestamp is not directly observed.'],
  };
  if (accessBoundary) manifest.access_boundary = accessBoundary;
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest, manifestSha256: sha256(fs.readFileSync(manifestPath)) };
}

test('source-capture adapter verifies content-addressed artifacts and builds valid SourceNote v2', () => {
  const fixture = createCapture();
  const verified = loadAndVerifySourceCapture(fixture.root, fixture.manifestSha256);
  const projection = buildSourceNoteProjection(verified);
  const validation = validateSourceNoteIssue({ body: projection.body, labels: projection.labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(projection.record.schema_version, 'source-note-issue.v2');
  assert.equal(projection.record.source_revision.id, 'xhs:runtime-test-1:r1');
  assert.equal(projection.record.source_revision.manifest_sha256, fixture.manifestSha256);
  assert.equal(projection.record.source_revision.storage_kind, 'runtime-artifact-store');
  assert.equal(projection.record.artifacts.every((item) => item.git_blob_sha === null), true);
  assert.equal(projection.record.artifacts.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)), true);
  assert.deepEqual(projection.record.artifacts.find((item) => item.kind === 'text_projection').derived_from, [
    'source-capture:xhs:runtime-test-1:r1#raw/page.a11y.txt',
  ]);
  assert.equal(projection.record.boundary_review.status, 'pending');
  assert.equal(projection.labels.includes('type:interview-note'), false);
});

test('source-capture adapter fails closed when an artifact changes after manifest creation', () => {
  const fixture = createCapture();
  fs.appendFileSync(path.join(fixture.root, 'raw/page.a11y.txt'), 'tampered');
  assert.throws(
    () => loadAndVerifySourceCapture(fixture.root, fixture.manifestSha256),
    /artifact size mismatch|artifact sha256 mismatch/,
  );
});

test('source-capture adapter requires the expected manifest hash', () => {
  const fixture = createCapture();
  assert.throws(
    () => loadAndVerifySourceCapture(fixture.root, 'f'.repeat(64)),
    /manifest sha256 mismatch/,
  );
});

test('source-capture adapter preserves access-boundary facts without deletion/privacy inference', () => {
  const fixture = createCapture({
    accessBoundary: {
      bare_canonical_replay: 'xhs_error_300031',
      live_rediscovery: 'success',
      stable_note_id_match: true,
      ephemeral_access_parameters_persisted: false,
    },
  });
  const projection = buildSourceNoteProjection(loadAndVerifySourceCapture(fixture.root, fixture.manifestSha256));
  assert.deepEqual(projection.record.access_boundary, fixture.manifest.access_boundary);
  assert.match(projection.record.limitations.join('\n'), /不得据此推断删除、私密或永久不可用/);
});

test('source-capture adapter normalizes path locators, derives redundant external_id, and preserves derived provenance', () => {
  const fixture = createCapture();
  const manifestPath = path.join(fixture.root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.external_id;
  for (const artifact of manifest.artifacts) {
    artifact.path = artifact.ref;
    delete artifact.ref;
  }
  manifest.artifacts.find((artifact) => artifact.path === 'projection/observed.json').provenance = 'derived_projection';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = sha256(fs.readFileSync(manifestPath));
  const projection = buildSourceNoteProjection(loadAndVerifySourceCapture(fixture.root, manifestSha256));
  assert.equal(projection.external_id, 'runtime-test-1');
  assert.equal(projection.record.source.external_id, 'runtime-test-1');
  assert.equal(projection.record.artifacts.some((artifact) => artifact.provenance === 'derived_projection'), true);
  assert.equal(projection.record.artifacts.every((artifact) => artifact.ref.startsWith('source-capture:xhs:runtime-test-1:r1#')), true);
});
