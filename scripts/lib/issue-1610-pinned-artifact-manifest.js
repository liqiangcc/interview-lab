'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 'issue-1610-pinned-artifact-manifest.v1';
const REF_RE = /^([^:]+):(.+)@([0-9a-f]{40})$/;
const SCOPE = 'issue-1610-fixed-2';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['pinned artifact manifest must be an object'] };
  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (manifest.scope !== SCOPE) errors.push(`scope must be ${SCOPE}`);
  if (typeof manifest.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(manifest.repository)) errors.push('repository must use owner/repo');
  if (!manifest.source_snapshot || typeof manifest.source_snapshot.repository !== 'string' || !/^[0-9a-f]{40}$/.test(String(manifest.source_snapshot.ref || ''))) errors.push('source_snapshot must pin a 40-char commit');
  if (!Array.isArray(manifest.items) || manifest.items.length !== 2) errors.push('items must contain exactly 2 items for issue-1610-fixed-2');
  if (manifest.verified !== true) errors.push('verified must be true');
  if (!Array.isArray(manifest.errors) || manifest.errors.length !== 0) errors.push('errors must be an empty array on a verified manifest');
  const seen = new Set();
  for (const [index, item] of (manifest.items || []).entries()) {
    const key = `${item && item.interview_issue_number}:${item && item.source_note_issue_number}`;
    if (seen.has(key)) errors.push(`duplicate manifest item ${key}`);
    seen.add(key);
    if (!Number.isInteger(item && item.interview_issue_number) || ![1, 2].includes(item.interview_issue_number)) errors.push(`items[${index}].interview_issue_number must be #1 or #2`);
    if (!Number.isInteger(item && item.source_note_issue_number) || item.source_note_issue_number < 1) errors.push(`items[${index}].source_note_issue_number must be positive`);
    if (typeof (item && item.source_note_id) !== 'string' || !item.source_note_id) errors.push(`items[${index}].source_note_id is required`);
    if (typeof (item && item.source_revision_id) !== 'string' || !item.source_revision_id) errors.push(`items[${index}].source_revision_id is required`);
    if (!Array.isArray(item && item.artifacts) || item.artifacts.length === 0) errors.push(`items[${index}].artifacts must be non-empty`);
    for (const [artifactIndex, artifact] of (item && item.artifacts || []).entries()) {
      if (!artifact || typeof artifact !== 'object') { errors.push(`items[${index}].artifacts[${artifactIndex}] must be an object`); continue; }
      if (typeof artifact.ref !== 'string' || !REF_RE.test(artifact.ref)) errors.push(`items[${index}].artifacts[${artifactIndex}].ref must be a recorded repository:path@commit ref`);
      if (!/^[0-9a-f]{40}$/.test(String(artifact.git_blob_sha || ''))) errors.push(`items[${index}].artifacts[${artifactIndex}].git_blob_sha must be a lowercase Git blob SHA`);
      if (!Number.isInteger(artifact.byte_size) || artifact.byte_size < 0) errors.push(`items[${index}].artifacts[${artifactIndex}].byte_size must be non-negative`);
    }
  }
  if (!manifest.verification || manifest.verification.commit_tree_verified !== true) errors.push('verification.commit_tree_verified must be true');
  if (manifest.verification && manifest.verification.tree_sha != null && !/^[0-9a-f]{40}$/.test(String(manifest.verification.tree_sha))) errors.push('verification.tree_sha must be a lowercase Git tree SHA');
  return { ok: errors.length === 0, errors };
}

function verifyRecordedArtifacts(items, treeEntries, sourceSnapshot) {
  const tree = new Map((treeEntries || []).filter((entry) => entry && entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
  const errors = [];
  for (const item of items || []) {
    for (const artifact of item.artifacts || []) {
      const match = artifact.ref && artifact.ref.match(REF_RE);
      if (!match) { errors.push(`invalid artifact ref for InterviewNote #${item.interview_issue_number}`); continue; }
      const [, repository, artifactPath, ref] = match;
      if (repository !== sourceSnapshot.repository) errors.push(`artifact repository mismatch for ${artifact.ref}`);
      if (ref !== sourceSnapshot.ref) errors.push(`artifact commit mismatch for ${artifact.ref}`);
      if (tree.get(artifactPath) !== artifact.git_blob_sha) errors.push(`commit tree blob mismatch/missing for ${artifact.ref}`);
    }
  }
  return { ok: errors.length === 0, errors, tree_sha: null };
}

function buildManifest({ repository, sourceSnapshot, entries, treeEntries, treeSha = null }) {
  const verification = verifyRecordedArtifacts(entries, treeEntries, sourceSnapshot);
  const manifestWithoutDigest = {
    schema_version: SCHEMA_VERSION,
    scope: SCOPE,
    repository,
    source_snapshot: sourceSnapshot,
    purpose: 'issue-1610-recovery-pinned-artifact-gate',
    items: (entries || []).slice().sort((a, b) => Number(a.interview_issue_number) - Number(b.interview_issue_number)).map((entry) => ({
      interview_issue_number: Number(entry.interview_issue_number),
      source_note_issue_number: Number(entry.source_note_issue_number),
      source_note_id: entry.source_note_id,
      source_revision_id: entry.source_revision_id,
      artifacts: (entry.artifacts || []).map((artifact) => ({
        kind: artifact.kind,
        ref: artifact.ref,
        git_blob_sha: artifact.git_blob_sha,
        byte_size: artifact.byte_size,
        provenance: artifact.provenance,
        integrity: artifact.integrity,
      })),
    })),
    verification: {
      commit_tree_verified: verification.ok,
      tree_sha: treeSha,
      errors: verification.errors,
    },
  };
  const manifest = { ...manifestWithoutDigest, digest: sha256Text(canonicalJson(manifestWithoutDigest)) };
  return { ...manifest, verified: verification.ok, errors: verification.errors };
}

function verifyManifestDigest(manifest, expectedDigest) {
  if (!manifest || manifest.digest !== expectedDigest) return { ok: false, errors: ['pinned artifact manifest digest mismatch'] };
  const withoutDigest = { ...manifest };
  delete withoutDigest.digest;
  delete withoutDigest.verified;
  delete withoutDigest.errors;
  return sha256Text(canonicalJson(withoutDigest)) === expectedDigest
    ? { ok: true, errors: [] }
    : { ok: false, errors: ['pinned artifact manifest digest is not reproducible'] };
}

module.exports = { SCHEMA_VERSION, SCOPE, REF_RE, canonicalJson, validateManifest, verifyRecordedArtifacts, buildManifest, verifyManifestDigest };
