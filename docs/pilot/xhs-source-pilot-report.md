# XHS Source Pilot 首轮报告

## 目的

本轮 Pilot 不追求迁移数量，而是用 5 个来源形态不同的 XHS 样本验证：

- InterviewNote classification 是否可靠
- Raw / Source projection / Derived 是否能严格分层
- Issue identity 与生命周期是否可执行
- 时间事实是否能保持真实语义和原始精度
- 图片缺失 / 图片有效两种场景是否能正确治理
- OCR 是否能保持 Derived
- Validator / Labels / CI 是否真正参与控制

## 结果概览

| Pilot | Source id | Live Issue | 当前结果 | 主要验证点 |
| --- | --- | --- | --- | --- |
| #1 | `630e2e22000000001103c490` | #1 | `blocked` | text-rich；2 张原图历史文件均为 0 字节 |
| #2 | `63ecd286000000001303fd16` | #2 | `blocked` | 作者不确定性；面试时间 / 发布时间 / 编辑时间拆分 |
| #3 | `6508552c000000001303f499` | #3 | `source-ready / closed` | 图片主导；Raw image fidelity review 完成；首个 Source lifecycle 闭环 |
| #4 | `656861da000000000f024258` | #4 | `source-review` | 正文 + 4 张有效原图；OCR 与 Raw 严格分离；`month_day` |
| #5 | `625564d70000000001025e46` | 不创建 | `excluded_from_interview_note` | 跨面试经验汇总边界；classification fail closed |

## Pilot #1：缺失原图必须阻塞

来源 HTML 和图片引用列表能证明页面引用了 2 张图片，但旧仓库对应的 `1.webp` / `2.webp` 都是 0 字节 Git blob。

结论：

```text
文件路径存在
≠
有效 Raw Artifact 存在
```

Issue #1 因此进入：

```text
status:blocked
quality:image-missing
task:source-recovery
```

没有用 OCR、AI 或历史 Derived 数据补图片内容。

## Pilot #2：一个 source_time 不够

Raw 正文直接写：

```text
2022.08.02提前批面试
```

而捕获页面同时证明：

```text
source_published_at = 2023-02-15T20:39:34+08:00
source_edited_at    = 2023-02-16
```

这三个时间属于不同事实。

由此将新 Issue 契约升级为 `interview-note-issue.v2`：

```text
interview_occurred_at
source_published_at
source_edited_at
```

旧 v1 只保留兼容读取。

此外，作者的：

- “还问了一个想不起来”
- “记不太清了”
- “好像是这样的问题”
- “不知道对不对”

都被视为 Source 本身的重要信息，不允许用历史 Question extraction 反向补齐。

## Pilot #3：完成首个 Source lifecycle 闭环

Raw 标题：

```text
9.18快手五战二面凉经
```

来源发布时间是 2023-09-18，但 Raw 没有直接证明面试年份，因此使用：

```json
{"precision":"month_day","value":"09-18"}
```

而不是自动补成 `2023-09-18`。

该样本有一张有效非空 Raw image：

```text
Git blob = 40af8ff629743ee3a549f69fb582b9f1af8e0e39
size     = 33136
SHA-256  = 0bbf60b5c4faf4f675dca181fbef15b768c4af01e51d153934b9a8709449a260
```

为了避免 OCR 自证 OCR，本轮通过 GitHub Actions 从固定的：

```text
liqiangcc/xhs@23a56d5aa1388cfa6fc1fa68bdb6576acad825eb
```

导出 Raw image，在独立环境直接视觉查看，再与历史 `note_img_txt` 逐行比对。

结果：

- 没有问题条目缺失
- 没有顺序变化
- 没有语义替换
- 没有 OCR 新增问题
- 差异仅为中英文标点、括号和空格等规范化

因此：

```text
Raw image
    ↓ 证据根
fidelity-reviewed OCR
    ↓ Derived readable projection
后续 SourceQuestion / Learning
```

OCR 即使通过 fidelity review，也没有被提升成 Raw Source。

剩余限制——原始 XHS URL 未登记、实际面试年份 unknown、来源编辑时间 unknown——都已经明确记录，不再构成未解释的 Source integrity 问题。

Issue #3 随后完成：

```text
status:source-review
        ↓
status:source-ready
        ↓
closed
```

`source-ready` 更新和 close 事件的 live InterviewNote validator 均 PASS。

这证明了首个完整 Source lifecycle：

```text
Raw capture
→ source-review
→ independent fidelity review
→ source-ready
→ closed
```

关闭只表示 Source 治理完成，不表示 Extraction、Knowledge 或 Training 完成。

## Pilot #4：正文、Raw image、OCR 三层可以稳定共存

该样本正文直接记录了真实面试叙事，且 4 张历史下载原图全部为有效非空 Git blobs。

Raw 正文只直接证明：

```text
11 月 27 日面试
```

因此 `interview_occurred_at` 只保存 `11-27`，不借 OCR 中的 `2023.11.27` 补年份。

