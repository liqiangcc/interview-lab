# 面试能力训练有效性计划 v1

## 目的

Interview Lab 已经建立了较严格的 Source-first、no-look-ahead、Source / Derived 分层和可恢复 ExplorationSession 机制。下一阶段的目标不再只是证明“真实面经可以被安全地逐层阅读”，而是证明这种学习方式能够转化为**没有 AI 提示时也能稳定作答的面试能力**。

本计划定义：

```text
什么叫“能力提升”
→ 当前仓库还缺什么
→ 先修哪些默认行为
→ 哪些能力需要新的 Training / ReviewProgress contract
→ 怎样用真实面经做延迟复测和迁移验收
→ 什么证据出现后才允许声称训练有效
```

## 审计基线

审计基线：`main@acc129d46611889bb70e5645da12dd6ad0d6425a`。

本轮检查了：

- README 与用户学习入口；
- `docs/learning/source-first-reading.md`；
- `docs/learning/interview-analysis-style.md`；
- `docs/learning/exploration-sessions.md`；
- `docs/domain/model.md`；
- `docs/architecture/boundaries.md`；
- `schemas/`；
- `scripts/` 与 `scripts/lib/`；
- `test/`；
- `.github/workflows/`；
- 当前 Learning Pool / Learning Content / E2E Issues。

结论：仓库在 **Source correctness / provenance / sequential frontier** 上已经投入了较完整的机制；当前最明显的薄弱点位于 **Training Effectiveness**。

## 已经做对的部分

### 1. 真实问题驱动，而不是题库先行

真实面经仍然是训练入口，Canonical / Analysis / Answer 都位于 Derived / Knowledge 层。

这使训练能够保留：

```text
真实 wording
真实顺序
真实 follow-up
真实阶段摘要
真实 outcome 时间位置
```

而不是把所有面经先改写成同质化标准题。

### 2. no-look-ahead 适合模拟现场认知状态

当前 protocol 已经能够阻止：

```text
未来问题
未来 follow-up
作者事后注释
最终 outcome
```

反向影响当前解释。

这对训练“有限信息下做判断”是必要条件。

### 3. 分层解释有利于形成可观察的回答结构

当前 Learning loop 已经显式训练：

```text
Recognize
→ Locate knowledge
→ Build response skeleton
→ Choose depth
→ Anticipate
→ Update
```

这比只保存“标准答案”更接近真实面试需要的反应链路。

### 4. Training / ReviewProgress 已经存在领域位置

领域模型已经为：

- Mock Interview；
- recall performance；
- response quality；
- failed follow-up；
- weak dimensions；
- ReviewProgress；

保留了 Layer 3 Training / Review 边界。

问题不是领域边界不存在，而是**还没有形成完整、可执行、可验收的训练闭环**。

## 本轮发现的问题

### P0 — Training 机制不能反向增加默认 Learning 摩擦

一次 guided Learning 确实不能证明独立作答能力，但普通阅读的首要目标是：

```text
AI 基于当前信息做高质量分析
→ 用户低成本理解
→ 一点一点建立知识结构
```

因此不能为了未来的 effectiveness measurement，把 `attempt-first / reconstruction` 强制塞进每一个普通 Learning unit。那会把“训练有效性”优化成用户的日常交互摩擦。

**修复：Learning 与 Training 明确分离。**

```text
Learning（默认）
→ AI analysis-first / friction-minimized

Training（用户主动选择）
→ attempt-first / reconstruction / recall / transfer
```

用户如果只想理解面经，可以始终只说“下一步”；如果想检验掌握，再切换 Training。

### P0 — E2E completion 不等于能力提升

当前 #925 的主要验收是：

- Session 能完成；
- runtime 对用户隐藏；
- no-look-ahead；
- 可恢复；
- 有复盘和 knowledge gap。

这些可以证明产品流程成立，但不能证明：

```text
用户离开 AI 提示以后答得更好
```

**修复：能力验收必须至少加入 baseline、delayed recall 和 transfer。**

### P1 — Training 需要独立的 reconstruction，而不是污染 Learning

如果用户主动选择检验能力，听懂 AI 的结构之后需要再次无提示组织，才能区分：

