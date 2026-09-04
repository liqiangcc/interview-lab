# 领域模型

## 目的

Interview Lab 采用 source-first：先保存真实来源，再确认面试事件，最后派生知识与训练状态。

本模型不绑定数据库实现。GitHub Issue 只是工作流入口，不是领域 identity。

## 总体关系

```text
External Source
      ↓
SourceNote
      ↓ Boundary Review
      ├── 0 InterviewNote
      ├── 1 InterviewNote
      └── N InterviewNote
              ↓
       InterviewContext
              ↓
       SourceSequenceManifest
              ↓
       SourceUnit / SourceQuestion
              ↓
       CanonicalQuestion
         ├── Analysis
         ├── Answer
         └── ReviewProgress

InterviewNote / CanonicalQuestion
              └── ExplorationSession*
```

核心边界：

```text
一条来源帖子 ≠ 一次真实面试。
```

## SourceNote

表示“一条外部来源帖子在固定 Source snapshot 中的采集身份”。

XHS 当前使用：

```text
source_note_id = xhs-note:<note_id>
```

职责：

- 保存 source system / external id；
- 固定 SourceRevision 与 source repository ref；
- 保存 `source_published_at` / `source_edited_at`；
- 登记 Raw / Source projection artifacts；
- 显式记录 zero-byte、时间异常等 intake anomaly；
- 承载 boundary review。

不负责：

- 判断是不是一次面试；
- 公司 / 岗位 / 招聘类型 / 轮次；
- 实际面试时间；
- 学习标签；
- 预声明 InterviewNote identity。

Boundary Review 结果：

```text
pending
not-interview
single-interview
multi-interview
```

只有 review 完成后才允许产生 `0..N InterviewNote`。

详细 contract：`docs/domain/source-note.md`。

## InterviewNote

表示“经过 boundary review 确认的一次真实面试事件”。

职责：

- 稳定面试事件 identity；
- 引用其来源 SourceNote / SourceRevision provenance；
- 进入 Source review / source-ready 生命周期；
- 关联 InterviewContext、顺序学习与问题抽取。

InterviewNote 不拥有 Canonical 知识，也不负责改写来源中的原始技术表述。

历史 Pilot #3/#4 在旧的一对一模型下已经建立正式 `xhs:<note_id>` identity。它们作为兼容历史保留；bulk reconciliation 不改写这些正式对象。多事件 child identity 在 Boundary Review 中按稳定 `case_key` 固定：`<source.system>:<source.external_id>:event:<sha256(source_note_id + "\\n" + case_key)>`。该 identity 仍属于经过审核的 Derived mapping；SourceNote 不因此变成 InterviewNote，正式 Issue 仍需后续 materialization。

## SourceArtifact

表示来源证据，例如：

- HTML snapshot；
- API JSON snapshot；
- text projection；
- image；
- 未来的 video / audio。

Raw 与 Derived 必须分开。

SourceNote intake 对 artifact 至少保留：

```text
kind
ref
git_blob_sha
sha256
provenance
byte_size
integrity
```

`byte_size=0` 必须显式使用 `integrity=zero-byte`，不能把路径存在等同于证据可用。

## InterviewContext

表示 InterviewNote 在正式学习前经过审核的 Derived 面试上下文。

职责：

- company；
- role family；
- recruitment type；
- round；
- interview occurred time；
- non-spoiler title；
- Learning Discovery Labels；
- sealed outcome。

每个事实区分：

```text
source-explicit
reviewed-inference
unknown
```

Outcome / result / self-assessment 默认不进入 pre-learning view。

## SourceSequenceManifest

表示针对一个固定 InterviewNote SourceRevision 中某个可顺序消费 evidence stream 的 Derived 序列定义。

职责：

- 固定 `manifest_id + content_sha256`；
- 绑定 evidence stream；
- 定义 `SourceUnit 1..N`；
- 需要时定义 SourceFragment。

一篇 InterviewNote 可以有多个 evidence stream；不能默认所有 artifact 存在一个全局顺序。

