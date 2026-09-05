# Interview Lab

Interview Lab 是一个以真实面经为第一手资料、由 AI 持续做高质量、低摩擦、逐层分析并沉淀知识的面试学习实验室。

项目不把面经当作一次性 ETL 输入。真实面经会被长期保留，并持续驱动问题提取、知识建设、答案准备、逐层分析和复盘。

## 日常使用

对普通学习过程，用户不需要理解仓库内部的 Manifest、Review、Checkpoint 或 Validator。

一篇面经录入后，系统先把它变成**可筛选、非剧透的学习样本**：

```text
录入真实面经
↓
审核基础 InterviewContext
↓
同步 company / role / recruitment / round 标签
↓
生成 non-spoiler Issue title
↓
进入学习池
```

用户可以先筛选：

```text
company:kuaishou role:backend round:2
```

再选择一篇开始学习。

学习前可以知道公司、岗位族、招聘类型、轮次和面试时间；结果默认 sealed，直到 Source 时间线真正走到 outcome 阶段。

默认体验：

```text
筛选 / 选择一篇真实面经
↓
AI 展示非剧透基础信息
↓
AI 展示当前真实输入
↓
AI 一点一点分析当前已知信息
↓
用户说“下一步”继续
↓
有价值的知识安全沉淀
↓
以后继续回看 / 深挖
```

常见交互只需要：

```text
找快手后端二面
开始读这篇面经
下一步
这里什么意思？
这个怎么回答？
再深入一点
复盘一下
```

SourceRevision、SourceSequenceManifest、SourceSequenceReview、checkpoint/history validator、review transition/staleness 等都属于 runtime infrastructure，默认由 Agent 自动维护；只有出现真实阻塞、需要审计，或当前任务本身是在开发 Interview Lab 时才展开。

详见：

- `docs/workflows/user-facing-workflow.md`
- `docs/domain/interview-context.md`

## 核心链路

```text
真实面经 InterviewNote
        ↓
学习前上下文 InterviewContext
        ↓
真实问题 SourceQuestion
        ↓
标准问题 CanonicalQuestion
        ↓
题目分析 Analysis
        ↓
准备答案 Answer
        ↓
分析 / 复盘 Analysis / Review
```

`InterviewContext` 负责学习发现与 non-spoiler 基础信息；它不替代 Source，也不包含提前泄漏的 Outcome。

## 核心原则

1. **真实面经优先。** 先忠实保存来源实际留下的内容，再做解释。
2. **Raw Source 不可被下游覆盖。** 后续认知可以变化，第一手证据不能被悄悄改写。
3. **Raw 与 Derived 分层。** InterviewContext、OCR、问题提取、归一化、分析、答案、复盘都属于派生层。
4. **一篇真实面经对应一个主 Issue。** Issue 是 AI 和人的主要工作界面。
5. **Issue 驱动工作流，证据驱动事实。** Issue、Label、Comment 用于查询、协作和状态投影；第一手 artifact 仍是证据根。
6. **先把录入面经变成可筛选学习样本。** Reviewed InterviewContext 驱动 Learning Discovery Labels；Unknown 不猜，Outcome 不剧透。
7. **逐步学习禁止偷看未来。** 当前步骤只能使用已经揭示的历史上下文和当前输入。
8. **一点一点拆解。** 一篇一篇读，一次一个输入，一次一个解释层。
9. **核心是 AI 层层分析质量，而不是背答案或刻意练习。** AI 应持续展示如何识别问题、定位知识、组织因果、判断深度、预判合理下钻方向，并根据新信息更新判断；用户通过长期阅读这些高质量分析自然吸收方法。
10. **同一篇面经可以反复挖掘。** Source 保持稳定，ExplorationSession 可以不断增加。
11. **重要状态由 Validator 证明。** Label 只是状态投影，不能替代领域验证。
12. **底层复杂度不能变成用户复杂度。** 新 schema、validator 或 runtime identity 默认隐藏，不自动增加用户日常操作。
13. **真实 Pilot 决定是否增加机制。** 没有可复现 correctness / provenance / concurrency 问题时，不因理论完备性继续堆叠协议。