```text
recognition / familiarity
vs
retrievable response skill
```

这应发生在 Training / ReviewProgress，而不是普通 Learning 的 closure gate 中。

```text
用户主动进入 Training
→ learner attempt
→ feedback / remediation
→ hide scaffold
→ learner reconstruction
→ review result
```

### P1 — 缺少 scaffold fading

如果每次复习都继续提供相同的分类、骨架和提示，系统无法证明这些结构已经内化。

**目标：随着重复训练逐步降低帮助。**

建议统一 hint level：

```text
H0 = cold / 无提示，只给真实问题
H1 = 只给轻量 cue，例如“先判断题型”
H2 = 给结构槽位，不给具体答案
H3 = 给部分回答骨架 / 局部提示
H4 = worked explanation / 完整讲解
```

能力提升的方向应是：

```text
同等或更高质量回答
+
更低 hint level
```

而不是单纯“答对次数增加”。

### P1 — ReviewProgress 只有领域定义，没有可执行训练 contract

当前领域模型已经提到 recall、last review、response quality、failed follow-ups、weak dimensions，但仓库还没有 schema / validator / user workflow 把这些串起来。

下一阶段需要 ReviewProgress v1，至少能记录：

```text
question / target identity
attempt timestamp
attempt kind: baseline | reconstruction | delayed | transfer
hint level
learner response evidence / compact reference
recognition
response structure
technical correctness
boundary / condition handling
follow-up handling
self-correction
review result
next review eligibility
```

这些全部属于 Training state，不得回写 Source 或冒充 Knowledge truth。

### P1 — 缺少 delayed retrieval / spacing workflow

同一会话内“刚讲完马上会答”不能证明保持性。

需要至少跨时间重新取回：

```text
Learning
→ immediate reconstruction
→ delayed cold recall
→ later delayed recall
```

Pilot 可以先使用简单 schedule，例如 1 天 / 3 天 / 7 天附近做实验，但不把具体间隔写成永久硬规则；间隔应能根据目标 retention window 调整。

### P1 — 缺少跨真实面经的 transfer benchmark

如果复测永远使用同一句原题，可能只是在记住 wording 或固定答案。

真正面试能力需要：

```text
同一个知识 / 推理结构
+
不同真实问法
→ 仍然能识别和组织回答
```

优先使用**用户尚未见过的真实 SourceQuestion variant** 做迁移测试；没有可靠真实 variant 时，可以使用 Derived simulation，但必须明确标注 synthetic / derived，不能伪装成真实面试发生过的问题。

### P2 — 评分容易产生伪精度

面试回答质量不是单一客观数值。不能让 AI 给出一个 `87/100` 就当成真实能力。

v1 建议使用少量、可解释的 ordinal rubric，例如每项 `0..3`：

```text
0 = 未形成可用回答
1 = 局部 / 高提示依赖
2 = 基本完整，可继续追问
3 = 稳定、边界清楚、能处理合理追问
```

分别评估：

- spontaneous recognition；
- response structure；
- technical correctness；
- boundary / condition handling；
- follow-up handling；
- self-correction。

不把总分升级成 Source truth，也不跨完全不同题目直接比较绝对分数。

### P2 — 训练数据不能污染 Source / Knowledge

learner 的错误回答、hint 使用、失败 follow-up 都属于 Training evidence。

必须保持：

```text
Learner failed this attempt
≠
Canonical Answer is wrong

Learner answered well
≠
Source proves this is interviewer expected answer
```

## 修复后的双模式闭环

### 默认 Learning：理解优先、低摩擦

对 question-like Source：

```text
真实 interviewer cue
↓
AI 主动解释它到底在问什么
↓
整理知识结构
↓
解释关键因果 / 必要前提 / 条件边界
↓
必要时给最小回答骨架
↓
到当前 Source-backed 最小闭环就停
↓
用户“下一步”
```

Learning 不要求 baseline attempt、reconstruction 或 review 操作。

### 可选 Training：能力检验

```text
同一真实问题 / 合法真实 follow-up
↓
更低 hint level
↓
cold response
↓
follow-up
↓
只在 checkpoint 后反馈
```

目标是逐步从：

```text
AI 带着想
```

过渡到：

