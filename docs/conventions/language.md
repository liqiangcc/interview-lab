# 仓库语言规范

## 目的

Interview Lab 主要用于长期阅读、学习、复盘和 AI 协作，因此面向人的内容默认使用中文；同时，为了保证脚本、Schema、查询和自动化稳定，机器标识保持英文。

核心原则：

> **面向人的内容中文优先，面向机器的标识保持稳定英文。**

## 使用中文的内容

以下内容默认使用中文：

- `README.md`
- `docs/**/*.md`
- GitHub Issue 标题和可读正文
- Issue 评论、审核记录和 ExplorationSession 摘要
- Analysis、Answer、学习笔记和复盘内容
- Label 的描述文本
- 面向人的错误说明和操作说明

原始面经属于第一手资料，必须保持原文，不为了统一语言而翻译或改写。

## 保持英文的内容

以下内容保持稳定英文：

- 文件名和目录名
- GitHub Label 名，例如 `type:interview-note`
- JSON / YAML 字段名
- Schema 名称、`schema_version` 和枚举值
- `interview_note_id`、`source_revision_id` 等机器身份
- CLI 命令和参数
- 代码中的变量名、函数名、模块名和测试接口
- 自动化需要稳定匹配的机器 marker

例如：

```text
人类标题：
[XHS] 面试真题｜阿里钉钉—Java开发岗 · 2022-08-30

机器 Label：
type:interview-note
source:xhs
status:source-review
quality:image-missing
```

机器记录仍保持：

```json
{
  "schema_version": "interview-note-issue.v1",
  "interview_note_id": "xhs:630e2e22000000001103c490",
  "source_time": {
    "precision": "exact",
    "value": "2022-08-30"
  }
}
```

## 原始资料例外

Raw Source 的语言由原始来源决定。

不得为了“全仓库中文”而：

- 翻译原始面经后覆盖原文
- 纠正原作者的技术表述
- 改写原作者语气
- 把 OCR 或 AI 翻译冒充原始资料

如需翻译、解释或规范化，必须进入 Derived / Knowledge 层，并保留对原文的追溯。

## 中英文术语

领域对象和协议名可以保留英文机器名，同时在中文文档中解释，例如：

- `InterviewNote`：一篇真实面经对应的稳定领域对象
- `SourceRevision`：一次不可变的第一手来源快照
- `SourceQuestion`：从原始面经派生出的真实问题单元
- `CanonicalQuestion`：跨面经复用的标准问题身份
- `ExplorationSession`：一次有边界的面经探索/学习会话

不要求把所有技术术语强行翻译成中文。

## 新内容要求

新增面向人的仓库内容时：

1. 默认先用中文表达。
2. 机器字段继续复用既有英文契约。
3. 不为了中文化修改稳定 identity、Label 或 Schema enum。
4. 如果某个英文字符串同时承担机器匹配和人类展示职责，优先拆分“稳定机器值 + 中文展示值”。

## 核心不变量

```text
人类阅读界面以中文为主。
机器身份与协议保持稳定英文。
原始资料保持原文。
中文化不能破坏可追溯性、Schema 或自动化。
```
