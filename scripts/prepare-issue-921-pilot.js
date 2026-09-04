#!/usr/bin/env node
'use strict';

/*
 * Reproducible live selector for the Issue #921 50-SourceNote pilot.
 * It only prepares transition requests and evidence metadata; the existing
 * boundary batch CLI remains the sole body/label mutation path.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSourceNoteIssue } = require('./lib/source-note-issue');
const { sha256Text } = require('./lib/source-note-boundary-review-transition');

const REPOSITORY = 'liqiangcc/interview-lab';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'pilot', 'issue-921');
const MOTHER_SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const MOTHER_EXPECTED_COUNT = 1459;
const ALL_CHECKS = [
  ['source_identity', 'stable XHS source identity'],
  ['source_revision_binding', 'exact SourceRevision and fixed source snapshot'],
  ['source_content_coverage', 'Raw/source projection content is traceable'],
  ['event_boundary', 'boundary disposition is supported by source evidence'],
  ['no_cross_source_mixing', 'no cross-source evidence is mixed'],
  ['no_fabrication', 'no InterviewNote content is fabricated'],
];
const BLOB_CACHE = new Map();

const SELECTION = [
  ...[30, 43, 49, 52, 54, 57, 62, 67, 71, 73, 80, 81, 82, 88, 89, 97, 100, 105, 106, 107].map((issue_number) => ({ issue_number, stratum: 'single-interview', decision: 'single-interview', rationale: 'Source projection records one bounded employer/candidate interview event; same-process rounds remain one child boundary.' })),
  { issue_number: 33, stratum: 'multi-interview', decision: 'multi-interview', rationale: 'Source projection has two separately named employer interview records (达梦数据库 and 数梦工厂), each with its own question block.', case_keys: ['dameng-database', 'shumeng-factory'], case_anchors: ['达梦数据库', '数梦工厂'] },
  { issue_number: 551, stratum: 'multi-interview', decision: 'multi-interview', rationale: 'Source projection has three separately numbered Tencent roles/interview records with separate evidence blocks.', case_keys: ['tencent-pcg-backend', 'tencent-mofang-backend', 'tencent-fullstack-backend'], case_anchors: ['腾讯PCG后台开发岗', '腾讯魔方暑假实习后台开发岗', '腾讯全栈开发日常实习'] },
  ...[22, 23, 26, 27, 47, 79, 85, 98].map((issue_number) => ({ issue_number, stratum: 'question-bank', decision: 'not-interview', rationale: 'Source projection is a generic question collection/preparation or written-test resource, not a report of one candidate interview event.' })),
  ...[21, 95, 1367].map((issue_number) => ({ issue_number, stratum: 'tutorial-or-simulation', decision: 'not-interview', rationale: 'Source projection is a simulation/tutorial or generic instructional prompt; it does not establish a real interview event.' })),
  ...[20, 24, 35, 36, 77, 83, 86].map((issue_number) => ({ issue_number, stratum: 'experience-summary-or-non-event', decision: 'not-interview', rationale: 'Source projection is an aggregate experience/marketing/advice/non-event record rather than one bounded interview.' })),
  { issue_number: 25, stratum: 'text-evidence-fallback', decision: 'single-interview', evidence_preference: 'raw_html', evidence_anchors: ['面试一：某团外包岗'], rationale: 'Downloaded image blobs are zero-byte and cannot authorize a boundary; the fixed Raw HTML visibly records the bounded entry “面试一：某团外包岗” and its question reflection, so this decision relies only on the exact Raw HTML excerpt.' },
  { issue_number: 48, stratum: 'text-evidence-fallback', decision: 'single-interview', evidence_anchors: ['4月底就收到了字节的面试', '8号还是去面试了'], rationale: 'Downloaded image blobs are zero-byte and cannot authorize a boundary; the fixed Source projection explicitly records receiving and attending the ByteDance interview, so this decision relies only on exact Source projection excerpts.' },
  { issue_number: 53, stratum: 'text-evidence-fallback', decision: 'single-interview', evidence_anchors: ['面试官很好', '🎈一面（一小时）：', '🎈二面（四十分钟）：'], rationale: 'Downloaded image blobs are zero-byte and cannot authorize a boundary; the fixed Source projection explicitly records the interviewer and separately bounded first/second rounds, so this decision relies only on exact Source projection excerpts.' },
  { issue_number: 91, stratum: 'image-evidence', decision: 'single-interview', visual_boundary_basis: 'Manual visual inspection of fixed Raw image 1 shows a Tencent interview invitation with interview date, time, role, and location; image 2 shows a post-interview result notification. Together they establish one bounded interview event. No OCR/Derived projection is used as the image evidence.', rationale: 'Fixed Raw images are non-empty, readable WebP blobs and manual visual inspection establishes one bounded Tencent interview event; image artifacts remain Source evidence and are not converted to Derived InterviewNote content.' },
  { issue_number: 109, stratum: 'image-evidence', decision: 'single-interview', visual_boundary_basis: 'Manual visual inspection of fixed Raw images 1 and 2 shows one numbered technical-question record, with image 1 visibly marked “快手实习面经”; the question sequence is the bounded interview record. No OCR/Derived projection is used as the image evidence.', rationale: 'Fixed Raw images are non-empty, readable WebP blobs and manual visual inspection establishes one bounded Kuaishou internship interview-question record; image artifacts remain Source evidence and are not converted to Derived InterviewNote content.' },
  { issue_number: 90, stratum: 'anomaly-blocked', disposition: 'blocked', rationale: 'Aggregate text mentions several interviews but does not provide separately bounded event evidence; retain pending.' },
  { issue_number: 92, stratum: 'anomaly-blocked', disposition: 'blocked', rationale: 'Generic repeated-interview encouragement has no identifiable bounded event; retain pending.' },
  { issue_number: 1115, stratum: 'anomaly-blocked', disposition: 'blocked', rationale: 'Text mentions three interviews but only one is described and the remaining boundaries are not recoverable from the current Source projection; retain pending.' },
  { issue_number: 1452, stratum: 'anomaly-blocked', disposition: 'blocked', rationale: 'Source projection is missing; title alone cannot authorize an InterviewNote boundary.' },
  { issue_number: 1460, stratum: 'anomaly-blocked', disposition: 'blocked', rationale: 'Source projection is missing; title alone cannot authorize an InterviewNote boundary.' },
];

function ghJson(args, input = null) {
  const readOnly = !args.includes('--method');
  const attempts = readOnly ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const raw = execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(1000 * attempt);
    }
  }
  throw lastError;
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRequest(file, request) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<!-- source-note-boundary-review-transition\n${JSON.stringify(request, null, 2)}\n-->\n`);
}

function readRequest(file) {
  const body = fs.readFileSync(file, 'utf8');
  const match = body.match(/<!--\s*source-note-boundary-review-transition\s*\n([\s\S]*?)\n-->/);
  if (!match) throw new Error(`${file}: transition marker missing`);
  return JSON.parse(match[1]);
}

function readMarker(file, marker) {
  const body = fs.readFileSync(file, 'utf8');
  const match = body.match(new RegExp(`<!--\\s*${marker}\\s*\\n([\\s\\S]*?)\\n-->`));
  if (!match) throw new Error(`${file}: ${marker} marker missing`);
  return JSON.parse(match[1]);
}

function issue(number) {
  return ghJson(['api', `repos/${REPOSITORY}/issues/${number}`]);
}

function comments(number) {
  return ghJson(['api', `repos/${REPOSITORY}/issues/${number}/comments?per_page=100`]);
}

function findLegacyComment(allComments, transitionId) {
  return allComments.find((comment) => {
    const body = String(comment.body || '');
    return body.includes('[ISSUE #921 BOUNDARY REVIEW EVIDENCE]')
      && body.includes(`transition_id: ${transitionId}`)
      && !body.includes('<!-- issue-921-pilot-evidence')
      && !body.includes('<!-- issue-921-pilot-blocked-evidence');
  }) || null;
}

function findMachineComment(allComments, marker, issueNumber, transitionId = null) {
  const matches = allComments.filter((comment) => {
    const body = String(comment.body || '');
    const match = body.match(new RegExp(`<!--\\s*${marker}\\s*\\n([\\s\\S]*?)\\n-->`));
    if (!match) return false;
    try {
      const payload = JSON.parse(match[1]);
      return Number(payload.issue_number) === Number(issueNumber)
        && (transitionId == null || payload.transition_id === transitionId);
    } catch {
      return false;
    }
  });
  if (matches.length > 1) throw new Error(`#${issueNumber} has duplicate ${marker} machine markers`);
  return matches[0] || null;
}

function evidenceArtifact(record, selection) {
  if (selection.evidence_preference === 'raw_html') {
    return record.artifacts.find((item) => item.provenance === 'raw_capture' && item.kind === 'html');
  }
  return record.artifacts.find((item) => item.provenance === 'source_projection' && item.kind === 'text_projection')
    || record.artifacts.find((item) => item.provenance === 'source_projection')
    || record.artifacts.find((item) => item.provenance === 'raw_capture');
}

function artifactText(artifact) {
  if (!artifact.git_blob_sha) return null;
  const blob = ghJson(['api', `repos/liqiangcc/xhs/git/blobs/${artifact.git_blob_sha}`]);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`artifact blob ${artifact.git_blob_sha} is not base64`);
  return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
}

function excerptAt(text, anchor = null) {
  const lines = String(text || '').split('\n');
  let lineIndex = -1;
  if (anchor) lineIndex = lines.findIndex((line) => line.includes(anchor));
  if (lineIndex < 0) lineIndex = lines.findIndex((line) => line.trim() && !line.trim().startsWith('{') && !line.trim().startsWith('['));
  if (lineIndex < 0) lineIndex = 0;
  const lineText = lines[lineIndex].trim();
  let excerpt = lineText.slice(0, 360);
  if (anchor && lineText.length > 360) {
    const anchorIndex = lineText.indexOf(anchor);
    const start = Math.max(0, Math.min(anchorIndex - 120, lineText.length - 360));
    excerpt = lineText.slice(start, start + 360);
  }
  return { excerpt, line: lineIndex + 1, locator: `artifact-line:${lineIndex + 1}` };
}

function rawImageIntegrity(record) {
  return record.artifacts.filter((item) => item.provenance === 'raw_capture' && item.kind === 'image').map((artifact, index) => {
    if (!artifact.git_blob_sha) return { image_sequence: index + 1, ref: artifact.ref, blob_sha: null, byte_length: 0, readable: false };
    const blob = BLOB_CACHE.has(artifact.git_blob_sha)
      ? BLOB_CACHE.get(artifact.git_blob_sha)
      : ghJson(['api', `repos/liqiangcc/xhs/git/blobs/${artifact.git_blob_sha}`]);
    BLOB_CACHE.set(artifact.git_blob_sha, blob);
    const content = blob.encoding === 'base64' && typeof blob.content === 'string'
      ? Buffer.from(blob.content.replace(/\s/g, ''), 'base64')
      : Buffer.alloc(0);
    const webp = content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
    return { image_sequence: index + 1, ref: artifact.ref, blob_sha: artifact.git_blob_sha, byte_length: content.length, readable: content.length > 0 && webp, format: webp ? 'webp' : null };
  });
}

function makeEvidence(record, selection, artifact) {
  const text = artifactText(artifact);
  if (text == null) throw new Error(`artifact ${artifact.ref} has no verifiable Git blob`);
  const anchors = selection.case_anchors || [];
  if (anchors.length && anchors.length !== (selection.case_keys || []).length) throw new Error(`#${selection.issue_number} case anchors do not align with case keys`);
  if (anchors.length && anchors.some((anchor) => !text.includes(anchor))) throw new Error(`#${selection.issue_number} multi case anchor is absent from ${artifact.ref}`);
  const evidenceAnchors = selection.evidence_anchors || [];
  if (evidenceAnchors.some((anchor) => !text.includes(anchor))) throw new Error(`#${selection.issue_number} evidence anchor is absent from ${artifact.ref}`);
  const imageIntegrity = rawImageIntegrity(record);
  if (selection.stratum === 'image-evidence') {
    if (!selection.visual_boundary_basis || !imageIntegrity.length || imageIntegrity.some((item) => !item.readable)) throw new Error(`#${selection.issue_number} image evidence is not fully readable or lacks a manual visual boundary basis`);
  }
  const excerptAnchors = evidenceAnchors.length ? evidenceAnchors : anchors;
  return {
    artifact_ref: artifact.ref,
    artifact_provenance: artifact.provenance,
    excerpts: excerptAnchors.length ? excerptAnchors.map((anchor) => ({ anchor, ...excerptAt(text, anchor) })) : [excerptAt(text)],
    image_integrity: imageIntegrity,
    visual_boundary_basis: selection.visual_boundary_basis || null,
  };
}

function makeCases(record, selection, artifact, evidence) {
  const keys = selection.case_keys || [];
  return keys.map((case_key, index) => ({
    case_key,
    evidence: [{
      ref: artifact.ref,
      locator: `source-projection:${evidence.excerpts[index].locator}`,
    }],
  }));
}

function makeRequest(live, selection, record, artifact, reviewedAt, evidence) {
  const sourceRevision = record.source_revision;
  const decision = selection.decision;
  const request = {
    schema_version: decision === 'multi-interview' ? 'source-note-boundary-review-transition.v2' : 'source-note-boundary-review-transition.v1',
    transition_id: `issue-921-pilot-${live.number}-boundary-review-1`,
    repository: REPOSITORY,
    issue_number: live.number,
    source_note_id: record.source_note_id,
    expected_body_sha256: sha256Text(live.body || ''),
    expected_boundary_status: 'pending',
    expected_source_revision_id: sourceRevision.id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: sourceRevision.source_repository_ref,
    decision,
    reviewed_at: reviewedAt,
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: REPOSITORY, issue_number: live.number, comment_id: 1 },
    checks: ALL_CHECKS.map(([check_id, note]) => ({ check_id, result: 'pass', note: check_id === 'event_boundary' ? `${note}: ${selection.rationale}` : `${note}; evidence=${evidence.excerpts[0].locator}` })),
    limitations: [selection.rationale, 'Boundary Review records only SourceNote state; it does not create InterviewNote Issues or Derived interview content.'],
  };
  if (selection.visual_boundary_basis) request.limitations.push(`Manual visual review: ${selection.visual_boundary_basis}`);
  if (selection.stratum === 'text-evidence-fallback') request.limitations.push('Raw downloaded image blobs were not used because zero-byte image artifacts cannot authorize a boundary.');
  if (decision === 'multi-interview') request.interview_cases = makeCases(record, selection, artifact, evidence);
  return request;
}

function evidenceBody(request, selection, evidence) {
  return [
    '[ISSUE #921 BOUNDARY REVIEW EVIDENCE]',
    `transition_id: ${request.transition_id}`,
    `source_note_id: ${request.source_note_id}`,
    `source_revision_id: ${request.expected_source_revision_id}`,
    `source_repository_ref: ${request.expected_source_repository_ref}`,
    `recommended_decision: ${request.decision}`,
    `stratum: ${selection.stratum}`,
    `rationale: ${selection.rationale}`,
    `evidence_ref: ${evidence.artifact_ref}`,
    `artifact_provenance: ${evidence.artifact_provenance}`,
    ...evidence.excerpts.flatMap((item) => [`source_excerpt: ${item.excerpt}`, `source_locator: ${item.locator}`]),
    ...(request.interview_cases || []).flatMap((item) => [
      `case_key: ${item.case_key}`,
      `locator: ${item.evidence[0].locator}`,
      `identity_is_immutable: true`,
    ]),
    ...(evidence.image_integrity || []).flatMap((item) => [
      `image_artifact_${item.image_sequence}: ${item.ref}`,
      `image_blob_sha_${item.image_sequence}: ${item.blob_sha}`,
      `image_byte_length_${item.image_sequence}: ${item.byte_length}`,
      `image_readable_${item.image_sequence}: ${item.readable}`,
    ]),
    ...(evidence.visual_boundary_basis ? [`visual_boundary_basis: ${evidence.visual_boundary_basis}`] : []),
    ...request.checks.map((check) => `${check.check_id}: ${check.result}`),
  ].join('\n');
}

function prepare() {
  if (SELECTION.length !== 50) throw new Error(`selection must contain 50 items, got ${SELECTION.length}`);
  const oldSelectionPath = path.join(OUT_DIR, 'selection.json');
  const oldItems = fs.existsSync(oldSelectionPath) ? JSON.parse(fs.readFileSync(oldSelectionPath, 'utf8')).items || [] : [];
  const oldByIssue = new Map(oldItems.map((item) => [Number(item.issue_number), item]));
  const oldPostingPath = path.join(OUT_DIR, 'evidence-posting.json');
  const oldPosting = fs.existsSync(oldPostingPath) ? JSON.parse(fs.readFileSync(oldPostingPath, 'utf8')).posted || [] : [];
  const oldCommentByIssue = new Map(oldPosting.map((item) => [Number(item.issue_number), Number(item.comment_id)]));
  const searchTotal = ghJson(['api', 'search/issues?q=repo%3Aliqiangcc%2Finterview-lab%20is%3Aissue%20label%3Atype%3Asource-note']).total_count;
  const migrationSearchTotal = ghJson(['api', 'search/issues?q=repo%3Aliqiangcc%2Finterview-lab%20is%3Aissue%20label%3Amigration%3Axhs-bulk']).total_count;
  const extra = issue(910);
  const extraRecord = parseSourceNoteIssue(extra.body || '').record;
  if (searchTotal !== 1460 || migrationSearchTotal !== MOTHER_EXPECTED_COUNT) throw new Error(`mother-set count mismatch: source-note search=${searchTotal}, migration search=${migrationSearchTotal}`);
  if ((extra.labels || []).some((label) => (typeof label === 'string' ? label : label.name) === 'migration:xhs-bulk')) throw new Error('#910 unexpectedly belongs to the migration mother set');
  const selected = [];
  const manifestItems = [];
  let generatedAt = new Date().toISOString();
  for (const selection of SELECTION) {
    const live = issue(selection.issue_number);
    const labels = (live.labels || []).map((label) => typeof label === 'string' ? label : label.name);
    if (String(live.state).toLowerCase() !== 'open') throw new Error(`#${live.number} is not open`);
    if (!labels.includes('type:source-note') || !labels.includes('boundary:pending') || !labels.includes('migration:xhs-bulk')) throw new Error(`#${live.number} is not a pending #920 migration SourceNote`);
    const parsed = parseSourceNoteIssue(live.body || '');
    if (!parsed.record || parsed.record.boundary_review.status !== 'pending') throw new Error(`#${live.number} SourceNote record is not pending`);
    if (parsed.record.source_revision.source_repository_ref !== MOTHER_SOURCE_REF) throw new Error(`#${live.number} source ref is not the #920 fixed source snapshot`);
    const artifact = evidenceArtifact(parsed.record, selection);
    if (!artifact) throw new Error(`#${live.number} has no Raw/source projection evidence artifact`);
    const bodySha = sha256Text(live.body || '');
    const previous = oldByIssue.get(live.number);
    const reviewedAt = previous && previous.body_sha256 === bodySha && Date.parse(previous.reviewed_at) <= Date.now() ? previous.reviewed_at : generatedAt;
    const evidence = makeEvidence(parsed.record, selection, artifact);
    const transitionId = `issue-921-pilot-${live.number}-boundary-review-1`;
    const liveComments = comments(live.number);
    const machineMarker = selection.disposition === 'blocked' ? 'issue-921-pilot-blocked-evidence' : 'issue-921-pilot-evidence';
    const machine = findMachineComment(liveComments, machineMarker, live.number, selection.disposition === 'blocked' ? null : transitionId);
    const legacy = findLegacyComment(liveComments, transitionId);
    const cachedCommentId = oldCommentByIssue.get(live.number) || null;
    if (machine && cachedCommentId && Number(machine.id) !== cachedCommentId) throw new Error(`#${live.number} live machine comment ${machine.id} disagrees with cached comment ${cachedCommentId}`);
    const authoritativeCommentId = machine && Number(machine.id) || (legacy && Number(legacy.id)) || cachedCommentId;
    const item = { ...selection, source_note_id: parsed.record.source_note_id, source_revision_id: parsed.record.source_revision.id, source_repository_ref: parsed.record.source_revision.source_repository_ref, body_sha256: bodySha, evidence_artifact: { ref: artifact.ref, provenance: artifact.provenance, kind: artifact.kind }, evidence, reviewed_at: reviewedAt, live_url: live.html_url, legacy_evidence_comment_id: legacy && Number(legacy.id) || null, evidence_comment_id_source: machine ? 'live-machine-marker' : legacy ? 'live-legacy-marker' : (cachedCommentId ? 'local-posting-receipt' : null) };
    if (selection.disposition === 'blocked') {
      const blockedChecks = ALL_CHECKS.map(([check_id, note]) => ({ check_id, result: check_id === 'event_boundary' ? 'fail' : 'pass', note }));
      const blockedRecord = { schema_version: 'issue-921-pilot-blocked-evidence.v1', issue_number: live.number, source_note_id: item.source_note_id, disposition: 'blocked', block_reason: selection.rationale, source_excerpt: evidence.excerpts, evidence_artifact: item.evidence_artifact, checks: blockedChecks, limitations: [selection.rationale, 'No SourceNote body or label mutation is authorized while event boundary remains unproven.'], reviewed_at: reviewedAt, evidence_comment_id: authoritativeCommentId || (previous && previous.evidence_comment_id) || null };
      writeJson(path.join(OUT_DIR, 'blocked', `${String(live.number).padStart(4, '0')}.json`), blockedRecord);
      selected.push({ ...item, disposition: 'blocked', evidence_comment_id: blockedRecord.evidence_comment_id, blocked_evidence: blockedRecord });
      continue;
    }
    const request = makeRequest(live, selection, parsed.record, artifact, reviewedAt, evidence);
    const requestFile = `requests/${String(live.number).padStart(4, '0')}.json.md`;
    writeRequest(path.join(OUT_DIR, requestFile), request);
    manifestItems.push({ issue_number: live.number, transition_id: request.transition_id, request_file: requestFile });
    selected.push({ ...item, transition_id: request.transition_id, decision: request.decision, case_keys: (request.interview_cases || []).map((item) => item.case_key), review_evidence_comment_id: authoritativeCommentId || (previous && previous.review_evidence_comment_id) || null });
  }
  writeJson(path.join(OUT_DIR, 'selection.json'), {
    schema_version: 'issue-921-stratified-pilot-selection.v1',
    repository: REPOSITORY,
    parent_issue: 919,
    issue: 921,
    policy: '50 live open pending SourceNotes; Raw/source_projection only; no SourceNote is treated as InterviewNote; blocked items remain pending.',
    mother_set: { source_note_search_total: searchTotal, migration_search_total: migrationSearchTotal, expected_migration_members: MOTHER_EXPECTED_COUNT, fixed_source_repository_ref: MOTHER_SOURCE_REF, search_api_limit_not_full_proof: true, selected_membership_verified: true, known_extra_source_note: { issue_number: 910, source_note_id: extraRecord && extraRecord.source_note_id, excluded_reason: 'no migration:xhs-bulk; already boundary:single-interview' } },
    total: selected.length,
    strata: selected.reduce((out, item) => { out[item.stratum] = (out[item.stratum] || 0) + 1; return out; }, {}),
    items: selected,
  });
  writeJson(path.join(OUT_DIR, 'boundary-batch.json'), { schema_version: 'source-note-boundary-review-batch.v1', repository: REPOSITORY, items: manifestItems });
  writeJson(path.join(OUT_DIR, 'dependency-gate.json'), {
    schema_version: 'source-note-boundary-review-dependency-gate.v1',
    parent_issue: 919,
    dependencies: [
      { issue_number: 917, acceptance: 'pass', evidence_url: 'https://github.com/liqiangcc/interview-lab/issues/917#issuecomment-5539209153' },
      { issue_number: 920, acceptance: 'pass', evidence_url: 'https://github.com/liqiangcc/interview-lab/actions/runs/33884024268' },
    ],
  });
  const blocked = selected.filter((item) => item.disposition === 'blocked');
  writeJson(path.join(OUT_DIR, 'evidence-plan.json'), {
    schema_version: 'issue-921-pilot-evidence-plan.v1',
    mutation: 0,
    ready_comments: selected.filter((item) => item.disposition !== 'blocked').map((item) => ({ issue_number: item.issue_number, transition_id: item.transition_id, body_sha256: item.body_sha256, reviewed_at: item.reviewed_at, evidence: item.evidence })),
    blocked_comments: selected.filter((item) => item.disposition === 'blocked').map((item) => ({ issue_number: item.issue_number, body_sha256: item.body_sha256, reviewed_at: item.reviewed_at, blocked_evidence: item.blocked_evidence })),
    legacy_comment_plan: selected.filter((item) => item.disposition !== 'blocked' && item.legacy_evidence_comment_id).map((item) => ({ issue_number: item.issue_number, transition_id: item.transition_id, legacy_comment_id: item.legacy_evidence_comment_id, action: 'patch-in-place', duplicate_post: false })),
  });
  writeJson(path.join(OUT_DIR, 'selection-dry-run.json'), {
    schema_version: 'issue-921-stratified-pilot-selection-dry-run.v1',
    total: selected.length,
    ready_manifest_items: manifestItems.length,
    mother_set: { expected_members: MOTHER_EXPECTED_COUNT, fixed_source_repository_ref: MOTHER_SOURCE_REF, selected_membership_verified: true, excluded_extra_issue: 910, excluded_extra_source_note_id: extraRecord && extraRecord.source_note_id },
    blocked: blocked.map((item) => ({ issue_number: item.issue_number, stratum: item.stratum, reason: item.rationale })),
    mutation: 0,
    fail_closed: blocked.length > 0,
  });
  console.log(JSON.stringify({ total: selected.length, ready: manifestItems.length, blocked: blocked.length, mutation: 0 }, null, 2));
}

function postEvidence(pauseMs) {
  const selectionPath = path.join(OUT_DIR, 'selection.json');
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  const posted = [];
  for (const item of selection.items) {
    const isBlocked = item.disposition === 'blocked';
    const marker = isBlocked ? 'issue-921-pilot-blocked-evidence' : 'issue-921-pilot-evidence';
    const requestPath = path.join(OUT_DIR, 'requests', `${String(item.issue_number).padStart(4, '0')}.json.md`);
    const request = isBlocked ? null : readRequest(requestPath);
    const comments = ghJson(['api', `repos/${REPOSITORY}/issues/${item.issue_number}/comments?per_page=100`]);
    const markerComments = comments.filter((candidate) => String(candidate.body || '').includes(`<!-- ${marker}`));
    if (markerComments.length > 1) throw new Error(`#${item.issue_number} has duplicate ${marker} comments`);
    const body = isBlocked
      ? `<!-- issue-921-pilot-blocked-evidence\n${JSON.stringify(item.blocked_evidence, null, 2)}\n-->\n\n#921 pilot blocked: ${item.blocked_evidence.block_reason}`
      : `<!-- issue-921-pilot-evidence\n${JSON.stringify({ transition_id: request.transition_id, issue_number: item.issue_number, source_note_id: request.source_note_id, reviewed_at: request.reviewed_at, evidence: item.evidence, checks: request.checks }, null, 2)}\n-->\n\n${evidenceBody(request, item, item.evidence)}`;
    let comment = markerComments.find((candidate) => {
      try { return JSON.parse(String(candidate.body).match(new RegExp(`<!--\\s*${marker}\\s*\\n([\\s\\S]*?)\\n-->`))[1]).issue_number === item.issue_number; } catch { return false; }
    });
    let action = 'reused-machine-marker';
    if (comment && String(comment.body || '') !== body) {
      comment = ghJson(['api', '--method', 'PATCH', `repos/${REPOSITORY}/issues/comments/${comment.id}`, '--input', '-'], { body });
      action = 'patched-machine-marker-in-place';
    } else if (!comment) {
      const legacy = !isBlocked && comments.find((candidate) => {
        const text = String(candidate.body || '');
        return text.includes('[ISSUE #921 BOUNDARY REVIEW EVIDENCE]') && text.includes(`transition_id: ${request.transition_id}`);
      });
      if (legacy) {
        // GitHub's edit-issue-comment endpoint is keyed by the global comment
        // id; the issue-scoped comments collection is read-only for PATCH.
        comment = ghJson(['api', '--method', 'PATCH', `repos/${REPOSITORY}/issues/comments/${legacy.id}`, '--input', '-'], { body });
        action = 'patched-legacy-in-place';
      } else {
        comment = ghJson(['api', '--method', 'POST', `repos/${REPOSITORY}/issues/${item.issue_number}/comments`, '--input', '-'], { body });
        action = 'posted-new-machine-marker';
      }
    }
    if (isBlocked) item.evidence_comment_id = Number(comment.id);
    else { request.review_evidence.comment_id = Number(comment.id); writeRequest(requestPath, request); item.review_evidence_comment_id = Number(comment.id); }
    posted.push({ issue_number: item.issue_number, comment_id: Number(comment.id), action, duplicate_post: false, disposition: isBlocked ? 'blocked' : 'ready' });
    writeJson(path.join(OUT_DIR, 'evidence-posting.json'), { schema_version: 'issue-921-pilot-evidence-posting.v1', total: posted.length, posted });
    sleepMs(pauseMs);
  }
  writeJson(selectionPath, selection);
  console.log(JSON.stringify({ evidence_comments: posted.length }, null, 2));
}

function finalizeEvidencePlan() {
  const selection = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'selection.json'), 'utf8'));
  const posting = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'evidence-posting.json'), 'utf8'));
  if (posting.total !== 50 || posting.posted.length !== 50) throw new Error(`evidence posting is incomplete: ${posting.total}`);
  const ids = posting.posted.map((item) => Number(item.comment_id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('evidence posting contains an invalid comment id');
  if (new Set(ids).size !== ids.length) throw new Error('evidence posting contains duplicate comment ids');
  if (posting.posted.some((item) => item.duplicate_post !== false)) throw new Error('evidence posting contains a duplicate post');
  const byIssue = new Map(posting.posted.map((item) => [Number(item.issue_number), item]));
  const planPath = path.join(OUT_DIR, 'evidence-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.ready_comments = plan.ready_comments.map((item) => ({ ...item, comment_id: byIssue.get(Number(item.issue_number)).comment_id }));
  plan.blocked_comments = plan.blocked_comments.map((item) => ({ ...item, comment_id: byIssue.get(Number(item.issue_number)).comment_id }));
  plan.evidence_posting = {
    receipt_file: 'evidence-posting.json',
    total: posting.total,
    unique_comment_ids: new Set(ids).size,
    duplicate_post: false,
  };
  writeJson(planPath, plan);
  console.log(JSON.stringify({ evidence_plan_comments: ids.length, unique_comment_ids: new Set(ids).size, duplicate_post: false }, null, 2));
}

function main() {
  const mode = process.argv[2] || 'prepare';
  const pauseMs = Number(process.argv[3] || 1000);
  if (!Number.isInteger(pauseMs) || pauseMs < 0) throw new Error('pause must be a non-negative integer');
  if (mode === 'prepare') prepare();
  else if (mode === 'post-evidence') postEvidence(pauseMs);
  else if (mode === 'finalize-evidence-plan') finalizeEvidencePlan();
  else throw new Error(`unknown mode: ${mode}`);
}

main();
