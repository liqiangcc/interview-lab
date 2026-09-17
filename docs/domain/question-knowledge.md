# Analysis / Answer layer

Derived knowledge records attached to `CanonicalQuestion` entries. Both record
types are versioned (`analysis.v1`, `answer.v1`), digest-pinned, and validated
by `scripts/validate-question-knowledge.js`.

## Analysis (`analysis.v1`)

Per-canonical-question analysis of what the interviewer is testing.

| field | meaning |
|---|---|
| `analysis_id` | `analysis:{canonical_question_id}` |
| `canonical_question_id` | must exist in the canonical index |
| `canonical_index_sha256` | digest of the canonical index this record was written against |
| `question_text` | verbatim copy of `canonical_text` (never rewritten) |
| `question_kind` | `knowledge` / `process` / `coding` / `project` / `scenario` / `non-question` |
| `interviewer_intent` | what the interviewer is probing |
| `expected_depth` | how deep a satisfactory answer goes |
| `mechanism` | how the underlying mechanism/topic actually works |
| `boundaries` | scope limits, common overclaims, version caveats |
| `common_mistakes` | array of failure modes |
| `follow_ups` | likely follow-up directions |
| `member_count` | how many source questions the canonical aggregates |

## Answer (`answer.v1`)

Prepared answer skeleton for the canonical question.

| field | meaning |
|---|---|
| `answer_id` | `answer:{canonical_question_id}` |
| `short_answer` | 1–2 sentence direct answer |
| `skeleton` | ordered answer outline (non-empty array) |
| `explanation` | full structured explanation |
| `example` | worked example or concrete illustration |

## Invariants

- `question_text` must equal `canonical_text` verbatim — analysis never rewrites
  the canonical wording.
- Both digests (`content_sha256`) cover all fields except the digest itself and
  are computed with the same stable-stringify recipe as manifests.
- One analysis and one answer per `canonical_question_id` (registry enforces
  uniqueness).
- Records are **general knowledge**, not source evidence: they must not claim a
  candidate's answer or interview outcome unless pinned to a source unit.
  `non-question` / `process` kinds carry `kind`-appropriate minimal content and
  should not be treated as knowledge questions.
