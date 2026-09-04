'use strict';

const {
  sha256Text,
  planMaterialization,
} = require('./source-note-interview-materialization');
const {
  parseSourceNoteIssue,
  validateSourceNoteIssue,
} = require('./source-note-issue');
const { parseInterviewNoteIssue } = require('./interview-note-issue');

const BATCH_SCHEMA_VERSION = 'source-note-interview-materialization-batch.v1';
const REQUIRED_DEPENDENCIES = ['917', '920', '921'];

function labelsOf(issue) {
  return (issue && issue.labels ? issue.labels : [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean);
}

function boundaryStatus(record) {
  return record && record.boundary_review ? record.boundary_review.status : null;
}

function issueSourceRecord(issue) {
  const validation = validateSourceNoteIssue({
    body: issue && issue.body,
    labels: labelsOf(issue),
    state: String((issue && issue.state) || 'open').toLowerCase(),
  });
  const parsed = validation.parsed && validation.parsed.record;
  return { validation, parsed };
}

function materializationId(record, caseKey = null) {
  // Keep the v1 id stable across single-case and batch planners. Existing
  // receipts use this identity; the SourceRevision/body CAS fields still
  // detect a stale or conflicting source.
  if (!record || !record.source || typeof record.source.external_id !== 'string' || !record.source.external_id) {
    throw new Error('SourceNote external_id must be a non-empty string before deriving materialization id');
  }
  return `xhs-note-${record.source.external_id.slice(0, 8)}${caseKey == null ? '' : `-${caseKey}`}-materialization-1`;
}

function buildMaterializationRequest(sourceIssue, repository, options = {}) {
  const { validation, parsed } = issueSourceRecord(sourceIssue);
  if (!validation.ok) {
    throw new Error(`SourceNote #${sourceIssue && sourceIssue.number} is invalid: ${validation.errors.join('; ')}`);
  }
  const status = boundaryStatus(parsed);
  const caseKey = options.caseKey == null ? null : options.caseKey;
  if (status === 'multi-interview') {
    if (caseKey == null) throw new Error(`SourceNote #${sourceIssue.number} multi-interview requires case_key`);
    const approved = (parsed.boundary_review.interview_note_cases || []).find((item) => item.case_key === caseKey);
    if (!approved) throw new Error(`SourceNote #${sourceIssue.number} does not declare case_key ${caseKey}`);
  } else if (status !== 'single-interview' || caseKey != null) {
    throw new Error(`SourceNote #${sourceIssue.number} is not a supported ${caseKey == null ? 'single-interview' : 'multi-interview'} materialization case`);
  }
  const ids = parsed.boundary_review.interview_note_ids || [];
  const derivedId = `${parsed.source.system}:${parsed.source.external_id}`;
  if (caseKey == null && (ids.length !== 1 || ids[0] !== derivedId)) {
    throw new Error(`SourceNote #${sourceIssue.number} does not declare its source-derived InterviewNote identity`);
  }
  const revision = parsed.source_revision || {};
  return {
    schema_version: caseKey == null ? 'source-note-interview-materialization.v1' : 'source-note-interview-materialization.v2',
    materialization_id: materializationId(parsed, caseKey),
    repository,
    source_note_issue_number: Number(sourceIssue.number),
    source_note_id: parsed.source_note_id,
    expected_source_note_body_sha256: sha256Text(sourceIssue.body),
    expected_boundary_status: status,
    ...(caseKey == null ? {} : { case_key: caseKey }),
    expected_source_revision_id: revision.id,
    expected_manifest_sha256: revision.manifest_sha256 == null ? null : revision.manifest_sha256,
    expected_source_repository_ref: revision.source_repository_ref == null ? null : revision.source_repository_ref,
  };
}

function dependencyGateStatus(gate) {
  const errors = [];
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    return { ok: false, errors: ['dependency gate evidence is required'] };
  }
  const entries = gate.dependencies && !Array.isArray(gate.dependencies) ? gate.dependencies : gate;
  const dependencies = {};
  for (const number of REQUIRED_DEPENDENCIES) {
    const item = entries[number] || entries[`#${number}`];
    if (!item || item.issue_number !== Number(number) || item.state !== 'closed' || item.acceptance !== 'pass' || item.evidence_schema !== 'issue-dependency-acceptance.v1' || typeof item.evidence !== 'string' || !item.evidence.trim() || typeof item.acceptance_evidence !== 'string' || !item.acceptance_evidence.trim()) {
      errors.push(`#${number} requires state=closed, acceptance=pass, and durable evidence`);
    } else {
      dependencies[number] = { issue_number: item.issue_number, state: item.state, acceptance: item.acceptance, evidence_schema: item.evidence_schema, evidence: item.evidence, acceptance_evidence: item.acceptance_evidence };
    }
  }
  return { ok: errors.length === 0, errors, dependencies };
}

