#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateSourceNoteIssue, yearFromTimeFact, SCHEMA_V2 } = require('./lib/source-note-issue');

const PRODUCER = 'liqiangcc/source-acquisition-runtime';
const CAPTURE_SCHEMA = 'source-capture.v1';
const STORAGE_KIND = 'runtime-artifact-store';
const CAPTURE_PROVENANCE = new Set(['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection', 'derived_projection']);
const BASE_LABELS = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'];
const HEX64 = /^[0-9a-f]{64}$/;
const TRANSIENT_ACCESS_RE = /(?:^|[?&])xsec_(?:token|source)=/i;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readFileSha256(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { captureRoot: null, expectedManifestSha256: null, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--capture-root') out.captureRoot = argv[++i];
    else if (arg === '--expected-manifest-sha256') out.expectedManifestSha256 = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.captureRoot) throw new Error('--capture-root is required');
  if (!HEX64.test(out.expectedManifestSha256 || '')) {
    throw new Error('--expected-manifest-sha256 must be a lowercase 64-char SHA-256');
  }
  return out;
}

function assertSafeRelativeRef(ref) {
  if (typeof ref !== 'string' || !ref || path.isAbsolute(ref)) throw new Error(`artifact ref must be a relative path: ${ref}`);
  const normalized = path.posix.normalize(ref.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`artifact ref escapes capture root: ${ref}`);
  }
  if (TRANSIENT_ACCESS_RE.test(ref)) throw new Error(`artifact ref contains transient XHS access parameters: ${ref}`);
  return normalized;
}

function resolveCapturePath(captureRoot, ref) {
  const normalized = assertSafeRelativeRef(ref);
  const root = path.resolve(captureRoot);
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`artifact ref escapes capture root: ${ref}`);
  return { normalized, absolute };
}

function validateManifestIdentity(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be one JSON object');
  if (manifest.schema_version !== CAPTURE_SCHEMA) throw new Error(`unsupported manifest schema: ${manifest.schema_version}`);
  if (manifest.source_system !== 'xhs') throw new Error('source-capture intake currently requires source_system=xhs');
  const sourceMatch = typeof manifest.source_id === 'string' ? manifest.source_id.match(/^xhs:(.+)$/) : null;
  if (!sourceMatch) throw new Error('manifest.source_id must use xhs:<external_id>');
  if (manifest.external_id == null || manifest.external_id === '') manifest.external_id = sourceMatch[1];
  if (manifest.source_id !== `xhs:${manifest.external_id}`) throw new Error('manifest.source_id and manifest.external_id disagree');
  if (!manifest.source_revision_id) throw new Error('manifest.source_revision_id is required');
  if (!manifest.source_revision_id.startsWith(`${manifest.source_id}:`)) throw new Error('manifest.source_revision_id must be derived from manifest.source_id');
  if (!manifest.captured_at) throw new Error('manifest.captured_at is required');
  if (typeof manifest.original_url !== 'string' || !manifest.original_url) throw new Error('manifest.original_url is required');
  if (TRANSIENT_ACCESS_RE.test(manifest.original_url)) throw new Error('manifest.original_url must not contain transient XHS access parameters');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('manifest.artifacts must be a non-empty array');
  if (manifest.metadata != null && (typeof manifest.metadata !== 'object' || Array.isArray(manifest.metadata))) {
    throw new Error('manifest.metadata must be an object when present');
  }
  if (manifest.limitations != null && !Array.isArray(manifest.limitations)) throw new Error('manifest.limitations must be an array when present');
}

function artifactLocator(artifact, index) {
  const ref = artifact && artifact.ref;
  const artifactPath = artifact && artifact.path;
  if (ref && artifactPath && ref !== artifactPath) throw new Error(`artifact[${index}] ref/path disagree`);
  return ref || artifactPath;
}

