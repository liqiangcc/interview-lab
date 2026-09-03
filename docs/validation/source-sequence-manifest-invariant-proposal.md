# SourceSequenceManifest machine gate 提案

状态：**PROPOSAL / pending PR CI + live v2 probe**

## 目标

把 sequential learning 的 Source frontier 从“checkpoint 自报 position”提升到“checkpoint 引用经过 review 的 SourceSequenceManifest”。

## 候选 HARD 约束

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

### Checkpoint v2 binding

`exploration-session-checkpoint.v2` 必须同时固定：

```text
source_manifest_id
source_manifest_sha256
source_unit_id
source_fragment_id（unit 有 fragment 时）
```

并由 validator 对照 manifest 证明：

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

v2 用于需要机器证明 SourceUnit / SourceFragment frontier 的新 sequential session。

Manifest 本身属于 Derived Extraction；机器只能证明它结构自洽并被 checkpoint 正确引用，不能自动证明 segmentation 在语义上绝对正确。

## Promotion gate

只有同时满足：

```text
PR npm run check PASS
+
manifest validator PASS
+
checkpoint v1 regression PASS
+
checkpoint v2 fixture PASS
+
history v2 fragment-order tests PASS
+
Issue #3 live v2 checkpoint/history workflow PASS
```

才将本 gate 提升为正式 HARD invariant。
