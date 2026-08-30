# Interview Lab

Interview Lab is a source-first lab for learning from real interview experiences.

The repository treats real interview notes as first-hand evidence, then derives questions, knowledge, answers, and training material from that evidence without rewriting the source.

## Core flow

```text
Real Interview Note
        ↓
SourceQuestion
        ↓
CanonicalQuestion
        ↓
Analysis
        ↓
Answer
        ↓
Training / Review
```

## Core principles

1. **Real interview notes are first-hand material.** Preserve what the source actually contained before interpreting it.
2. **Raw source is immutable.** Downstream knowledge may evolve; captured source evidence must not be silently rewritten by later understanding.
3. **Derived knowledge is separated from source evidence.** OCR, question extraction, canonicalization, analysis, answers, and review state are derived layers.
4. **One real interview note is one primary case.** A GitHub Issue can act as the AI/human working surface for that case.
5. **Issue-driven workflow, source-grounded truth.** Issues, labels, comments, and assignments organize work; immutable source artifacts remain the evidence root.
6. **No look-ahead during learning.** When interpreting an interview sequentially, the current step may only use previously revealed context plus the current input.
7. **Learn incrementally.** Read one case at a time, one input at a time, one layer at a time, and repeatedly deepen understanding.
8. **The goal is a response loop, not answer memorization.** Practice recognizing intent, locating knowledge, structuring a response, anticipating follow-ups, and updating reasoning as new information arrives.

## Repository domains

- **Source** — raw interview notes, source revisions, and immutable evidence.
- **Extraction** — OCR, SourceQuestion extraction, metadata inference, and structural interpretation.
- **Knowledge** — CanonicalQuestion, relations, analysis, answers, evidence, and derived insights.
- **Training** — guided reading, exploration sessions, mock interviews, review progress, knowledge gaps, and repeated practice.
- **Issues** — AI/human operational interface and workflow control plane.

## Foundation documents

### Architecture and domain

- `docs/architecture/boundaries.md` — Raw / Derived / Knowledge / Training ownership boundaries.
- `docs/architecture/source-revisions.md` — immutable source revision and preferred-revision policy.
- `docs/domain/model.md` — stable domain objects and identities.

### GitHub Issue control plane

- `docs/issues/interview-note-issue.md` — one InterviewNote ↔ one primary Issue contract.
- `docs/issues/label-taxonomy.md` — low-cardinality workflow/query labels.
- `docs/workflows/interview-note-lifecycle.md` — source-only lifecycle and close/reopen semantics.
- `docs/workflows/issue-driven-workflow.md` — AI/human work loop and validator-guarded mutation rules.

### Learning

- `docs/learning/source-first-reading.md` — incremental no-look-ahead reading protocol.
- `docs/learning/exploration-sessions.md` — repeated bounded passes over the same real interview case.

### Migration and validation

- `docs/migration/xhs-source-migration.md` — historical XHS source classification, idempotent migration, pilot, and chronological migration policy.
- `docs/validation/invariants.md` — initial hard/review invariants and future validator groups.

## Current phase — protocol first

Do not begin full historical source migration yet.

Current sequence:

```text
freeze boundaries and protocols
        ↓
implement Issue/schema/validator mechanics
        ↓
5-case representative pilot
        ↓
use the pilot with real AI source-first reading
        ↓
review and repair the mechanism
        ↓
pass pilot invariants
        ↓
full XHS migration by defensible source chronology
```

The pilot is successful only when the mechanism preserves first-hand evidence, keeps Raw and Derived separate, is idempotent, and supports real sequential AI-assisted learning without future-context leakage.
