# ExplorationSession 探索会话

## 目的

真实面经不是一次性 ETL 输入，而是可以反复回看的 case。我们可以不断从中加深理解、验证回答模式、发现关系、暴露知识缺口。

`ExplorationSession` 表示一次有明确边界的探索/学习过程，不修改 Raw Source。

## 原则

```text
Source 保持稳定。
Exploration 不断累积。
理解可以继续加深或修正。
```

不能因为完成一轮探索，就把 InterviewNote 标记成永久 `processed=true`。

## Session target

一次 session 应有一个主目标：

```text
InterviewNote
或
CanonicalQuestion
```

初期优先支持 InterviewNote，因为真实面经负责驱动学习和后续知识建设。

## Session mode

### Learning

AI 一点一点解释当前 Source unit 和可观察的 reasoning structure。

目标：

- 识别 cue
- 判断当前问题类型或 Source unit 类型
- 激活相关知识结构
- 在 question-like Source 中形成 response skeleton
- 理解新输入为什么改变之前判断
- 在当前 Source-backed depth frontier 到达后停止

### Training

AI 更接近面试官，在合适 checkpoint 前不主动解释。

目标：

- 测 spontaneous recognition
- 测 response structure
- 测 follow-up handling
- 找出反应链路在哪里断掉

### Source analysis

重点分析来源结构，而不是学习者表现，例如：

- SourceQuestion boundary
- SourceUnit / SourceFragment segmentation
- sequence / follow-up candidate
- source ambiguity
- real phrasing variant
- Source unit 内时间阶段

### Knowledge audit

用真实面经挑战现有 Knowledge，例如：

- Canonical mapping coverage
- Answer 是否覆盖真实问法
- 缺失的 follow-up handling
- Knowledge boundary 问题

## No-look-ahead

顺序探索必须维护当前 Source frontier。

最基础形式：

```text
revealed_position
+
当前 mode 允许使用的已有知识
```

如果一个 Source unit 内部还存在未来时间片段，则还需要：

```text
temporal_cursor
```

有 reviewed `SourceSequenceManifest` 时，应进一步把 frontier 表示为：

```text
manifest_id + manifest digest
+
source_unit_id
+
source_fragment_id（如有）
```

禁止使用当前 frontier 之后的 Source 来解释、预测或评分当前步骤。

后来的 session 可以带着更多知识回看早期位置，但必须明确这是 retrospective analysis，而不是实时模拟。

## Source unit type 与 learning loop

Session 不应假设所有 Source unit 都是 interviewer question。

当前推荐至少区分：

### Question-like / interviewer-cue

```text
literal
→ classification
→ knowledge
→ response
→ depth
→ anticipation
→ closure
```

### Stage summary

没有逐字问题、只记录某个持续阶段时，不应反向制造本场具体问题。

```text
literal
→ classification
→ preparation structure
→ routing
→ dynamic depth
→ plausible dimensions
→ closure
```

### Outcome / reflection summary

结果、候选人感受或事后解释没有 interviewer cue 时，不应强行生成 response/depth/follow-up。

```text
literal
→ evidence classification
→ structured extraction
→ attribution boundary
→ closure
```

这些类型不是永久封闭枚举。系统真正需要统一的是 evidence discipline、no-look-ahead 和 Source / Derived 分离，而不是强制相同 layer 数量。

## 小步交互

默认粒度：

```text
一个 Source 输入或时间片段
→ 一个解释层
→ 消化 / 停顿
→ 下一层
```

不要一次性把字面意思、考察意图、完整答案、follow-up 和总结全部倒出来。

目标是训练可复用 mental path，而不是最大化一次输出的信息密度。

## Position closure 与 depth frontier

每一个 Source position 或 position 内时间片段都应该允许显式执行 `closure_assessment`。

推荐语义：

```text
Source-backed cue
↓
已经形成可复述、可推导、可应对合理追问的最小闭环
↓
继续扩展将主要由一般知识而不是 Source 驱动
↓
position_status = complete / ready-to-close
```

关键原则：

> “深挖”不授权无限展开；Source 仍然决定 depth frontier。

Position closure 只表示当前 Source unit 的本轮训练价值已经形成最小闭环，不表示相关领域知识已经完整，也不表示整个 InterviewNote 永远不再需要探索。

## Outcome / reflection 的归因边界

