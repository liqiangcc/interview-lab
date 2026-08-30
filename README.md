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

- **Source** — raw interview notes and immutable evidence.
- **Extraction** — OCR, SourceQuestion extraction, metadata inference, and structural interpretation.
- **Knowledge** — CanonicalQuestion, relations, analysis, answers, evidence, and derived insights.
- **Training** — guided reading, mock interviews, review progress, knowledge gaps, and repeated practice.
- **Issues** — AI/human operational interface and workflow control plane.

## Foundation documents

- `docs/architecture/boundaries.md`
- `docs/domain/model.md`
- `docs/issues/interview-note-issue.md`
- `docs/workflows/interview-note-lifecycle.md`
- `docs/learning/source-first-reading.md`

The first implementation milestone is to freeze these boundaries before migrating historical XHS interview notes into GitHub Issues.