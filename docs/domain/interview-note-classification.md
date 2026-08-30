# InterviewNote 分类门禁

## 目的

并不是旧来源仓库中的每一篇帖子、每一个文件、每一个“面试”标题都应该被创建成 `InterviewNote`。

`InterviewNote` 表示：

> **能够由第一手来源合理证明为一个有边界的真实面试经历、面试轮次，或同一次候选流程中的多轮面试记录。**

分类必须发生在创建 InterviewNote Issue **之前**。

## 为什么需要分类门禁

历史来源中可能同时存在：

- 一次真实面试的记录
- 同一次候选流程的多轮面试总结
- 多家公司 / 多次面试累积出的经验总结
- 面试准备清单
- 技术教程
- 转述题库
- 招聘信息
- 经验文章

如果只按关键词、标题或旧 `note_structured` 结果机械迁移，就会把不同领域对象混在一起。

## 可以判定为 InterviewNote 的情况

### 单次面试 / 单轮记录

来源明确描述一个具体面试事件，例如：

```text
2022.08.02 提前批面试
百度 Java 一面
...
```

即使作者忘记部分问题，仍然可以是 InterviewNote。作者的不确定性应原样保存。

### 同一次候选流程中的多轮记录

一篇来源可以覆盖多轮面试，只要第一手来源足以证明这些轮次属于同一次有边界的候选流程，例如：

```text
某公司校招
一面 → 二面 → 三面 → HR 面
```

此时可以先作为一个 InterviewNote case 保存，并在 Derived 层进一步拆分 round / sequence。

### 以真实经历为主体，同时附带总结

如果来源主体清楚记录一次真实经历，末尾再附复盘、建议或准备经验，仍然可以是 InterviewNote。

关键判断不是“有没有总结”，而是：

> 是否存在一个可以由 Source 直接界定的真实面试 case。

## 不应直接判定为 InterviewNote 的情况

### 跨多次面试的累计经验

例如来源明确表示：

```text
这些都是不断面试积累来的经验
```

正文按“技术基础 / 技术宽度 / 原理深入 / 项目经验”组织，而没有可证明的一次具体面试流程。

这更像 InterviewDigest / PreparationSource，而不是一个 InterviewNote。

### 题库 / 教程 / 经验清单

标题包含“面试题”“Java 面试”“大厂面试”等关键词，并不能证明内容来自一次真实面试。

### 来源边界无法证明

如果正文看起来可能是一次面试，也可能是多次经验汇总，而关键图片又缺失或损坏，应进入：

```text
boundary_review
```

而不是猜一个分类。

## Fail-closed 规则

分类证据不足时：

```text
不创建 InterviewNote Issue
        ↓
记录 boundary review 结果
        ↓
保留原始来源
        ↓
等待更强 Source evidence
```

禁止：

```text
“看起来像面经”
        ↓
自动创建 InterviewNote
```

## Raw 与 Derived 的分类优先级

分类时的证据优先级：

```text
Raw HTML / Raw image / source-native metadata
        ↓
经过 provenance 校验的 Source projection
        ↓
Derived 只能作为提示，不能单独授权分类
```

历史 `note_structured` / `note_tagged` 即使已经把来源标成某公司、某轮次，也不能反向覆盖 Raw Source 的歧义。

OCR 也是 Derived。若原图存在，应以原图为证据根；若原图缺失，OCR 不能单独把一个 ambiguous source 提升为 InterviewNote。

## 多事件来源

未来可能出现一篇 SourceDocument 明确记录多个互不属于同一候选流程的真实面试事件。

不要为了维持“一篇帖子一个 InterviewNote”而强行合并。

正确方向是：

```text
SourceDocument
    ↓
0..N 个 InterviewNote case
```

当前仓库尚未正式建立 `SourceDocument` Issue 契约，因此遇到此类来源时先 boundary review，不提前发明持久化结构。

“一篇真实面经一个主 Issue”仍成立；但“一篇来源帖子一定等于一篇真实面经”不成立。

## 分类结果

初始迁移至少支持：

```text
issue_candidate
    Source 足以证明 InterviewNote，可进入 Issue lifecycle

boundary_review
    当前证据不足，禁止自动创建 InterviewNote

excluded_from_interview_note
    当前证据支持“不是一个有边界 InterviewNote”的判断
```

`excluded_from_interview_note` 只表示不进入 InterviewNote 模型，不表示丢弃来源。

## 重新分类

以下情况可以重新进入 classification review：

- 找回缺失原图
- 找回完整页面 / API payload
- 发现之前遗漏的来源正文
- 证明原先多个片段实际属于同一次候选流程
- 证明原先认为是单次面试的内容其实是跨多次汇总

重新分类必须基于新增 Source evidence，而不是为了迁移数量调整标准。

## Pilot 边界样本

`xhs:625564d70000000001025e46` 验证了该门禁：

- Raw 标题包含“阿里蚂蚁金服 Java 中间件 6 轮面试题! 总结”；
- 但正文主要是跨面试的经验归纳，并明确说“这些都是不断面试积累来的经验”；
- 页面引用的 5 张历史图片在旧仓库全部为 0 字节，无法用 Raw image 消除歧义。

因此当前结果是：

```text
excluded_from_interview_note
```

不创建 InterviewNote Issue。未来若恢复原图，再重新审核。

## 核心不变量

```text
先分类，再创建 InterviewNote identity。
标题关键词不是分类授权。
Derived 不能单独授权 InterviewNote 分类。
证据不足时 fail closed。
不属于 InterviewNote 不等于丢弃来源。
一篇来源文档可能最终映射到 0..N 个 InterviewNote case。
```
