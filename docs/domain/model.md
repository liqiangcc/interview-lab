# 领域模型

## 目的

本文定义 Interview Lab 的核心领域对象，不绑定具体数据库实现。

模型采用 source-first：从真实面经派生可复用知识和训练状态，同时保留完整 provenance。

## InterviewNote

表示一个来源中的一篇真实面经 case。

职责：

- 稳定 identity
- 引用不可变 Raw Artifact
- 保存 source provenance
- 管理 SourceRevision
- 关联主 GitHub Issue

它不拥有 Canonical 知识，也不负责“纠正”原始技术表述。

## SourceArtifact

表示一次采集得到的来源证据，例如：

- HTML snapshot
- API JSON snapshot
- 原始 text export
- image
- 未来可能支持的 video/audio

推荐 identity 字段：

- artifact id
- interview note id
- source revision
- content type
- content hash
- capture timestamp
- storage reference

## SourceSequenceManifest

表示针对某个固定 `SourceRevision` 中一个可顺序消费 evidence stream 的 Derived 序列定义。

职责：

- 固定 `manifest_id + content_sha256`
- 绑定 Raw evidence stream
- 保存可选 readable Derived projection provenance
- 定义 `SourceUnit 1..N`
- 在确有 position 内时间阶段时定义 `SourceFragment`

Manifest 属于 Layer 1 Derived Extraction，不是 Raw Source。

一个 InterviewNote 可以有多个 evidence stream，因此不能默认存在跨所有 artifact 的单一全局顺序。

## SourceUnit

表示一个可以在 sequential learning 中作为独立 reveal frontier 的 Derived Source 单元。

重要属性：

- `source_unit_id`
- `position`
- `source_unit_type`
- `text_projection`
- `fragments[]`

`SourceUnit` 比 `SourceQuestion` 更底层，因为并非所有顺序单元都是问题。它可以是：

- question-like
- stage-summary
- outcome-reflection-summary
- 未来经过 review 的其他类型

## SourceFragment

表示一个 SourceUnit 内部存在的可证明时间片段。

只在 unit 内确实包含多个时间阶段时建立，例如：

```text
interviewer cue
→ retrospective intent summary
→ retrospective follow-up summary
```

重要属性：

- `source_fragment_id`
- `order`
- `fragment_type`
- `text_projection`

不要为了统一结构给所有 SourceUnit 人工制造 fragment。

## SourceQuestion

表示从某个 InterviewNote 中派生的问题型单元。

重要属性：

- 原始 wording 或准确 source span
- source location / provenance
- sequence position
- 可选 `source_unit_id`，指向其 question-like SourceUnit
- extraction status
- 必要时记录 interpretation confidence

SourceQuestion 不应该被润色成标准知识题。

SourceUnit 与 SourceQuestion 的关系是：

```text
question-like SourceUnit
↓
可进一步派生 SourceQuestion
```

Stage-summary / outcome-summary SourceUnit 不应被强行伪装成 SourceQuestion。

## QuestionRelation

表示 SourceQuestion 和/或 CanonicalQuestion 之间的显式关系。

可能包括：

- same
- alias
- follow-up
- parent-child
- prerequisite
- contrast
- related

除非原文直接建立该关系，否则关系属于 Derived decision。

## CanonicalQuestion

表示可跨面经复用的标准问题 identity，可以聚合一个或多个 SourceQuestion。

职责：

- 稳定知识边界
- 管理真实问法/source variant membership
- 拥有知识关系
- 关联 Analysis 和 Answer

Canonicalization 必须能够反向追溯到每个贡献的 SourceQuestion 和 InterviewNote。

## Analysis

表示围绕 CanonicalQuestion 的派生分析，例如：

- 面试官在考什么
- 预期回答深度
- mechanism decomposition
- boundary / trade-off
- 常见误区
- 合理 follow-up 方向

Analysis 可以独立于 Source 演化。

## Answer

表示针对 CanonicalQuestion 准备的回答。

可以包含：

- 简短结论
- 一分钟回答骨架
- 深入解释
- 边界 / 版本约束
- 示例
- follow-up 回答
- evidence 引用

Answer 的正确性依赖外部技术证据和真实 source variants，而不是通过改写面经来“证明”。

## ExplorationSession

表示一次针对 InterviewNote 或知识对象的有边界探索/学习过程。

长期领域对象需要保持：

- `session_id`
- `target_type`
- `target_id`
- `mode`
- `started_at`
- `completed_at`
- findings / knowledge gaps / relation candidates / actions

当 ExplorationSession 进行 sequential InterviewNote 学习时，还需要一个可审计的当前 Source frontier：

- `source_revision_id`
- `revealed_position`
- `revealed_range`
- `source_unit_type`
- `loop_phase`
- `temporal_cursor`（必要时）
- `revealed_within_unit`（必要时）
- `position_status`
- `session_status`
- `closure_reason`（非 active position）

`exploration-session-checkpoint.v2` 进一步固定：

- `source_manifest_id`
- `source_manifest_sha256`
- `source_unit_id`
- `source_fragment_id`（SourceUnit 有 fragments 时）

这些 runtime 字段用于表达：

```text
当前看到哪一个 manifest-backed SourceUnit
+
当前 unit 内看到哪个稳定 SourceFragment
+
当前使用哪一种 learning loop
+
为什么继续或停止
```

`ExplorationSession` 本身属于 Derived/Training 层，不修改 Raw Source。

v1 checkpoint 继续作为兼容 contract；v2 用于把 frontier 与正式 SourceSequenceManifest 绑定。CanonicalQuestion 等其他 session target 仍属于领域模型，只是需要未来独立 contract 后再进入 machine enforcement。

Exploration 可重复、可追加。一篇面经不会因为完成一轮探索就“永久处理完毕”。

## ReviewProgress

表示学习者针对某个知识对象或面经 case 的训练状态，例如：

- recall status
- last reviewed time
- response quality
- failed follow-ups
- weak dimensions
- next review suggestion

ReviewProgress 不是 Source truth，不得修改 Source 或 Knowledge identity。

## 对象关系

```text
InterviewNote
   ├── SourceArtifact*
   ├── SourceSequenceManifest*
   │      └── SourceUnit*
   │             ├── SourceFragment*
   │             └── SourceQuestion?   # 仅 question-like unit
   └── SourceQuestion*
            │
            ├── QuestionRelation*
            │
            ▼
      CanonicalQuestion
            ├── Analysis
            ├── Answer
            └── ReviewProgress

InterviewNote / CanonicalQuestion
            └── ExplorationSession*
```

## Identity 规则

所有长期存在的领域对象都必须拥有独立于 GitHub Issue number、Issue title、文件路径和展示文本的稳定 machine identity。

GitHub Issue number 只是操作界面的 locator，不是领域 identity。

被 ExplorationSession 引用的 SourceSequenceManifest 还必须固定 content digest；如果 segmentation 需要修正，创建新的 manifest version，而不是静默改写历史 session 所依赖的 frontier。
