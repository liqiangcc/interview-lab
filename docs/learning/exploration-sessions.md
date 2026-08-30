# Exploration Sessions

## Purpose

A real interview note is not a one-time ETL input. It is a case that can be revisited repeatedly to deepen understanding, test response patterns, discover relations, and expose knowledge gaps.

`ExplorationSession` records one bounded pass over an InterviewNote or knowledge object without modifying Raw Source.

## Principle

```text
Source stays fixed.
Exploration accumulates.
Understanding may deepen or change.
```

Do not mark an InterviewNote as permanently "processed" merely because one exploration pass completed.

## Session target

A session should identify one primary target:

```text
InterviewNote
or
CanonicalQuestion
```

The initial implementation should prioritize InterviewNote sessions because real interview cases drive learning and later knowledge construction.

## Session modes

### Learning

AI incrementally explains the current source unit and observable reasoning structure.

Goal:

- recognize cues
- identify the current problem type
- activate relevant knowledge structure
- form a response skeleton
- understand why new input changes the interpretation

### Training

AI behaves closer to an interviewer and withholds explanation until an appropriate checkpoint.

Goal:

- test spontaneous recognition
- test response structure
- test follow-up handling
- reveal where the learner's response loop breaks

### Source analysis

Focuses on derived structure rather than learner performance.

Examples:

- SourceQuestion boundaries
- sequence segmentation
- follow-up candidates
- source ambiguity
- real phrasing variants

### Knowledge audit

Uses the source case to challenge existing knowledge assets.

Examples:

- Canonical mapping coverage
- Answer coverage of real source variants
- missing follow-up handling
- knowledge-boundary problems

## No-look-ahead constraint

For sequential InterviewNote exploration, every session has a revealed position.

At source position `N`, the session may use only:

```text
source units 1..N
+
prior knowledge allowed by the selected mode
```

It must not use source units `N+1..end` to explain, predict, or score the current step.

A later session may revisit earlier positions with more knowledge, but it should explicitly state that it is retrospective analysis rather than real-time simulation.

## Small-step interaction

Default granularity:

```text
one source input
→ one interpretation layer
→ pause/consume
→ next layer
```

Do not automatically dump literal meaning, intent, answer, follow-ups, and final analysis at once.

The purpose is to train a reusable mental path rather than maximize summary density.

## Suggested session record

A session may record:

```text
session_id
target_type
target_id
mode
started_at
source_revision_id
revealed_position
focus
observed_cues
classification
response_skeleton
plausible_followup_dimensions
new_findings
knowledge_gaps
relation_candidates
actions
completed_at
```

Not every field is required in the first implementation. The important properties are stable target identity, source revision, temporal order, and separation between observation and later action.

## Findings vs actions

A session may discover:

- possible SourceQuestion
- possible follow-up relation
- possible Canonical boundary issue
- missing Answer coverage
- learner weakness

Discovery does not itself authorize domain mutation.

Use:

```text
Exploration finding
    ↓
explicit review / domain operation
    ↓
validated state change
```

This prevents a conversational insight from silently becoming formal knowledge.

## Session history in Issues

The InterviewNote Issue is the natural entry point for exploration.

A concise session summary may be recorded as an Issue comment or linked artifact. It should identify:

- session/mode
- source revision
- revealed range
- key findings
- actions created

Do not append large repetitive AI transcripts to the Issue merely because they were generated. Preserve reusable findings, decisions, and learning checkpoints.

## Repeated passes

Useful passes may include:

```text
Pass A: experience the interview sequentially
Pass B: inspect question boundaries
Pass C: inspect sequence and follow-up structure
Pass D: map to CanonicalQuestions
Pass E: challenge Answers with real phrasing
Pass F: run mock interview / response-loop training
Pass G: revisit after knowledge improves
```

These are examples, not a required fixed order. Sessions remain purpose-bounded rather than being numbered as permanent lifecycle states.

## Completion semantics

An ExplorationSession can be complete.

An InterviewNote is not "fully explored forever".

New knowledge, new source revisions, new interview targets, or new learner weaknesses may justify another session later.

## Core invariant

```text
One session is bounded.
The source case remains reusable.
Future source context never leaks into current sequential interpretation.
Findings are not mutations until explicitly reviewed and applied.
Repeated practice should strengthen the interview response loop.
```
