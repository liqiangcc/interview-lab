# SourceNote Boundary Review

## 目的

Boundary Review 回答一个窄问题：

```text
当前 SourceNote 的第一手 / provenance-validated Source evidence
究竟能证明 0、1 还是多个有边界的 InterviewNote case？
```

它发生在 Source intake 之后、InterviewNote 创建之前。不得在这里拆题、生成答案或补 InterviewContext。

## 状态

```text
pending
├─ not-interview      → 0 InterviewNote
├─ single-interview   → 1 InterviewNote
└─ multi-interview    → 2..N InterviewNote（只登记稳定 child identity；仍需后续 materialization）
```

`multi-interview` 不是“把一家公司的一面/二面机械拆开”。同一次候选流程中的多轮可以先作为一个有边界的 InterviewNote case，round/sequence 后续在 Derived 层处理。

## 证据顺序

继续遵守 InterviewNote 分类门禁：

```text
Raw / source-native evidence
↓
provenance-validated Source projection
↓
Derived 只能提示，不能单独授权
```

证据不足时保持 `pending`；不能因为标题包含“面经 / 一面 / 二面”直接授权。

## Transition contract

请求使用：

```text
<!-- source-note-boundary-review-transition
{ ... source-note-boundary-review-transition.v1 ... }
-->
```

`multi-interview` 使用 `source-note-boundary-review-transition.v2`，并携带 `interview_cases`。每个 case 只允许提交稳定的 `case_key` 和至少一个精确 Source artifact 引用及 locator；调用方不得提交 `interview_note_id`。

请求必须绑定：

- repository + Issue number；
- SourceNote stable id；
- 当前 Issue body SHA-256；
- `boundary:pending` expected state；
- exact SourceRevision id；
- v2：exact SourceCapture manifest SHA-256；
- v1：exact Git source snapshot ref；
- durable review evidence comment；
- explicit checks + limitations。

必需 checks：

```text
source_identity
source_revision_binding
source_content_coverage
event_boundary
no_cross_source_mixing
no_fabrication
```

全部必须 PASS 才允许确定性 transition。

## CAS / fail-closed

planner 在任何写入前检查：

```text
body digest
boundary machine state
boundary label
task:boundary-review
SourceRevision binding
manifest / source snapshot binding
review evidence comment exact request
```

任一 stale 都拒绝写入。

`--apply` 会在 PATCH 前重新读取 live Issue 并再次执行全部检查，然后使用一次 GitHub Issue PATCH 同时更新 body + labels。写入后重新读取 live body/labels 并运行 SourceNote validator，只有全部一致才写 applied receipt comment。

## Identity rule

当前 `interview-note-issue.v2` 规定：

```text
interview_note_id = <source.system>:<source.external_id>
```

因此 transition 不接受调用方提供 InterviewNote id：

```text
not-interview
→ []

single-interview
→ [<source.system>:<source.external_id>]
```

一条 SourceNote 的多个 case 使用如下稳定 identity contract：

```text
child_id = <source.system>:<source.external_id>:event:<sha256(xhs-note:<external_id> + "\\n" + case_key)>
```

`case_key` 是持久 identity 的不可变 opaque key：创建后必须在重排、重命名或展示措辞调整时原样复用。它必须是小写、稳定、来源证据可定位的 key；不能使用易变标题、Issue number、数组位置或 `case-1` 之类顺序编号作为唯一依据。展示标题/措辞不参与 identity，也不应写入 machine contract。transition 会按 `case_key` 规范化排序，所以输入重排不会改变 child ID 或已存在 decision 的幂等判断；回归测试锁定了重排和展示措辞变化。

同一 SourceNote 内所有 child evidence locator 必须全局唯一，即使它们来自不同 artifact；重复 locator 直接 fail closed。child ID 使用完整 SHA-256，并在同一 transition 内检查派生 ID 集合，任何 key/identity collision 都不能写入。

因此 `multi-interview` 只更新 SourceNote 的 Boundary Review Derived record，不创建 InterviewNote Issue，也不会把 SourceNote 直接当作 InterviewNote。没有足够 case evidence、出现重复 key 或 identity 冲突时保持 fail closed。

## 幂等

成功 apply 后写入 `source-note-boundary-review-applied.v1` receipt comment。重复执行相同 transition 时，如果 live target state、case mapping 与 receipt 一致，则返回 already-applied，不重复修改。

## #910 首个 acceptance

`xhs-note:6a8abe2d000000001602b26e` 的 review evidence：

- stable SourceRevision `xhs:6a8abe2d000000001602b26e:r1`；
- manifest SHA-256 固定；
- Raw A11y 直接包含来源标题与 16 条面试问题；
- provenance-validated `observed.json` / `readable.txt` 与 Raw A11y 一致；
- Source 标题明确为“携程Java后端一面面经”；
- 当前 Source evidence 未出现第二家公司、第二候选流程、二面/三面或“跨多次面试累计汇总”等信号；
- 精确面试发生时间仍 unknown，不因分类而提高时间精度；
- 5 张 Raw image 保留为证据，但本次 event-boundary 判断不依赖 OCR/Derived image transcription。

因此首个 transition 候选是：

```text
pending → single-interview
InterviewNote id candidate = xhs:6a8abe2d000000001602b26e
```

只有 planner + live CAS + post-write validator 全部 PASS 后才算生效；随后才进入独立的 InterviewNote 创建流程。
