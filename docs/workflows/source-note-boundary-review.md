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
└─ multi-interview    → 2..N InterviewNote（当前 identity contract 暂不能落地）
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

当前无法为一条 SourceNote 安全分配多个互不相关 InterviewNote identity。因此：

```text
multi-interview
→ capability gap
→ fail closed
→ 不修改 SourceNote
```

禁止临时发明 `:event-1`、`:event-2` 等持久化 identity。

## 幂等

成功 apply 后写入 `source-note-boundary-review-applied.v1` receipt comment。重复执行相同 transition 时，如果 live target state 与 receipt 一致，则返回 already-applied，不重复修改。

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
