# Issue #1658：专用 InterviewNote materialization runner

`npm run plan:issue-1658-materialization` 是 #1658 的默认入口。它先通过 GitHub GET-only 重新读取全量 SourceNote、全量 InterviewNote ownership 和 comments，再生成新的 SourceNote snapshot、boundary report/manifest、ownership inventory、上游 materialization plan，以及绑定这些 digest 的 #1658 runner plan。

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

controller issue #1658 的指定 comment 必须包含且只包含一个 `issue-1658-interview-note-materialization-authorization` marker；marker 的 `comment_id`、五个 fresh digest、`allow_live_github=true` 以及 create/receipt ceiling 必须全部和本次 plan/CLI 参数精确相等。plan 必须顶层无 error、无 blocked row、全量 CAS-ready；否则在获取 lock 前拒绝，任何目标写入均不会发生。

可达的 apply writer 具有 atomic exclusive lock、inode/token ownership check、fsync durable journal 和 per-row intent。每条 create/receipt 之前都会 fresh GET SourceNote、owner、comments 并执行 body/revision/identity/label CAS；不提供 label PATCH 路径。未知 POST response 只允许有限次 GET：create 只 reconcile exact owner，receipt 只 reconcile exact machine marker；不确定、重复、冲突或超时都记录 `possibly_performed=true` 并永久 fail closed，禁止盲重试。

本任务不执行目标 PATCH/POST、InterviewNote create、label 写入或 Issue closure。允许的远端写操作仅限本任务完成后的 branch push、PR 创建和 #1658 机器证据评论。
