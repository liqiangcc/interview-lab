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
effective approved review
↓
新的 sequential checkpoint 才可消费
```

## 分离原则

不要把 `approved=true` 写回 manifest 本体。

```text
Manifest identity
≠
Review identity
```

原因：

- manifest 的 `manifest_id + content_sha256` 稳定表达序列定义；
- review 是独立、时间性的治理决定；
- segmentation 修订产生新的 manifest version/digest；
- 新 digest 不继承旧 approval。

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

- `approved` 要求所有登记 check=`pass`；
- `rejected` 至少需要一个显式 `fail`；
- review 不能通过省略问题来伪造 approval。

## Append-only decision chain

Review 决定采用 append-only chain，而不是 last-write-wins。

```text
review-1 approved
↓
review-2 rejected
supersedes_review_id = review-1
↓
review-3 approved
supersedes_review_id = review-2
```

Registry 对同一 exact：

```text
manifest_id + manifest_sha256
```

必须解析出且只解析出一个 effective head。

出现两个并行 head时 fail closed，不能按文件名、时间或“最后读到哪个”猜测。

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

正式流程要求 segmentation 修订创建新的 manifest version，而不是原地改写。

## 为什么 checkpoint 还需要 pin review identity

仅在运行时查询“当前 effective review”仍不够。

假设：

```text
T1: review-1 approved
T2: checkpoint 使用 manifest
T3: review-2 rejected，supersede review-1
```

如果 checkpoint 只记录 manifest digest，而不记录当时授权它的 review，那么 T3 会让 T2 的历史输入被今天的治理状态反向重新解释。

因此需要区分：

```text
历史授权事实
vs
当前允许继续使用吗
```

这对应两个检查视角：

```text
current write gate
→ 必须使用当前 effective approved review

history replay gate
→ 必须证明当时 pin 的 review 存在、匹配 exact digest、且 decision=approved
→ 后续 supersede 不改写历史事实
```

## Checkpoint 版本边界

### v2 — 已发布 manifest-backed legacy contract

`exploration-session-checkpoint.v2` 已经产生真实历史 comment，因此不能事后新增必填字段。

v2：

```text
pins manifest_id + manifest digest
但不 pin source_review_id
```

新写入 v2 仍要求 manifest 当前 effective review=`approved`。

历史 replay 对 v2 保持兼容：验证 manifest/unit/fragment frontier，但只能发出“approval provenance 未 pin”的 warning；不得因为今天 review 状态变化而重写旧 v2 comment 的历史事实。

### v3 — review-pinned contract

`exploration-session-checkpoint.v3` 在 v2 基础上新增：

```text
source_review_id
```

新写入 v3 必须同时证明：

```text
pinned review 存在
+
pinned review targets exact manifest_id + digest
+
pinned review.decision = approved
+
pinned review == 当前 effective approved review
```

同一 v3 session 中 `source_review_id` 必须稳定；approval 发生变化后继续探索应新建 session，而不是静默切换授权来源。

历史 replay 则只要求 pinned review 本身当时是有效 approval；如果今天已经被 supersede，可给 stale/revoked warning，但不把历史 checkpoint 判成“从未合法”。

## 机器 gate 总结

```text
Manifest schema PASS
≠
Manifest approved

Current v3 checkpoint PASS
=
manifest binding PASS
+
pinned review PASS
+
pinned review is current effective approval

Historical v3 checkpoint PASS
=
manifest binding PASS
+
pinned review existed and was approved
```

## 边界

`SourceSequenceReview` 仍属于 Derived governance / review state。

Approval 不意味着：

- manifest 变成 Raw Source；
- SourceQuestion 自动创建；
- CanonicalQuestion / Analysis / Answer 自动修改；
- 自然语言 reasoning 自动通过 no-look-ahead semantic review。

它只授权 exact manifest digest 作为 sequential-learning 的 machine frontier contract。
