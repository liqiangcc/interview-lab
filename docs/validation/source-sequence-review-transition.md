# SourceSequenceReview transition 与 staleness 传播

状态：**PROPOSAL / pending PR CI + live Issue #3 dry-run**

## 目标

`SourceSequenceReview` 已经是 append-only chain，但“怎样安全追加下一条 review”以及“review 变化会让哪些 session 过期”不能只靠人工记忆。

本契约把 review lifecycle operation 分成：

```text
观察当前 effective review
↓
构造 transition request
↓
CAS 式 precondition
↓
生成候选 review
↓
预演 session impact
↓
人工 / AI review
↓
显式写入新的 append-only review file
↓
registry validator
```

预检本身不修改正式 review chain。

## Transition request v1

Machine marker：

```text
<!-- source-sequence-review-transition
{ ... source-sequence-review-transition.v1 ... }
-->
```

核心字段：

```text
transition_id
manifest_id
manifest_sha256
expected_effective_review_id
new_review_id
decision
reviewed_at
reviewer_kind
review_evidence
checks
limitations
```

`expected_effective_review_id` 是并发 / stale-write 边界。

Planner 必须证明：

```text
manifest exact digest 可解析
+
expected_effective_review_id == 当前 effective head
+
new_review_id 尚不存在
+
reviewed_at 晚于当前 head
+
候选 SourceSequenceReview 本身合法
```

然后自动生成：

```text
supersedes_review_id = 当前 effective head
```

调用者不能通过 transition request 任意选择要 supersede 哪条旧 review。

如果在读取 head 后另一个 writer 已经推进 review chain：

```text
expected head != current head
↓
transition FAIL CLOSED
```

## Predicted staleness impact

Transition preflight 可以同时读取 InterviewNote Issue 的 ExplorationSession history，并把“候选 review 成为新 effective head”作为未来状态做 dry-run。

### v3 session

```text
active + pinned review == 新 effective approved review
→ active-current

active + pinned review != 新 effective review
→ active-stale / HARD

completed + pinned review != 新 effective review
→ historical-superseded / INFO
```

`active-stale` 不允许把旧 session 改绑到新 review；如果仍需要继续学习，应建立新的 v3 session。

如果新 effective decision=`rejected`：

```text
active v3
→ stale + blocked
```

直到出现新的 effective approved review。

### Legacy v2 session

v2 没有 pin `source_review_id`，因此不能恢复它当时具体由哪条 review 授权。

```text
completed v2
→ legacy-historical-unpinned / INFO

active v2 + 当前仍 approved
→ legacy-active-unpinned / REVIEW
→ 建议新开 v3 session

active v2 + 当前 rejected / missing approval
→ legacy-active-blocked / HARD
```

这不反向修改历史 v2 的真实性，只约束继续写入。

## 当前 write gate 与 impact analyzer 的关系

v3 current checkpoint validator 已经要求：

```text
source_review_id
==
当前 effective approved review
```

因此 review head 一旦改变，旧 active v3 session 的下一条 checkpoint 会自然 fail closed。

Impact analyzer 的职责不是重复这个 gate，而是提前回答：

> 如果这次 review transition 真正 apply，哪些下游 session 会 stale / blocked？

## Live preflight

仓库监听包含 `source-sequence-review-transition` marker 的 Issue comment：

```text
transition request
↓
读取当前 manifest / review registry
↓
transition planner
↓
读取当前 Issue 全量 ExplorationSession comments
↓
predicted staleness impact
↓
PASS | FAIL
```

该 workflow 只做 dry-run，不写新的 SourceSequenceReview 文件。

## Promotion gate

只有同时满足：

```text
PR npm run check PASS
+
transition CAS / stale-head tests PASS
+
review validation regression PASS
+
impact classification tests PASS
+
Issue #3 live active-v3 + dry-run successor review
    → predicted active-stale PASS
+
正式 review chain 未被 dry-run 修改
```

才把该机制提升为 HARD / REVIEW invariants。
