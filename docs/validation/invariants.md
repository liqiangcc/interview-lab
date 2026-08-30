# Repository Invariants and Validation Gates

## Purpose

Interview Lab relies on AI-assisted, Issue-driven workflows. Therefore important boundaries must be enforceable as invariants rather than existing only as prose conventions.

This document defines the initial repository-wide invariants that future validators, migration commands, and CI must enforce or report.

## Validation philosophy

```text
Source evidence
    ↓
explicit operation
    ↓
validation
    ↓
state/projection update
```

When an invariant cannot be proven, fail closed or report the object as unresolved. Do not repair uncertainty by guessing.

## Severity

- **HARD** — violation blocks the formal operation or readiness transition.
- **REVIEW** — violation/signals require explicit review before progression.
- **INFO** — diagnostic information that does not by itself block state.

## Source identity invariants

### I1 — Stable InterviewNote identity — HARD

Every InterviewNote has exactly one stable machine identity independent of Issue number, title, display metadata, and file path.

For XHS migration the initial identity is based on source system + external note id.

### I2 — One primary Issue per InterviewNote — HARD

A stable InterviewNote identity must resolve to at most one primary `type:interview-note` Issue.

Migration/sync must detect an existing machine marker before creating a new Issue.

### I3 — Issue marker matches the domain object — HARD

The InterviewNote Issue must contain a valid machine marker and its identity must agree with all formal references used by migration or synchronization.

## Raw source invariants

### I4 — Raw evidence is not overwritten by derived interpretation — HARD

OCR, SourceQuestion extraction, metadata inference, CanonicalQuestion, Analysis, Answer, or Review must never silently replace captured Raw Source.

### I5 — Raw artifact provenance is resolvable — HARD

Every artifact treated as first-hand evidence must have enough information to locate and identify it, including content identity/hash when the storage contract supports hashing.

### I6 — SourceRevision immutability — HARD

Once a SourceRevision is registered, changing its defining captured artifacts/content creates a new revision rather than mutating the existing revision in place.

### I7 — Preferred revision belongs to the same InterviewNote — HARD

A preferred source revision must resolve to the same InterviewNote identity and pass source-integrity validation.

### I8 — Unknown remains unknown — HARD

Missing source facts must not be replaced by invented precision.

Examples:

- unknown date must not become an arbitrary exact date
- absent image text must not be fabricated
- inferred company/round must not be presented as directly sourced metadata

## Raw / Derived separation invariants

### I9 — Derived records preserve provenance — HARD

A derived record that makes a source-grounded claim must be traceable to the InterviewNote and, where practical, the SourceRevision/source span/artifact that produced it.

### I10 — OCR is derived unless directly sourced — HARD

OCR output must not be displayed or stored as though the original source itself contained that textual representation.

### I11 — Historical XHS derived data stays derived — HARD

During migration, `note_structured`, `note_tagged`, Question, CanonicalQuestion, Answer, and other historical downstream outputs must not be promoted to Raw Source solely because they already exist.

## InterviewNote lifecycle invariants

### I12 — Source-ready has a bounded meaning — HARD

`source-ready` proves source identity, captured evidence, known limitations, and provenance only.

It must not require or imply completed SourceQuestion extraction, Canonical mapping, Answer readiness, or learner mastery.

### I13 — Closed InterviewNote requires source-ready completion — HARD

A normal completed InterviewNote Issue may be closed only when its source lifecycle meets the source-ready completion contract.

A terminal non-completion close, if later supported, must use an explicit reason/state contract rather than pretending to be source-ready.

### I14 — Reopen only for source-layer reasons — REVIEW

Knowledge, Answer, or training changes do not reopen a completed InterviewNote source lifecycle. A reopen should identify a source-level reason such as new evidence, truncation, corruption, identity conflict, or duplicate-source remediation.

## Label invariants

### I15 — Labels are projections, not proof — HARD

A manually present `status:*` label is not sufficient evidence that the corresponding domain preconditions are satisfied.

Validators must assess the underlying Issue/source state.

### I16 — Lifecycle label cardinality — HARD

An open InterviewNote Issue must not simultaneously carry contradictory lifecycle labels such as both `status:captured` and `status:source-ready`.

### I17 — High-cardinality facts do not expand the label namespace — REVIEW

Company, role, year, note id, technology, CanonicalQuestion id, and similar unbounded values should not be encoded as global labels without a new explicit taxonomy decision.

## Issue content invariants

### I18 — Source and derived sections are distinguishable — HARD

The readable Issue representation must not visually merge AI/derived interpretation into the first-hand source body.

### I19 — Large artifacts are referenced, not rewritten into a new source — REVIEW

HTML, images, and other large artifacts should remain in their evidence storage and be referenced from the Issue. A human-readable projection may be shown, but its provenance must remain clear.

### I20 — Issue title is non-authoritative — HARD

Issue title text may aid navigation but must never be the only identity or provenance carrier.

## Sequential learning invariants

### I21 — No look-ahead — HARD for sequential mode

At revealed position `N`, a learning/training session may use only previously revealed source context plus the current input. Future source units must not influence current interpretation.

### I22 — Session names source revision and revealed position — REVIEW

A reproducible sequential ExplorationSession should identify the source revision and current revealed position/range.

### I23 — Exploration finding is not mutation authorization — HARD

A conversational finding or AI suggestion does not directly mutate SourceQuestion, relation, CanonicalQuestion, or Answer state. It becomes a candidate for the owning domain operation/review path.

## Migration invariants

### I24 — Migration is idempotent — HARD

Running migration/synchronization repeatedly for the same InterviewNote must not create duplicate Issues or duplicate stable identities.

### I25 — Migration preserves source chronology uncertainty — HARD

Migration ordering may use only defensible source time precision. Internal sort keys must not be persisted as invented source dates.

### I26 — Issue number is not chronology — HARD

Issue creation number/order must never be used as the authoritative interview/source timestamp.

### I27 — Full migration requires pilot gate — HARD

Full historical XHS migration must not begin until the documented pilot exit criteria pass.

## Concurrency invariants

### I28 — Stale source-dependent writes fail closed — HARD

If an operation was reviewed against SourceRevision `R` and the relevant preferred/source state has changed before commit, the operation must be re-evaluated rather than blindly applied.

### I29 — Duplicate identity conflict blocks ownership mutation — HARD

If multiple Issues or source records claim the same stable InterviewNote identity, automated progression must stop until ownership is explicitly resolved.

## Initial validator groups

Future tooling should expose bounded checks rather than one opaque all-purpose validator.

Recommended groups:

```text
validate identity
validate source
validate revisions
validate issues
validate labels
validate lifecycle
validate migration
validate exploration
validate all
```

`validate all` should aggregate the bounded checks and return a machine-readable report.

## Minimum pilot gates

Before creating more than the pilot InterviewNotes, require at least:

```text
identity uniqueness            PASS
Issue marker consistency       PASS
source artifact traceability   PASS
Raw/Derived separation         PASS
label consistency              PASS
source lifecycle consistency   PASS
migration idempotency          PASS
no invented source precision   PASS
AI can navigate Issue → evidence root PASS
```

## Evidence over counts

Aggregate counts do not prove integrity.

For example:

```text
5 Issues created
```

is not a successful pilot if one Issue duplicates an identity or displays OCR as original source text.

Completion requires invariant-level evidence.

## Core invariant set

```text
Preserve first-hand evidence.
Keep identity stable.
Keep Raw and Derived separate.
Make uncertainty explicit.
Use Issues to drive work, not bypass validation.
Keep sequential learning causal.
Make migration idempotent.
Fail closed on stale or ambiguous state.
```
