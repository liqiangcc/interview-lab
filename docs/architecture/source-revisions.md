# Source Revision Policy

## Purpose

A captured interview source may later be found incomplete, corrupted, or superseded by a better first-hand capture.

This document defines how Interview Lab improves source fidelity without rewriting history.

Core rule:

```text
old source evidence is never silently replaced
```

## InterviewNote identity vs SourceRevision identity

An `InterviewNote` is the stable identity of one real source case.

A `SourceRevision` is one immutable captured snapshot of that case.

```text
InterviewNote
├── SourceRevision 1
├── SourceRevision 2
└── ...
```

A new revision does not create a new InterviewNote unless investigation proves that the material belongs to a different source case.

## When to create a new revision

Create a new SourceRevision when new first-hand evidence changes the captured source representation, for example:

- a previously missing original image is recovered
- a full page snapshot replaces a truncated capture
- the original API/source payload is recovered
- a corrupted artifact is recaptured correctly
- a later capture includes source content that was genuinely unavailable in the earlier capture

Do not create a SourceRevision merely because:

- OCR improved
- question extraction changed
- company/role inference changed
- CanonicalQuestion mapping changed
- an Answer was corrected
- a learner gained a new interpretation

Those are downstream revisions.

## Immutable revision contents

A SourceRevision should identify its captured artifacts and source-level metadata through stable references such as:

```text
source_revision_id
interview_note_id
captured_at
source_external_id
source_url, when available
artifact ids
artifact hashes
capture method/version
known capture limitations
```

After registration, the artifacts and metadata that define that revision must not be silently edited in place.

## Preferred revision

Downstream extraction may use a designated preferred revision.

```text
InterviewNote
├── rev-1
└── rev-2  ← preferred for new extraction
```

`preferred` means "best current first-hand snapshot for downstream use". It does not invalidate or delete older evidence.

Changing the preferred revision requires explicit validation that the candidate revision belongs to the same InterviewNote and is suitable for downstream use.

## Revision lineage

When possible, record why a revision was added:

```text
supersedes: rev-1
reason: recovered missing original images 3-5
```

`supersedes` expresses preferred evidence progression, not deletion.

## Raw, deterministic projection, and derived interpretation

Keep these distinctions explicit:

```text
Raw artifact
→ captured first-hand bytes/content

Deterministic source projection
→ faithful extraction of source body/title/image order from a raw artifact

Derived interpretation
→ OCR interpretation, question extraction, metadata inference, relations, knowledge
```

A deterministic projection may be regenerated when the parser improves, provided it remains traceable to a specific immutable SourceRevision. Parser output must not be mislabeled as the original bytes.

OCR is always derived unless the source itself provides that text directly.

## Issue behavior

An InterviewNote Issue may display the preferred source representation for readability, but must expose enough revision identity to avoid pretending history never changed.

When a new SourceRevision becomes preferred:

1. reopen the Issue if it was closed
2. register the new immutable revision
3. record the source-level reason
4. run source integrity review
5. update the preferred revision reference
6. synchronize the Issue display
7. return to `source-ready` and close when valid

Do not delete the old revision from the source record.

## Downstream invalidation

A new preferred SourceRevision may make downstream data stale.

Examples:

- SourceQuestion source span changed
- previously missing content reveals additional questions
- sequence order changes because an image was missing

The source revision operation should not silently rewrite derived data. Instead it should mark or report downstream objects that require re-extraction or review.

## Concurrency rule

Any operation that depends on a specific SourceRevision should record or check the revision it used.

If current preferred source revision differs from the expected revision at mutation time, fail closed and re-evaluate against current evidence.

## Deletion policy

Source revisions are evidence and should not normally be deleted.

Exceptional removal requires an explicit policy reason such as legal/privacy obligations or a proven artifact that never belonged to the InterviewNote. Such removal must leave an auditable tombstone or decision record without preserving prohibited content.

## Core invariants

```text
InterviewNote identity is stable.
SourceRevision is immutable.
Better evidence appends history; it does not rewrite history.
Derived data names the revision it depends on.
A newer revision may invalidate downstream interpretation without altering older evidence.
```
