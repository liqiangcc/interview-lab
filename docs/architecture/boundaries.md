# Source and Knowledge Boundaries

## Purpose

This document defines the non-negotiable separation between first-hand interview material, derived interpretation, knowledge assets, training state, and GitHub workflow metadata.

The repository must remain reconstructable from source evidence even if downstream extraction, canonicalization, analysis, or answers later prove wrong.

## Layer 0 — Raw Source

Raw Source answers only one question:

> What did the original source actually contain?

Typical material:

- original page HTML or API response
- original title and body text
- original images and their order
- original source identifier and URL
- original publication metadata when directly present in the source
- capture timestamp
- content hashes and artifact metadata

### Rules

- Raw Source is immutable after capture.
- Never correct technical mistakes in the original material.
- Never rewrite awkward language.
- Never turn statements into questions at this layer.
- Never fill missing content with AI inference.
- A later, better capture creates a new source revision; it does not silently overwrite an old snapshot.

## Layer 1 — Derived Extraction

Derived Extraction answers:

> What can reasonably be extracted or inferred from the raw material?

Examples:

- OCR output
- extracted company / role / round when not explicit source metadata
- SourceQuestion candidates
- question boundaries
- whether a sentence is a question, answer fragment, narration, or noise
- interview sequence and follow-up candidates

Every derived record should preserve provenance back to Raw Source.

Derived data may be corrected or regenerated without modifying Raw Source.

## Layer 2 — Knowledge

Knowledge answers:

> What reusable interview knowledge can be built from one or more source records?

Examples:

- CanonicalQuestion
- alias / same / follow-up / parent-child / prerequisite relations
- question analysis
- standard answers
- evidence mappings
- real phrasing variants
- expected interview depth
- company / role / round patterns

Knowledge is explicitly revisable. It must never be treated as a reason to rewrite the first-hand source.

## Layer 3 — Training and Review

Training answers:

> What has the learner practiced, understood, missed, or internalized?

Examples:

- guided reading sessions
- mock interview sessions
- response-loop practice
- knowledge gaps
- review progress
- recall performance
- follow-up failures

Training state is personal and temporal. It does not change source facts or knowledge identity.

## GitHub Issues — Operational Surface

GitHub Issues provide the primary human/AI working interface.

They may act as an operational document store for domain objects such as InterviewNote and CanonicalQuestion, but they do not replace immutable raw artifacts.

Issues provide:

- readable case documents
- labels as queryable workflow indexes
- comments as review / decision history
- assignment and lifecycle management
- direct AI access

### Hard boundary

Issue edits, labels, comments, and close/reopen actions must not silently mutate Raw Source evidence.

## Allowed dependency direction

```text
Raw Source
    ↓
Derived Extraction
    ↓
Knowledge
    ↓
Training / Review
```

GitHub Issues may expose and coordinate all layers, but domain truth must retain its layer ownership.

## Forbidden flows

The following are prohibited:

- Derived Extraction overwriting Raw Source.
- CanonicalQuestion rewriting SourceQuestion wording.
- Answer content correcting the original interview note in place.
- AI-inferred metadata being presented as directly sourced fact.
- Labels being treated as sufficient proof of domain validity.
- A failed validator being bypassed by manually setting an Issue to `ready`.
- Future interview context influencing interpretation of an earlier learning step.
- Deleting old source revisions when a better capture is discovered.

## Core invariants

```text
Raw source stays fixed.
Understanding may deepen.
Derived knowledge may change.
Every derived claim must remain traceable to its source or evidence.
Future context must not influence current sequential interpretation.
```
