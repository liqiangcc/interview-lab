# Issue #1658：专用 InterviewNote materialization runner

`npm run plan:issue-1658-materialization` 是 #1658 的默认入口。它读取固定的 `/tmp/materialization-13-plan.bound.json` bounded adapter，并 GET 指定的授权评论；默认只生成 plan-only 输出，不触发 1460-row fresh replan，也不产生 GitHub POST/PATCH。旧的全量入口保留为 `npm run plan:issue-1658-materialization-full`。

只有显式 `--apply --allow-live-github --max-create 13 --max-receipts 13` 才会进入 mutation gate。apply 在 lock 内重新读取 13 个 SourceNote、每条 comments 与全库 `type:interview-note` ownership，逐条执行 body SHA、SourceRevision、boundary、唯一 owner、projection body/labels 和 receipt CAS；任一漂移都 fail closed。

## 绑定与选择

所有 runner 物料固定绑定：`parent_issue=1611`、`controller_issue=1658`、`boundary_parent_issue=1605`、`liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。每个 `would-materialize` 和 `already-materialized` row 都保存由完整 request canonical JSON 计算的 `request_sha256`。

single case 只允许来源派生 identity：`<system>:<external_id>`；multi case 必须使用 SourceNote boundary record 中的稳定 `case_key`，并映射为 `childInterviewNoteId(source, case_key)`。标题、数组序号和 issue number 都不能构造 identity。materialized receipt 使用唯一 `source-note-interview-materialized` machine marker，并绑定 request SHA、SourceNote body/revision/ref、case key 和 owner issue。

计划只允许三种 action：`skip-not-interview`、`already-materialized`、`would-materialize`。任何 blocked row、顶层 error、SourceNote/manifest/ownership/plan digest 漂移，都会使 `ok=false`、`ready_for_apply=false`，并保持：

```json
{"patch":0,"post":0,"create":0,"label":0,"interview_note":0}
```

`not-interview` 有 owner 时永不删除；既有 InterviewNote 只做 GET reconciliation，不改 body、Raw、labels 或 Derived 内容。`would-materialize` 只能在未来明确授权后创建缺失 owner 并写一条 receipt；重复 owner、receipt 冲突或 projection CAS 失败都停止。

## Apply gate（本轮不可达）

`--apply` 不是默认模式，且必须同时提供：

```sh
node scripts/issue-1658-materialization-runner.js \
  --apply \
  --authorization-comment-id <comment_id> \
  --allow-live-github \
  --max-create <would_count> \
  --max-receipts <would_count>
```

controller issue #1658 的指定 comment 必须包含且只包含一个 `issue-1658-interview-note-materialization-authorization` marker；fetched comment 自身的 `issue_url`（以及存在时的 `issue_number`）必须实际指向 #1658，`url` 必须与指定 `comment_id` 精确对应。marker 的 `comment_id`、五个 fresh digest、`allow_live_github=true` 以及 create/receipt ceiling 必须全部和本次 plan/CLI 参数精确相等。plan 必须顶层无 error、无 blocked row、全量 CAS-ready；否则在获取 lock 前拒绝，任何目标写入均不会发生。

可达的 apply writer 具有 atomic exclusive lock、inode/token ownership check、fsync durable journal 和 per-row intent。`mutation_attempted=true` 在每个 POST 前先持久化；恢复时任何未 `complete` 的 in-flight phase（包括 `create-pending`、`create-unknown`、`receipt-pending`、`uncertain`）都拒绝重试。每条 create/receipt 之前都会 fresh GET SourceNote、owner、comments 并执行 body/revision/identity/label CAS；不提供 label PATCH 路径。create POST 后 owner GET/validate 的异常先持久化 `uncertain`/`possibly_performed=true`，再只允许有限次 exact-owner reconcile；receipt POST 只允许有限次 exact machine marker reconcile。不确定、重复、冲突或超时都永久 fail closed，禁止盲重试；只有唯一且完整验证的收敛结果才清除 uncertain。

本任务不执行目标 PATCH/POST、InterviewNote create、label 写入或 Issue closure。允许的远端写操作仅限本任务完成后的 branch push、PR 创建和 #1658 机器证据评论。
