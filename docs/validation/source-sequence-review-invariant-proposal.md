# SourceSequenceReview machine gate 提案

状态：**PROPOSAL / pending PR CI + live approval-backed v2 probe**

## 目标

把“有 reviewed SourceSequenceManifest 时使用 checkpoint v2”中的 `reviewed` 变成可机器证明的状态，而不是自然语言约定。

## 候选 HARD 约束

### Review identity 与 manifest 分离

```text
Manifest
→ 定义 SourceUnit / SourceFragment 序列

Review
→ 对 exact manifest digest 做审核决定
```

不得把 approval 状态直接写回 manifest 以混合序列定义与治理状态。

### Exact-digest approval

Review 必须绑定：

```text
manifest_id
+
manifest_sha256
```

新 digest 不继承旧 approval。

### Append-only review chain

同一 exact manifest digest 的 review 决定通过：

```text
supersedes_review_id
```

形成显式 chain。

Registry 必须：

- review_id 唯一；
- supersedes 指向同一 exact digest；
- 不允许 cycle；
- 只能有一个 effective head；
- 多个并行 head 时 fail closed。

### Decision semantics

```text
approved
→ 所有登记 check 都 pass

rejected
→ 至少一个登记 check fail
```

### Checkpoint v2 consumption gate

`exploration-session-checkpoint.v2` 在 manifest/unit/fragment binding 之外，还必须证明：

```text
effective SourceSequenceReview exists
+
effective decision == approved
```

manifest 存在或 schema PASS 本身不再足够。

## Pilot #3 review evidence

正式 semantic review：Issue #3 comment `5523241379`。

Review target：

```text
manifest_id:
xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1

manifest_sha256:
829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad
```

Decision：`approved`。

## Promotion gate

只有同时满足：

```text
PR npm run check PASS
+
SourceSequenceReview registry validator PASS
+
review-chain regression tests PASS
+
checkpoint v1 regression PASS
+
approved checkpoint v2 PASS
+
missing/rejected approval checkpoint v2 FAIL as expected
+
Issue #3 live approval-backed v2 checkpoint/history workflow PASS
```

才把本 proposal 提升为正式 HARD invariant。

## 不属于 machine proof 的部分

Review registry 能证明“当前有效决定是什么”，但不能仅靠 JSON 自动证明 reviewer 的语义判断一定正确。

因此仍保持：

```text
Raw evidence review
↓
Manifest semantic review
↓
Review decision registry
↓
Checkpoint/history machine gate
```

每层职责不同。