结构保持：

```text
Raw HTML / Raw images
        ↓
Source projection: note_desc / note_json
        ↓
OCR Derived: note_img_txt
```

OCR 可以辅助后续阅读和 extraction，但不承担 Source truth。

## Pilot #5：不是所有旧帖子都应该创建 InterviewNote

Raw 标题虽然包含：

```text
阿里蚂蚁金服Java中间件6轮面试题! 总结
```

但正文主要按技术基础、技术宽度、原理深入、项目总结等维度组织，并明确说：

```text
这些都是不断面试积累来的经验
```

同时 5 张历史图片全部为 0 字节，当前没有更强 Raw image 证据证明这是同一次候选流程的 6 轮面试。

因此不创建 InterviewNote Issue，结果记录为：

```text
excluded_from_interview_note
```

这推动了正式的 `docs/domain/interview-note-classification.md` 分类门禁。

## 本轮已经证明的机制

### 1. Stable identity

```text
interview_note_id = source_system + external_id
```

Issue number / title / migration order 都不承担 identity。

### 2. 一篇真实 InterviewNote 一个主 Issue

4 个 candidate 均使用一个主 Issue，且 machine marker / Validator 能工作。

### 3. Raw 与 Derived 可以 fail closed

- 0 字节图片不会被误判成 Raw image
- OCR 不会被提升成 Raw
- historical structured/tagged 不会反写 Source
- OCR fidelity review 也不会改变 Raw/Derived ownership

### 4. 时间必须保存语义与精度

支持：

```text
exact
month
year
month_day
unknown
```

并区分：

```text
interview occurrence
source publish
source edit
```

### 5. Classification 必须先于 Issue 创建

来源帖子不一定等于 InterviewNote。

```text
SourceDocument candidate
        ↓
classification
        ↓
0..N InterviewNote case
```

当前只实现 InterviewNote Issue；更宽的 SourceDocument / InterviewDigest 模型以后再设计。

### 6. Source lifecycle 可以闭环

Pilot #3 已证明：

```text
source-review
→ source-ready
→ closed
```

且每个关键状态变化均由 live validator 检查。

### 7. GitHub 控制面已实际工作

- Issue Label taxonomy 已真实同步
- InterviewNote live validator 已真实触发
- repo CI 已真实通过
- lifecycle drift 能被发现
- 二进制 Raw Artifact 可以通过受控 Actions artifact 导出后独立审核

## 当前仍未证明的机制

### 1. Pilot #4 Raw image fidelity review

#4 的 4 张原图 bytes 有效，但还没有逐图独立核对，因此仍处于 `source-review`。

### 2. Source recovery 闭环

Pilot #1 / #2 的历史原图缺失，目前只证明：

```text
现有仓库没有有效图片 bytes
```

还没有建立完整的 recovery → new SourceRevision → re-review 闭环。

### 3. 真正的 no-lookahead 学习闭环

协议和文档已经存在，但还没有在 Pilot Issue 上实际执行：

```text
当前输入
→ 当前一层拆解
→ 不读取未来 Source 内容
→ 新输入
→ 更新判断
```

这是开始全量迁移前必须验证的核心用户体验。

### 4. Migration idempotency 的 live create-or-reconcile

Planner 已有 stable identity，但还需要实际重复执行同一 Pilot migration，证明不会创建 duplicate Issue，并能安全 reconcile 已有记录。

## 全量迁移结论

当前仍然是：

```text
NO-GO for full migration
```

与上一阶段相比，以下两个 gate 已经关闭：

```text
Pilot #3 Raw image fidelity review ✅
至少一个 Pilot 完成 source-ready / closed ✅
```

剩余关键 gate：

1. 在 Pilot #3 上实际执行一次 source-first / no-lookahead 学习。
2. 把该学习过程按 ExplorationSession 协议留下可复用 checkpoint，而不是完整 AI transcript。
3. 实际重复运行 migration reconcile，证明幂等且不会重复创建 Issue。
4. 对 Pilot #4 完成 Raw image fidelity review。
5. 明确 #1 / #2 missing-image 的 recovery 或终态 limitation 决策路径。

## 下一阶段推荐顺序

```text
在已 closed 的 Pilot #3 上执行第一次 no-lookahead 学习
        ↓
验证 ExplorationSession 记录
        ↓
重复 migration reconcile，验证幂等
        ↓
Pilot #4 Raw image fidelity review
        ↓
处理 #1 / #2 recovery policy
        ↓
重新评估 full migration gate
```

## 核心结论

首轮 Pilot 的价值不是“已经迁了 4 篇”，而是用真实来源提前暴露并修正了：

```text
时间语义
时间精度
artifact 有效性
OCR 边界
作者不确定性
InterviewNote 分类边界
Source lifecycle closure
```

这些问题如果在全量迁移后才发现，返工成本会非常高。

因此当前策略继续保持：

> **先用少量真实样本把机制跑通，再按可证明的真实面试时间线扩展。**
