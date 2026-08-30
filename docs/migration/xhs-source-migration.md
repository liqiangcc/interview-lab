# XHS Source Migration Protocol

## Purpose

This document defines how historical material in `liqiangcc/xhs` is migrated into Interview Lab without converting historical AI interpretation into first-hand source facts.

Migration is source preservation first, not knowledge cleanup.

## Scope

Initial migration target:

```text
xhs InterviewNote source cases
    ↓
interview-lab InterviewNote identities
    ↓
one primary GitHub Issue per InterviewNote
    ↓
references to preserved source artifacts
```

SourceQuestion, CanonicalQuestion, Analysis, Answer, and training migration are later concerns and must not be silently bundled into source migration.

## Historical XHS layers

The old repository contains several generations of data. They must not be treated as equivalent.

### Source-evidence candidates

These are closest to first-hand captured material:

```text
note_detail/*.html
    captured page snapshots

downloaded_images/<note_id>/
    captured original images

note_images/*_urls.txt
    captured image references / ordering evidence when valid
```

The exact artifact type and provenance should be recorded during migration.

### Source projections

These may faithfully expose source content but are outputs of parsing/extraction and must remain traceable to source artifacts:

```text
note_json/*.json
note_desc/*.txt
```

Do not pretend a parser-generated text file is identical to the original bytes. It may be used as the readable Issue representation when its provenance is known and fidelity checks pass.

### Derived interpretation

These are downstream derived data and are not Raw Source:

```text
note_img_txt/*.txt     OCR / image interpretation
note_structured/*.json structured metadata and extracted questions
note_tagged/*.json     classified/tagged questions

data/questions/*       later Question / CanonicalQuestion data
review/*                later answers / review state
```

Derived data may be linked for later comparison, but it must not be copied into source sections as though the original author wrote it.

## Stable identity

Initial InterviewNote identity should derive from source system plus stable external source id, for example:

```text
interview_note_id = xhs:<note_id>
```

The exact encoded storage format may evolve, but the identity must remain stable and independent of:

- Issue number
- Issue title
- company inference
- role inference
- file path
- migration order

## One Issue per InterviewNote

Before creating an Issue, migration must search for the machine identity marker:

```text
<!-- interview-note: id=xhs:<note_id> schema=interview-note-issue.v1 -->
```

If the identity already exists, the migration must reconcile/update the existing projection rather than create another Issue.

Repeated migration must therefore be idempotent.

## Issue content rule

The migrated InterviewNote Issue should prioritize source material in this order:

1. stable source identity
2. directly captured source metadata when available
3. readable source text projection with provenance
4. raw artifact references and hashes
5. known capture limitations
6. clearly separated links to historical derived data

Do not promote values from `note_structured` or `note_tagged` into first-hand source facts merely because they are convenient.

For example, if `company=阿里钉钉` came from historical AI structuring rather than an explicit captured source field, it must remain derived unless source evidence independently supports it.

Issue titles may use derived display values for navigation when clearly treated as non-authoritative conveniences. Stable identity and source sections remain authoritative for provenance.

## Time ordering

After the pilot, full source migration should proceed from older to newer source time when source time is available.

Preferred ordering evidence:

1. directly captured source publication timestamp
2. directly captured partial source date/year
3. otherwise `unknown-time`

Do not infer a precise migration time from:

- Git commit time
- local file modification time
- capture time
- Issue number
- source id encoding unless the source contract explicitly defines that encoding as a publication timestamp
- AI inference from surrounding content

### Partial and unknown dates

Preserve uncertainty.

Examples:

```text
2023-08-02       exact source date
2023-08          source month known, day unknown
2023             source year known, month/day unknown
unknown          no defensible source time
```

Never invent `2023-01-01` merely to sort a year-only record.

A migration planner may use an internal stable sort key while preserving the actual partial date as partial.

Recommended full-migration order:

```text
known times: oldest → newest
partial times: ordered only to their defensible precision
unknown-time: separate backlog after known-time cases
```

Issue number records creation order only. It must never be treated as interview chronology.

## Pilot before full migration

Do not start full migration until the protocol and validators are exercised on a small pilot.

Initial pilot size:

```text
5 InterviewNotes
```

Select representative source conditions rather than optimizing for volume:

- text-dominant case
- image-dominant case
- mixed text + image case
- incomplete source case
- ambiguous/legacy-derived case

The pilot is a mechanism-validation exception; it does not establish permanent chronology. Once the mechanism passes, the full migration follows the source-time ordering rule.

## Pilot validation

For each pilot InterviewNote verify:

- stable identity resolves uniquely
- exactly one primary Issue exists
- machine marker is correct
- readable source content is faithful to referenced source artifacts
- source and derived sections are visibly separated
- missing source material remains missing/explicit rather than inferred
- labels match the lifecycle state
- repeated migration produces no duplicate Issue
- a second AI/human reader can locate the evidence root from the Issue alone
- no downstream knowledge modification is required to finish source migration

## Migration lifecycle

Recommended flow per InterviewNote:

```text
historical source discovery
        ↓
resolve stable identity
        ↓
register/source-check artifacts
        ↓
create or reconcile Issue
        ↓
status:captured
        ↓
source integrity review
        ↓
status:source-review
        ↓
source-ready or blocked
        ↓
close only when source lifecycle permits
```

## Derived-data preservation

Historical `note_structured`, `note_tagged`, Question, CanonicalQuestion, and Answer data remain valuable as prior derived work.

Do not discard them merely because they are not first-hand source.

Instead, later migration stages may use them as:

- candidate derived records
- regression comparisons
- extraction-review inputs
- knowledge migration inputs

They must always remain distinguishable from Raw Source.

## Fail-closed conditions

Do not create or mark a source-ready InterviewNote when:

- source identity is ambiguous
- available artifacts appear to belong to multiple notes
- readable text cannot be traced to a source artifact/projection
- expected artifacts are corrupted without an explicit limitation record
- migration would need AI invention to fill missing source content
- a duplicate InterviewNote identity already exists and ownership is unresolved

Use `status:blocked` and record the reason instead.

## Exit criteria for full migration readiness

Full chronological migration may begin only after:

1. Issue contract is stable
2. label taxonomy is stable
3. source revision policy is stable
4. migration is idempotent in the pilot
5. repository invariants/validators pass
6. pilot Issues are actually usable for AI source-first reading
7. no pilot finding requires changing the fundamental Raw/Derived boundary

## Core invariant

```text
Migration preserves evidence before interpretation.
Historical derived data stays derived.
Unknown stays unknown.
Identity is stable.
Migration is idempotent.
After pilot validation, full migration proceeds by defensible source chronology.
```
