# SourceSequenceReview machine gate — Promotion Record

状态：**PROMOTED / HARD machine gate**

本文件保留从 proposal 到正式 machine-enforcement 的 promotion 证据；文件名保留 `proposal` 仅用于历史可追踪性。

## 目标

把“reviewed SourceSequenceManifest”变成可机器证明的状态，同时保证后续 review 决定不会反向改写历史 checkpoint 当时的授权事实。

## 正式 HARD 约束

### Review identity 与 manifest 分离

```text
Manifest
→ 定义 SourceUnit / SourceFragment 序列

Review
→ 对 exact manifest digest 做审核决定
```

Approval 不写回 manifest 本体。

### Exact-digest approval

每个 review 固定：

```text
manifest_id
+
manifest_sha256
```

新 digest 不继承旧 approval。

### Append-only review chain

同一 exact digest 的 review 通过 `supersedes_review_id` 形成显式 chain。

Registry 必须：

- `review_id` 唯一；
- supersedes 只指向同一 exact digest；
- 不允许 cycle；
- 只能有一个 effective head；
- 多个并行 head fail closed。

Decision semantics：

```text
approved
→ 所有登记 check 都 pass

rejected
→ 至少一个登记 check fail
```

### v2 — 已发布 legacy compatibility

`exploration-session-checkpoint.v2` 已有真实历史，因此 contract 不原地改变。

新写入 v2 仍要求 manifest 当前 effective review=`approved`。

历史 replay 对 v2 只证明 manifest / unit / fragment frontier，并显式 warning：approval provenance 未 pin。后续 review 状态变化不得反向把旧 v2 comment 改写成“历史上从未发生”。

### v3 — review-pinned authorization

`exploration-session-checkpoint.v3` 在 manifest binding 上固定：

```text
source_review_id
```

Current write gate：

```text
pinned review exists
+
targets exact manifest_id + digest
+
decision = approved
+
pinned review == current effective review
```

History replay gate：

```text
pinned review exists
+
targets exact manifest_id + digest
+
decision = approved
```

后续 supersede/rejection 只能更新“当前信任状态”，不能改写历史 checkpoint 当时 pin 的授权事实。

同一 v3 session 中 `source_review_id` 必须稳定；effective review 变化后如需继续探索，应新建 session。

## Promotion evidence

### Semantic review

Pilot #3 SourceSequenceManifest semantic review：Issue #3 comment `5523241379`。

Review target：

```text
manifest_id:
xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1

manifest_sha256:
829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad
```

Decision：`approved`。

Machine review record：

```text
review_id:
xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1
```

### PR #8 — approval registry gate

PR #8：`feat: require approved SourceSequenceManifest reviews`

- merge commit：`d80c290cf302fadbcf4704f869f01eb34b522263`
- repository check：PASS
- `node --test`：66 / 66 PASS
- SourceSequenceReview registry：1 review / 1 effective approval
- missing/rejected approval fail-closed tests：PASS
- live approval-backed v2 probe：Issue #3 comment `5523340520`
- workflow run：`33737062748` — current checkpoint + full history PASS

### PR #9 — historical reproducibility / v3 gate

PR #9：`fix: pin SourceSequenceReview in checkpoint v3`

- merge commit：`bbc93e191e9397665af25306e4b86cc3a7362fae`
- repository check：PASS
- `node --test`：76 / 76 PASS
- v1 regression：PASS
- v2 current approval gate：PASS
- v2 historical replay after current approval change：PASS with unpinned-provenance warning
- v3 fixture：PASS
- v3 unknown/rejected/wrong-digest/non-current-review tests：PASS
- v3 historical replay after pinned approval is superseded by rejection：PASS with current-trust warning

### Live v3 gate

Issue #3 live v3 checkpoint：comment `5523495731`。

Pinned identities：

```text
manifest_id:
xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1

manifest_sha256:
829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad

source_review_id:
xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1
```

Workflow run：`33738201105`，运行于 main commit `bbc93e191e9397665af25306e4b86cc3a7362fae`。

关键步骤全部 PASS：

```text
校验当前 ExplorationSession checkpoint     PASS
提取 Issue 全量 comment history            PASS
校验 ExplorationSession history            PASS
```

这同时证明 full-history gate 能兼容此前的 v2 live checkpoints，并接受新的 review-pinned v3。

## 当前完整信任链

```text
Raw evidence
↓
SourceSequenceManifest
↓
semantic review evidence
↓
SourceSequenceReview append-only chain
↓
unique effective approval
↓
current checkpoint v3 pins review identity
↓
Issue comment current-write validation
+
historical replay validation
↓
PASS
```

## 仍不属于 machine proof 的部分

Review registry 能证明“当前有效决定是什么”以及“历史 checkpoint 当时 pin 了哪个 approval”，但不能仅靠 JSON 自动证明 reviewer 的语义判断一定正确。

因此仍保持：

```text
Raw evidence review
+
Manifest semantic review
+
Review decision machine state
+
Checkpoint/history machine gate
≠
全部语义自动正确
```
