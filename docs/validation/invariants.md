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

### I22 — Sequential checkpoint machine boundary 完整 — HARD

新的可机器校验 sequential InterviewNote checkpoint 必须包含且只包含一个 `exploration-session-checkpoint` machine marker。

v1 至少机器记录：

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
- 历史上 contract 引入前已经存在的 comment 不要求原地改写。

当存在经过有效 SourceSequenceReview 批准的 SourceSequenceManifest 时，新 sequential session 应优先使用 review-pinned v3 contract；v2 保留为已发布兼容 contract，见 I34–I40。

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

当前至少覆盖：

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

### I33 — SourceSequenceManifest 是可追溯 Derived sequence contract — HARD

`SourceSequenceManifest` 属于 Layer 1 Derived Extraction，不得伪装成 Raw Source。

每个 manifest 必须：

```text
绑定一个 SourceRevision
+
绑定一个可辩护顺序的 evidence stream
+
manifest_id 唯一
+
content_sha256 自校验
+
SourceUnit position 连续 1..N
+
unit / fragment id 唯一
+
fragment order 连续
```

可读 OCR projection 即使经过 fidelity review，也必须继续声明为 Derived。

多个 artifact 没有可靠全局顺序时，不得为了获得 position 强行拼接成一个 manifest stream。

一旦 manifest 被 manifest-backed checkpoint 引用，其 `manifest_id + content_sha256` 构成历史 frontier identity；segmentation 修正必须创建新的 manifest version，而不是静默改写旧 frontier。

### I34 — Manifest-backed checkpoint 必须由 Manifest 证明 SourceUnit frontier — HARD

v2/v3 manifest-backed checkpoint 必须固定：

```text
source_manifest_id
source_manifest_sha256
source_unit_id
source_fragment_id（SourceUnit 有 fragment 时）
```

validator 必须证明：

```text
target_id == manifest.interview_note_id
source_revision_id == manifest.source_revision_id
source_manifest_sha256 == manifest.content_sha256
revealed_position == SourceUnit.position
source_unit_type == SourceUnit.source_unit_type
current_source_unit == SourceUnit.text_projection
```

如果 SourceUnit 有 fragments，则还必须证明：

```text
source_fragment_id 属于当前 SourceUnit
+
temporal_cursor == source_fragment_id
+
has_withheld_within_unit 与 fragment order 一致
```

### I35 — Manifest-backed history frontier 单调 — HARD

同一 v2/v3 session 必须保持：

```text
source_manifest_id 稳定
source_manifest_sha256 稳定
source_unit_id 在同 position 稳定
source_fragment_id 按 manifest order 单调向前
```

Manifest-backed history gate 与现有 session history gate 共同工作；completed session 仍然 terminal，position / phase / closure 仍不得倒退。

### I36 — SourceSequenceReview 是 exact-digest 的独立批准链 — HARD

`SourceSequenceManifest` schema PASS 不等于允许被 sequential learning 消费。

Review identity 与 Manifest identity 必须分离：

```text
Manifest
→ 序列定义

SourceSequenceReview
→ 对 exact manifest_id + manifest_sha256 的治理决定
```

同一 exact digest 的 review 通过 `supersedes_review_id` 形成 append-only chain，并满足：

- `review_id` 唯一；
- supersedes 只能指向同一 exact digest；
- 不允许 cycle；
- 必须且只能有一个 effective head；
- 多个并行 head fail closed；
- `approved` 要求所有登记 check=`pass`；
- `rejected` 至少有一个显式 `fail`；
- manifest 新 digest 不继承旧 approval。

Review 本身属于 Derived governance state，不把 Manifest 或 SourceUnit 升级为 Raw Source，也不授权 Knowledge mutation。

### I37 — Checkpoint v3 固定当时授权它的 SourceSequenceReview — HARD

`exploration-session-checkpoint.v3` 在 Manifest frontier identity 之外必须固定：

```text
source_review_id
```

Current write gate 必须证明：

```text
pinned review 存在
+
pinned review targets exact manifest_id + digest
+
pinned review.decision = approved
+
pinned review == 当前 unique effective review
```

History replay gate 必须证明：

```text
pinned review 存在
+
pinned review targets exact manifest_id + digest
+
pinned review.decision = approved
```

后续 review 被 supersede 或变成 rejected，只能更新当前信任状态；不得反向改写历史 checkpoint 当时 pin 的授权事实。历史 replay 可以给 stale/revoked warning，但不能因此宣称旧 checkpoint “当时从未合法”。

同一 v3 session 的 `source_review_id` 必须稳定；effective review 变化后若需要继续探索，应新建 session。

已发布 v2 不原地增加 `source_review_id`：

- 新写入 v2 仍要求 Manifest 当前 effective review=`approved`；
- 历史 v2 因未 pin review identity，只能保留 `approval provenance unpinned` warning，不使用今天的 review 状态反向重写旧 comment。

