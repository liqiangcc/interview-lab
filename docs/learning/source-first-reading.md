# Source-First Sequential Reading

## Purpose

This learning protocol uses real interview notes to train an interview reasoning loop rather than memorize prepared answers.

The learner should experience the interview incrementally, as close as practical to the information available in a real interview.

## Core rule: no look-ahead

At step `N`, interpretation may use only:

```text
previously revealed interview context
+
current input
```

Future content in the same interview note must not influence the current interpretation.

This is a hard rule.

## Why

Real interviews are causal and incremental. The candidate does not know the next question in advance.

Allowing future context to leak backward trains retrospective explanation rather than real-time reasoning.

The target skill is:

```text
limited information
→ current judgment
→ response structure
→ new information
→ update judgment
```

## Learning granularity

Default to the smallest useful unit.

```text
one interview case
→ one input at a time
→ one interpretation layer at a time
```

Do not dump all layers of analysis at once.

For one input, progressively explore layers such as:

1. What does the current input literally say?
2. What kind of interview signal or question is this?
3. What knowledge area does it activate?
4. What answer structure should be recalled now?
5. What depth is justified by the current information?
6. What follow-up dimensions are plausible from the current state?

Only proceed when the current layer has been consumed sufficiently.

## Interview reasoning loop

Repeated practice should internalize this loop:

```text
Input
  ↓
Recognize
  ↓
Locate knowledge
  ↓
Infer current intent
  ↓
Build response skeleton
  ↓
Choose depth
  ↓
Anticipate plausible follow-up dimensions
  ↓
Receive new input
  ↓
Update
```

The goal is not to expose hidden chain-of-thought. The learning artifact is the observable reasoning structure: cues, classifications, response skeletons, boundaries, and updates.

## AI behavior

In learning mode, the AI should:

- reveal only the current source unit
- use only allowed historical context
- explain incrementally
- avoid giving the full answer too early
- distinguish source wording from derived interpretation
- point out which cues trigger which knowledge structure
- show how new information changes the previous interpretation
- pause at natural learning boundaries instead of racing through the note

The learner should not need to repeatedly type long prompts to maintain the protocol.

## Two modes

### Learning mode

AI explains incrementally while preserving no-look-ahead constraints.

Primary goal: build recognition and response structure.

### Training mode

AI withholds explanation and acts more like an interviewer.

Primary goal: test whether the response loop has been internalized.

Training mode may use real source sequences and real follow-up structures, but must still respect sequential reveal.

## Repeated passes

A real interview note is not permanently exhausted after one reading.

Later passes may focus on different derived dimensions:

- SourceQuestion boundaries
- interview sequence
- follow-up chains
- expected depth
- CanonicalQuestion mapping
- answer coverage
- knowledge gaps
- mock interview behavior

The raw source remains unchanged while understanding deepens.

## Session record

A useful ExplorationSession may record:

```text
case
revealed_position
focus
observed_cues
response_structure
new_findings
knowledge_gaps
follow-up candidates
actions
```

This allows repeated practice to become an auditable learning history without modifying the original interview note.

## Core invariant

```text
Source stays fixed.
Context grows only forward.
Understanding deepens one step at a time.
Practice builds a reusable interview response loop.
```