## 领域分层

- **Source**：真实面经、原始页面、图片、来源身份和 SourceRevision。
- **Extraction / Discovery**：InterviewContext、OCR、SourceQuestion、问题边界、顺序和结构解释。
- **Knowledge**：CanonicalQuestion、关系、Analysis、Answer 和证据映射。
- **Exploration**：ExplorationSession 只维护当前 Source frontier、解释层、closure 与可复用 finding，保证跨会话连续分析。
- **Issues**：AI / 人的操作界面和工作流控制面；Learning Discovery Labels 用于筛选真实面经。
- **Runtime Infrastructure**：Manifest、Review、Checkpoint、Validator、staleness 等正确性机制；默认不进入学习者日常操作面。

## Issue 驱动

```text
GitHub Issue
    ↓
稳定 machine identity
    ↓
第一手来源引用
    ↓
Reviewed InterviewContext
    ↓
non-spoiler title + Learning Discovery Labels
    ↓
用户筛选学习样本
    ↓
有边界的 AI / 人学习操作
```

对于 `InterviewNote`：

```text
1 InterviewNote
↕ 1:1
1 primary GitHub Issue
```

Issue number、标题和显示文本都不是领域 identity。

## 学习方式

默认使用 source-first sequential reading：

```text
非剧透 InterviewContext
+
过去已揭示的信息
+
当前新输入
        ↓
AI 识别它到底在问什么
        ↓
定位并整理知识结构
        ↓
解释关键因果 / 必要前提
        ↓
判断当前意图
        ↓
组织回答骨架
        ↓
选择深度 / 标出边界
        ↓
等待下一条真实输入
```

核心规则：

> **Future context must not influence current interpretation.**

也就是：未来面经内容和 Outcome 不得反向影响当前步骤的理解。

面向用户的分析表达统一遵循 `docs/learning/interview-analysis-style.md`：AI 基于当前已知信息主动做高质量、低摩擦、逻辑连续的逐层分析；用户不需要额外完成自测、复述或评分流程。

## 仓库语言

面向人的内容默认使用中文；机器标识保持稳定英文。详见：

- `docs/conventions/language.md`

原始面经永远保持原文，不为了语言统一而翻译或改写。

## 基础机制文档

日常使用入口：

- `docs/workflows/user-facing-workflow.md`

领域与底层机制文档：

- `docs/domain/interview-context.md`
- `docs/architecture/boundaries.md`
- `docs/architecture/source-revisions.md`
- `docs/domain/model.md`
- `docs/issues/interview-note-issue.md`
- `docs/issues/label-taxonomy.md`
- `docs/workflows/interview-note-lifecycle.md`
- `docs/workflows/interview-context-batch-review.md`
- `docs/workflows/issue-driven-workflow.md`
- `docs/workflows/source-note-boundary-review.md`
- `docs/workflows/source-note-boundary-review-batch.md`
- `docs/workflows/issue-1539-boundary-expansion.md`
- `docs/learning/source-first-reading.md`
- `docs/learning/interview-analysis-style.md`
- `docs/learning/exploration-sessions.md`
- `docs/migration/xhs-source-migration.md`
- `docs/validation/invariants.md`
- `docs/conventions/language.md`

## 当前阶段

首个真实 sequential-learning Pilot 已经验证了 Source frontier、review-pinned checkpoint、history gate 和 staleness 等底层边界。

当前优先级：

```text
更多真实面经
→ 录入后完成 InterviewContext / Learning Labels
→ 用户从 Issue 池筛选学习样本
→ 验证学习体验
→ 验证分析质量 / 逻辑连续性 / 理解摩擦
→ 验证知识沉淀质量
→ 真实失败暴露新问题时再扩展底层协议
```

而不是继续主动寻找无限的下一层 runtime abstraction。