机器能证明 review identity / decision / chain 与 checkpoint 的引用关系，但不能自动证明 semantic reviewer 的判断一定正确；SourceUnit / SourceFragment segmentation 与自然语言 no-look-ahead 仍需 semantic review。

### I38 — SourceSequenceReview transition stale-head fail closed — HARD

任何通过正式 transition operation 生成下一条 review 的请求，都必须显式固定观察到的当前 head：

```text
expected_effective_review_id
```

Planner 必须证明：

```text
manifest_id + manifest_sha256 精确匹配
+
expected_effective_review_id == 当前 effective review
+
new_review_id 尚不存在
+
reviewed_at 晚于当前 head
+
候选 review contract 合法
```

并自动设置：

```text
supersedes_review_id = 当前 effective review
```

如果另一个 writer 已经推进了 review chain，则旧 transition request 必须 FAIL CLOSED；调用者不能自行指定任意历史 review 作为 supersedes 目标来绕过当前 head。

### I39 — Active v3 session 必须跟随 pinned review 的当前有效性 — HARD

Active v3 session 只能继续使用它启动时 pin 的 `source_review_id`，且该 review 仍必须是当前 effective approved review。

如果 effective review head 改变：

```text
active v3 + pinned old review
→ active-stale
→ 后续 write blocked
```

不得把旧 session 原地换绑到新 review。

如果新 effective review 仍是 `approved` 且需要继续探索：

```text
start new v3 session
→ pin new effective review
```

如果当前 effective review 为 `rejected` 或不存在有效 approval：

```text
pause
→ 不得继续 manifest-backed sequential learning
```

Completed session 仍保持历史有效；它可以被标记为 `historical-superseded`，但不能被反向改写为“当时从未合法”。

Legacy active v2 因没有 pin review identity：当前 approval 仍有效时属于 REVIEW；当前 approval rejected/missing 时继续写入属于 HARD block。

### I40 — Review mutation 前执行 dependency impact preflight — REVIEW

在正式追加新的 SourceSequenceReview 前，应先针对目标 exact manifest digest 执行 transition dry-run，并扫描对应 InterviewNote Issue 的 ExplorationSession dependencies。

至少区分：

```text
active-current
active-stale
historical-current
historical-superseded
legacy-active-unpinned
legacy-active-blocked
legacy-historical-unpinned
```

Preflight 应明确报告 blocking sessions，以及需要：

```text
continue
start new v3 session
pause until approved review
manual review
```

当前该规则仍为 REVIEW，而不是 HARD，原因是：

```text
transition preflight PASS
↓
创建新的 SourceSequenceReview file
```

仍是两个独立仓库操作；目前没有一个 persisted applied-transition identity / impact snapshot 让 review file 必须证明自己来自已通过的 preflight。因此工具可以发现和预演 stale impact，但尚不能阻止 writer 完全绕过 preflight 直接提交一个结构合法的新 review file。

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
validate source sequence manifest
validate source sequence reviews
validate source sequence review transition
validate source sequence review impact
validate exploration checkpoint
validate exploration history
validate exploration attribution
validate all
```

`validate all` 聚合这些检查，并返回 machine-readable report。

当前仓库已经提供：

- `source-sequence-manifest.v1` validator；
- `source-sequence-review.v1` registry / chain validator；
- `source-sequence-review-transition.v1` planner；
- SourceSequenceReview staleness impact analyzer；
- `exploration-session-checkpoint.v1/v2/v3` validator；
- ExplorationSession history validator。

语义 attribution、segmentation 与 reviewer judgement 仍属于人工 / AI review gate。

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
manifest-backed frontier contract      PASS（有 manifest 的 sequential case）
source sequence review approval        PASS（有 manifest 的新 sequential case）
review transition stale-head guard     PASS（发生 review transition 时）
review dependency impact               REVIEW（发生 review mutation 时）
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
SourceSequenceManifest 始终属于 Derived。
Manifest schema PASS 不等于 approved。
Approval 通过独立 exact-digest review chain 表达。
新的 review-pinned sequential checkpoint 使用 v3 固定 source_review_id。
历史输入与当前信任状态分离，后续 review 不反向改写历史授权事实。
Review transition 基于 expected effective head；stale transition 必须 fail closed。
Active v3 session 在 pinned review 被 supersede 后必须 stale，不得原地换绑。
Review mutation 前应显式预演下游 staleness；当前 apply 尚未与 preflight 原子绑定。
不确定性显式存在。
Issue 驱动工作，但不能绕过 Validation。
顺序学习保持因果性，包括 position 内时间边界。
Exploration checkpoint 的 Source type、frontier 和 closure 可机器审计。
Outcome 不自动生成 Cause 或 Verified Weakness。
Migration 必须幂等。
遇到 stale / ambiguous state 必须 fail closed。
```