# SourceSequenceReview 审核与批准契约

## 目的

`SourceSequenceManifest` 是 Derived Extraction。结构 validator 可以证明它自洽，但不能证明 segmentation / ordering / type boundary 在语义上忠于 Raw Source。

因此 manifest 不能因为“文件存在且 schema PASS”就自动进入 sequential-learning trusted frontier。

需要独立的 `SourceSequenceReview`：

```text
Raw evidence
↓
SourceSequenceManifest candidate
↓
semantic review
↓
SourceSequenceReview decision
↓
只有 effective approved review
↓
checkpoint v2 可引用
```

## 分离原则

不要把 `approved=true` 写回 manifest 本体。

原因：

- manifest 的 `manifest_id + content_sha256` 应稳定表达序列定义本身；
- review 是另一个时间性的治理决定；
- 修改 segmentation 必须产生新的 manifest version/digest；
- 新 digest 不得继承旧 approval。

因此：

```text
Manifest identity
≠
Review identity
```

## SourceSequenceReview v1

核心字段：

```text
review_id
manifest_id
manifest_sha256
decision
reviewed_at
reviewer_kind
review_evidence
checks
limitations
supersedes_review_id
```

`decision`：

```text
approved
或
rejected
```

`review_evidence` 应定位到可审计的 review 记录。当前 GitHub Issue workflow 使用：

```text
repository
issue_number
comment_id
```

## Review checks

review check 名称是可扩展 machine identifier。

典型检查：

```text
evidence_stream_binding
sequence_scope
unit_boundaries
unit_order
unit_types
fragment_boundaries
fragment_order
no_fabrication
```

规则：

- `approved` 要求所有登记 check 都为 `pass`；
- `rejected` 至少需要一个显式 `fail`；
- review 不能通过省略问题来伪造 approval。

## Append-only decision chain

Review 决定采用 append-only chain，而不是 last-write-wins。

第一条：

```text
review-1
supersedes_review_id = null
```

如果以后发现问题：

```text
review-1 approved
↓
review-2 rejected
supersedes_review_id = review-1
```

如果问题修复且仍针对**同一个 exact digest**重新批准：

```text
review-2 rejected
↓
review-3 approved
supersedes_review_id = review-2
```

Registry 对同一：

```text
manifest_id + manifest_sha256
```

必须解析出且只解析出一个 effective head。

出现两个并行 head 时 fail closed，不能按文件名、时间或“最后读取到哪个”猜测。

## Digest 边界

Review 只覆盖 exact digest：

```text
manifest_id
+
manifest_sha256
```

如果 manifest 内容变化：

```text
旧 digest approval
≠
新 digest approval
```

即使 `manifest_id` 被错误复用，review registry 也不会把旧 approval 自动授予新内容。

正式流程仍要求 segmentation 修订创建新的 manifest version，而不是原地改写。

## Checkpoint v2 gate

`exploration-session-checkpoint.v2` 只有同时满足以下条件才可以 PASS：

```text
manifest registry 可解析 exact manifest
+
manifest digest 匹配
+
SourceUnit / SourceFragment binding PASS
+
SourceSequenceReview registry 可解析 exact digest
+
effective review.decision == approved
```

所以：

```text
Manifest schema PASS
≠
Manifest approved
```

## 边界

`SourceSequenceReview` 仍属于 Derived governance / review state。

Approval 不意味着：

- manifest 变成 Raw Source；
- SourceQuestion 自动创建；
- CanonicalQuestion / Analysis / Answer 自动修改；
- 自然语言 reasoning 自动通过 no-look-ahead semantic review。

它只授权 exact manifest digest 作为 sequential-learning 的 machine frontier contract。
