# Issue #1539 provenance and recovery boundary

本文档是 #1539 的本地审查设计，不授权 GitHub mutation。

## Provenance conclusion

SourceNote v1 的 `source-note-issue-record.schema.json` 允许 artifact 使用
`provenance=source_projection`，但没有 `derived_from` 字段。现有
`reconcile-xhs-source-notes.js` 也只按固定 path/role 生成 `source_projection`，没有
producer manifest、输入 Raw ref 或逐 projection mapping；它生成的 `派生链接` 还是
历史 Derived 路径提示，不能作为 lineage proof。

Pinned `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437` 的 commit message 是
`ci: verify batch 0062 completion gates`，只新增 CI workflow。#30 的
`note_detail`、`note_desc`、`note_json` 和 `note_images` 四个 exact paths 的 path history
都只有 root `init` commit `6ac989f4dde363fe7b8ddb28fcc13852845cf409`。因此仓库内没有
可以证明这些 projection 是从哪个 Raw artifact 一对一生成的链路。相同 note id、相同
commit、文件名相似或 history 共现均不构成 `derived_from`。

## Backward-compatible status and gate

v1 增加了可选的 record-level `provenance_status`，旧记录省略它仍然合法。新生成的 v1
record 使用：

```json
{
  "status": "pinned-source-artifact",
  "raw_lineage_claim": "not-claimed"
}
```

这句话只表示 projection bytes 被固定 SourceRevision、path、Git blob SHA 绑定；它不
声称 projection derived-from Raw。policy 对旧 v1 记录在缺字段时作同样的保守分类，绝不
从文件名补字段。

Source Review 默认 `provenance_mode=raw-lineage`，保持原 gate：所有 projection 必须
有可解析到登记 `raw_capture` 的 `derived_from`。另一个显式模式是
`provenance_mode=pinned-source-artifact`，只有同时满足以下条件才可能 source-ready：

- 所有非 lineage checks 通过，且每个 projection 的 recorded reference 能由审计 manifest
  在 pinned commit tree 中验证 path+blob SHA；仅有 ref/blob SHA 的结构绑定不够；
- 有独立 Source Review evidence；
- request 固定 `provenance_statement=pinned-source-artifact; raw-lineage-unproven`；
- `raw_projection_traceability` 仍报告 fail/未证明，系统只通过明确的 pinned-artifact
  alternate gate，绝不把它改写为 Raw lineage pass。

因此当前 #1539 的 30 条在没有独立 evidence 时继续 blocked。Boundary Review evidence
永远不能满足 Source Review evidence。

## Evidence binding and non-circular digest

独立 evidence marker 必须绑定本批次 transition 的全部不可变事实：InterviewNote/SourceNote
身份、两份 body SHA-256、SourceRevision、provenance mode/statement、pinned manifest
digest，以及完整的机器 check 数组。`evidence_subject_sha256` 是这些事实的确定性
digest；它不包含 `review_evidence.comment_id`、`reviewed_at` 或其它评论 locator，因而
不会形成“request 包含 comment id、comment 又必须包含 request digest”的自引用循环。

最终 request 的 `request_sha256` 仍由 receipt/CAS 在评论 locator 已知后绑定；它不是
evidence subject digest 的输入。旧 marker、跨 transition/批次 marker、body SHA、manifest
digest、provenance mode 或任一 check 不匹配时，解析结果为无效 evidence 并保持 blocked。

## #30 manifest and deterministic Boundary Review plan

`data/pilot/issue-1539/plan-manifest.json` 固定 #1509--#1538 的 30 条 Source Review
mapping；planner 先为这 30 条构造全量 pinned-artifact manifest，读取 pinned commit tree
并逐项核验每个 artifact 的 repository/path/ref、Git blob SHA 和对应
`InterviewNote # / SourceNote # / SourceRevision`。之后每条 alternate request 都必须用
相同 mapping 逐项 `verifyManifestItem`，再进入强 transition planner 的事实/check 校验；
不能只相信顶层 `verified=true` 或 manifest digest。planner 随后按
`pending-source-note-issue-number-ascending` 选择后续 Boundary Review 候选。planner 只读取 Issue、评论、SourceNote body 和 ownership search；它不接受
`--apply`，不生成 InterviewContext、学习标签或 GitHub mutation。

### Future authorized Source Review apply

每条 transition 必须带：

1. exact InterviewNote/SourceNote Issue number、stable identity、两者 body SHA-256；
2. SourceRevision id，以及 manifest SHA 或 pinned repository ref；
3. machine-computed checks 和独立 evidence comment；
4. exact ownership result；
5. immutable `transition_id`、evidence subject digest 和最终 request digest。

真实 runner 对 pinned recovery 必须显式传入经验证的
`--pinned-artifact-manifest <path>`；缺少该参数或 manifest 校验失败即停止，不进入
任何 lifecycle 或 receipt mutation。

普通 transition 的 `expected_initial_status` 必须是 `captured`；live status 在开始阶段
必须精确等于该值。对 #922 的实际 blocked 项，只有显式
`recovery_mode=blocked-source-recovery` 才允许 `expected_initial_status=blocked`，并且
同时强制 pinned manifest、no-Raw statement、`evidence_subject_sha256` 和独立 evidence。
该模式的受限状态机是 `blocked → source-review → source-ready`；普通 transition 不能借
`expected_initial_status=blocked` 改写 terminal blocked。`source-review` 仅作为同一已开始
transition 的中间态继续执行，不能改变其初始 CAS 事实。

已到 `source-ready` 但只缺 receipt 时，另有明确的
`recovery_mode=source-ready-receipt-repair`；它要求
`expected_initial_status=source-ready`、`decision=source-ready` 和 evidence subject，
只允许 receipt repair，不重新执行 lifecycle label transition。普通 transition 不得用
`expected_initial_status=captured` 冒充这一终态恢复。

主控在批准前复核 native dry-run digest。批准后 runner 串行、按 manifest 顺序执行，
每笔写入前再读 CAS facts；任何 body、revision、ownership、evidence 或 receipt 漂移都
停止。durable intent 在第一笔 mutation 前按 transition 写入本地受保护 store，receipt
在成功写入后原子落盘；网络错误不自动重试 write。

恢复只重新 dry-run：`captured` 可从同一 request 进入 review/final，`source-review`
继续同一 request，final 无 receipt 只补 receipt，final+匹配 receipt 返回
`already-applied`。request digest、body SHA、SourceRevision 或 owner 不一致则停止。

### Future authorized Boundary Review apply

Boundary 批次继续复用 `source-note-boundary-review-batch.v1` 和现有 transition
planner；每个 SourceNote 单独拥有 stable `transition_id`、body CAS、证据 locator、
child identity 和 receipt。批次先整体 dry-run；任何一条 blocked 都不执行部分写入。

Boundary evidence 只允许决定 0/1/N InterviewNote boundary；它不能进入 Source Review
request，也不能给 v1 projection 虚构 `derived_from`。每笔 boundary mutation 后限速并
落盘进度、intent、receipt；恢复时只按 live state 分类为 pending/ready、target+
receipt `already-applied`、target 无 receipt `receipt-repair`，不靠旧 index 猜测。

## Review boundary

本设计停在主控评审边界。未获得授权前，不写 Issue/comment，不改 label/status，不创建
InterviewContext，不启动 #924/#925，不 merge/close。
