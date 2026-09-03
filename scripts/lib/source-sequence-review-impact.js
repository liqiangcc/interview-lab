'use strict';

const { parseCheckpoint } = require('./exploration-session-checkpoint');

const MACHINE_MARKER_OPEN_RE = /<!--\s*exploration-session-checkpoint\b/;

function compareEntries(a, b) {
  const at = Date.parse(a.created_at || '');
  const bt = Date.parse(b.created_at || '');
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at - bt;
  const ai = Number(a.id);
  const bi = Number(b.id);
  if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
  return a.input_index - b.input_index;
}

function classifySession(last, effectiveReview) {
  const record = last.record;
  const effectiveId = effectiveReview ? effectiveReview.review_id : null;
  const effectiveDecision = effectiveReview ? effectiveReview.decision : null;

  if (record.schema_version === 'exploration-session-checkpoint.v2') {
    if (record.session_status === 'completed') {
      return {
        status: 'legacy-historical-unpinned',
        severity: 'info',
        blocking: false,
        recommended_action: 'none',
      };
    }
    if (!effectiveReview || effectiveDecision !== 'approved') {
      return {
        status: 'legacy-active-blocked',
        severity: 'hard',
        blocking: true,
        recommended_action: 'pause-until-approved-review-then-start-v3-session',
      };
    }
    return {
      status: 'legacy-active-unpinned',
      severity: 'review',
      blocking: false,
      recommended_action: 'prefer-new-v3-session-before-continuing',
    };
  }

  if (record.schema_version === 'exploration-session-checkpoint.v3') {
    const pinnedId = record.source_review_id || null;
    const isCurrentApproved = effectiveDecision === 'approved' && pinnedId === effectiveId;
    if (record.session_status === 'completed') {
      return {
        status: isCurrentApproved ? 'historical-current' : 'historical-superseded',
        severity: 'info',
        blocking: false,
        recommended_action: 'none',
      };
    }
    if (isCurrentApproved) {
      return {
        status: 'active-current',
        severity: 'info',
        blocking: false,
        recommended_action: 'continue',
      };
    }
    return {
      status: 'active-stale',
      severity: 'hard',
      blocking: true,
      recommended_action: effectiveDecision === 'approved'
        ? 'start-new-v3-session-pinned-to-current-review'
        : 'pause-until-approved-review-then-start-new-v3-session',
    };
  }

  return {
    status: 'unsupported-checkpoint-version',
    severity: 'review',
    blocking: false,
    recommended_action: 'review-manually',
  };
}

function analyzeSourceSequenceReviewImpact(comments, options = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(comments)) {
    return { ok: false, errors: ['impact input must be an array of Issue comments'], warnings, sessions: [], summary: {} };
  }
  const manifestId = options.manifestId;
  const manifestSha256 = options.manifestSha256;
  if (typeof manifestId !== 'string' || manifestId.length === 0) errors.push('manifestId is required');
  if (!/^[0-9a-f]{64}$/.test(String(manifestSha256 || ''))) errors.push('manifestSha256 must be a 64-char lowercase hex SHA-256');
  if (errors.length > 0) return { ok: false, errors, warnings, sessions: [], summary: {} };

  const grouped = new Map();
  comments.forEach((comment, inputIndex) => {
    const body = String(comment && comment.body || '');
    if (!MACHINE_MARKER_OPEN_RE.test(body)) return;
    const parsed = parseCheckpoint(body);
    if (!parsed.record) {
      warnings.push(`comment ${comment && comment.id != null ? comment.id : inputIndex + 1}: checkpoint marker could not be parsed for impact analysis`);
      return;
    }
    const record = parsed.record;
    if (!['exploration-session-checkpoint.v2', 'exploration-session-checkpoint.v3'].includes(record.schema_version)) return;
    if (record.source_manifest_id !== manifestId || record.source_manifest_sha256 !== manifestSha256) return;
    const entry = {
      id: comment && comment.id != null ? comment.id : null,
      created_at: comment && comment.created_at || null,
      input_index: inputIndex,
      record,
    };
    if (!grouped.has(record.session_id)) grouped.set(record.session_id, []);
    grouped.get(record.session_id).push(entry);
  });

  const sessions = [];
  for (const [sessionId, entries] of grouped.entries()) {
    const ordered = [...entries].sort(compareEntries);
    const last = ordered[ordered.length - 1];
    const classification = classifySession(last, options.effectiveReview || null);
    sessions.push({
      session_id: sessionId,
      schema_version: last.record.schema_version,
      session_status: last.record.session_status,
      pinned_review_id: last.record.source_review_id || null,
      last_comment_id: last.id,
      ...classification,
    });
  }
  sessions.sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)));

  const summary = {
    sessions: sessions.length,
    blocking_sessions: sessions.filter((session) => session.blocking).length,
    active_stale: sessions.filter((session) => session.status === 'active-stale').length,
    active_current: sessions.filter((session) => session.status === 'active-current').length,
    legacy_active_unpinned: sessions.filter((session) => session.status === 'legacy-active-unpinned').length,
    legacy_active_blocked: sessions.filter((session) => session.status === 'legacy-active-blocked').length,
    historical_current: sessions.filter((session) => session.status === 'historical-current').length,
    historical_superseded: sessions.filter((session) => session.status === 'historical-superseded').length,
    legacy_historical_unpinned: sessions.filter((session) => session.status === 'legacy-historical-unpinned').length,
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    effective_review: options.effectiveReview
      ? { review_id: options.effectiveReview.review_id, decision: options.effectiveReview.decision }
      : null,
    sessions,
    summary,
  };
}

module.exports = {
  analyzeSourceSequenceReviewImpact,
};
