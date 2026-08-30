# Domain Model

## Purpose

This document defines the core domain objects without committing the repository to a specific database implementation.

The model is source-first: reusable knowledge and training state are derived from real interview material while preserving provenance.

## InterviewNote

Represents one real interview-note case from one source.

Responsibilities:

- stable identity for one source case
- reference to immutable raw artifacts
- source provenance
- source revisions
- operational Issue linkage

It must not own canonical knowledge or corrected technical interpretation.

## SourceArtifact

Represents one captured piece of source evidence.

Examples:

- HTML snapshot
- API JSON snapshot
- original text export
- image
- video/audio when applicable

Recommended identity fields:

- artifact id
- interview note id
- source revision
- content type
- content hash
- capture timestamp
- storage reference

## SourceQuestion

Represents a question-like unit derived from one InterviewNote.

Important properties:

- original wording or exact source span
- source location / provenance
- sequence position
- extraction status
- interpretation confidence when applicable

A SourceQuestion is not rewritten into a polished knowledge question.

## QuestionRelation

Represents an explicit relation between SourceQuestions and/or CanonicalQuestions.

Potential relation types include:

- same
- alias
- follow-up
- parent-child
- prerequisite
- contrast
- related

Relations are derived decisions, not raw facts unless the source explicitly establishes them.

## CanonicalQuestion

Represents a reusable interview-knowledge identity that may aggregate one or more SourceQuestions.

Responsibilities:

- stable knowledge boundary
- source variant membership
- relationship ownership
- link to analysis and answer assets

Canonicalization must preserve reverse traceability to every contributing SourceQuestion and InterviewNote.

## Analysis

Represents derived reasoning about a CanonicalQuestion.

Examples:

- what the interviewer is testing
- expected answer depth
- mechanism decomposition
- boundaries and trade-offs
- common confusion
- likely follow-up dimensions

Analysis may evolve independently of the source.

## Answer

Represents a prepared response to a CanonicalQuestion.

An Answer may include:

- short conclusion
- one-minute structure
- deeper explanation
- boundaries / version constraints
- examples
- follow-up answers
- source/evidence references

Answer correctness must be judged against external technical evidence and source variants, not by rewriting first-hand interview material.

## ExplorationSession

Represents one pass of AI/human exploration over an InterviewNote or CanonicalQuestion.

Useful fields:

- session id
- target object
- timestamp
- focus
- revealed source position
- findings
- new relation candidates
- knowledge gaps
- actions produced

Exploration is appendable and repeatable. A case is never considered permanently exhausted merely because one pass completed.

## ReviewProgress

Represents training state for a learner against a knowledge object or interview case.

Examples:

- recall status
- last reviewed time
- response quality
- failed follow-ups
- weak dimensions
- next review suggestion

ReviewProgress is not source truth and must not modify source or knowledge identity.

## Object graph

```text
InterviewNote
   ├── SourceArtifact*
   └── SourceQuestion*
            │
            ├── QuestionRelation*
            │
            ▼
      CanonicalQuestion
            ├── Analysis
            ├── Answer
            └── ReviewProgress

InterviewNote / CanonicalQuestion
            └── ExplorationSession*
```

## Identity rule

Every long-lived domain object must have a stable machine identity independent of GitHub Issue number, title, file path, or display text.

GitHub Issue numbers are locators in the operational interface, not domain identities.
