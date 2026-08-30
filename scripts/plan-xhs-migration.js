#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DERIVED_PREFIXES = [
  'note_img_txt/',
  'note_structured/',
  'note_tagged/',
  'data/questions/',
  'review/',
];

const RAW_PREFIXES = [
  'note_detail/',
  'note_images/',
  'downloaded_images/',
];

const SOURCE_PROJECTION_PREFIXES = [
  'note_json/',
  'note_desc/',
];

function pathHasPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function validateSourceTime(sourceTime, errors, noteId) {
  if (!sourceTime || typeof sourceTime !== 'object') {
    errors.push(`${noteId}: source_time is required`);
    return;
  }
  const patterns = {
    exact: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
    month: /^\d{4}-\d{2}$/,
    year: /^\d{4}$/,
  };
  if (sourceTime.precision === 'unknown') {
    if (sourceTime.value !== null) errors.push(`${noteId}: unknown source_time must have value=null`);
    return;
  }
  const pattern = patterns[sourceTime.precision];
  if (!pattern) {
    errors.push(`${noteId}: unsupported source_time precision ${sourceTime.precision}`);
    return;
  }
  if (typeof sourceTime.value !== 'string' || !pattern.test(sourceTime.value)) {
    errors.push(`${noteId}: source_time value does not match ${sourceTime.precision} precision`);
  }
}

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  if (!manifest || manifest.schema_version !== 'xhs-pilot-selection.v1') {
    errors.push('schema_version must be xhs-pilot-selection.v1');
  }
  if (!Array.isArray(manifest && manifest.cases)) {
    errors.push('cases must be an array');
    return { ok: false, errors, warnings };
  }

  const ids = new Set();
  for (const item of manifest.cases) {
    const noteId = item && item.note_id;
    if (!noteId) {
      errors.push('every case requires note_id');
      continue;
    }
    if (ids.has(noteId)) errors.push(`${noteId}: duplicate note_id in pilot manifest`);
    ids.add(noteId);

    if (!['issue_candidate', 'boundary_review'].includes(item.expected_disposition)) {
      errors.push(`${noteId}: unsupported expected_disposition`);
    }

    for (const field of ['raw_evidence_paths', 'source_projection_paths', 'derived_comparison_paths']) {
      if (!Array.isArray(item[field])) errors.push(`${noteId}: ${field} must be an array`);
    }

    for (const sourcePath of item.raw_evidence_paths || []) {
      if (pathHasPrefix(sourcePath, DERIVED_PREFIXES)) {
        errors.push(`${noteId}: derived path cannot be raw evidence: ${sourcePath}`);
      }
      if (!pathHasPrefix(sourcePath, RAW_PREFIXES)) {
        warnings.push(`${noteId}: unrecognized raw evidence prefix: ${sourcePath}`);
      }
    }

    for (const sourcePath of item.source_projection_paths || []) {
      if (pathHasPrefix(sourcePath, DERIVED_PREFIXES)) {
        errors.push(`${noteId}: derived path cannot be source projection: ${sourcePath}`);
      }
      if (!pathHasPrefix(sourcePath, SOURCE_PROJECTION_PREFIXES)) {
        warnings.push(`${noteId}: unrecognized source projection prefix: ${sourcePath}`);
      }
    }

    for (const derivedPath of item.derived_comparison_paths || []) {
      if (!pathHasPrefix(derivedPath, DERIVED_PREFIXES)) {
        warnings.push(`${noteId}: derived comparison path is outside known derived prefixes: ${derivedPath}`);
      }
    }

    validateSourceTime(item.source_time, errors, noteId);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function planCase(item) {
  const interviewNoteId = `xhs:${item.note_id}`;
  if (item.expected_disposition === 'boundary_review') {
    return {
      note_id: item.note_id,
      interview_note_id: interviewNoteId,
      action: 'boundary_review',
      create_issue: false,
      reason: item.purpose,
    };
  }

  return {
    note_id: item.note_id,
    interview_note_id: interviewNoteId,
    idempotency_key: interviewNoteId,
    action: 'create_or_reconcile_interview_note_issue',
    create_issue: true,
    machine_marker: `<!-- interview-note: id=${interviewNoteId} schema=interview-note-issue.v1 -->`,
    suggested_title: `[XHS] ${item.note_id}`,
    labels: ['type:interview-note', 'source:xhs', 'status:discovered'],
    source_time: item.source_time,
    raw_evidence_paths: item.raw_evidence_paths,
    source_projection_paths: item.source_projection_paths,
    derived_comparison_paths: item.derived_comparison_paths,
  };
}

function buildPlan(manifest) {
  const validation = validateManifest(manifest);
  if (!validation.ok) return { schema_version: 'xhs-migration-plan.v1', ok: false, ...validation, plans: [] };
  return {
    schema_version: 'xhs-migration-plan.v1',
    ok: true,
    errors: [],
    warnings: validation.warnings,
    source_repository: manifest.source_repository,
    plans: manifest.cases.map(planCase),
  };
}

function main(argv = process.argv) {
  const manifestPath = argv[2];
  if (!manifestPath) {
    process.stderr.write('Usage: node scripts/plan-xhs-migration.js <pilot-selection.json>\n');
    return 2;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
    const plan = buildPlan(manifest);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DERIVED_PREFIXES,
  RAW_PREFIXES,
  SOURCE_PROJECTION_PREFIXES,
  validateManifest,
  planCase,
  buildPlan,
  main,
};