```text
用户自己识别 → 自己组织 → 自己控制深度
```

### 延迟复测

```text
至少隔开一次真实时间间隔
↓
H0/H1 recall
↓
记录与 baseline / reconstruction 的差异
↓
如果退化，重新进入最小 remediation
```

### 迁移测试

```text
未见过的真实 SourceQuestion variant
↓
不告诉 Canonical identity
↓
用户独立识别
↓
组织回答
↓
处理真实或合理 follow-up
↓
再揭示 mapping / feedback
```

## 能力指标

### 1. Attempt coverage

多少 question-like learning unit 在 AI 讲解前保留了 learner attempt 或 explicit skip。

### 2. Hint dependence

同一知识结构重复训练时，需要的 hint level 是否下降。

### 3. Immediate reconstruction

讲解结束后，在隐藏骨架的情况下能否重新组织出最小完整回答。

### 4. Delayed recall

至少跨一个真实时间间隔以后，是否仍能独立作答。

### 5. Follow-up resilience

第一轮答案之后，面对真实/合法 follow-up 是否能更新，而不是只会背第一段。

### 6. Transfer

面对未见过的真实问法，是否能识别同一知识结构并迁移回答策略。

### 7. Calibration

用户能否区分：

```text
我真的会
我需要提示
我只记得结论
我不知道
```

不把熟悉感误当成掌握。

## Effectiveness claim gate

仓库以后不能因为：

```text
用户完成了 10 个 Session
```

就声称“提高了面试能力”。

首个 effectiveness Pilot 至少应收集：

```text
>= 10 个完整真实学习 Session
>= 30 个 question-like baseline attempts
>= 30 个 immediate reconstructions
>= 20 个跨 >=24h 的 delayed attempts
>= 10 个未见真实 SourceQuestion variants 的 transfer attempts
```

并单独报告：

- baseline vs reconstruction；
- baseline vs delayed；
- hint level 变化；
- follow-up handling；
- transfer performance；
- knowledge gap；
- 中断 / 放弃 / invalid sample。

只有当 delayed / transfer 结果显示**在不增加提示依赖**的情况下，独立回答质量有稳定改善时，才允许写“Pilot 提供了能力提升证据”。

如果只看到 immediate improvement，而 delayed / transfer 没改善，应诚实结论为：

```text
提高了当下理解 / 表现
但尚未证明长期保持或迁移
```

## 分阶段实施计划

### Phase 0 — 模式边界修复（本轮）

- [x] Learning 默认恢复为 AI analysis-first / friction-minimized；
- [x] attempt-first / reconstruction 移入用户主动选择的 Training；
- [x] 保留 scaffold fading / hint level 作为 Training 能力；
- [x] 用户工作流用“考我一下 / 模拟面试 / 无提示复测”显式进入 Training；
- [x] 明确 E2E completion ≠ effectiveness；
- [x] 提交本 Training Effectiveness 总计划。

这一步只改行为规范，不新增 runtime schema。

### Phase 1 — Training Attempt / feedback contract

目标：当用户进入 Training 时，保留“讲解前我会什么”，但不改变默认 Learning 体验。

建议产物：

- learner attempt 最小 record；
- attempt kind；
- hint level；
- explicit skip / `不知道`；
- feedback summary；
- immediate reconstruction result。

验收：

- 没有 attempt/skip 时不得把该问题标记成 ability-tested；
- AI 反馈必须引用当前 attempt 的可观察缺口，而不是只输出范文；
- Source / Derived / Training boundary 不变。

### Phase 2 — ReviewProgress v1 + scaffold fading

目标：将 Training Layer 从概念变成可恢复状态。

建议产物：

- ReviewProgress schema；
- validator；
- history / update rule；
- hint level；
- rubric；
- next-review eligibility；
- failed follow-up / weak dimension evidence。

验收：

- ReviewProgress 不能修改 Source / Knowledge identity；
- 重复 review 可审计；
- hint level 只能作为训练辅助信息，不伪装成客观能力真值；
- active review 并发更新不丢失最新进度。

### Phase 3 — Delayed retrieval workflow

目标：证明知识不是只在当前 conversation 里有效。

建议先做小规模调度：

