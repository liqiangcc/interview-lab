# Issue Label Taxonomy

## Purpose

Labels are the low-cardinality query and workflow index for Interview Lab.

They exist so humans and AI agents can quickly find the next relevant domain object without parsing every Issue body.

Labels are operational metadata. They are not sufficient proof of source integrity, knowledge validity, answer quality, or learner mastery.

## Design rules

1. Labels must be low-cardinality and reusable across many Issues.
2. Labels should describe orthogonal dimensions rather than encode several meanings in one string.
3. High-cardinality facts such as company, role, year, source id, technology, or canonical id belong in structured Issue content or generated indexes, not in the global label namespace.
4. Lifecycle labels are projections of validated state. Manually applying a lifecycle label must not bypass validators.
5. One Issue should normally have at most one active label from each mutually exclusive family.

## Core families

### Object type

```text
type:interview-note
type:canonical-question
```

The initial implementation should support `type:interview-note` first. Additional types are introduced only after their Issue contracts exist.

### Source

```text
source:xhs
source:nowcoder
source:maimai
source:manual
source:other
```

Source labels identify the source system, not the company interviewed.

### InterviewNote lifecycle

Exactly one active lifecycle label is expected while an InterviewNote Issue is open:

```text
status:discovered
status:captured
status:source-review
status:source-ready
status:blocked
```

Closing the Issue is an additional GitHub lifecycle event; it does not create a separate domain state beyond the source lifecycle contract.

### Source-quality signals

Use only when the condition is currently relevant:

```text
quality:source-incomplete
quality:image-missing
quality:text-truncated
quality:artifact-corrupt
quality:identity-conflict
quality:duplicate-source
quality:provenance-missing
```

Quality labels are review signals, not replacements for a recorded limitation or decision.

### Work intent

Use these when an Issue needs a specific next action beyond its lifecycle state:

```text
task:source-review
task:source-recovery
task:artifact-check
task:identity-review
```

Do not use task labels to represent durable domain facts.

### Priority

Optional operational priority:

```text
priority:P0
priority:P1
priority:P2
```

Priority is only for work scheduling. It must not be confused with question importance or interview frequency unless a later contract explicitly defines such semantics.

## Recommended InterviewNote combinations

Newly discovered source:

```text
type:interview-note
source:xhs
status:discovered
```

Captured and awaiting source integrity review:

```text
type:interview-note
source:xhs
status:source-review
task:source-review
```

Blocked by a missing image:

```text
type:interview-note
source:xhs
status:blocked
quality:image-missing
task:source-recovery
```

Source-ready before close:

```text
type:interview-note
source:xhs
status:source-ready
```

## Forbidden label patterns

Do not create unbounded taxonomies such as:

```text
company:alibaba
company:tencent
role:java-backend
year:2023
note:630e2e...
tech:redis
canonical:cq_...
```

These values grow with the data set and should live in structured fields or generated indexes.

Do not encode derived judgments as though they were source facts. For example, an AI guess that a note is a second-round interview must not become a source-level label that implies the original source explicitly said so.

## State transition rule

A lifecycle transition follows:

```text
requested operation
    ↓
domain/source validation
    ↓
validated state change
    ↓
Issue label synchronization
```

Not:

```text
manual label change
    ↓
assume domain state is valid
```

## Query intent

Labels should make queries such as these cheap and predictable:

```text
type:interview-note status:source-review

type:interview-note status:blocked quality:image-missing

type:interview-note source:xhs status:source-ready
```

The label system is successful when an AI agent can locate the next work item quickly while still needing the underlying Issue and source evidence to make substantive decisions.
