# Issue #1605 guarded full SourceNote boundary transition

该 runner 只消费已经生成的 `full-boundary-manifest.json` 和其中逐条 request 文件的
`source-note-boundary-review-transition` machine marker。默认是 plan-only；它不会因为
plan 成功而修改 GitHub。

入口 validator 固定要求 #1605 full scope 的 419 条 item、既定
`plan_digest=ad3e3974c21415e2371b8fe77a2ae54b65dd7783516ed6a68ef61bb070877781`，并校验
当前 full manifest canonical digest `40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a`。
任意 subset、重算后不同的 manifest 或只伪造 item count 的 manifest 都会被拒绝。

## Plan gate

```bash
npm run plan:issue-1605-full-boundary-transition
```

每条 manifest item 都会：

1. 读取并解析恰好一个 formal request marker；repository、parent #1605、Issue、transition
   id 与固定 XHS ref `95b77bb261048059846273688e4b90a2e108b437` 必须一致。
2. 对该 SourceNote 做 live GET，并用显式 `page=1..N&per_page=100` 读取 comments。每个只读
   GET（包括每一页 comments）对 EOF/TLS/timeout 等 transient exec failure 默认且最多重试 5 次，
   使用短指数退避；非 transient failure 立即失败，最终失败仍生成 blocked item 并进入顶层
   errors。每页必须是数组，且必须
   观察到短终页；到达 100 页仍没有短终页即 fail closed。PATCH/POST 不使用这个 retry wrapper。
3. 用 `parseSourceNoteBoundaryReviewTransition` 和
   `planSourceNoteBoundaryReviewTransition` 校验 evidence comment、body SHA、SourceRevision、
   pending boundary state、labels、SourceNote validator 和 multi-interview case evidence。

生成的 plan digest 绑定 manifest digest、request marker digest 和预期目标；live 的 current
body/labels/status 仍保留在报告中作为 CAS 审计字段。每条 live read failure 都会生成完整
blocked item 并进入顶层 `errors`；任何 `status=blocked` 或缺少 `decision` 的 item 也会被汇总，
因此任一条失败都会使整批 plan 为 blocked，CLI 返回非零且不会显示 `plan-ready`，mutation
count 保持 0。

## Apply gate

apply 必须显式声明所有高风险开关：

```bash
node scripts/apply-issue-1605-full-boundary-transition.js \
  --manifest data/pilot/issue-1605/full-boundary-manifest.json \
  --output data/pilot/issue-1605/full-boundary-transition.plan.json \
  --journal data/pilot/issue-1605/full-boundary-transition.journal.json \
  --lock data/pilot/issue-1605/full-boundary-transition.lock \
  --prior-plan data/pilot/issue-1605/full-boundary-transition.plan.json \
  --apply \
  --confirm-plan <plan.canonical_digest> \
  --authorization-proof <parent-1605-transition-authorization.json> \
  --max-mutations <N>
```

authorization proof 必须是 `issue-1605-full-boundary-transition-authorization.v1`，明确绑定
repository、`parent_issue: 1605`、`action: authorize-full-boundary-transition`、manifest
digest、plan digest、正整数 `max_mutations`、`allow_live_github: true` 和 parent #1605
上同一个 authorization marker。CLI 的 `--max-mutations` 不得超过 proof 的
`max_mutations` ceiling；旧的 `authorize-evidence-comments-only` proof 不可升级为
transition 权限。

apply 在每个 item 写入前重新 GET + 分页 comments 并再次调用同一 planner。PATCH payload
只含 `{body, labels}`：body 只允许改变 SourceNote machine `boundary_review` 和可读的
`## 边界审核`，labels 只允许把 `boundary:pending` 改为 `boundary:<decision>` 并移除
`task:boundary-review`；其他 SourceNote 内容和 labels 必须保持 CAS 相等。PATCH 后必须
重新 GET、运行 SourceNote validator，并确认 target body/labels 完全相等，之后才 POST
`source-note-boundary-review-applied` receipt。

