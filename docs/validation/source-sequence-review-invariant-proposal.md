# SourceSequenceReview machine gate 提案

状态：**PROPOSAL / approval gate proven, review-pinned history reproducibility pending v3 gate**

## 目标

把“reviewed SourceSequenceManifest”变成可机器证明的状态，同时保证后续 review 决定不会反向改写历史 checkpoint 当时的授权事实。

## 已验证的第一阶段

PR #8 已证明：

```text
SourceSequenceManifest exists
+
SourceSequenceReview registry
+
unique effective head
+
effective decision = approved
↓
当前 checkpoint 可以消费 manifest
```

Pilot #3 semantic review evidence：Issue #3 comment `5523241379`。

PR #8 merge commit：`d80c290cf302fadbcf4704f869f01eb34b522263`。

PR CI：66 / 66 tests PASS；review registry：1 review / 1 effective approval。

Live approval-backed v2 probe：Issue #3 comment `5523340520`，workflow run `33737062748`，current checkpoint + full history PASS。

## Promotion 前发现的版本 / 历史边界

v2 已经在真实 Issue 中产生历史 checkpoint，因此不能事后给 v2 增加必填 `source_review_id`。

同时，仅依赖“当前 effective review”会导致：

```text
T1 review-1 approved
T2 checkpoint created
T3 review-2 rejected
↓
如果 checkpoint 没 pin review identity
历史 T2 会被 T3 的当前治理状态重新解释
```

这违反历史输入固定与可复现原则。

因此正式 promotion 前增加新的 v3 contract，而不是原地修改 v2。

## 候选 HARD 约束

### Review identity 与 manifest 分离

```text
Manifest
→ 定义 SourceUnit / SourceFragment 序列

Review
→ 对 exact manifest digest 做审核决定
```

### Exact-digest approval

Review 绑定：

```text
manifest_id
+
manifest_sha256
```

新 digest 不继承旧 approval。

### Append-only review chain

同一 exact digest 的 review 通过 `supersedes_review_id` 形成显式 chain。

Registry 必须：

- review_id 唯一；
- supersedes 只指向同一 exact digest；
- 不允许 cycle；
- 只能有一个 effective head；
- 多个并行 head fail closed。

### Decision semantics

```text
approved
→ 所有登记 check 都 pass

rejected
→ 至少一个登记 check fail
```

### v2 — legacy compatibility

新写入 v2 仍要求 manifest 当前 effective review=`approved`。

历史 replay 对已存在 v2 不再使用“今天的 effective decision”反向判定过去，只保留：

```text
manifest / unit / fragment frontier validation
+
approval provenance unpinned warning
```

### v3 — pinned authorization

`exploration-session-checkpoint.v3` 在 manifest binding 上增加：

```text
source_review_id
```

Current write gate：

```text
pinned review exists
+
targets exact manifest digest
+
decision = approved
+
pinned review == current effective review
```

History replay gate：

```text
pinned review exists
+
targets exact manifest digest
+
decision = approved
```

后续 supersede/rejection 可以产生 current-trust warning，但不能把历史 checkpoint 改写成“当时从未被授权”。

同一 v3 session 的 `source_review_id` 必须稳定；review 发生变化后继续探索应开始新的 session。

## 最终 Promotion gate

只有同时满足：

```text
PR #8 approval registry gate PASS
+
follow-up v3 PR npm run check PASS
+
v1 / v2 regression PASS
+
v3 fixture PASS
+
v3 current effective-review tests PASS
+
v3 historical pinned-review reproducibility tests PASS
+
Issue #3 live review-pinned v3 checkpoint/history workflow PASS
```

才把本 proposal 提升为正式 HARD invariant。

## 不属于 machine proof 的部分

Review registry 能证明“哪个 review 是当前决定 / 哪个 review 当时授权了 checkpoint”，但不能仅靠 JSON 自动证明 reviewer 的语义判断一定正确。

因此仍保持：

```text
Raw evidence review
↓
Manifest semantic review
↓
Review decision registry
↓
Checkpoint current-write gate
+
Historical replay gate
```

每层职责不同。
