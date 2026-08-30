# InterviewNote Issue 契约

## 目的

一篇真实面经通过一个主 GitHub Issue 管理。

```text
1 InterviewNote
↕ 1:1
1 GitHub Issue
```

Issue 是该 case 面向 AI / 人的主要操作文档；不可变 Raw Artifact 仍然是证据根。

## 标题

推荐格式：

```text
[XHS] <来源原始标题或可读描述> · <来源时间或 unknown> · <短 source id>
```

标题只用于导航，不承担领域 identity。

如果公司、岗位、轮次来自 Derived 推断，而不是来源直接提供，不得通过标题让它看起来像已确认的 Source fact。

## Machine marker

每个 InterviewNote Issue 顶部必须包含稳定隐藏 marker：

```text
<!-- interview-note: id=<interview-note-id> schema=interview-note-issue.v1 -->
```

用于幂等同步、重复检测和机器 identity 解析。

## Machine record

Issue 中应包含一个隐藏的 `interview-note-record` JSON block。字段名、enum、schema version 保持英文稳定。

示例：

```text
<!-- interview-note-record
{
  "schema_version": "interview-note-issue.v1",
  "interview_note_id": "xhs:<note_id>",
  "source": {...},
  "source_revision": {...},
  "source_time": {...},
  "artifacts": [...],
  "limitations": [...]
}
-->
```

机器块不用于替代人类可读正文。

## 可读正文必需章节

推荐固定顺序：

```text
## 来源身份
## 原始标题
## 原始正文
## 原始附件
## 来源限制
## 派生链接
```

### 来源身份

可包含来源直接提供或 capture 层确认的信息，例如：

- source system
- external source id
- original URL（如有）
- SourceRevision
- capture timestamp
- 来源页面显示时间及其精度

来源时间与“实际面试发生时间”是不同概念。只有在原文明确时才能认定 interview-event time。

### 原始标题

只展示能够从第一手来源直接验证的标题。

如果只有 parser 或 Derived 推断结果，必须明确其 provenance，不能升级为 Raw title。

### 原始正文

忠实展示来源正文或经过 provenance 校验的 readable source projection。

不得：

- 润色原文
- 纠正技术结论
- 把陈述改成问题
- 补写缺失内容
- 把 OCR 与原始正文静默合并

如果使用 projection，必须明确它不是 Raw bytes，并保持可追溯。

### 原始附件

引用 HTML、JSON、图片、hash 等不可变 artifact。大体积内容应引用，不要全部复制进 Issue。

如果历史文件存在但实际为空、损坏或不可用，必须明确标记，不能仅因路径存在就视为有效证据。

### 来源限制

显式记录已知缺失、不确定性和采集限制，例如：

- 原图缺失
- URL 未恢复
- timestamp 只能确认到年份
- 正文可能截断

Unknown 必须保持 unknown，不能为了流程顺畅而猜测补全。

### 派生链接

Derived 内容必须与 Raw 清晰隔离，例如：

- SourceQuestion
- CanonicalQuestion
- ExplorationSession
- 历史 `note_structured` / `note_tagged`

不得让 Derived 在视觉上成为“原始面经的一部分”。

## Label

Label taxonomy 的唯一 SSOT：

- `config/issue-labels.json`
- `docs/issues/label-taxonomy.md`

典型 InterviewNote：

```text
type:interview-note
source:xhs
status:source-review
quality:image-missing
task:source-review
```

Label 只是查询和状态投影，不是领域有效性的 proof。

## Comment

Comment 用于记录：

- source-review finding
- recovery attempt
- uncertainty / decision rationale
- ExplorationSession 摘要
- commit / report 链接

Comment 不得成为“修订后的 Raw Source”替代品。

## Close 语义

正常关闭 InterviewNote Issue 只表示：

> 第一手来源 case 已达到稳定的 `source-ready` 完成状态。

不表示：

- SourceQuestion 全部正确
- Canonical mapping 完成
- Answer 完成
- 学习者已经掌握

## Reopen 语义

只因 Source 层原因 reopen，例如：

- 找到之前缺失的第一手资料
- source identity 错误
- artifact 损坏
- 找到更好的 SourceRevision
- 发现截断
- duplicate-source ownership 需要处理

下游知识或训练变化不 reopen Source lifecycle。

## 幂等要求

迁移和同步在创建 Issue 前必须按稳定 InterviewNote identity / machine marker 查询。

重复执行必须 reconcile 已有 Issue，而不是创建 duplicate。

## 核心不变量

```text
一篇真实面经一个主 Issue。
Issue 是操作文档，不是唯一证据存储。
Raw 与 Derived 必须可见分离。
Machine identity 独立于标题和 Issue number。
迁移和同步必须幂等。
```