function planBatchMaterialization({
  repository,
  sourceIssues = [],
  interviewIssues = [],
  receiptsBySourceIssue = new Map(),
  dependencyGate = null,
  allowMultiInterview = false,
} = {}) {
  const errors = [];
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) {
    errors.push('repository must be owner/repo');
  }
  if (!Array.isArray(sourceIssues)) errors.push('sourceIssues must be an array');
  if (!Array.isArray(interviewIssues)) errors.push('interviewIssues must be an array');
  if (errors.length) return { ok: false, errors };

  const gate = dependencyGateStatus(dependencyGate);
  const sourceIdentityCounts = new Map();
  const interviewIdentityCounts = new Map();
  const parsedSources = [];

  for (const issue of sourceIssues) {
    const { validation, parsed } = issueSourceRecord(issue);
    const sourceId = parsed && parsed.source_note_id;
    if (sourceId) sourceIdentityCounts.set(sourceId, (sourceIdentityCounts.get(sourceId) || 0) + 1);
    const declaredIds = parsed && parsed.boundary_review
      ? parsed.boundary_review.interview_note_ids || []
      : [];
    for (const id of declaredIds) interviewIdentityCounts.set(id, (interviewIdentityCounts.get(id) || 0) + 1);
    parsedSources.push({ issue, validation, parsed });
  }

  const results = [];
  const add = (item) => results.push({
    source_note_issue_number: Number(item.issue && item.issue.number),
    source_note_id: item.parsed && item.parsed.source_note_id || null,
    boundary_status: boundaryStatus(item.parsed),
    ...item,
  });

  for (const item of parsedSources) {
    const { issue, validation, parsed } = item;
    if (!validation.ok) {
      add({ ...item, action: 'blocked', reason_code: 'invalid-source-note', errors: validation.errors });
      continue;
    }
    const sourceId = parsed.source_note_id;
    if (sourceIdentityCounts.get(sourceId) > 1) {
      add({ ...item, action: 'blocked', reason_code: 'duplicate-source-note-identity', errors: [`${sourceId} appears in ${sourceIdentityCounts.get(sourceId)} SourceNote Issues`] });
      continue;
    }

    const status = boundaryStatus(parsed);
    const declaredIds = parsed.boundary_review.interview_note_ids || [];
    if (declaredIds.some((id) => interviewIdentityCounts.get(id) > 1)) {
      add({ ...item, action: 'blocked', reason_code: 'duplicate-interview-note-identity', errors: ['one InterviewNote identity is declared by multiple SourceNotes'] });
      continue;
    }
    if (status === 'not-interview') {
      const derivedId = `${parsed.source.system}:${parsed.source.external_id}`;
      const owners = interviewIssues.filter((candidate) => {
        const marker = parseInterviewNoteIssue(candidate.body || '').marker;
        return marker && marker.interview_note_id === derivedId;
      });
      if (owners.length) {
        add({ ...item, action: 'blocked', reason_code: 'not-interview-has-interview-owner', errors: [`not-interview SourceNote already has ${owners.length} matching SourceNote marker owner(s); deletion is not automatic`] });
      } else {
        add({ ...item, action: 'skip-not-interview', reason_code: null, errors: [] });
      }
      continue;
    }
    if (status === 'pending') {
      add({ ...item, action: 'blocked', reason_code: 'boundary-review-required', errors: ['Boundary Review is still pending'] });
      continue;
    }
    if (!['single-interview', 'multi-interview'].includes(status)) {
      add({ ...item, action: 'blocked', reason_code: 'unknown-boundary-status', errors: [`unsupported boundary status: ${status}`] });
      continue;
    }

    const receipts = receiptsBySourceIssue instanceof Map
      ? receiptsBySourceIssue.get(Number(issue.number)) || []
      : receiptsBySourceIssue && receiptsBySourceIssue[Number(issue.number)] || [];
    const caseKeys = status === 'multi-interview'
      ? (parsed.boundary_review.interview_note_cases || []).map((entry) => entry.case_key).sort()
      : [null];
    if (status === 'multi-interview' && caseKeys.length < 2) {
      add({ ...item, action: 'blocked', reason_code: 'invalid-multi-interview-contract', errors: ['multi-interview must declare at least two approved child cases'] });
      continue;
    }
    for (const caseKey of caseKeys) {
      let request;
      try {
        request = buildMaterializationRequest(issue, repository, { caseKey });
      } catch (error) {
        add({ ...item, case_key: caseKey, action: 'blocked', reason_code: 'invalid-materialization-request', errors: [error.message] });
        continue;
      }
      const materialization = planMaterialization(request, {
        repository,
        sourceIssue: issue,
        issues: interviewIssues,
        receipts,
      });
      if (!materialization.ok) {
        add({ ...item, case_key: caseKey, action: 'blocked', reason_code: 'materialization-preflight-failed', errors: materialization.errors, request, materialization });
        continue;
      }
      const action = materialization.already_materialized
        ? 'already-materialized'
        : materialization.needs_receipt_repair
          ? 'would-repair-receipt'
          : 'would-materialize';
      add({
        ...item,
        case_key: caseKey,
        action,
        reason_code: null,
        errors: [],
        request,
        materialization,
        source_review: 'not-started',
      });
    }
  }

  const counts = {};
  for (const result of results) counts[result.action] = (counts[result.action] || 0) + 1;
  const blocked = results.filter((result) => result.action === 'blocked');
  const applyBlocked = blocked.filter((result) => result.reason_code !== 'boundary-review-required');
  const mutationCandidates = results.filter((result) => ['would-materialize', 'would-repair-receipt'].includes(result.action));
  return {
    ok: true,
    schema_version: BATCH_SCHEMA_VERSION,
    repository,
    dependency_gate: { ok: gate.ok, errors: gate.errors, dependencies: gate.dependencies },
    ready_for_apply: gate.ok && applyBlocked.length === 0 && results.some((result) => ['would-materialize', 'would-repair-receipt', 'already-materialized'].includes(result.action)),
    mutation_performed: false,
    total_candidates: sourceIssues.length,
    counts,
    materialization_candidates: mutationCandidates.length,
    source_ready: 0,
    blocked: blocked.length,
    apply_blocked: applyBlocked.length,
    results,
  };
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  REQUIRED_DEPENDENCIES,
  labelsOf,
  issueSourceRecord,
  materializationId,
  buildMaterializationRequest,
  dependencyGateStatus,
  planBatchMaterialization,
};