function verifyArtifacts(captureRoot, manifest) {
  const seenRefs = new Set();
  const seenSequences = new Set();
  const artifactRefs = new Set(manifest.artifacts.map((item, index) => assertSafeRelativeRef(artifactLocator(item, index))));
  return manifest.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error(`artifact[${index}] must be an object`);
    const locator = artifactLocator(artifact, index);
    const { normalized, absolute } = resolveCapturePath(captureRoot, locator);
    if (seenRefs.has(normalized)) throw new Error(`duplicate artifact ref: ${normalized}`);
    seenRefs.add(normalized);
    if (!CAPTURE_PROVENANCE.has(artifact.provenance)) throw new Error(`artifact[${index}] has invalid provenance`);
    if (!HEX64.test(artifact.sha256 || '')) throw new Error(`artifact[${index}].sha256 must be a lowercase 64-char SHA-256`);
    if (!Number.isInteger(artifact.size) || artifact.size < 0) throw new Error(`artifact[${index}].size must be a non-negative integer`);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`artifact missing: ${normalized}`);
    const bytes = fs.readFileSync(absolute);
    if (bytes.length !== artifact.size) throw new Error(`artifact size mismatch: ${normalized} expected=${artifact.size} actual=${bytes.length}`);
    const actualSha = sha256Buffer(bytes);
    if (actualSha !== artifact.sha256) throw new Error(`artifact sha256 mismatch: ${normalized} expected=${artifact.sha256} actual=${actualSha}`);
    if (artifact.sequence != null) {
      if (!Number.isInteger(artifact.sequence) || artifact.sequence < 1) throw new Error(`artifact sequence must be a positive integer: ${normalized}`);
      if (seenSequences.has(artifact.sequence)) throw new Error(`duplicate artifact sequence: ${artifact.sequence}`);
      seenSequences.add(artifact.sequence);
    }
    const derivedFrom = artifact.derived_from == null ? undefined : artifact.derived_from.map((ref) => {
      const derivedRef = assertSafeRelativeRef(ref);
      if (!artifactRefs.has(derivedRef)) throw new Error(`artifact derived_from ref not present in manifest: ${ref}`);
      return `source-capture:${manifest.source_revision_id}#${derivedRef}`;
    });
    const projected = {
      kind: artifact.kind,
      ref: `source-capture:${manifest.source_revision_id}#${normalized}`,
      git_blob_sha: null,
      sha256: actualSha,
      provenance: artifact.provenance,
      byte_size: bytes.length,
      integrity: bytes.length === 0 ? 'zero-byte' : 'present',
    };
    if (artifact.sequence != null) projected.sequence = artifact.sequence;
    if (artifact.content_type) projected.content_type = artifact.content_type;
    if (derivedFrom) projected.derived_from = derivedFrom;
    return projected;
  });
}