结果型 Source 必须把不同证据等级分开保存。

至少保持：

```text
Outcome
Process Evidence
Self Assessment
External Evaluation
Verified Weakness
Cause
Hypotheses
```

并遵守：

```text
Outcome
≠
Failure Cause
≠
Verified Weakness
```

- 结果只能证明结果；
- 候选人自我感受不能自动升级为面试官评价；
- `Verified Weakness` 需要独立、可定位或可重复验证的 evidence；
- 没有直接证据时 `Cause` 保持 `unknown`；
- 假设必须显式标记为 `Hypotheses`；
- 后来的 outcome 不能反向污染前面已经按当时 evidence 得出的判断。

## 建议的 Session record

基础 runtime 字段：

```text
session_id
target_type
target_id
mode
started_at
source_revision_id
revealed_position
revealed_range
source_unit_type
loop_phase
temporal_cursor
revealed_within_unit
position_status
session_status
closure_reason
completed_at
```

当 session 使用 reviewed `SourceSequenceManifest` 时，还应稳定记录：

```text
source_manifest_id
source_manifest_sha256
source_unit_id
source_fragment_id
```

业务学习内容继续单独记录：

```text
focus
observed_cues
classification
response_skeleton
plausible_followup_dimensions
new_findings
knowledge_gaps
relation_candidates
actions
```

最重要的是稳定 target identity、SourceRevision、Source frontier，以及 observation 与正式 action 的分离。

## Machine checkpoint contract

Issue 中的 sequential ExplorationSession checkpoint 使用一个人类可读正文 + 一个 machine marker：

```text
<!-- exploration-session-checkpoint
{ ... }
-->
```

### v1 — 兼容 contract

`exploration-session-checkpoint.v1` 保存自报的 position / temporal cursor，并由 checkpoint/history validator 检查其结构与跨 checkpoint 单调性。

v1 继续支持历史和尚未建立 SourceSequenceManifest 的 sequential case。

### v2 — Manifest-backed contract

当当前 `SourceRevision` 已有 reviewed SourceSequenceManifest 时，新 sequential InterviewNote session 应优先使用：

```text
exploration-session-checkpoint.v2
```

v2 在 v1 字段基础上增加：

```text
source_manifest_id
source_manifest_sha256
source_unit_id
source_fragment_id
```

机器语义：

```text
manifest_id + digest
→ 固定本 session 使用的 sequence definition

source_unit_id
→ 证明 revealed_position 对应哪个已登记 SourceUnit

source_fragment_id
→ 证明 position 内 temporal frontier 到哪个已登记 fragment
```

v2 validator 会对照 manifest 检查：

```text
Target / SourceRevision
↓
Manifest
↓
SourceUnit identity / position / type / text
↓
SourceFragment order（如有）
↓
Checkpoint frontier
```

因此 v2 不再只相信自由文本：

```text
revealed_position = 4
```

而是要求：

```text
source_unit_id
→ manifest 中确实 position=4
```

如果 SourceUnit 有 fragments：

- `source_fragment_id` 必须属于该 unit；
- `temporal_cursor == source_fragment_id`；
- `has_withheld_within_unit` 由 fragment 是否为最后一个推导；
- history 中 fragment frontier 必须按 manifest order 单调向前。

如果 SourceUnit 没有 fragments：

```text
source_fragment_id = null
temporal_cursor = null
has_withheld_within_unit = false
```

### Manifest 版本边界

`SourceSequenceManifest` 是 Derived Extraction，不是 Raw Source。

Checkpoint v2 同时固定：

```text
source_manifest_id
+
source_manifest_sha256
```

如果之后 review 发现 unit/fragment segmentation 应修正，不应原地改变历史 session 所依赖的 frontier；应创建新的 manifest version，并由新的 ExplorationSession 显式引用。

## Session history machine gate

Workflow 不只验证当前 comment，还会读取整个 Issue comment history，按 `session_id` 分组后验证状态机。

当前可机器阻止：

```text
revealed_position 倒退 / 跳步
previous position 尚 active 就推进
SourceRevision 静默切换
同 position SourceUnit / phase / status 倒退
fully revealed 又退回 withheld
completed session resurrection
```

对于 v2，还会阻止：

```text
manifest_id / manifest digest 静默切换
同 position source_unit_id 切换
source_fragment_id 按 manifest order 倒退
```

