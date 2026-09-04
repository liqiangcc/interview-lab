'use strict';

const HEX40 = /^[0-9a-f]{40}$/;

const PROVENANCE_STATUS = Object.freeze({
  DERIVED_FROM_RAW: 'derived-from-raw',
  PINNED_SOURCE_ARTIFACT: 'pinned-source-artifact',
  UNPROVEN: 'unproven',
});

const PROVENANCE_MODES = Object.freeze({
  RAW_LINEAGE: 'raw-lineage',
  PINNED_SOURCE_ARTIFACT: 'pinned-source-artifact',
});

function isPinnedArtifact(record, artifact) {
  const revision = record && record.source_revision;
  if (!revision || typeof revision !== 'object' || !HEX40.test(String(revision.source_repository_ref || ''))) return false;
  if (!artifact || typeof artifact.ref !== 'string' || !HEX40.test(String(artifact.git_blob_sha || ''))) return false;
  const repository = String(revision.source_repository || '');
  const refSuffix = `@${revision.source_repository_ref}`;
  return artifact.ref.startsWith(`${repository}:`) && artifact.ref.endsWith(refSuffix);
}

function analyzeSourceProvenance(record) {
  const artifacts = record && Array.isArray(record.artifacts) ? record.artifacts : [];
  const raw = artifacts.filter((artifact) => artifact && artifact.provenance === 'raw_capture');
  const rawRefs = new Set(raw.map((artifact) => artifact.ref).filter(Boolean));
  const projections = artifacts.filter((artifact) => artifact && artifact.provenance === 'source_projection');
  const details = projections.map((artifact) => {
    const hasDerivedFrom = Object.prototype.hasOwnProperty.call(artifact, 'derived_from');
    const derivedFrom = artifact.derived_from;
    const derivedFromRaw = Array.isArray(derivedFrom)
      && derivedFrom.length > 0
      && derivedFrom.every((ref) => rawRefs.has(ref));
    const pinned = isPinnedArtifact(record, artifact);
    let status = PROVENANCE_STATUS.UNPROVEN;
    if (derivedFromRaw) status = PROVENANCE_STATUS.DERIVED_FROM_RAW;
    else if (!hasDerivedFrom && pinned) status = PROVENANCE_STATUS.PINNED_SOURCE_ARTIFACT;
    return {
      ref: artifact.ref || null,
      status,
      pinned,
      derived_from_present: hasDerivedFrom,
      derived_from_raw: derivedFromRaw,
    };
  });
  const rawLineageProven = projections.length > 0 && details.every((item) => item.status === PROVENANCE_STATUS.DERIVED_FROM_RAW);
  const pinnedSourceArtifact = projections.length > 0 && details.every((item) => item.pinned && item.status !== PROVENANCE_STATUS.UNPROVEN);
  const legacyPinnedSourceArtifact = projections.length > 0 && details.every((item) => item.status === PROVENANCE_STATUS.PINNED_SOURCE_ARTIFACT);
  const knownSourceArtifact = projections.length > 0 && details.every((item) => item.status !== PROVENANCE_STATUS.UNPROVEN);
  const computedStatus = rawLineageProven
      ? PROVENANCE_STATUS.DERIVED_FROM_RAW
      : legacyPinnedSourceArtifact
        ? PROVENANCE_STATUS.PINNED_SOURCE_ARTIFACT
        : PROVENANCE_STATUS.UNPROVEN;
  const computedRawLineageClaim = rawLineageProven ? 'proven' : 'not-claimed';
  const declared = record && record.provenance_status;
  const declarationErrors = [];
  if (declared != null) {
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      declarationErrors.push('record.provenance_status must be an object');
    } else {
      if (declared.status !== computedStatus) declarationErrors.push(`declared provenance status ${declared.status} conflicts with computed ${computedStatus}`);
      if (declared.raw_lineage_claim !== computedRawLineageClaim) declarationErrors.push(`declared raw_lineage_claim ${declared.raw_lineage_claim} conflicts with computed ${computedRawLineageClaim}`);
    }
  }
  return {
    status: computedStatus,
    projection_count: projections.length,
    raw_capture_count: raw.length,
    raw_lineage_proven: rawLineageProven,
    pinned_source_artifact: pinnedSourceArtifact,
    known_source_artifact: knownSourceArtifact,
    legacy_pinned_source_artifact: legacyPinnedSourceArtifact,
    raw_lineage_claim: computedRawLineageClaim,
    declared_status: declared && declared.status || null,
    declared_raw_lineage_claim: declared && declared.raw_lineage_claim || null,
    declaration_consistent: declarationErrors.length === 0,
    declaration_errors: declarationErrors,
    details,
  };
}

function sourceReadyGate(request, checks, provenance, pinnedArtifactManifest = null) {
  const byId = new Map((checks || []).map((check) => [check.check_id, check]));
  const nonLineageChecks = (checks || []).filter((check) => check.check_id !== 'raw_projection_traceability');
  const allNonLineagePass = nonLineageChecks.every((check) => check.result === 'pass');
  const mode = request && request.provenance_mode || PROVENANCE_MODES.RAW_LINEAGE;
  if (mode === PROVENANCE_MODES.RAW_LINEAGE) {
    const rawModeChecks = checks || [];
    return {
      ok: rawModeChecks.length > 0 && rawModeChecks.every((check) => check.result === 'pass'),
      mode,
      raw_lineage_claim: provenance && provenance.raw_lineage_claim || 'not-claimed',
      reason: 'source-ready requires explicit Source projection -> Raw lineage',
    };
  }
  const artifactCheck = byId.get('source_artifact_provenance');
  const alternateOk = allNonLineagePass
    && artifactCheck && artifactCheck.result === 'pass'
    && provenance && provenance.status === PROVENANCE_STATUS.PINNED_SOURCE_ARTIFACT
    && provenance.declaration_consistent
    && request.provenance_statement === 'pinned-source-artifact; raw-lineage-unproven'
    && /^[0-9a-f]{64}$/.test(String(request.pinned_artifact_manifest_sha256 || ''))
    && pinnedArtifactManifest
    && pinnedArtifactManifest.verified === true
    && pinnedArtifactManifest.digest === request.pinned_artifact_manifest_sha256
    && pinnedArtifactManifest.item_verified === true;
  return {
    ok: Boolean(alternateOk),
    mode,
    raw_lineage_claim: 'not-claimed',
    reason: alternateOk
      ? 'source-ready is based on a recorded pinned reference whose commit-tree path+blob was audited; Raw derivation is explicitly not claimed'
      : 'pinned-source-artifact mode requires a verified path+blob manifest, independent evidence, and an explicit no-Raw-lineage statement',
  };
}

module.exports = {
  PROVENANCE_STATUS,
  PROVENANCE_MODES,
  isPinnedArtifact,
  analyzeSourceProvenance,
  sourceReadyGate,
};
