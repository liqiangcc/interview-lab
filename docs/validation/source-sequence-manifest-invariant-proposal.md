# SourceSequenceManifest machine gate — Promotion Record

状态：**PROMOTED / HARD machine gate**

本文件保留从 proposal 到正式 machine-enforcement 的 promotion 证据；文件名保留 `proposal` 仅用于历史可追踪性。

## 目标

把 sequential learning 的 Source frontier 从“checkpoint 自报 position”提升到“checkpoint 引用经过 review 且内容 digest 固定的 SourceSequenceManifest”。

## 已提升的 HARD 约束

### Manifest contract

```text
SourceSequenceManifest
→ 绑定 SourceRevision + 一个 evidence stream
→ manifest_id 唯一
→ content_sha256 自校验
→ SourceUnit position 连续 1..N
→ unit / fragment id 唯一
→ fragment order 连续
→ readable OCR projection 继续属于 Derived
```

Manifest 属于 Layer 1 Derived Extraction，不是 Raw Source。

一个 InterviewNote 可以同时有多个 artifact；manifest 只能描述有可辩护顺序的 evidence stream，不得为了获得全局 position 强拼多个没有可靠先后关系的 artifact。

### Checkpoint v2 binding

`exploration-session-checkpoint.v2` 必须同时固定：

```text
source_manifest_id
source_manifest_sha256
source_unit_id
source_fragment_id（unit 有 fragment 时）
```

validator 对照 manifest 证明：

```text
target_id == manifest.interview_note_id
source_revision_id == manifest.source_revision_id
source_manifest_sha256 == manifest.content_sha256
revealed_position == SourceUnit.position
source_unit_type == SourceUnit.source_unit_type
current_source_unit == SourceUnit.text_projection
```

如果 SourceUnit 有 fragments：

```text
source_fragment_id 必须存在
+
temporal_cursor == source_fragment_id
+
has_withheld_within_unit 由 fragment order 推导
```

### History v2 binding

同一 session 还必须保持：

```text
manifest_id + manifest digest 稳定
source_unit_id 在同 position 稳定
source_fragment_id 按 manifest fragment order 单调向前
```

## 版本边界

v1 checkpoint 继续兼容。

当已有 reviewed SourceSequenceManifest 时，新 sequential InterviewNote session 应优先使用 v2，从而让 Source frontier 能被机器对照 manifest 证明。

Manifest 本身仍是 Derived Extraction；机器能证明结构和引用一致性，但不能自动证明 segmentation 在语义上绝对正确。Manifest boundary/type 的语义正确性仍需 Source review。

## Promotion evidence

### PR gate

PR #7：`feat: bind sequential learning to SourceSequenceManifest`

- merge commit：`9bf9bb6a285cd11ee00bd0c301fecaeb3b0a94f4`
- repository check：PASS
- `node --test`：56 / 56 PASS
- `SourceSequenceManifest` validator：PASS，Pilot #3 manifest 共 7 个 SourceUnit
- checkpoint v1 regression fixture：PASS
- checkpoint v2 fixture：PASS
- v2 manifest / fragment-order regression tests：PASS

Pilot #3 manifest：

```text
manifest_id:
xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1

content_sha256:
829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad
```

它只绑定 fidelity-reviewed 的 Raw image `1.webp` evidence stream；历史 OCR 仍以 `provenance=derived` 作为 readable projection。

### Live Issue-comment v2 gate

Issue #3 上创建同一 v2 validation session 的三个连续 manifest-backed checkpoints：

```text
5523155206
u4:f1 / manifest order 1 / withheld=true
↓
5523157814
u4:f2 / manifest order 2 / withheld=true
↓
5523161909
u4:f3 / manifest order 3 / withheld=false / completed
```

最后一条触发 workflow run：`33735742114`，运行在 main commit `9bf9bb6a285cd11ee00bd0c301fecaeb3b0a94f4`。

关键步骤全部 PASS：

```text
校验当前 ExplorationSession checkpoint     PASS
提取 Issue 全量 comment history            PASS
校验 ExplorationSession history            PASS
```

因此真实链路已经验证：

```text
Raw evidence identity
↓
SourceSequenceManifest registry
↓
SourceUnit / SourceFragment identity
↓
checkpoint v2
↓
Issue comment event
↓
current checkpoint validator
+
full history validator
↓
PASS
```

## 仍不属于 machine proof 的部分

以下继续保留为 semantic review：

- SourceUnit / SourceFragment segmentation 是否在语义上忠于 Raw；
- source_unit_type / fragment_type 的语义分类是否合理；
- 自然语言解释是否实际偷看未来；
- Outcome / Cause / Verified Weakness 的语义归因；
- readable projection 是否忠于 Raw artifact。

因此：

```text
Raw evidence review
+
Manifest validation
+
Checkpoint/history validation
≠
全部语义自动正确
```

三层边界继续分离。
