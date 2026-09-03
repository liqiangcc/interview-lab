# SourceSequenceManifest / SourceUnit

## 目的

`SourceSequenceManifest` 为 source-first 顺序学习提供一个可机器引用的 Derived 序列层。

它解决的问题不是“原始来源是什么”，而是：

> 对某个固定 `SourceRevision` 中的一个可顺序消费 evidence stream，哪些 Source 单元以什么顺序被 reveal？

## 所属层

```text
Layer 0 Raw Source
    ↓
Layer 1 Derived Extraction
    └── SourceSequenceManifest
          ├── SourceUnit*
          └── SourceFragment*
```

Manifest 永远属于 Derived Extraction。

它不能：

- 替代 Raw artifact；
- 把 OCR 升级成 Raw；
- 修改原作者 wording；
- 因为训练需要而重排第一手证据。

## 为什么不能直接使用 SourceQuestion

`SourceQuestion` 只表示问题型单元，但真实面经还可能包含：

- 阶段摘要；
- 结果 / 反思摘要；
- interviewer cue 之外的时间片段。

因此更底层的顺序对象是 `SourceUnit`：

```text
SourceUnit
├── question-like
├── stage-summary
├── outcome-reflection-summary
└── future source unit types
```

Question-like `SourceUnit` 后续可以派生 `SourceQuestion`，但两者不是同一个对象。

## Evidence stream 边界

一个 InterviewNote 可能同时包含 HTML 正文、图片、附件等多个 artifact，这些 artifact 不一定存在可证明的单一全局顺序。

因此 v1 manifest 必须绑定一个明确的 `evidence_stream`，例如：

```text
SourceRevision
↓
Raw image 1.webp
↓
SourceSequenceManifest(image-1)
↓
SourceUnit 1..N
```

不能因为系统需要一个 position，就把多个无法证明先后关系的 artifact 强行拼成一条时间线。

## SourceUnit

每个 unit 至少稳定记录：

```text
source_unit_id
position
source_unit_type
text_projection
fragments[]
```

`text_projection` 是用于可读定位的 Derived projection。其证据根仍由 manifest 的 `raw_artifact_ref` 指向 Raw artifact。

position 必须形成连续的：

```text
1..N
```

## SourceFragment

只有当一个 SourceUnit 内部确实包含多个时间阶段时，才建立 fragment。

例如：

```text
SourceUnit
├── interviewer-cue
├── retrospective-intent-summary
└── retrospective-followup-summary
```

每个 fragment 记录：

```text
source_fragment_id
order
fragment_type
text_projection
```

fragment order 必须连续，且其 projection 必须能够在父 SourceUnit projection 中按相同顺序定位。

不要为了统一结构给所有 unit 人工制造 fragment。

## Provenance

Manifest 必须同时记录：

```text
Raw evidence identity
+
可选 readable projection identity
```

如果 readable projection 来自 OCR，即使已通过 fidelity review，也必须继续声明：

```text
provenance = derived
```

## Identity 与不可静默改写

Manifest 使用：

```text
manifest_id
+
content_sha256
```

`content_sha256` 是对 manifest 内容（排除 digest 字段本身）的稳定 canonical digest。

新的 `exploration-session-checkpoint.v2` 会同时固定这两个值。

因此，一旦 manifest 被 checkpoint 引用：

```text
不能：
原地改变 unit boundary / position / type / fragment order
并继续假装还是同一个历史输入
```

如果 segmentation 经过 review 后需要修正：

```text
旧 manifest 保留
↓
创建新的 manifest version / manifest_id
↓
新 ExplorationSession 显式使用新 manifest
```

## 与 ExplorationSession 的关系

v1 checkpoint：

```text
SourceRevision
+
self-reported frontier
```

v2 checkpoint：

```text
SourceRevision
+
manifest_id + manifest digest
+
source_unit_id
+
source_fragment_id（如有）
```

这样 validator 可以证明：

- unit 确实属于该 SourceRevision 的指定 evidence stream；
- unit position 与 checkpoint position 一致；
- Source type 与 manifest 一致；
- 当前 unit 文本没有被 checkpoint 静默改写；
- fragment frontier 属于真实登记顺序；
- `has_withheld_within_unit` 与 fragment order 一致。

## 仍需 review 的部分

Manifest 本身是 Derived extraction，因此机器校验不能证明 segmentation 一定语义正确。

仍需 source review 证明：

- unit boundary 是否忠于 Raw；
- fragment 切分是否合理；
- source_unit_type / fragment_type 是否合理；
- readable projection 是否忠于 Raw artifact。

所以：

```text
Raw evidence review
+
Manifest validation
+
Checkpoint/history validation
```

三层职责必须分离。
