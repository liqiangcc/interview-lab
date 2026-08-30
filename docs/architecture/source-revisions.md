# SourceRevision 策略

## 目的

一份已采集的面经后来可能被发现不完整、损坏，或者找到更好的第一手快照。

本文定义如何提升 Source fidelity，同时不改写历史。

核心规则：

```text
旧的第一手证据永远不能被静默替换
```

## InterviewNote 与 SourceRevision

`InterviewNote` 是一篇真实来源 case 的稳定 identity。

`SourceRevision` 是该 case 的一次不可变捕获快照。

```text
InterviewNote
├── SourceRevision 1
├── SourceRevision 2
└── ...
```

新增 revision 不会创建新的 InterviewNote，除非调查证明材料实际上属于另一个来源 case。

## 什么时候创建新 revision

当新的第一手证据改变了已捕获的 Source 表示时创建，例如：

- 找回原来缺失的原图
- 完整页面快照替代截断快照
- 找回原始 API/source payload
- 损坏 artifact 被重新正确采集
- 新 capture 包含此前确实无法获得的来源内容

以下情况不创建 SourceRevision：

- OCR 改进
- SourceQuestion 提取变化
- 公司/岗位推断变化
- Canonical 映射变化
- Answer 被修正
- 学习者获得新的理解

这些属于下游 revision。

## Revision 的不可变内容

一个 SourceRevision 应通过稳定引用记录：

```text
source_revision_id
interview_note_id
captured_at
source_external_id
source_url（如有）
artifact ids
artifact hashes
capture method/version
known capture limitations
```

一旦注册，定义该 revision 的 artifact 和来源级元数据不得被静默原地修改。

## Preferred revision

下游提取可以指定当前 preferred revision：

```text
InterviewNote
├── rev-1
└── rev-2  ← 新提取默认使用
```

`preferred` 只表示“当前最适合作为下游输入的第一手快照”，不代表旧证据失效或可以删除。

切换 preferred revision 前必须验证它属于同一个 InterviewNote，并满足来源完整性要求。

## Revision lineage

尽量记录新增 revision 的原因，例如：

```text
supersedes: rev-1
reason: recovered missing original images 3-5
```

`supersedes` 表达证据优先级推进，不表达删除。

## Raw、确定性 Projection 与 Derived

必须持续区分：

```text
Raw artifact
→ 捕获到的第一手 bytes/content

Deterministic source projection
→ 从 Raw 中忠实提取正文、标题、图片顺序等

Derived interpretation
→ OCR、问题提取、metadata inference、relations、knowledge
```

Parser 改进后可以重新生成确定性 projection，但它必须明确追溯到某个不可变 SourceRevision，不能冒充原始 bytes。

除非来源本身直接提供文字，否则 OCR 永远属于 Derived。

## Issue 行为

InterviewNote Issue 可以展示 preferred source representation 以便阅读，但必须显示足够的 revision identity，不能制造“历史从未变化”的假象。

当新的 SourceRevision 成为 preferred：

1. 若 Issue 已关闭，则因 Source 原因 reopen。
2. 注册新的不可变 revision。
3. 记录来源级原因。
4. 重新执行 source integrity review。
5. 更新 preferred revision 引用。
6. 同步 Issue 展示。
7. 满足条件后回到 `source-ready` 并关闭。

旧 revision 不能被删除。

## 对下游的影响

新的 preferred revision 可能让下游数据变 stale，例如：

- SourceQuestion span 变化
- 找回的内容暴露新的问题
- 缺失图片恢复后顺序发生变化

Source revision 操作不能静默重写 Derived，而应标记或报告需要重新提取/审核的对象。

## 并发规则

任何依赖特定 SourceRevision 的操作都应记录或检查它实际使用的 revision。

如果提交时当前 preferred revision 已与预期不同，必须 fail closed，并基于最新证据重新评估。

## 删除策略

SourceRevision 属于证据，原则上不删除。

只有法律/隐私义务，或者确认 artifact 从未属于该 InterviewNote 等特殊情况才允许移除，并留下可审计 tombstone/decision record，同时不得保留被禁止保留的内容。

## 核心不变量

```text
InterviewNote identity 稳定。
SourceRevision 不可变。
更好的证据追加历史，而不是改写历史。
Derived 数据应标明所依赖的 revision。
新 revision 可以使下游解释失效，但不能修改旧证据。
```