```text
first delayed review ~= 1 day
second ~= 3 days
third ~= 7 days
```

这些只是 Pilot default，不是永久间隔公式。

验收：

- 复测前不展示旧 Answer / response skeleton；
- 优先 H0；必要时逐级加 hint；
- 保存实际时间间隔；
- 相同题重复时能比较 hint dependence 和 response quality。

### Phase 4 — Cross-case transfer benchmark

目标：验证“会这道题”是否迁移成“会这一类问题”。

优先构造：

```text
CanonicalQuestion
← SourceQuestion A（已学）
← SourceQuestion B（未见）
← SourceQuestion C（未见）
```

用 B/C 做 blind transfer。

验收：

- transfer question 在测试前没有对该 learner reveal；
- 不提前展示 Canonical mapping；
- 优先真实 Source wording；
- synthetic variant 必须显式标记 Derived；
- 结果单独统计，不和 exact-repeat recall 混在一起。

### Phase 5 — Training Effectiveness Pilot

目标：不是验收 runtime，而是验收能力变化。

Pilot 使用 within-learner longitudinal evidence：

```text
baseline cold attempt
→ guided Learning
→ reconstruction
→ delayed recall
→ transfer
```

最终报告必须包含失败样本和没有改善的题，不能只挑成功 case。

## 与现有 #919 / #925 的关系

`#919` 继续负责：

```text
Source inventory
→ reviewed learning pool
→ learning content readiness
→ basic E2E usability
```

`#925` 应增加最小 ability gate，避免把“10 次 Session 完成”误写成“训练有效”。

Training Effectiveness v1 应作为独立 Epic 承担：

```text
Attempt-first
→ ReviewProgress
→ spacing
→ transfer
→ effectiveness evidence
```

避免把 Source migration Epic 再扩张成学习科学 runtime 大杂烩。

## 非目标

v1 不做：

- 自动生成复杂个性化 spaced-repetition 算法；
- 用一个总分给用户排名；
- 用 AI 自评分替代真实证据；
- 根据一次面试失败自动推断 weakness；
- 为了做 transfer 把 synthetic question 冒充真实 Source；
- 在效果证据不足时声称“已经证明可以显著提高面试通过率”。

## 学习科学依据

本计划采用的是保守的机制映射，不把教育实验直接等同于“面试通过率”。主要依据：

1. Roediger & Karpicke (2006), *Test-enhanced learning: taking memory tests improves long-term retention*：延迟测试中 retrieval practice 相比重复学习表现出更好的保持。DOI: `10.1111/j.1467-9280.2006.01693.x`。
2. Karpicke & Blunt (2011), *Retrieval practice produces more learning than elaborative studying with concept mapping*：retrieval practice 对概念理解和推理测试也表现出优势。DOI: `10.1126/science.1199327`。
3. Cepeda et al. (2006), *Distributed practice in verbal recall tasks: A review and quantitative synthesis*：大规模综述支持分散练习相对集中练习的长期保持优势。DOI: `10.1037/0033-2909.132.3.354`。
4. Dunlosky et al. (2013), *Improving Students’ Learning With Effective Learning Techniques*：将 practice testing 与 distributed practice 评为高效用学习技术。

这些证据支持：

```text
主动取回
+
分散练习
+
反馈后再次重建
```

比单纯重复阅读更适合作为长期保持目标；但 Interview Lab 仍必须通过自己的真实面试 Pilot 验证这些原则能否迁移到“识别问题、组织回答、处理追问”这一复杂技能。

## 最终成功标准

Interview Lab 同时有两个成功标准：

```text
Learning success
→ AI 高质量压缩当前信息，用户低摩擦理解

Training success（用户选择时）
→ 能在更少提示下独立识别、组织、回答和迁移
```

Training 的成功不应只是：

```text
我看过很多面经
AI 给我的分析很完整
```

而应该是：

```text
看到一个陌生的真实问题
↓
我能自己识别它在问什么
↓
快速定位知识结构
↓
组织第一轮答案
↓
知道应该答到多深
↓
面对追问继续更新
↓
隔几天仍然能做到
↓
换一种真实问法仍然能做到
```

这才是“面经分析 → 面试能力”的完整闭环。
