# InterviewNote Lifecycle

## Purpose

The InterviewNote lifecycle governs only first-hand source capture and source integrity.

It must not absorb downstream extraction, canonicalization, answer production, or learner review.

## State machine

```text
discovered
    ↓
captured
    ↓
source-review
    ├──→ blocked
    │       ↓
    │   source recovered
    │       ↓
    └──── source-review
            ↓
       source-ready
            ↓
          closed
```

## discovered

The source case is known, but first-hand material has not yet been captured sufficiently.

Examples:

- only a source id is known
- only a URL or search hit is available
- title exists but source body/artifacts are missing

Expected label:

```text
status:discovered
```

## captured

The available first-hand material has been captured and stored or referenced.

Capture completion is not review completion.

Expected label:

```text
status:captured
```

From this point, captured source revisions are immutable.

## source-review

Review only source integrity and provenance.

Typical checks:

- source id and artifacts belong to the same case
- body is not unexpectedly truncated
- image set and order are complete or limitations are recorded
- artifact hashes and references are valid
- duplicate captures are identified
- encoding or extraction damage is detected

Do not evaluate technical correctness or canonical knowledge at this stage.

Expected label:

```text
status:source-review
```

## blocked

Use `blocked` when source integrity cannot currently be resolved.

Examples:

- missing images cannot be recovered
- only secondary retelling remains
- source identity conflicts
- artifact is corrupted
- required source provenance is unavailable

Never fabricate missing source content to unblock the lifecycle.

Expected labels:

```text
status:blocked
quality:<specific-source-problem>
```

## source-ready

A source is source-ready when:

- source identity is stable
- available raw material is preserved
- known missing material is explicitly recorded
- provenance is sufficient for downstream use
- no unexplained source-level integrity problem remains

`source-ready` means only that the source can be used as a stable first-hand input.

It does not imply that extracted questions, canonical mappings, answers, or training state are complete.

Expected label:

```text
status:source-ready
```

## closed

Close the Issue after it reaches `source-ready` and the source lifecycle is complete.

A closed InterviewNote Issue remains a first-class readable case and may continue to participate in downstream exploration and knowledge construction.

## Reopen policy

Reopen for source-layer changes only.

Valid reasons include:

- a more complete original snapshot is recovered
- an artifact was linked to the wrong source note
- hidden truncation is discovered
- source identity must be corrected
- duplicate-source resolution changes ownership

Do not reopen because:

- a SourceQuestion was extracted incorrectly
- a CanonicalQuestion boundary changes
- an Answer becomes outdated
- the learner fails a mock interview

## Revision rule

A better capture produces a new immutable source revision.

```text
InterviewNote
├── source revision 1
└── source revision 2
```

The newer revision may become preferred for downstream use, but the earlier captured evidence remains available for audit.