function loadAndVerifySourceCapture(captureRoot, expectedManifestSha256) {
  const root = path.resolve(captureRoot);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) throw new Error('manifest.json is missing from capture root');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256Buffer(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256) {
    throw new Error(`manifest sha256 mismatch: expected=${expectedManifestSha256} actual=${manifestSha256}`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifestIdentity(manifest);
  const artifacts = verifyArtifacts(root, manifest);
  return {
    root,
    manifest,
    manifestSha256,
    manifestByteSize: manifestBytes.length,
    artifacts,
  };
}

function exactOrUnknown(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return { precision: 'exact', value };
  return { precision: 'unknown', value: null };
}

function quoteMarkdown(value) {
  return String(value || '').replace(/\r\n/g, '\n').split('\n').map((line) => `> ${line}`).join('\n');
}

function labelsForRecord(record) {
  const labels = [...BASE_LABELS];
  const year = yearFromTimeFact(record.source_published_at);
  if (year) labels.push(`source-year:${year}`);
  return labels;
}

function normalizeAccessBoundary(accessBoundary) {
  if (accessBoundary == null) return null;
  if (typeof accessBoundary !== 'object' || Array.isArray(accessBoundary)) throw new Error('manifest.access_boundary must be an object when present');
  const out = {
    bare_canonical_replay: accessBoundary.bare_canonical_replay,
    live_rediscovery: accessBoundary.live_rediscovery,
    stable_note_id_match: accessBoundary.stable_note_id_match == null ? null : accessBoundary.stable_note_id_match,
    ephemeral_access_parameters_persisted: accessBoundary.ephemeral_access_parameters_persisted,
  };
  if (out.ephemeral_access_parameters_persisted !== false) throw new Error('manifest access boundary must prove ephemeral access parameters were not persisted');
  return out;
}

function buildSourceNoteProjection(verified) {
  const { root, manifest, manifestSha256, manifestByteSize, artifacts } = verified;
  const sourceNoteId = `xhs-note:${manifest.external_id}`;
  const metadata = JSON.parse(JSON.stringify(manifest.metadata || {}));
  const sourcePublishedAt = exactOrUnknown(metadata.published_at);
  const sourceEditedAt = { precision: 'unknown', value: null };
  const anomalies = artifacts.filter((item) => item.byte_size === 0).length ? [{
    code: 'zero-byte-artifacts',
    detail: `${artifacts.filter((item) => item.byte_size === 0).length} artifact(s) are zero-byte in the verified SourceCapture revision`,
  }] : [];
  const accessBoundary = normalizeAccessBoundary(manifest.access_boundary || null);
  const limitations = [...(manifest.limitations || [])];
  limitations.push('SourceNote intake 只证明一条 Source 的采集身份；必须经过 boundary review 才能产生 0..N InterviewNote。');
  limitations.push('source_projection 属于 Source 派生可读层，不等于 Interview-derived 题目、分类或答案。');
  if (artifacts.some((item) => item.provenance === 'derived_projection')) limitations.push('derived_projection 必须保持为 Derived；不得反向覆盖或替代 Raw Source artifact。');
  if (accessBoundary) limitations.push('canonical replay 结果只是一条 access observation；不得据此推断删除、私密或永久不可用。');

  const record = {
    schema_version: SCHEMA_V2,
    source_note_id: sourceNoteId,
    source: { system: manifest.source_system, external_id: manifest.external_id, url: manifest.original_url },
    source_revision: {
      id: manifest.source_revision_id,
      captured_at: manifest.captured_at,
      producer: PRODUCER,
      source_capture_schema: manifest.schema_version,
      storage_kind: STORAGE_KIND,
      manifest_ref: `source-capture:${manifest.source_revision_id}#manifest.json`,
      manifest_sha256: manifestSha256,
      manifest_byte_size: manifestByteSize,
      reason: 'source-capture.v1 runtime intake handoff',
    },
    source_published_at: sourcePublishedAt,
    source_edited_at: sourceEditedAt,
    artifacts,
    observed_metadata: metadata,
    access_boundary: accessBoundary,
    anomalies,
    limitations,
    boundary_review: { status: 'pending', reviewed_at: null, interview_note_ids: [] },
  };

  const readableArtifact = manifest.artifacts.find((item, index) => artifactLocator(item, index) === 'projection/readable.txt' && item.provenance === 'source_projection')
    || manifest.artifacts.find((item) => item.kind === 'text_projection' && item.provenance === 'source_projection');
  let readable = '';
  if (readableArtifact) {
    const readableIndex = manifest.artifacts.indexOf(readableArtifact);
    const resolved = resolveCapturePath(root, artifactLocator(readableArtifact, readableIndex));
    readable = fs.readFileSync(resolved.absolute, 'utf8');
  }
  const title = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : '（来源标题未直接观察）';
  const artifactLines = artifacts.map((item) => {
    const sequence = item.sequence == null ? '' : ` — sequence=${item.sequence}`;
    return `- \`${item.kind}\` — \`${item.provenance}\` — \`${item.integrity}\` — ${item.byte_size} bytes${sequence} — \`${item.ref}\` — sha256 \`${item.sha256}\``;
  }).join('\n');
  const anomalyLines = anomalies.length ? anomalies.map((item) => `- \`${item.code}\` — ${item.detail}`).join('\n') : '- 无 intake-level anomaly。';
  const limitationLines = limitations.map((item) => `- ${item}`).join('\n');
  const accessLine = accessBoundary
    ? `- Access boundary：canonical=\`${accessBoundary.bare_canonical_replay}\`，rediscovery=\`${accessBoundary.live_rediscovery}\`，stable-id-match=\`${accessBoundary.stable_note_id_match}\``
    : '- Access boundary：本 revision 未登记特殊访问边界。';

  const body = `<!-- source-note: id=${sourceNoteId} schema=${SCHEMA_V2} -->\n<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->\n\n## 来源身份\n\n- 来源系统：XHS\n- External source id：\`${manifest.external_id}\`\n- SourceNote id：\`${sourceNoteId}\`\n- SourceRevision：\`${manifest.source_revision_id}\`\n- Producer contract：\`${PRODUCER} / ${manifest.schema_version}\`\n- Manifest SHA-256：\`${manifestSha256}\`\n${accessLine}\n\n## 原始标题\n\n${title}\n\n## 原始正文\n\n### 可读 Source projection — \`projection/readable.txt\`\n\n${readable ? quoteMarkdown(readable) : '（当前 SourceCapture 没有可读文本 Projection；以 Raw artifact 为准。）'}\n\n## 原始附件\n\n${artifactLines}\n\n## Intake 异常\n\n${anomalyLines}\n\n## 边界审核\n\n- 状态：\`pending\`\n- 当前不判断该 Source 是 0、1 还是多个真实 InterviewNote。\n- 审核完成后才允许建立 InterviewNote identity。\n\n## 来源限制\n\n${limitationLines}\n\n## 派生链接\n\n- 尚未生成 Interview-derived 数据；本 Issue 中的 \`source_projection\` 仍属于 Source 层。\n`;
  const labels = labelsForRecord(record);
  const validation = validateSourceNoteIssue({ body, labels, state: 'open' });
  if (!validation.ok) throw new Error(`generated SourceNote v2 failed validation: ${validation.errors.join('; ')}`);

  return {
    source_note_id: sourceNoteId,
    external_id: manifest.external_id,
    source_revision_id: manifest.source_revision_id,
    title: `[XHS Source] runtime · ${manifest.external_id.slice(0, 8)}`,
    body,
    labels,
    record,
  };
}

function main() {
  const args = parseArgs();
  const verified = loadAndVerifySourceCapture(args.captureRoot, args.expectedManifestSha256);
  const projection = buildSourceNoteProjection(verified);
  if (args.output) fs.writeFileSync(args.output, projection.body);
  const report = {
    schema_version: 'source-capture-intake-report.v1',
    source_note_schema: projection.record.schema_version,
    source_note_id: projection.source_note_id,
    source_revision_id: projection.source_revision_id,
    manifest_sha256: verified.manifestSha256,
    artifact_count: projection.record.artifacts.length,
    raw_artifact_count: projection.record.artifacts.filter((item) => item.provenance === 'raw_capture' || item.provenance.startsWith('raw_')).length,
    source_projection_artifact_count: projection.record.artifacts.filter((item) => item.provenance === 'source_projection').length,
    derived_projection_artifact_count: projection.record.artifacts.filter((item) => item.provenance === 'derived_projection').length,
    boundary_review_status: projection.record.boundary_review.status,
    output: args.output || null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  loadAndVerifySourceCapture,
  buildSourceNoteProjection,
  sha256Buffer,
};
