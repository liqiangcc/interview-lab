# 来源与知识边界

## 目的

本文定义第一手面经、派生解释、知识资产、连续分析状态和 GitHub 工作流元数据之间不可跨越的边界。

即使后续 OCR、问题提取、Canonical、Analysis 或 Answer 被证明有误，仓库仍必须能够回到第一手证据重新构建。

## Layer 0 — Raw Source

Raw Source 只回答一个问题：

> 原始来源当时实际留下了什么？

典型内容：

- 原始页面 HTML / API 响应
- 原始标题和正文
- 原始图片及顺序
- 原始 source id / URL
- 来源直接提供的发布时间等元数据
- capture 时间
- artifact hash 和存储信息

### 规则

- capture 后的 Raw Source 不可被下游解释覆盖。
- 不纠正原作者的技术错误。
- 不润色原文。
- 不把陈述改写成问题。
- 不用 AI 补全缺失内容。
- 找到更完整的第一手资料时创建新的 `SourceRevision`，不能覆盖旧快照。

## Layer 1 — Derived Extraction

Derived Extraction 回答：

> 可以从 Raw 中合理提取或推断出什么？

例如：

- OCR
- 非直接来源字段的公司 / 岗位 / 轮次推断
- SourceSequenceManifest
- SourceUnit / SourceFragment boundary
- SourceQuestion 候选
- 问题边界
- 句子是问题、答案片段、叙述还是噪声的判断
- 面试顺序和 follow-up 候选

所有派生记录都应能追溯回 Raw Source。

Derived 可以修正、删除或重建，但不能修改 Raw。

其中 SourceSequenceManifest 需要额外区分两种语义：

```text
Raw artifact
→ immutable evidence

SourceSequenceManifest
→ reviewed Derived ordering contract
```

Manifest 只能描述有可辩护顺序的 evidence stream，不能为了获得 position 而把多个没有可靠全局顺序的 artifact 强行拼接。

一旦某个 manifest 被 ExplorationSession v2 通过 `manifest_id + content_sha256` 引用，其历史版本应保持可追溯；如果 segmentation 需要修正，创建新的 manifest version，而不是静默改写历史分析所依赖的 Source frontier。

## Layer 2 — Knowledge

Knowledge 回答：

> 可以从一份或多份真实面经中形成什么可复用的面试知识？

例如：

- CanonicalQuestion
- same / alias / follow-up / parent-child / prerequisite 等关系
- 题目 Analysis
- Answer
- Evidence 映射
- 真实问法 variants
- 预期面试深度
- 公司 / 岗位 / 轮次模式

Knowledge 天然允许演化，但绝不能成为回写第一手资料的理由。

## Analysis Runtime — ExplorationSession

ExplorationSession 只回答：

> 当前连续分析已经看到哪里、解释到哪一层、为什么在这里停止？

它可以记录 Source frontier、Source type、loop phase、temporal cursor、closure 与可复用 finding。

它不是新的事实层，也不保存个人能力评级；它只引用 Raw / Derived / Knowledge 并维护分析连续性。

## GitHub Issue — 操作界面

GitHub Issue 是主要的人机工作界面，可以作为 InterviewNote、CanonicalQuestion 等领域对象的操作型文档存储，但不能取代不可变 Raw Artifact。

Issue 提供：

- 可读的 case 文档
- Label 查询索引
- Comment 审核/决策历史
- assignment 和生命周期管理
- AI 直接访问入口

### 硬边界

Issue 编辑、Label、Comment、Close/Reopen 都不得悄悄修改 Raw Source 证据。

## 允许的依赖方向

```text
Raw Source
    ↓
Derived Extraction
    ↓
Knowledge

ExplorationSession
→ 只读取上述层并维护当前分析 frontier
```

Issue 可以横跨这些层提供操作入口，但领域事实仍由各自所属层负责。

## 禁止的流向

禁止：

- Derived 覆盖 Raw Source。
- SourceSequenceManifest 冒充 Raw 顺序证据。
- 为了学习或分析方便把多个无可靠先后的 artifact 强拼成一条 Source sequence。
- CanonicalQuestion 改写 SourceQuestion 的原始 wording。
- Answer 在原面经中直接“纠错”。
- AI 推断字段伪装成来源明确事实。
- 只凭 Label 判断领域有效性。
- Validator 失败后手工加 `ready` 类 Label 绕过门禁。
- 未来面经内容影响更早步骤的顺序学习解释。
- 找到更好快照后删除旧 SourceRevision。

## 核心不变量

```text
Raw Source 保持稳定。
SourceSequenceManifest 始终属于 Derived。
理解可以不断加深。
Derived Knowledge 可以变化。
所有来源型派生结论都应保持可追溯。
未来上下文不得影响当前顺序解释。
```
