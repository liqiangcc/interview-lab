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

Title fields are conveniences for people. They are not authoritative domain identity.

## Machine marker

Every InterviewNote Issue must contain a stable hidden marker near the top:

```text
<!-- interview-note: id=<interview-note-id> schema=interview-note-issue.v1 -->
```

This marker is used for idempotent synchronization and duplicate detection.

## Body sections

Recommended order:

```text
Machine marker

Source identity
Raw title
Raw content
Raw artifacts
Capture metadata
Source notes / limitations
Derived data links
```

### Source identity

May include directly sourced or capture-level values such as:

- source system
- external source id
- original URL when available
- capture revision
- capture timestamp

### Raw content

Display the captured first-hand text faithfully.

Do not:

- rewrite awkward wording
- correct technical claims
- turn statements into questions
- insert missing content
- silently merge OCR and source body as though both were original text

When multiple source representations exist, label them explicitly.

### Raw artifacts

Link or reference immutable artifacts such as HTML, JSON, images, and hashes rather than copying very large payloads into the Issue body.

### Derived data links

Derived content must be clearly separated from first-hand material.

Examples:

- SourceQuestion count
- linked CanonicalQuestions
- exploration sessions
- analysis status

Derived content must never be visually presented as part of the original note.

## Labels

Labels are low-cardinality workflow indexes.

Initial taxonomy:

```text
type:interview-note
source:xhs

status:discovered
status:captured
status:source-review
status:source-ready
status:blocked

quality:source-incomplete
quality:image-missing
quality:text-truncated
quality:duplicate-source
```

Do not create high-cardinality labels for every company, year, role, note id, or technology.

## Comments

Comments record review observations, recovery attempts, decisions, and exploration history.

Comments must not be used to silently replace first-hand source content.

A correction to a derived interpretation belongs in the derived layer. A better source capture creates a new source revision.

## Close semantics

Closing an InterviewNote Issue means only:

> The first-hand source case has reached a stable source-ready state, or its terminal source limitation has been explicitly resolved according to policy.

It does not mean:

- all SourceQuestions are perfect
- CanonicalQuestion mapping is complete
- answers are ready
- the learner has mastered the case

## Reopen semantics

Reopen only for source-layer reasons such as:

- newly discovered missing source material
- wrong source identity
- corrupted artifact
- better source revision
- previously unnoticed truncation
- duplicate-source resolution

Downstream knowledge or training changes do not reopen the InterviewNote source lifecycle.

## Idempotency requirement

Migration and synchronization must query by stable InterviewNote identity / machine marker before creating an Issue.

Repeated runs must update the existing Issue projection rather than create duplicates.
