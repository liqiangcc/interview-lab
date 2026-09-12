'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256Text } = require('./aggregate-downstream-pipeline');
const { issueSourceRecord } = require('./interview-note-materialization-batch');
const { findOwnershipMatches, validateExistingOwnership, buildInterviewProjection } = require('./source-note-interview-materialization');
const { validateCorrectionMarker, CORRECTION_SCHEMA_VERSION } = require('./source-note-boundary-receipt-correction');
const BINDINGS_FILE = path.resolve(__dirname, '../../audit/issue-1658-receipt-repair/repair-plan.json');
const BINDINGS_FILE_SHA = '3cf92f9403640e1aed0a32d3d30910457574db19ebc90c24a37cef231e413d84';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const REPOSITORY = 'liqiangcc/interview-lab';

function pinnedRow(number) {
  const raw = fs.readFileSync(BINDINGS_FILE, 'utf8');
  if (sha256Text(raw) !== BINDINGS_FILE_SHA) throw new Error('receipt correction historical binding file digest mismatch');
  const rows = JSON.parse(raw).rows.filter(row => row.source_issue === number);
  if (rows.length !== 1) throw new Error(`receipt correction scope excludes #${number}`);
  return rows[0];
}

// Count every exact marker opening, including malformed JSON/unterminated
// markers. A malformed or second marker cannot be hidden by a JSON filter.
function strictMarkers(comments, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opening = new RegExp(`<!--\\s*${escaped}(?=\\s|-->)`, 'g');
  const complete = new RegExp(`<!--\\s*${escaped}\\s*\\n([\\s\\S]*?)\\n-->`, 'g');
  const matches = [];
  for (const comment of comments) {
    const body = String(comment.body || '');
    const starts = [...body.matchAll(opening)];
    const parsed = [...body.matchAll(complete)];
    if (starts.length !== parsed.length) throw new Error(`malformed ${marker} marker in comment ${comment.id}`);
    for (const match of parsed) matches.push({ comment, raw:match[0], value:JSON.parse(match[1].trim()) });
  }
  return matches;
}

function validateAppliedReceiptCorrection(source, comments, options = {}) {
  const errors = [];
  try {
    const corrections = strictMarkers(comments, CORRECTION_SCHEMA_VERSION);
    if (corrections.length === 0) return { present:false, ok:false, errors:[] };
    if (corrections.length !== 1) throw new Error(`expected one correction marker, got ${corrections.length}`);
    const correction = corrections[0];
    const row = pinnedRow(Number(source.number));
    const issueUrl = `https://api.github.com/repos/${REPOSITORY}/issues/${row.source_issue}`;
    if (!Number.isSafeInteger(correction.comment.id) || correction.comment.id < 1 || correction.comment.issue_url !== issueUrl) throw new Error('correction comment locator mismatch');
    if (comments.filter(c => c.id === correction.comment.id).length !== 1) throw new Error('duplicate correction comment locator');
    if (String(correction.comment.body).trim() !== correction.raw) throw new Error('correction must be a dedicated marker-only comment');
    const parsed = issueSourceRecord(source);
    if (!parsed.validation.ok || !parsed.parsed) throw new Error('correction live SourceNote validation failed');
    const record = parsed.parsed;
    if (sha256Text(source.body) !== row.source_body_sha256 || record.source_note_id !== row.source_note_id
      || record.source_revision.id !== row.source_revision_id || record.source_revision.source_repository_ref !== SOURCE_REF
      || record.source_revision.source_repository !== 'liqiangcc/xhs' || record.boundary_review.status !== 'single-interview'
      || JSON.stringify(record.boundary_review.interview_note_ids) !== JSON.stringify([row.identity])) throw new Error('correction source/body/revision/ref/identity binding mismatch');
    const bindings = [
      ['source-note-boundary-review-applied','applied_comment_id','applied_receipt_body_sha256','applied_receipt_marker_sha256'],
      ['source-note-interview-materialized','materialization_comment_id','materialization_receipt_body_sha256','materialization_receipt_marker_sha256'],
      ['issue-1608-boundary-evidence.v1','evidence_comment_id','evidence_body_sha256','evidence_marker_sha256'],
    ];
    for (const [marker,id,bodySha,markerSha] of bindings) {
      const found = strictMarkers(comments,marker);
      if (found.length !== 1) throw new Error(`${marker} count=${found.length}`);
      const item = found[0];
      if (item.comment.id !== row[id] || item.comment.issue_url !== issueUrl || sha256Text(item.comment.body) !== row[bodySha] || sha256Text(item.raw) !== row[markerSha]) throw new Error(`${marker} historical comment binding mismatch`);
    }
    if (options.ownerInventoryComplete !== true || !Array.isArray(options.ownerIssues)) throw new Error('correction requires complete validated ownership inventory');
    const owners = findOwnershipMatches(options.ownerIssues,row.identity);
    if (owners.length !== 1 || owners[0].number !== row.owner_issue) throw new Error('correction owner missing/duplicate/number mismatch');
    if (options.ownerIssues.filter(owner => owner.number === row.owner_issue).length !== 1) throw new Error('correction duplicate owner issue number');
    const owner = owners[0];
    if (sha256Text(owner.body) !== row.owner_body_sha256) throw new Error('correction live owner body mismatch');
    const ownerValidation = validateExistingOwnership(owner,buildInterviewProjection(source,parsed.validation));
    if (!ownerValidation.ok) throw new Error(ownerValidation.errors.join('; '));
    // owner_binding.labels binds the immutable reviewed repair snapshot.
    // Current title/lifecycle labels may evolve through the ordinary existing
    // ownership validator; Raw body/identity/revision must still match exactly.
    const validation = validateCorrectionMarker(correction.value,row);
    errors.push(...validation.errors);
    return {present:true,ok:errors.length===0,errors,comment_id:correction.comment.id,comment_body_sha256:sha256Text(correction.comment.body)};
  } catch (error) {
    return {present:true,ok:false,errors:[error.message]};
  }
}

module.exports = { pinnedRow, strictMarkers, validateAppliedReceiptCorrection };
