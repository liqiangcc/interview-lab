# Interview Lab

Interview Lab 是一个以真实面经为第一手资料、由 AI 陪伴持续拆解、训练和沉淀的面试学习实验室。

项目不把面经当作一次性 ETL 输入。真实面经会被长期保留，并持续驱动问题提取、知识建设、答案准备、模拟面试和复盘。

## 核心链路

```text
真实面经 InterviewNote
        ↓
真实问题 SourceQuestion
        ↓
标准问题 CanonicalQuestion
        ↓
题目分析 Analysis
        ↓
准备答案 Answer
        ↓
训练 / 复盘 Training / Review
```

## 核心原则

1. **真实面经优先。** 先忠实保存来源实际留下的内容，再做解释。
2. **Raw Source 不可被下游覆盖。** 后续认知可以变化，第一手证据不能被悄悄改写。
3. **Raw 与 Derived 分层。** OCR、问题提取、归一化、分析、答案、复盘都属于派生层。
4. **一篇真实面经对应一个主 Issue。** Issue 是 AI 和人的主要工作界面。
5. **Issue 驱动工作流，证据驱动事实。** Issue、Label、Comment 用于查询、协作和状态投影；第一手 artifact 仍是证据根。
6. **逐步学习禁止偷看未来。** 当前步骤只能使用已经揭示的历史上下文和当前输入。
7. **一点一点拆解。** 一篇一篇读，一次一个输入，一次一个解释层。
8. **目标是形成面试反应链路，而不是背答案。** 训练识别问题、定位知识、组织回答、判断深度、预判追问和根据新信息更新判断。
9. **同一篇面经可以反复挖掘。** Source 保持稳定，ExplorationSession 可以不断增加。
10. **重要状态由 Validator 证明。** Label 只是状态投影，不能替代领域验证。

## 领域分层

- **Source**：真实面经、原始页面、图片、来源身份和 SourceRevision。
- **Extraction**：OCR、SourceQuestion、问题边界、顺序和结构解释。
- **Knowledge**：CanonicalQuestion、关系、Analysis、Answer 和证据映射。
- **Training**：逐步学习、Mock Interview、ReviewProgress、知识缺口和反复训练。
- **Issues**：AI / 人的操作界面和工作流控制面。

## Issue 驱动

```text
GitHub Issue
    ↓
稳定 machine identity
    ↓
第一手来源引用
    ↓
有边界的 AI / 人操作
    ↓
Validator
    ↓
正式状态变化
    ↓
同步 Issue / Label
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
过去已揭示的信息
+
当前新输入
        ↓
识别
        ↓
定位知识
        ↓
判断当前意图
        ↓
组织回答骨架
        ↓
选择深度
        ↓
预判合理追问方向
        ↓
等待下一条真实输入
```

核心规则：

> **Future context must not influence current interpretation.**

也就是：未来面经内容不得反向影响当前步骤的理解。

## 仓库语言

面向人的内容默认使用中文；机器标识保持稳定英文。详见：

- `docs/conventions/language.md`

原始面经永远保持原文，不为了语言统一而翻译或改写。

## 基础机制文档

- `docs/architecture/boundaries.md`
- `docs/architecture/source-revisions.md`
- `docs/domain/model.md`
- `docs/issues/interview-note-issue.md`
- `docs/issues/label-taxonomy.md`
- `docs/workflows/interview-note-lifecycle.md`
- `docs/workflows/issue-driven-workflow.md`
- `docs/learning/source-first-reading.md`
- `docs/learning/exploration-sessions.md`
- `docs/migration/xhs-source-migration.md`
- `docs/validation/invariants.md`
- `docs/conventions/language.md`

## 当前阶段

当前处于机制验证阶段：

```text
文档边界
→ 机器契约
→ Validator
→ 5 篇 XHS pilot
→ 实际 AI 阅读/审核
→ 修正机制
→ 再按可信 Source 时间从旧到新全量迁移
```

在 pilot 证明身份唯一、Raw/Derived 分离、来源可追溯、迁移幂等和 AI 可用之前，不开始全量历史迁移。
