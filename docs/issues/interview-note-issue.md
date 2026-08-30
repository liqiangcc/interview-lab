# InterviewNote Issue Contract

## Purpose

A real interview note is managed through one primary GitHub Issue.

```text
1 InterviewNote
↕ 1:1
1 GitHub Issue
```

The Issue is the main AI/human operational document for that case. Immutable raw artifacts remain the evidence root.

## Title

Recommended form:

```text
[XHS] <company-or-unknown> · <role-or-unknown> · <round-or-unknown> · <year-or-unknown> · <short-source-id>
```

Title fields are conveniences for people. They are not authoritative domain identity or first-hand source facts unless independently supported by source evidence.

## Machine marker

Every InterviewNote Issue must contain a stable hidden marker near the top:

```text
<!-- interview-note: id=<interview-note-id> schema=interview-note-issue.v1 -->
```

This marker is used for idempotent synchronization and duplicate detection.

Issue number, title, and creation order must never replace this stable identity.

## Body sections

Recommended order:

```text
Machine marker

Source identity
Raw / captured source representation
Raw artifacts
Capture and revision metadata
Known source limitations
Derived data links
```

### Source identity

May include directly sourced or capture-level values such as:

- source system
- external source id
- original URL when available
- source revision id
- capture timestamp

When a display field such as company, role, round, or year is inferred rather than directly sourced, keep that distinction explicit.

### Raw / captured source representation

Display the captured first-hand text faithfully, or a clearly identified deterministic source projection that is traceable to an immutable SourceRevision.

Do not:

- rewrite awkward wording
- correct technical claims
- turn statements into questions
- insert missing content
- silently merge OCR and source body as though both were original text
- promote historical AI-structured fields into Raw Source without source evidence

When multiple source representations exist, label them explicitly.

### Raw artifacts

Link or reference immutable artifacts such as HTML, captured JSON/source payloads, images, and content hashes rather than copying very large payloads into the Issue body.

The Issue must provide enough information for an AI/human reviewer to navigate back to the evidence root.

### Capture and revision metadata

Identify the SourceRevision represented by the Issue and, when applicable, the currently preferred revision.

Source revision semantics are defined in:

```text
docs/architecture/source-revisions.md
```

### Known source limitations

Record source-level limitations explicitly, for example:

- original image missing
- body capture truncated
- publication time unavailable
- source URL unavailable

Missing information must remain missing rather than being repaired by AI inference.

### Derived data links

Derived content must be clearly separated from first-hand material.

Examples:

- OCR
- SourceQuestion count / records
- linked CanonicalQuestions
- exploration sessions
- analysis status

Derived content must never be visually presented as part of the original note.

## Labels

The canonical label taxonomy is defined only in:

```text
docs/issues/label-taxonomy.md
```

This Issue contract does not maintain a second independent label list.

At minimum an InterviewNote Issue uses:

```text
type:interview-note
source:<source>
status:<source-lifecycle-state>
```

Additional quality/task/priority labels must follow the taxonomy SSOT.

Labels are workflow/query projections. Their presence does not by itself prove source validity or authorize a lifecycle transition.

## Comments

Comments record review observations, recovery attempts, decisions, and exploration history.

Comments must not be used to silently replace first-hand source content.

A correction to a derived interpretation belongs in the derived layer. A better source capture creates a new SourceRevision.

Exploration comments should preserve reusable findings and checkpoints rather than dumping large repetitive AI transcripts.

## Close semantics

Closing an InterviewNote Issue normally means only:

> The first-hand source case has reached a stable `source-ready` state under the source lifecycle and validation contracts.

It does not mean:

- all SourceQuestions are perfect
- CanonicalQuestion mapping is complete
- answers are ready
- the learner has mastered the case
- the InterviewNote can never be explored again

## Reopen semantics

Reopen only for source-layer reasons such as:

- newly discovered missing source material
- wrong source identity
- corrupted artifact
- better SourceRevision
- previously unnoticed truncation
- duplicate-source resolution

Downstream knowledge or training changes do not reopen the InterviewNote source lifecycle.

## Idempotency requirement

Migration and synchronization must query by stable InterviewNote identity / machine marker before creating an Issue.

Repeated runs must reconcile the existing Issue projection rather than create duplicates.

If multiple primary Issues claim the same stable identity, automated progression must fail closed until ownership is resolved.

## Validation references

The Issue must remain consistent with:

```text
docs/architecture/boundaries.md
docs/architecture/source-revisions.md
docs/issues/label-taxonomy.md
docs/workflows/interview-note-lifecycle.md
docs/workflows/issue-driven-workflow.md
docs/validation/invariants.md
```
