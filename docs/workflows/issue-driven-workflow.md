# Issue-Driven Workflow

## Purpose

Interview Lab uses GitHub Issues as the primary human/AI operational interface.

The architecture is intentionally:

```text
source-first data model
+
Issue-driven workflow
+
validator-guarded mutation
```

Issues make domain objects easy to discover, read, discuss, assign, and revisit. They do not make workflow metadata equivalent to source truth.

## Control plane and evidence plane

```text
GitHub Issues / Labels / Comments / Assignees
                │
                │ control, query, coordination
                ▼
        validated domain operations
                │
                ▼
Source artifacts / derived records / knowledge assets
```

For InterviewNote, immutable source artifacts remain the evidence root. The Issue is the operational document for that source case.

## One domain object, one primary Issue

The initial contract is:

```text
1 InterviewNote
↕ 1:1
1 primary GitHub Issue
```

A stable machine identity in the Issue body prevents Issue number, title, or human wording from becoming the domain identity.

Do not create a new Issue for every small action performed on the same InterviewNote. Recovery attempts, source reviews, and exploration history normally stay attached to the primary case Issue.

## Agent work loop

An AI agent should normally operate through this loop:

```text
1. Query Issues by type/status/task labels
2. Read the selected Issue
3. Resolve its stable domain identity
4. Read only the source evidence and derived data allowed for the current task
5. Produce an explicit observation or proposed operation
6. Run the appropriate validation / guarded mutation path
7. Persist the formal result
8. Synchronize Issue body or labels
9. Record a concise audit comment when a decision or exception matters
10. Stop or select the next Issue
```

The agent must not infer completion from labels alone.

## Read path

The preferred AI read path for an InterviewNote is:

```text
Issue
  ↓
machine identity
  ↓
source references
  ↓
current raw revision / limitations
  ↓
optional derived links relevant to the requested task
```

During sequential learning, the read path is further constrained by the no-look-ahead protocol. The fact that an AI can technically read the whole Issue does not authorize future source content to influence the current learning step.

## Write path

A write that changes formal state must be explicit.

Examples:

- register a new source revision
- record a source limitation
- resolve duplicate-source identity
- transition InterviewNote lifecycle state
- create or revise a SourceQuestion
- later, change CanonicalQuestion or Answer state

The Issue itself may be edited as an operational document, but formal mutation must respect the owning layer's contract and validator.

## Label synchronization

Labels are synchronized after a valid state transition.

```text
formal state
   ↓
projection
   ↓
Issue labels
```

If Issue labels drift from formal state, the repair direction is from validated state to labels, not the reverse.

## Comments as audit history

Comments are useful for:

- source review findings
- recovery attempts
- explicit uncertainty
- decisions requiring rationale
- exploration session summaries
- links to commits or generated reports

Comments are append-only history in spirit, but they are not immutable source evidence.

Do not put a corrected version of the original interview note in a comment and then treat that correction as the new Raw Source.

## Close and reopen

Issue close/reopen semantics are defined by the owning domain contract.

For `type:interview-note`:

- close means the source lifecycle has reached a stable source-ready completion state
- reopen only for source-layer reasons
- downstream knowledge or training changes continue without reopening the source case

## Concurrency and idempotency

Automation must assume that humans and multiple agents may inspect the same repository.

Minimum requirements:

- resolve by stable domain identity, never by title matching alone
- check current state before mutation
- make repeated migration/sync operations idempotent
- avoid duplicate Issues for the same InterviewNote
- fail closed when the expected source revision or identity changed
- do not overwrite a newer decision with a stale agent result

## What Issue-driven does not mean

It does not mean:

- every repository object must be stored only as an Issue
- large raw HTML or images belong in Issue bodies
- a label is a transaction authorization
- an Issue edit may rewrite immutable source artifacts
- an AI should consume all available context regardless of the current learning boundary

## Success criterion

Issue-driven workflow succeeds when a human or AI can start from a query such as:

```text
type:interview-note status:source-review
```

and safely perform the next bounded unit of work without losing source provenance, bypassing validation, or needing to reconstruct hidden workflow state from unrelated files.
