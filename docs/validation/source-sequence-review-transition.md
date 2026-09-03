# SourceSequenceReview transition 与 staleness 传播

状态：**PROMOTED / transition preflight + staleness impact gate**

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

这已经通过 PR #10 的 stale-head regression test 验证，提升为正式 HARD transition invariant。

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

该 HARD 语义不是仅由 impact analyzer 提示：v3 current checkpoint validator 本身要求 `source_review_id == 当前 effective approved review`，所以真实 review head 一旦变化，旧 active v3 session 的下一条写入会 fail closed。

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

因此：

```text
active-session staleness blocking
→ HARD

apply 前运行 impact preflight
→ 当前为 REVIEW
```

后者暂不提升为 HARD，因为正式写入新的 SourceSequenceReview 文件仍是一个独立仓库写操作，尚未与 transition preflight / impact snapshot 原子绑定。

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

## Promotion evidence

### PR #10

PR #10：`feat: preflight SourceSequenceReview transitions and staleness`

- merge commit：`f1941fa50753c854289d67219c70cbf0ab158c36`
- `node --test`：85 / 85 PASS
- transition planner fixture：PASS
- stale `expected_effective_review_id`：FAIL as expected
- duplicate review id / wrong digest / non-increasing review time：FAIL as expected
- proposed approved successor → old active v3=`active-stale`：PASS
- proposed rejected successor → active v3 + legacy active v2 blocked：PASS
- v1 / v2 / v3 regression：PASS

### Issue #3 live dry-run

先建立临时 active v3 dependency：

```text
comment 5523685741
session: explore-xhs-6508552c-20260903-review-impact-live-probe-01
pinned review: review-1
status: active
```

当前 checkpoint/history workflow：`33739671448` PASS。

随后提交 transition dry-run：

```text
comment: 5523693426
transition: xhs-6508552c-review-impact-live-dryrun-01
expected head: review-1
candidate head: review-live-dryrun-2
candidate decision: approved
```

transition workflow run：`33739732954` PASS。

真实 predicted impact：

```text
sessions = 4
blocking_sessions = 1
active_stale = 1
historical_superseded = 1
legacy_historical_unpinned = 2
```

其中：

```text
临时 active v3 / pin review-1
→ active-stale / HARD

已完成 v3 / pin review-1
→ historical-superseded / INFO

两个 completed legacy v2
→ legacy-historical-unpinned / INFO
```

最后仍使用正式 effective `review-1` 关闭临时 session：

```text
comment 5523702986
workflow 33739803838
→ current checkpoint PASS
→ full session history PASS
```

这证明 dry-run 没有把候选 `review-live-dryrun-2` 偷偷 apply 到正式 review registry。

## 已提升的规则

```text
I38 / HARD
review transition stale-head fail closed

I39 / HARD
active v3 session 一旦 pinned review 不再是当前 effective approved review，就 stale / blocked；不得原地换绑 review

I40 / REVIEW
正式 review mutation 前应运行 dependency impact preflight，显式审查 active / historical / legacy downstream sessions
```

## 仍未闭合的边界

当前真实 apply 路径仍是：

```text
transition dry-run PASS
↓
显式创建新的 SourceSequenceReview file
↓
review registry validator
```

也就是说，transition request / impact evidence 与最终 review-file mutation **尚未形成一个原子 machine operation**。当前工具可以发现 stale precondition，也可以预演影响，但仍无法阻止某个 writer 完全绕过 preflight，直接手工提交一个结构合法的新 review file。

因此下一阶段若继续 machine-enforcement，应建立：

```text
AppliedReviewTransition
或等价 operation record
↓
固定 transition_id
+ expected head
+ impact evidence identity/hash
+ produced review_id
↓
review file 必须证明来自已验证 transition
↓
再把 I40 从 REVIEW 提升为 HARD
```