## Live Issue-comment validation

仓库 workflow 监听新建/编辑的 Issue comment。

当 comment 包含 `ExplorationSession checkpoint` 或 `exploration-session-checkpoint` marker 时，依次执行：

```text
校验当前 checkpoint
↓
提取 Issue 全量 comment history
↓
校验整个 ExplorationSession history
```

因此新 checkpoint 不能只写人类可读 YAML 而没有 machine marker。

历史上 contract 引入前已经存在的旧 comment 不要求原地改写；新 session 在已有 manifest 时优先 v2，没有 manifest 时可以继续 v1。

机器 gate 可以证明 Source frontier 与登记 manifest 的引用关系，但仍不能仅凭 JSON 证明：

- manifest segmentation 一定语义正确；
- 自然语言解释完全没有 semantic look-ahead；
- outcome 归因一定合理。

这些继续属于 Source review / semantic review。

## Finding 与 Action 分离

Session 可以发现：

- 可能的 SourceQuestion
- 可能的 follow-up relation
- 可能的 Canonical boundary 问题
- Answer coverage 缺失
- learner weakness candidate
- Source runtime protocol 的改进候选

但发现本身不授权正式 mutation。

```text
Exploration finding
    ↓
显式 review / domain operation
    ↓
validated state change
```

避免一次对话中的临时判断悄悄变成正式知识。

尤其是 outcome 或 self-assessment 本身，不授权创建 failure-cause 或 verified-weakness 结论。

## Issue 中的 Session history

InterviewNote Issue 是 Exploration 的自然入口。

可以把简洁 session summary 写入 Issue Comment 或链接到 artifact，至少标明：

- session / mode
- source revision
- revealed range
- source unit type / position status
- 必要时的 temporal frontier
- 关键 finding
- 产生的 action

有 reviewed manifest 时，还应记录 manifest / unit / fragment identity；这些状态同时写入 v2 machine marker，由 CI 验证。

不要因为 AI 生成了长对话，就把大量重复 transcript 全塞进 Issue。只沉淀可复用发现、决策和学习 checkpoint。

## 多遍挖掘示例

```text
Pass A：按真实顺序经历整场面试
Pass B：检查问题边界 / SourceUnit segmentation
Pass C：检查 sequence / follow-up
Pass D：映射 CanonicalQuestion
Pass E：用真实问法挑战 Answer
Pass F：Mock Interview / response-loop 训练
Pass G：知识提升后再次回看
```

这些只是示例，不是固定 lifecycle。Session 应按目的划界，而不是把 pass 编号变成永久状态。

## Completion 语义

### Position completion

一个 Source position 可以在当前 session 中完成。

Position completion 表示当前 Source-backed cue 已达到本轮 closure gate，不表示相关知识永久完成。

Machine checkpoint 中，非 active `position_status` 必须对应 `loop_phase=closure` 并给出非空 `closure_reason`。

### Session completion

一个 ExplorationSession 可以完成。

Session completion 应至少满足：

```text
本 session 目标范围内的 Source 已消费完
+
每个当前目标 position 已达到 closure 或被显式标记为 deferred
+
findings / actions 已区分
+
未把 derived content 伪装成 Source
```

Machine checkpoint 中，`session_status=completed` 必须同时有：

```text
position_status = complete
loop_phase = closure
completed_at = 可解析时间
```

一篇 InterviewNote 不存在“永远彻底探索完成”。

新的知识、新的 SourceRevision、新的求职目标或新的薄弱点，都可以触发下一轮探索。

## 核心不变量

```text
一次 Session 有边界。
Source case 可以长期复用。
未来 Source context 永远不能泄漏到当前顺序解释。
Position 内尚未 reveal 的信息同样属于未来。
有 reviewed manifest 时，优先用稳定 SourceUnit / SourceFragment identity 表达 frontier。
不同 Source type 可以使用不同 learning loop。
Source 与 Derived 必须分离。
SourceSequenceManifest 始终属于 Derived。
Outcome 不自动生成 Cause 或 Verified Weakness。
Finding 经过显式 review/apply 后才成为正式 mutation。
每个 position 和 session 都应有明确 closure 语义。
新的 sequential checkpoint 应具备可机器验证的 frontier / type / phase / closure record。
反复练习应该不断强化 Interview Reasoning Loop。
```
