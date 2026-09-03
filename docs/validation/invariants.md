# 仓库不变量与验证门禁

## 目的

Interview Lab 大量依赖 AI 协作和 Issue-driven workflow，因此关键边界不能只停留在文字约定，必须能够被 Validator、migration command 和 CI 检查。

验证哲学：

```text
Source Evidence
    ↓
显式 operation
    ↓
validation
    ↓
state / projection update
```

无法证明时 fail closed 或进入 review，绝不通过猜测消除不确定性。

## Severity

- **HARD**：违规会阻止正式 operation / readiness transition。
- **REVIEW**：需要显式人工或 AI 审核后才能继续。
- **INFO**：诊断信息，本身不阻塞。

## Source identity

### I1 — Stable InterviewNote identity — HARD

每个 InterviewNote 必须有唯一稳定 machine identity，独立于 Issue number、title、display metadata 和 file path。

XHS 初始 identity 使用 source system + external note id。

### I2 — One primary Issue per InterviewNote — HARD

一个稳定 InterviewNote identity 最多只能对应一个主 `type:interview-note` Issue。

Migration / sync 在 create 前必须先检测 machine marker。

### I3 — Issue marker 与领域对象一致 — HARD

Issue 必须有合法 machine marker，且 identity 与正式 machine record 一致。

## Raw Source

### I4 — Derived 不覆盖 Raw — HARD

OCR、SourceQuestion、metadata inference、CanonicalQuestion、Analysis、Answer、Review 都不得静默替换 Raw Source。

### I5 — Raw Artifact provenance 可解析 — HARD

所有被当作第一手证据的 artifact 都必须能够定位和识别；存储支持 hash 时应记录 content identity/hash。

### I6 — SourceRevision immutable — HARD

SourceRevision 注册后，如定义它的 artifact/content 发生变化，必须创建新 revision，不能原地修改。

### I7 — Preferred revision 属于同一 InterviewNote — HARD

preferred revision 必须解析到同一 InterviewNote，并通过 source integrity validation。

### I8 — Unknown 保持 Unknown — HARD

缺失事实不能被人为补成精确值。例如：

- unknown date 不能变成任意 exact date
- 缺失图片文字不能编造
- inferred company/round 不能冒充 sourced metadata

## Raw / Derived separation

### I9 — Derived 保留 provenance — HARD

任何声称来自 Source 的 Derived record 都必须能追溯到 InterviewNote，并在可行时追溯到 SourceRevision / source span / artifact。

### I10 — OCR 默认属于 Derived — HARD

除非来源本身直接提供该文字，否则 OCR 不能显示或存储成原始文本。

### I11 — 历史 XHS Derived 继续属于 Derived — HARD

迁移时 `note_structured`、`note_tagged`、Question、CanonicalQuestion、Answer 等不能因为“已经存在”就升级为 Raw。

## InterviewNote lifecycle

### I12 — source-ready 含义严格受限 — HARD

`source-ready` 只证明 source identity、已捕获证据、已知 limitation 和 provenance 稳定。

它不要求也不意味着 SourceQuestion、Canonical mapping、Answer 或 learner mastery 完成。

### I13 — 正常关闭必须满足 source-ready — HARD

InterviewNote 正常 complete close 前必须满足 source-ready contract。

未来如支持 terminal non-completion close，必须使用独立显式 reason/state contract，不能伪装成 source-ready。

### I14 — Reopen 只因 Source 原因 — REVIEW

Knowledge、Answer、Training 变化不 reopen 已完成的 Source lifecycle。Reopen 应说明 new evidence、truncation、corruption、identity conflict、duplicate remediation 等 Source 原因。

## Label

### I15 — Label 是 projection，不是 proof — HARD

手工存在 `status:*` 不足以证明领域前置条件成立，Validator 必须检查底层 Issue / Source state。

### I16 — Lifecycle Label cardinality — HARD

一个 open InterviewNote 不得同时存在矛盾 lifecycle labels，例如 `status:captured` 与 `status:source-ready`。

### I17 — 高基数事实不扩张 Label namespace — REVIEW

company、role、year、note id、technology、canonical id 等不应成为全局 Label，除非经过新的 taxonomy decision。

## Issue content

### I18 — Raw 与 Derived 可见区分 — HARD

Issue readable body 不得把 AI/Derived interpretation 混入第一手 Source body。

### I19 — 大 Artifact 以引用为主 — REVIEW

HTML、image 等大内容应保留在 Evidence Store，并从 Issue 引用。Readable projection 可以展示，但 provenance 必须清楚。

### I20 — Issue title 非权威 — HARD

Issue title 不能成为唯一 identity 或 provenance carrier。

## Sequential learning

### I21 — No look-ahead — HARD（sequential mode）

revealed position `N` 只能使用之前已揭示 Source context + 当前已经揭示的输入。未来 Source unit 不得影响当前解释。

如果同一个 Source unit 内仍包含未来时间片段，则 `revealed_position=N` 仍不足以授权使用整条 Source；当前 checkpoint 必须遵守 position 内的 `temporal_cursor` 边界。

