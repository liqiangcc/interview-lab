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

## InterviewContext

表示一篇 InterviewNote 在正式学习之前经过审核的 **Derived 面试上下文**。

职责：

- 把 source-ready 面经变成可筛选学习样本；
- 保存 company / role family / recruitment type / round / interview time；
- 为 Learning Discovery Labels 提供经过 review 的 projection source；
- 生成 non-spoiler Issue title；
- 明确 outcome 在学习前保持 sealed。

重要属性：

- `context_id`
- `interview_note_id`
- `source_revision_id`
- `review_status`
- `reviewed_at`
- `company`
- `role`
- `recruitment_type`
- `round`
- `interview_occurred_at`
- `outcome_visibility`

每个基础事实必须区分：

```text
source-explicit
reviewed-inference
unknown
```

`InterviewContext` 属于 Derived，不修改 Raw Source，也不允许把 result / outcome / self-assessment / external feedback 放进 pre-learning view。

Learning Discovery Labels 是它的查询 projection，例如：

```text
company:kuaishou
role:backend
recruitment:campus
round:2
```

Unknown 默认不生成标签。

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

## SourceSequenceReview

表示对一个 **exact SourceSequenceManifest digest** 的独立审核决定。

它与 Manifest 分离：

```text
SourceSequenceManifest
→ 定义序列

SourceSequenceReview
→ 判断这个 exact 序列定义是否可被 sequential learning 消费
```

重要属性：

- `review_id`
- `manifest_id`
- `manifest_sha256`
- `decision`：approved / rejected
- `reviewed_at`
- `reviewer_kind`
- `review_evidence`
- `checks[]`
- `limitations[]`
- `supersedes_review_id`

Review 通过 `supersedes_review_id` 形成 append-only decision chain；同一个 `manifest_id + manifest_sha256` 必须只有一个 effective head。

`SourceSequenceReview` 属于 Derived governance / review state，不修改 Raw Source，也不修改 Manifest 内容。

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

Sequential InterviewNote 学习开始前，可以读取 reviewed `InterviewContext` 中的非剧透上下文；OutcomeContext 不得因为后台已知而提前进入 reasoning context。

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

Manifest-backed v2/v3 checkpoint 进一步固定：

- `source_manifest_id`
- `source_manifest_sha256`
- `source_unit_id`
- `source_fragment_id`（SourceUnit 有 fragments 时）

Review-pinned v3 再固定：

- `source_review_id`

这些 runtime 字段表达：

```text
当前使用哪个 SourceRevision
+
使用哪个固定 Manifest digest
+
看到哪个 SourceUnit / SourceFragment
+
当时由哪个 SourceSequenceReview 授权这个 Manifest 被消费
+
当前处于哪一种 learning loop / closure state
```

`ExplorationSession` 本身属于 Derived/Training 层，不修改 Raw Source。

版本边界：

- v1：基础兼容 contract；
- v2：manifest-backed legacy contract；
- v3：manifest + review-pinned contract，新的已批准 manifest sequential session 首选。

历史授权事实与当前 review 状态分离：后续 review 被 supersede/rejected 可以改变当前是否允许继续使用，但不能反向改写历史 v3 checkpoint 当时 pin 的 approved review。

CanonicalQuestion 等其他 session target 仍属于领域模型，只是需要未来独立 contract 后再进入 machine enforcement。

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
   ├── InterviewContext?
   │      └── Learning Discovery Labels / non-spoiler title
   ├── SourceSequenceManifest*
   │      ├── SourceSequenceReview*
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

InterviewContext 必须绑定具体 `source_revision_id`，避免 Source 改变后继续使用旧上下文投影。

被 ExplorationSession 引用的 SourceSequenceManifest 必须固定 content digest；被 v3 session 引用的 SourceSequenceReview 还必须固定 `review_id`。

如果 segmentation 需要修正：创建新的 manifest version；如果审核决定变化：追加新的 review 并通过 `supersedes_review_id` 形成新 effective head。都不能静默改写历史 session 的 frontier 或授权 provenance。
