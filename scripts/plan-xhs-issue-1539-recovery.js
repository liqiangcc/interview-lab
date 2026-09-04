#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  canonicalJson, sha256Text, labelsOf, statusOf, validateManifest,
  parseIndependentEvidence, reviewAction,
} = require('./lib/issue-1539-recovery-plan');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { computeChecks, ownershipMatches, evidenceSubjectSha256 } = require('./lib/interview-note-source-review-transition');
const { planSourceReview, validateEvidenceComment } = require('./lib/interview-note-source-review-transition');
const { analyzeSourceProvenance } = require('./lib/source-note-provenance');
const { buildManifest: buildPinnedArtifactManifest, validateManifest: validatePinnedArtifactManifest, verifyManifestItem } = require('./lib/issue-1539-pinned-artifact-manifest');
const { exactOwnershipCandidates, ownershipSearchEndpoint, createSearchThrottle } = require('./lib/interview-note-ownership-search');

const MAX_PAGES = 100;

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, report: null, pinnedArtifactManifest: null, searchPauseMs: 2200 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') out.manifest = argv[++i];
    else if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--pinned-artifact-manifest') out.pinnedArtifactManifest = argv[++i];
    else if (argv[i] === '--search-pause-ms') out.searchPauseMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.manifest) throw new Error('--manifest is required');
  if (!Number.isInteger(out.searchPauseMs) || out.searchPauseMs < 2100) throw new Error('--search-pause-ms must be an integer >= 2100');
  return out;
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function ghReadJson(args, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return ghJson(args); } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(attempt * 1000);
    }
  }
  throw lastError;
}

function pageWiseIssues(repository, label) {
  const result = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = ghReadJson(['api', `repos/${repository}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue list for ${label} page ${page} was not an array`);
    result.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) return result;
  }
  throw new Error(`Issue list for ${label} exceeded ${MAX_PAGES} pages`);
}

function loadIssue(repository, number) {
  return ghReadJson(['api', `repos/${repository}/issues/${number}`]);
}

