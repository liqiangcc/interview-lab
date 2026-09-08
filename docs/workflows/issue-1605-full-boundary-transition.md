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
2. 对该 SourceNote 做 live GET，并用显式 `page=1..N&per_page=100` 读取 comments。每页必须
   是数组，且必须观察到短终页；到达 100 页仍没有短终页即 fail closed。
3. 用 `parseSourceNoteBoundaryReviewTransition` 和
   `planSourceNoteBoundaryReviewTransition` 校验 evidence comment、body SHA、SourceRevision、
   pending boundary state、labels、SourceNote validator 和 multi-interview case evidence。

生成的 plan digest 绑定 manifest digest、request marker digest 和预期目标；live 的 current
body/labels/status 仍保留在报告中作为 CAS 审计字段。任一条失败，整批 plan 为 blocked，
mutation count 保持 0。

## Apply gate

apply 必须显式声明所有高风险开关：

```bash
node scripts/apply-issue-1605-full-boundary-transition.js \
  --manifest data/pilot/issue-1605/full-boundary-manifest.json \
  --output data/pilot/issue-1605/full-boundary-transition.plan.json \
  --journal data/pilot/issue-1605/full-boundary-transition.journal.json \
  --lock data/pilot/issue-1605/full-boundary-transition.lock \
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
PATCH/POST 尝试。每个 applied receipt 必须精确绑定当前 plan digest、manifest digest、
expected SourceRevision id/ref 和唯一 transition；同一 transition 出现多个 applied receipt
会 fail closed。journal 带 canonical digest；exclusive lock 持有并持续校验 lock file 的
device/inode，并在创建、释放时 fsync parent directory。预算不足时在下一笔 mutation 前停止。

本变更不执行 live mutation。取得主控 transition authorization、reviewer 评审和明确 apply
窗口前，不应提供 `--apply`。
