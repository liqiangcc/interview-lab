# #1658 历史 applied boundary receipt 修复提案

这是一个 proposal-only、GET-only 的设计和 dry-run。基线为当前 main `f01716f6b531e7338ca4c59bdb4e0229df2b3375`，固定 Source 为 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。范围严格固定为 `1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458`。

本提案没有生成或发布授权：`authorization_present=false`、`authorization_required=true`、`mutation_performed=false`，`writes.post=0`、`patch=0`、`create=0`、`labels=0`、`receipts=0`。#1611 评论 5602915668 只授权 13 条 materialization-only 工作，不能作为 boundary/applied receipt repair 授权。

## 仓库语义

历史 producer 是 `scripts/lib/source-note-boundary-review-transition.js` 的 `buildAppliedReceipt()`。它生成 `source-note-boundary-review-applied.v1`，其中 `interview_note_ids` 直接来自 transition plan；该 producer/schema 没有历史 correction/reconciliation marker。现有 13 条 live applied receipt 的 ids 都是 `[]`，而当前 SourceNote 的 boundary record 都有唯一 `xhs:<external-id>` identity。

当前 consumer 是 `scripts/plan-issue-1611-live-materialization.js` 的 `exactAppliedBoundaryEvidence()`：它将 applied receipt 的 `interview_note_ids` 与当前 SourceNote `boundary_review.interview_note_ids` 精确比较，所以 13 条当前 planner 都报告 `receipt interview_note_ids mismatch`。原授权 request/plan/journal 不在本次可复核范围内，因此历史执行合法性仍是 `UNKNOWN`，不能把当前 mismatch 反推为当时 producer 一定非法。

未来应追加一个独立的 `source-note-boundary-review-applied-correction.v1` comment，保留旧 applied receipt 原文和 comment 不变。当前仓库没有这个 schema；本 PR 只定义它和严格验证器，不接入生产 planner，不实现 apply。

## 未来 correction 的最小契约

future correction 必须发布在对应 SourceNote Issue 的新 comment 中，且完整绑定 source issue/body SHA、SourceRevision id/ref、原 applied comment 的 ID/body/marker SHA、issue-1608 evidence comment 的 ID/body/marker SHA、唯一 owner 的 Issue/identity/body SHA/完整 labels，以及唯一 materialization receipt 的 ID/body/marker SHA、source/ref/owner bindings。`corrected_receipt.interview_note_ids` 对本 scope 必须恰好是该 SourceNote 派生的一个 identity，`interview_note_cases` 必须为 `null`。

未来 consumer 兼容逻辑应保持旧 receipt 的全部校验。只有以下条件同时成立，才把这一行的旧 `[]` mismatch 解释为已严格 reconciliation：旧 receipt 恰好一个且除 ids 外绑定完整；correction 恰好一个；correction 的所有 source/revision/ref/body/comment bindings 与 fresh GET 完全相等；owner 和 materialization receipt 各恰好一个且 identity 一致；corrected ids 恰好等于当前 SourceNote 机械派生 identity。缺 correction、重复 correction、任一 identity/source/ref/body SHA/comment locator 漂移、坏 digest、重复 owner 或 receipt 歧义都继续 fail closed。其他旧 receipt 字段不因 correction 被放宽。

未来单独授权只允许追加 correction marker comment，禁止修改 boundary body/labels、补发 evidence、创建 owner、materialize InterviewNote、追加 materialization receipt、Source Review 或 learning。门禁为 `max_mutations=13`、`max_receipts=13`，并要求 durable journal、单 writer lock、fresh GET/CAS；POST response unknown 必须通过 bounded paginated marker GET reconcile，无法确认时进入 durable uncertain 状态并拒绝第二次 POST。不得覆盖旧评论。

独立授权 contract/schema 和 correction marker schema 分别见 [receipt-repair-authorization.schema.json](./receipt-repair-authorization.schema.json) 与 [correction-marker.schema.json](./correction-marker.schema.json)。[future-authorization-template.json](./future-authorization-template.json) 明确是 template-only，未填入本次授权。

## 本次 GET-only dry-run

脚本 [plan-receipt-repair.js](./plan-receipt-repair.js) 只使用 `gh api` GET：逐条读取 13 个 SourceNote、各自完整 comments 分页和对应 owner Issue；它不会接受 mutation 参数，也没有 POST/PATCH/create 分支。原始最小 live snapshot 保存在 [current-live-snapshot.json](./current-live-snapshot.json)，proposal 保存在 [repair-plan.json](./repair-plan.json)。

本次实际结果：13/13 `REPAIR_ELIGIBLE`，0 blocked。这个状态只表示当前 fresh facts 满足未来 correction proposal 的严格前置条件，不表示已授权、已执行或历史执行已验证。

| SourceNote | Owner | issue-1608 evidence | applied receipt | materialization receipt | 当前 proposal |
|---:|---:|---:|---:|---:|---|
| #1309 | #1674 | 5601731380 | 5602392005 | 5613888065 | `REPAIR_ELIGIBLE` |
| #1325 | #1675 | 5601733863 | 5602395322 | 5613892926 | `REPAIR_ELIGIBLE` |
| #1333 | #1676 | 5601734915 | 5602397470 | 5613896228 | `REPAIR_ELIGIBLE` |
| #1363 | #1677 | 5601736517 | 5602399300 | 5613898735 | `REPAIR_ELIGIBLE` |
| #1375 | #1678 | 5601737634 | 5602400786 | 5613903360 | `REPAIR_ELIGIBLE` |
| #1376 | #1679 | 5601746468 | 5602403224 | 5613905233 | `REPAIR_ELIGIBLE` |
| #1380 | #1680 | 5601747308 | 5602404677 | 5613908279 | `REPAIR_ELIGIBLE` |
| #1401 | #1681 | 5601748374 | 5602406000 | 5613911802 | `REPAIR_ELIGIBLE` |
| #1406 | #1682 | 5601749401 | 5602407754 | 5613915850 | `REPAIR_ELIGIBLE` |
| #1418 | #1683 | 5601750274 | 5602408908 | 5613920895 | `REPAIR_ELIGIBLE` |
| #1428 | #1684 | 5601752211 | 5602410444 | 5613923886 | `REPAIR_ELIGIBLE` |
| #1447 | #1686 | 5601752917 | 5602412434 | 5614172867 | `REPAIR_ELIGIBLE` |
| #1458 | #1687 | 5601753678 | 5602413639 | 5614208444 | `REPAIR_ELIGIBLE` |

proposal plan digest：`1966615b17237b52978059ca3db0a65554fef8c9840ce18118994140e2e54592`；`scope_digest=d8695be13f4b947c534ac4756db45519fd510b656ab74223b948b0ec8ec91e87`；`source_bindings_digest=89cdcb3628ae1b8c7620b3efe7cd5eda9cc44fe1413e8869122a92e10e8c4827`；`owner_bindings_digest=2bfdf420794021487e4fb3efd3c5c2357c8ac21de32873dac772130bcd527e72`；`receipt_bindings_digest=64580939774b9a63a872bdb94936bd61d9137304a57760d20b61f36eae0a8f80`。这些 digest 和每行 body/marker digest 只锁定 proposal facts，不是授权凭证。

## 验收边界

- `historical_execution=UNKNOWN`：本次查找范围没有原授权 plan/journal。
- 当前 planner 的 13 条旧 receipt mismatch 仍然存在；本 proposal 不宣称 planner 已兼容。
- 本 proposal 不修改 live Issue、旧 receipt、owner、labels 或任何生产数据，也不关闭 #1611/#1658。