PATCH 或 receipt POST 的 response 不确定时只做 bounded read-only reconcile。若没有恰好一个
收敛结果，journal 进入 `uncertain`，后续运行拒绝 blind retry；不会根据错误重新发送同一
mutation。journal 和 exclusive lock 都是 apply 的强制条件，`--max-mutations` 统计实际
PATCH/POST 尝试。目标已经到位但缺少 receipt 时，item 会进入 `receipt-needed`；repair receipt
对 `already_applied` 使用 request 的旧 body SHA 作为 `previous_body_sha256`，使用 live 当前
目标 body SHA 作为 `new_body_sha256`，这样仍能通过同一 SourceRevision/ref、body CAS 和 plan
digest 校验并安全重规划。每个 applied receipt 必须精确绑定当前 plan digest、manifest digest、
expected SourceRevision id/ref 和唯一 transition；同一 transition 出现多个 applied receipt
会 fail closed。journal 带 canonical digest；exclusive lock 持有并持续校验 lock file 的
device/inode，并在创建、释放时 fsync parent directory。journal/plan 的 atomic JSON rename
之后也会 fsync parent directory，确保崩溃后目录项持久化。预算不足时在下一笔 mutation 前停止。

当 journal 已有成功 mutation、需要从冻结计划恢复时，`--prior-plan` 应指向最初获授权的
plan 文件。GitHub REST API 可能以不同顺序返回同一组 labels；runner 会先验证 live label
集合与 prior plan 完全相同，再保留 prior plan 的逐项 label 表示，从而不因 REST 排序改变
canonical plan digest。集合发生变化仍会 fail closed；不能用一个未经授权的 prior plan 绕过
`--confirm-plan` 或 parent authorization。

本变更不执行 live mutation。取得主控 transition authorization、reviewer 评审和明确 apply
窗口前，不应提供 `--apply`。

## Remaining evidence stage (557 actionable / 421 blocked)

剩余范围使用独立的 `remaining-boundary.manifest.json`，绑定批准的 1397-row snapshot、固定
XHS ref 和 978-row scope；它只排除已完成的 419-row manifest，不复用 419 的 authorization 或
request artifacts。默认路径分别是：

```text
data/pilot/issue-1605/remaining-boundary-evidence-plan.json
data/pilot/issue-1605/remaining-boundary-evidence-progress.json
data/pilot/issue-1605/remaining-boundary-evidence-progress.lock
data/pilot/issue-1605/remaining-boundary-evidence-requests/
```

`node scripts/issue-1605-full-boundary-coordinator.js` 默认只生成 plan。计划必须覆盖 978/978，
其中 557 条为 actionable（含 152 条 `not-interview`），421 条保留为 blocked。#735 的
“multi-interview 少于两个 case”是唯一允许保留的 blocked audit error，记录在
`blocked_errors`，不进入 executable `errors`，所以不会阻断其余 557 条；任何其它错误仍使
plan fail-closed。

evidence 阶段需显式 `--mode evidence --confirm-plan <digest> --authorization-proof <file>`。
该 proof 使用独立的
`issue-1605-remaining-boundary-evidence-authorization.v1` schema，并必须绑定 parent #1605、
remaining manifest digest `fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9`、
scope digest `6ef4fa26e838fe8c30d571c08807c09d5a3280eb40aa4af57d679274f6a131a1`、frozen
snapshot digest（必须等于当前 plan 的 `frozen_inventory.digest`）、当前 plan digest、正整数
`max_mutations`、`authorized_by` 和 `proof_sha256`。proof 的 comment_id 必须
在 #1605 上恰好对应一个完全相同的 authorization marker；CLI 的 `--max-mutations` 不得
超过 proof ceiling。没有 proof 或 marker 时 evidence mode fail-closed，默认仍是 plan-only。

它对每条 actionable item 在 POST 前重新 GET 并检查 `boundary:pending` 与 body SHA；live Issue
GET 与 comments 分页 GET 仅对 transient TLS/网络/timeout 错误使用最多 5 次短指数退避，非
transient 错误或耗尽重试都保持 fail-closed。只 POST
review-evidence comment，绝不 PATCH SourceNote。POST 响应未知时最多做 bounded exact-marker
reconcile；不会自动重试 POST。每条成功 marker 生成独立 request 文件，journal 与 request 使用
带 file/parent-directory fsync 的 atomic write，并在每次 durable write 前验证独占 lock。
完成的 419 artifacts 不会被覆盖。