```text
revealed_position
+
temporal_cursor（必要时）
=
当前可用 Source frontier
```

### I22 — Sequential checkpoint machine boundary 完整 — HARD（新 checkpoint contract）

新的可机器校验 sequential InterviewNote checkpoint 必须包含且只包含一个：

```text
<!-- exploration-session-checkpoint
{ ... exploration-session-checkpoint.v1 ... }
-->
```

至少机器记录：

```text
session_id
target_id
mode
source_revision_id
revealed_position
revealed_range
current_source_unit
source_unit_type
loop_phase
has_withheld_within_unit
position_status
session_status
```

并满足：

- `revealed_range` 末端必须等于 `revealed_position`；
- `has_withheld_within_unit=true` 时必须记录 `temporal_cursor` 与 `revealed_within_unit`；
- checkpoint 的 Source type / loop phase / closure state 必须通过 validator；
- 历史上在本 contract 引入前已经存在的 comment 不要求原地改写，但新建或编辑后的 `ExplorationSession checkpoint` 应遵守 v1 contract。

### I23 — Exploration finding 不等于 mutation authorization — HARD

对话发现或 AI suggestion 不能直接修改 SourceQuestion、relation、CanonicalQuestion 或 Answer，必须进入所属领域 operation/review path。

## Migration

### I24 — Migration idempotent — HARD

重复执行同一 InterviewNote 的 migration/sync 不得产生 duplicate Issue 或 duplicate identity。

### I25 — Preserve chronology uncertainty — HARD

迁移排序只能使用可辩护 Source time precision；内部 sort key 不得持久化成虚假日期。

### I26 — Issue number 不是 chronology — HARD

Issue 创建顺序不能成为权威面经时间。

### I27 — Full migration 需要 Pilot gate — HARD

文档规定的 pilot exit criteria 通过前不得开始历史 XHS 全量迁移。

## Concurrency

### I28 — Stale source-dependent write fail closed — HARD

如果 operation 基于 SourceRevision `R` 审核，但提交前 relevant source/preferred state 已改变，必须重新评估，不能盲目 apply。

### I29 — Duplicate identity conflict 阻止自动推进 — HARD

如果多个 Issue 或 Source record 声称同一 stable InterviewNote identity，自动状态推进必须停止，直到 ownership 显式解决。

## Exploration runtime

### I30 — Source type 与 loop phase 一致 — HARD（known source types）

对于 validator 已认识的 Source type，checkpoint 的 normalized `loop_phase` 必须属于该 type 的允许路径。

当前 v1 至少覆盖：

```text
question-like
stage-summary
outcome-reflection-summary
```

新 Source type 可以先以 extensible identifier 进入，但 validator 必须给出 warning，直到其 loop contract 被正式提升。

### I31 — Closure state 必须显式且自洽 — HARD

`ready-to-close`、`complete`、`deferred` 不得在普通解释阶段被静默设置。

非 active position 必须：

```text
loop_phase = closure
+
closure_reason != empty
```

`session_status=completed` 还必须同时满足：

```text
position_status = complete
+
completed_at 可解析
```

### I32 — Outcome attribution 不越权 — REVIEW

结果型 Source 的语义复盘必须保持：

```text
Outcome
≠
Failure Cause
≠
Verified Weakness
```

结构 validator 可以检查 Source type / loop path / closure contract，但无法仅靠机器字段证明自然语言中没有 hindsight attribution；这部分仍需显式 review。

## 初始 Validator group

未来工具应暴露有边界的检查：

```text
validate identity
validate source
validate revisions
validate issues
validate labels
validate lifecycle
validate migration
validate exploration checkpoint
validate exploration attribution
validate all
```

`validate all` 聚合这些检查，并返回 machine-readable report。

当前仓库已经提供 `exploration-session-checkpoint.v1` 的 comment validator；语义 attribution review 仍属于人工 / AI review gate。

## Pilot 最低门禁

超过 pilot 数量前至少要求：

```text
identity uniqueness                    PASS
Issue marker consistency               PASS
source artifact traceability           PASS
Raw/Derived separation                 PASS
label consistency                      PASS
source lifecycle consistency           PASS
migration idempotency                  PASS
no invented source precision           PASS
AI can navigate Issue → evidence root  PASS
sequential checkpoint contract         PASS
```

## Evidence over counts

聚合数量不能证明完整性。

例如：

```text
5 Issues created
```

如果其中一个 identity 重复，或把 OCR 当原文展示，pilot 仍然失败。

完成必须由 invariant-level evidence 证明。

## 核心不变量集合

```text
保护第一手证据。
Identity 保持稳定。
Raw 与 Derived 分离。
不确定性显式存在。
Issue 驱动工作，但不能绕过 Validation。
顺序学习保持因果性，包括 position 内时间边界。
Exploration checkpoint 的 Source type、frontier 和 closure 可机器审计。
Outcome 不自动生成 Cause 或 Verified Weakness。
Migration 必须幂等。
遇到 stale / ambiguous state 必须 fail closed。
```