function loadComments(repository, number) {
  const result = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = ghReadJson(['api', `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments page ${page} was not an array`);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error(`Issue #${number} comments exceeded ${MAX_PAGES} pages`);
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function findCaseKey(sourceRecord, interviewNoteId) {
  const cases = sourceRecord.boundary_review && sourceRecord.boundary_review.interview_note_cases || [];
  const found = cases.find((item) => item && item.interview_note_id === interviewNoteId);
  return found ? found.case_key : null;
}

function buildSourceReviewRequest(manifest, item, interviewIssue, interviewRecord, sourceRecord, pinnedArtifactManifest = null) {
  const sourceRevision = sourceRecord.source_revision || {};
  const caseKey = findCaseKey(sourceRecord, interviewRecord.interview_note_id);
  const request = {
    schema_version: 'interview-note-source-review-transition.v1',
    transition_id: `${manifest.source_review.batch_id}-${item.interview_issue_number}`,
    repository: manifest.repository,
    issue_number: item.interview_issue_number,
    interview_note_id: interviewRecord.interview_note_id,
    expected_interview_body_sha256: sha256Text(interviewIssue.body || ''),
    expected_initial_status: 'blocked',
    expected_source_revision_id: sourceRevision.id,
    source_note_issue_number: item.source_note_issue_number,
    expected_source_note_body_sha256: sha256Text(item.source_note_body || ''),
    ...(sourceRevision.manifest_sha256 == null ? {} : { expected_manifest_sha256: sourceRevision.manifest_sha256 }),
    ...(sourceRevision.source_repository_ref == null ? {} : { expected_source_repository_ref: sourceRevision.source_repository_ref }),
    recovery_mode: 'blocked-source-recovery',
    provenance_mode: 'pinned-source-artifact',
    provenance_statement: 'pinned-source-artifact; raw-lineage-unproven',
    pinned_artifact_manifest_sha256: pinnedArtifactManifest && pinnedArtifactManifest.digest || null,
    decision: 'source-ready',
    limitations: sourceRecord.limitations || [],
  };
  if (caseKey) request.case_key = caseKey;
  return request;
}

function planSourceReviewItem(manifest, item, interviewIssue, sourceIssue, ownership, comments, pinnedArtifactManifest = null) {
  const errors = [];
  const interviewValidation = validateInterviewNoteIssue({ body: interviewIssue.body || '', labels: labelsOf(interviewIssue), state: String(interviewIssue.state || '').toLowerCase() });
  const sourceValidation = validateSourceNoteIssue({ body: sourceIssue.body || '', labels: labelsOf(sourceIssue), state: String(sourceIssue.state || '').toLowerCase() });
  if (!interviewValidation.ok) errors.push(...interviewValidation.errors.map((error) => `InterviewNote: ${error}`));
  if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((error) => `SourceNote: ${error}`));
  const interviewRecord = interviewValidation.parsed && interviewValidation.parsed.record;
  const sourceRecord = sourceValidation.parsed && sourceValidation.parsed.record;
  if (!interviewRecord || !sourceRecord) {
    return { issue_number: item.interview_issue_number, source_note_issue_number: item.source_note_issue_number, action: 'remain-blocked', candidate_decision: 'blocked', current_status: statusOf(interviewIssue), computed_checks: [], failed_check_ids: [], independent_evidence: 'missing', receipt_count: 0, mutation_performed: false, errors };
  }
  if (item.interview_note_id && item.interview_note_id !== interviewRecord.interview_note_id) errors.push('manifest InterviewNote identity mismatch');
  const request = buildSourceReviewRequest(
    manifest,
    { ...item, source_note_body: sourceIssue.body || '' },
    interviewIssue,
    interviewRecord,
    sourceRecord,
    pinnedArtifactManifest,
  );
  const checks = computeChecks(request, interviewIssue, sourceIssue, ownership);
  request.checks = checks;
  request.evidence_subject_sha256 = evidenceSubjectSha256(request, checks);
  const evidence = parseIndependentEvidence(comments, {
    repository: manifest.repository,
    interview_note_id: interviewRecord.interview_note_id,
    source_note_issue_number: item.source_note_issue_number,
    source_revision_id: sourceRecord.source_revision.id,
    transition_id: request.transition_id,
    evidence_subject_sha256: request.evidence_subject_sha256,
    expected_interview_body_sha256: request.expected_interview_body_sha256,
    expected_source_note_body_sha256: request.expected_source_note_body_sha256,
    provenance_mode: request.provenance_mode,
    pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256,
    checks,
  });
  errors.push(...evidence.errors);
  const evidenceComment = evidence.evidence && comments.find((comment) => Number(comment.id) === Number(evidence.evidence.comment_id));
  if (evidenceComment) {
    request.review_evidence = { comment_id: Number(evidenceComment.id) };
    const evidenceErrors = [];
    validateEvidenceComment(request, evidenceComment, evidenceErrors);
    errors.push(...evidenceErrors);
  }
  const transition = planSourceReview(request, interviewIssue, {
    planningOnly: true,
    sourceIssue,
    allIssues: ownership,
    evidenceComment,
    pinnedArtifactManifest,
  });
  errors.push(...transition.errors);
  const result = reviewAction({
    currentStatus: transition.current_status || statusOf(interviewIssue),
    checks: transition.computed_checks || checks,
    evidence: evidence.evidence,
    receiptCount: comments.filter((comment) => String(comment.body || '').includes('interview-note-source-review-applied')).length,
    errors,
    sourceReadyGateResult: transition.source_ready_gate,
  });
  return {
    ...result,
    issue_number: item.interview_issue_number,
    source_note_issue_number: item.source_note_issue_number,
    interview_note_id: interviewRecord.interview_note_id,
    case_key: request.case_key || null,
    expected_interview_body_sha256: request.expected_interview_body_sha256,
    expected_source_note_body_sha256: request.expected_source_note_body_sha256,
    expected_source_revision_id: sourceRecord.source_revision.id,
    source_revision_evidence: {
      source_repository: sourceRecord.source_revision.source_repository || null,
      source_repository_ref: request.expected_source_repository_ref,
      ...(request.expected_manifest_sha256 == null ? {} : { manifest_sha256: request.expected_manifest_sha256 }),
      raw_artifact_count: (sourceRecord.artifacts || []).filter((artifact) => artifact.provenance === 'raw_capture').length,
      source_projection_count: (sourceRecord.artifacts || []).filter((artifact) => artifact.provenance === 'source_projection').length,
    },
    evidence_subject_sha256: request.evidence_subject_sha256,
    pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256,
    pinned_artifact_manifest_item_verified: transition.source_ready_gate && transition.source_ready_gate.ok ? true : verifyManifestItem(pinnedArtifactManifest, request, sourceRecord).ok,
    provenance: transition.provenance || analyzeSourceProvenance(sourceRecord),
    boundary_review_evidence_reused: false,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const manifestValidation = validateManifest(manifest);
  if (!manifestValidation.ok) throw new Error(manifestValidation.errors.join('; '));
  const progressFile = args.report ? `${args.report}.progress.json` : null;
  const progress = { schema_version: 'issue-1539-recovery-dry-run-progress.v1', status: 'running', repository: manifest.repository, report: args.report, search_pause_ms: args.searchPauseMs, completed_interview_issues: [] };
  if (progressFile) atomicWrite(progressFile, progress);
  try {
    const interviewInventory = pageWiseIssues(manifest.repository, 'type:interview-note');
    const sourceInventory = pageWiseIssues(manifest.repository, 'type:source-note');
    const baseline = {
      interview_notes: interviewInventory.length,
      source_ready: interviewInventory.filter((issue) => labelsOf(issue).includes('status:source-ready')).length,
      source_review: interviewInventory.filter((issue) => labelsOf(issue).includes('status:source-review')).length,
      blocked: interviewInventory.filter((issue) => labelsOf(issue).includes('status:blocked')).length,
      captured: interviewInventory.filter((issue) => labelsOf(issue).includes('status:captured')).length,
      source_notes: sourceInventory.length,
      boundary_single: sourceInventory.filter((issue) => labelsOf(issue).includes('boundary:single-interview')).length,
      boundary_multi: sourceInventory.filter((issue) => labelsOf(issue).includes('boundary:multi-interview')).length,
      boundary_not_interview: sourceInventory.filter((issue) => labelsOf(issue).includes('boundary:not-interview')).length,
      boundary_pending: sourceInventory.filter((issue) => labelsOf(issue).includes('boundary:pending')).length,
    };
    const sourceByNumber = new Map(sourceInventory.map((issue) => [Number(issue.number), issue]));
    const throttle = createSearchThrottle(args.searchPauseMs, sleepMs);
    const sourceReviewItems = [];
    const pinnedArtifactEntries = [];
    const sourceReviewInputs = [];
    for (const item of manifest.source_review.items) {
      const interviewIssue = loadIssue(manifest.repository, item.interview_issue_number);
      const sourceIssue = loadIssue(manifest.repository, item.source_note_issue_number);
      sourceReviewInputs.push({ item, interviewIssue, sourceIssue });
      const sourceValidation = validateSourceNoteIssue({ body: sourceIssue.body || '', labels: labelsOf(sourceIssue), state: String(sourceIssue.state || '').toLowerCase() });
      if (sourceValidation.parsed && sourceValidation.parsed.record) {
        pinnedArtifactEntries.push({
          interview_issue_number: item.interview_issue_number,
          source_note_issue_number: item.source_note_issue_number,
          source_note_id: sourceValidation.parsed.record.source_note_id,
          source_revision_id: sourceValidation.parsed.record.source_revision.id,
          artifacts: sourceValidation.parsed.record.artifacts,
        });
      }
    }
    const pinnedTree = ghReadJson(['api', `repos/${manifest.source_snapshot.repository}/git/trees/${manifest.source_snapshot.ref}?recursive=1`]);
    if (!pinnedTree || !Array.isArray(pinnedTree.tree)) throw new Error('pinned source commit tree response is invalid');
    if (pinnedArtifactEntries.length !== manifest.source_review.items.length) throw new Error(`pinned artifact manifest entries incomplete: ${pinnedArtifactEntries.length}/${manifest.source_review.items.length}`);
    const pinnedArtifactManifest = buildPinnedArtifactManifest({
      repository: manifest.repository,
      sourceSnapshot: manifest.source_snapshot,
      entries: pinnedArtifactEntries,
      treeEntries: pinnedTree.tree,
      treeSha: pinnedTree.sha || null,
    });
    if (!pinnedArtifactManifest.verified) throw new Error(`pinned artifact manifest verification failed: ${pinnedArtifactManifest.errors.join('; ')}`);
    const pinnedManifestValidation = validatePinnedArtifactManifest(pinnedArtifactManifest);
    if (!pinnedManifestValidation.ok) throw new Error(`pinned artifact manifest schema validation failed: ${pinnedManifestValidation.errors.join('; ')}`);
    const pinnedArtifactManifestPath = args.pinnedArtifactManifest || (args.report ? `${args.report}.pinned-artifact-manifest.json` : null);
    if (pinnedArtifactManifestPath) atomicWrite(pinnedArtifactManifestPath, pinnedArtifactManifest);
    for (const { item, interviewIssue, sourceIssue } of sourceReviewInputs) {
      const parsedInterview = parseInterviewNoteIssue(interviewIssue.body || '');
      const interviewNoteId = item.interview_note_id || parsedInterview.marker && parsedInterview.marker.interview_note_id;
      if (!interviewNoteId) throw new Error(`#${item.interview_issue_number} has no InterviewNote identity`);
      const ownership = exactOwnershipCandidates({
        interviewNoteId,
        readPage: (page) => ghReadJson(['api', `${ownershipSearchEndpoint(manifest.repository, interviewNoteId)}&page=${page}`]),
        readIssue: (number) => loadIssue(manifest.repository, number),
        matches: ownershipMatches,
        beforePage: throttle,
      });
      const comments = loadComments(manifest.repository, item.interview_issue_number);
      sourceReviewItems.push(planSourceReviewItem(manifest, item, interviewIssue, sourceIssue, ownership, comments, pinnedArtifactManifest));
      if (progressFile) {
        progress.completed_interview_issues.push(Number(item.interview_issue_number));
        atomicWrite(progressFile, { ...progress, completed_interview_issues: [...progress.completed_interview_issues] });
      }
    }
    const boundaryItems = manifest.boundary_expansion.issue_numbers.map((number) => {
      const issue = sourceByNumber.get(Number(number)) || loadIssue(manifest.repository, number);
      const labels = labelsOf(issue);
      const validation = validateSourceNoteIssue({ body: issue.body || '', labels, state: String(issue.state || '').toLowerCase() });
      const parsed = parseSourceNoteIssue(issue.body || '');
      const status = parsed.record && parsed.record.boundary_review && parsed.record.boundary_review.status || null;
      const errors = [];
      if (!labels.includes('type:source-note')) errors.push('not a SourceNote Issue');
      if (!labels.includes('boundary:pending') || status !== 'pending') errors.push('live SourceNote is not still boundary:pending');
      if (!validation.ok) errors.push(...validation.errors);
      return { issue_number: Number(number), title: issue.title, action: errors.length ? 'remain-blocked' : 'requires-boundary-review-evidence', boundary_status: status, mutation_performed: false, errors };
    });
    const reviewReady = sourceReviewItems.filter((item) => item.action === 'source-review-ready-for-authorized-transition').length;
    const reportWithoutDigest = {
      schema_version: 'issue-1539-recovery-dry-run.v1',
      repository: manifest.repository,
      source_snapshot: manifest.source_snapshot,
      manifest: { path: args.manifest, source_review_batch_id: manifest.source_review.batch_id, source_review_item_count: manifest.source_review.items.length, boundary_batch_id: manifest.boundary_expansion.batch_id, boundary_selection_policy: manifest.boundary_expansion.selection_policy, boundary_item_count: manifest.boundary_expansion.issue_numbers.length, pinned_artifact_manifest_path: pinnedArtifactManifestPath, pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest, pinned_artifact_manifest_verified: pinnedArtifactManifest.verified, pinned_artifact_manifest_item_count: pinnedArtifactManifest.items.length },
      baseline,
      source_review: { total: sourceReviewItems.length, candidate_source_ready: sourceReviewItems.filter((item) => item.candidate_decision === 'source-ready').length, independent_evidence_present: sourceReviewItems.filter((item) => item.independent_evidence === 'present').length, ready_for_authorized_transition: reviewReady, blocked: sourceReviewItems.filter((item) => item.candidate_decision === 'blocked').length, provenance_status_counts: sourceReviewItems.reduce((counts, item) => { const status = item.provenance && item.provenance.status || 'unknown'; counts[status] = (counts[status] || 0) + 1; return counts; }, {}), raw_lineage_proven: sourceReviewItems.filter((item) => item.provenance && item.provenance.raw_lineage_proven).length, pinned_source_artifact: sourceReviewItems.filter((item) => item.provenance && item.provenance.pinned_source_artifact).length, items: sourceReviewItems },
      boundary_expansion: { total: boundaryItems.length, pending_valid: boundaryItems.filter((item) => item.action === 'requires-boundary-review-evidence').length, blocked: boundaryItems.filter((item) => item.action === 'remain-blocked').length, items: boundaryItems },
      safety: { mutation_performed: false, apply_entrypoint: 'none; this planner has no mutation path', exact_ownership_checked: true, search_pause_ms: args.searchPauseMs, cas: 'body SHA-256 and SourceRevision recorded for every Source Review item; no write attempted', pinned_artifact_manifest: '30-item manifest verified against the pinned commit tree path+blob SHA', durable_intent_receipt: 'not created because no mutation was authorized or attempted', recovery_dry_run: 'required after any future authorized apply', boundary_evidence_not_used_as_source_review: true, interview_context_or_learning_labels_generated: false },
      ready_for_authorization: reviewReady > 0 && sourceReviewItems.every((item) => item.action !== 'remain-blocked') && boundaryItems.every((item) => item.action !== 'remain-blocked'),
      mutation_performed: false,
    };
    const report = { ...reportWithoutDigest, dry_run_sha256: sha256Text(canonicalJson(reportWithoutDigest)) };
    if (args.report) atomicWrite(args.report, report);
    if (progressFile) atomicWrite(progressFile, { ...progress, status: 'complete', stage: 'complete', dry_run_sha256: report.dry_run_sha256, mutation_performed: false });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (progressFile) atomicWrite(progressFile, { ...progress, status: 'failed', error: error.message, mutation_performed: false });
    throw error;
  }
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { parseArgs, main, buildSourceReviewRequest, planSourceReviewItem, pageWiseIssues };