## SourceSequenceReview

表示对 exact Manifest digest 的独立审核决定：

```text
SourceSequenceManifest
→ 定义顺序

SourceSequenceReview
→ 判断这个 exact 顺序是否允许 sequential learning
```

Review 使用 append-only supersedes chain。后续 review 变化不能反向改写历史 session 当时的授权事实。

## SourceUnit

表示 sequential learning 的独立 reveal frontier。

当前已验证类型包括：

```text
question-like
stage-summary
outcome-reflection-summary
```

统一的是 evidence discipline，不是统一 layer 数量。

## SourceFragment

只在一个 SourceUnit 内确实存在多个时间阶段时建立，例如：

```text
interviewer cue
→ retrospective intent
→ retrospective later-followup
```

不要为了结构统一给所有 unit 人工制造 fragment。

## SourceQuestion

表示从 question-like SourceUnit 或准确 source span 派生的问题单元。

保留：

- 原始 wording；
- source location / provenance；
- sequence position；
- extraction status；
- 必要时的 interpretation confidence。

SourceQuestion 不应被润色成标准知识题。

## QuestionRelation

表示 SourceQuestion / CanonicalQuestion 之间的显式关系，例如：

```text
same
alias
follow-up
parent-child
prerequisite
contrast
related
```

除非 Source 明确建立关系，否则属于 Derived decision。

## CanonicalQuestion

表示可跨面经复用的标准问题 identity，可以聚合多个 SourceQuestion。

Canonicalization 必须能够反向追溯到每个贡献 SourceQuestion、InterviewNote 和最终 SourceNote provenance。

## Analysis

围绕 CanonicalQuestion 的派生分析，例如：

- 面试官在考什么；
- 预期回答深度；
- mechanism decomposition；
- boundary / trade-off；
- 常见误区；
- 合理 follow-up 方向。

## Answer

针对 CanonicalQuestion 准备的回答，可包含：

- 简短结论；
- 回答骨架；
- 深入解释；
- 边界 / 版本约束；
- 示例；
- follow-up；
- evidence 引用。

Answer 的正确性依赖技术证据和真实 Source variants，不通过改写面经“证明”。

## ExplorationSession

表示一次有边界探索 / 学习过程。

Sequential InterviewNote learning 的新 session 使用 review-pinned v3 checkpoint，固定：

```text
source_revision_id
source_manifest_id
source_manifest_sha256
source_review_id
source_unit_id
source_fragment_id? 
revealed_position
loop_phase
position_status
session_status
```

这些 runtime 字段只服务可审计学习边界，不进入普通用户界面。

无前视原则：

```text
position N reasoning context
=
previously revealed Source
+ current revealed Source / temporal fragment
+ mode-allowed general knowledge
```

不能使用未来 Source 解释、预测或评分当前步骤。

## ReviewProgress

表示训练状态，例如 recall、last review、response quality、failed follow-ups、weak dimensions。

它不是 Source truth，不得修改 Source 或 Knowledge identity。

## 分层

```text
Layer 0  Raw Source
         SourceNote evidence / immutable artifact

Layer 1  Derived Extraction / Discovery
         Boundary Review
         InterviewNote extraction
         InterviewContext
         SourceSequenceManifest
         SourceUnit / SourceFragment / SourceQuestion

Governance
         SourceSequenceReview

Layer 2  Knowledge
         CanonicalQuestion / Analysis / Answer

Layer 3  Training
         ExplorationSession / ReviewProgress
```

## Identity 规则

所有长期对象必须拥有独立于 Issue number、Issue title、文件路径和展示文本的 stable machine identity。

```text
Issue number
→ locator
≠ domain identity
```

SourceNote 与 InterviewNote identity 必须分离，因为一个 SourceNote 可以产生 0..N InterviewNote。

任何 segmentation、review 或 Context 修正都通过新的 Derived version / review decision 演进，不静默改写 Raw Source 或历史学习 frontier。
