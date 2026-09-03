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

// Historical pilot selection still contains reviewed interview occurrence hints.
// They remain valid pilot evidence, but SourceNote intake MUST NOT project them
// into SourceNote identity, labels, or creation chronology.
const LEGACY_TIME_FIELDS = ['source_published_at', 'source_edited_at', 'interview_occurred_at'];

function pathHasPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function validateTimeFact(fieldName, timeFact, errors, noteId) {
  if (!timeFact || typeof timeFact !== 'object') {
    errors.push(`${noteId}: ${fieldName} is required`);
    return;
  }
  const patterns = {
    exact: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
    month: /^\d{4}-\d{2}$/,
    year: /^\d{4}$/,
    month_day: /^\d{2}-\d{2}$/,
  };
  if (timeFact.precision === 'unknown') {
    if (timeFact.value !== null) errors.push(`${noteId}: unknown ${fieldName} must have value=null`);
    return;
  }
  const pattern = patterns[timeFact.precision];
  if (!pattern) {
    errors.push(`${noteId}: unsupported ${fieldName} precision ${timeFact.precision}`);
    return;
  }
  if (typeof timeFact.value !== 'string' || !pattern.test(timeFact.value)) {
    errors.push(`${noteId}: ${fieldName} value does not match ${timeFact.precision} precision`);
  }
}

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  if (!manifest || manifest.schema_version !== 'xhs-pilot-selection.v2') {
    errors.push('schema_version must be xhs-pilot-selection.v2');
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
      errors.push(`${noteId}: unsupported historical expected_disposition`);
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

    for (const field of LEGACY_TIME_FIELDS) validateTimeFact(field, item[field], errors, noteId);
    if (Object.prototype.hasOwnProperty.call(item, 'source_time')) {
      errors.push(`${noteId}: v2 manifest must not use ambiguous source_time`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function sourceCreationChronology(item) {
  const published = item && item.source_published_at;
  if (published
      && ['exact', 'month', 'year'].includes(published.precision)
      && published.value != null) {
    return { basis: 'source_published_at', time: published };
  }
  return { basis: 'unknown', time: { precision: 'unknown', value: null } };
}

function planCase(item) {
  const sourceNoteId = `xhs-note:${item.note_id}`;
  const plan = {
    note_id: item.note_id,
    source_note_id: sourceNoteId,
    idempotency_key: sourceNoteId,
    action: 'create_or_reconcile_source_note_issue',
    create_issue: true,
    machine_marker: `<!-- source-note: id=${sourceNoteId} schema=source-note-issue.v1 -->`,
    suggested_title: `[XHS Source] ${item.note_id}`,
    labels: [
      'type:source-note',
      'source:xhs',
      'status:captured',
      'boundary:pending',
      'task:boundary-review',
    ],
    source_published_at: item.source_published_at,
    source_edited_at: item.source_edited_at,
    creation_chronology: sourceCreationChronology(item),
    raw_evidence_paths: item.raw_evidence_paths,
    source_projection_paths: item.source_projection_paths,
    derived_comparison_paths: item.derived_comparison_paths,
    legacy_review_hint: {
      expected_disposition: item.expected_disposition,
      purpose: item.purpose,
      interview_occurred_at: item.interview_occurred_at,
      projected_to_source_note: false,
    },
  };
  return plan;
}

function buildPlan(manifest) {
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return {
      schema_version: 'xhs-source-note-pilot-plan.v1',
      ok: false,
      ...validation,
      plans: [],
    };
  }
  return {
    schema_version: 'xhs-source-note-pilot-plan.v1',
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
  LEGACY_TIME_FIELDS,
  validateManifest,
  sourceCreationChronology,
  planCase,
  buildPlan,
  main,
};
