# Issue #1662：动态全量 InterviewNote Context / Learning Discovery

Issue #1611 的 350 条 boundary candidate 只是历史输入，不能作为 #1662 的候选集合。#1662 的候选集合唯一来自 fresh、complete、canonical-digest 的全仓库 InterviewNote ownership inventory；inventory 中每个 owner 都必须同时绑定 `interview_note_id`、Issue number、当前 Raw body SHA 和 SourceRevision。

计划器入口：

```bash
npm run plan:issue-1662-context-learning -- \
  --ownership-inventory data/pilot/issue-1662/fresh-full-ownership-inventory.json \
  --materialization-post-audit data/pilot/issue-1662/issue-1658-materialization-post-audit.json \
  --source-review-receipts data/pilot/issue-1662/issue-1661-source-review-receipts.json \
  --context-artifacts data/pilot/issue-1662/context-artifacts.json \
  --live-issue-snapshot data/pilot/issue-1662/live-interview-note-snapshot.json \
  --label-catalog data/pilot/issue-1662/label-catalog.json
```

默认是本地 plan-only：`patch=0, post=0, create=0`。计划会 fail-closed 检查 #1658 materialization/post-audit、#1661 独立 Source Review receipt、`status:source-ready`、reviewed Context 及其 `repository/path/ref/commit/sha256`，并将 Context 作为 Derived artifact，禁止写入 Raw `body`/`next_body`。

Unknown 只会保留在 `unknown_facts`；不会猜测，也不会生成对应 Learning label。title 与 Learning labels 由 `buildLearningDiscovery` 可重放地产生，并经过 outcome-spoiler 检查。apply 不会隐式创建 label，taxonomy preflight 必须确认完整 label catalog。

Apply 的代码路径需要同时满足：Issue #1662 的 `issue-1662-authorization` marker 与正整数 `comment_id`、`allow_live_github=true`、精确 plan digest、精确 mutation ceiling、独占 lock/journal。每个 PATCH 先做 body/title/labels CAS；未知 PATCH 或 receipt POST 响应都会写入 uncertain journal 并停止，PATCH 响应必须返回完整且精确匹配的 labels。没有执行授权时，不会调用 GitHub PATCH/POST/label。

相关机器契约：`scripts/lib/issue-1662-context-learning.js`；CLI：`scripts/plan-issue-1662-context-learning.js`；测试：`test/issue-1662-context-learning.test.js`。
