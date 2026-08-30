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
[XHS] <来源原始标题或可读描述> · <面试时间 / 来源时间 / unknown> · <短 source id>
```

标题只用于导航，不承担领域 identity。标题中的时间必须注明语义；不能把来源发布时间显示成实际面试时间。

如果公司、岗位、轮次来自 Derived 推断，而不是来源直接提供，不得通过标题让它看起来像已确认的 Source fact。

## Machine marker

新建 InterviewNote Issue 顶部必须包含稳定隐藏 marker：

```text
<!-- interview-note: id=<interview-note-id> schema=interview-note-issue.v2 -->
```

用于幂等同步、重复检测和机器 identity 解析。历史 `v1` Issue 只为兼容读取，不再用于新建记录。

## Machine record

Issue 中应包含一个隐藏的 `interview-note-record` JSON block。字段名、enum、schema version 保持英文稳定。

`v2` 明确拆分三种时间事实：

```text
source_published_at
    来源内容首次发布/机器发布时间

source_edited_at
    来源页面明确显示或机器字段证明的编辑时间

interview_occurred_at
    原文能够直接证明的实际面试发生时间
```

不能继续使用语义含混的单一 `source_time` 字段创建新记录。

## 时间事实规则

每个时间字段都显式记录精度：

```text
exact      YYYY-MM-DD 或带时区 timestamp
month      YYYY-MM
year       YYYY
month_day  MM-DD（原文只给月日、年份无法证明）
unknown    value=null
```

禁止为了排序提高时间精度。例如来源只写“9.18”时，应记录：

```json
{"precision": "month_day", "value": "09-18"}
```

而不是因为笔记恰好发布于 2023-09-18，就自动改成 `2023-09-18`。

`month_day` 能保存第一手事实，但没有年份，不能单独用于跨年 chronology 排序。此时 planner 可以显式回退到 `source_published_at`，同时继续保留真实的 `interview_occurred_at=09-18`。

三种时间可以同时存在，且可能相差很远。

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

可包含来源直接提供或 capture 层确认的信息，例如 source system、external source id、original URL、SourceRevision、capture timestamp、来源发布时间/编辑时间、原文明确给出的实际面试时间。

三类时间必须保持语义独立。

### 原始标题

只展示能够从第一手来源直接验证的标题。如果只有 parser 或 Derived 推断结果，必须明确 provenance，不能升级为 Raw title。

### 原始正文

忠实展示来源正文或经过 provenance 校验的 readable source projection。不得润色、纠正技术结论、把陈述改成问题、补写缺失内容、把 OCR 与原始正文静默合并。

### 原始附件

引用 HTML、JSON、图片、hash 等不可变 artifact。大体积内容应引用，不要全部复制进 Issue。历史文件存在但为空、损坏或不可用时必须明确标记。

### 来源限制

显式记录已知缺失、不确定性和采集限制。Unknown 必须保持 unknown。

### 派生链接

Derived 内容必须与 Raw 清晰隔离，例如 SourceQuestion、CanonicalQuestion、ExplorationSession、OCR、历史 `note_structured` / `note_tagged`。

**OCR 永远不能因为原图中包含主要面试内容，就被提升成 Raw Source。** OCR 可以成为可读 Derived projection，但正式 Source 仍必须指向原图 artifact。

## Label

Label taxonomy 的唯一 SSOT：`config/issue-labels.json` 与 `docs/issues/label-taxonomy.md`。Label 只是查询和状态投影，不是领域有效性的 proof。

## Comment

Comment 用于记录 source-review finding、recovery attempt、不确定性、decision rationale、ExplorationSession 摘要、commit/report 链接。Comment 不得成为“修订后的 Raw Source”。

## Close / Reopen

正常关闭只表示第一手 Source case 达到稳定 `source-ready`。只因 Source 层原因 reopen；下游知识或训练变化不 reopen Source lifecycle。

## 幂等要求

迁移和同步在创建 Issue 前必须按稳定 InterviewNote identity / machine marker 查询。重复执行必须 reconcile 已有 Issue。

## 核心不变量

```text
一篇真实面经一个主 Issue。
Issue 是操作文档，不是唯一证据存储。
Raw 与 Derived 必须可见分离。
来源发布时间、来源编辑时间、面试发生时间互不替代。
只知道月日时保存 month_day，不猜年份。
OCR 永远保持 Derived，并追溯到原图。
Machine identity 独立于标题和 Issue number。
迁移和同步必须幂等。
```
