# 已有 materialization request 的精确摘要重放

13 条已有 owner 的 receipt 使用 `issue-1656-materialization-<source>`，而全量 planner 默认构造 `xhs-note-<prefix>-materialization-1`。两种 ID 不同并不证明历史执行无效。实际重放表明：以当前 SourceNote 构造请求，只采用 receipt 中的旧 materialization_id，完整 request SHA 在 13/13 行与已有 receipt 完全一致。

`selectExistingMaterializationRequest()` 据此选择已有操作的 request，供 `issue-1605-materialization-plan.js` 调用，避免给同一个已存在的 owner 再补写一条 materialization receipt。

选择条件：

- 默认 ID 已有 receipt 时，继续原来的严格验证，不用别的 receipt 覆盖它的错误。
- 对默认 ID 没有 receipt 的情况，目标 identity/source 对应的历史候选必须唯一，且当前 owner 恰好一个、SourceNote 和 owner 均通过既有验证。
- 只允许候选的 materialization_id 来自 receipt；其他 request 字段全部由当前 SourceNote 构造，完整 canonical request SHA 必须与 receipt.request_sha256 精确相等。
- 对该候选再次执行原 `planMaterialization()`，必须已经满足 already_materialized，schema、source/body/revision/ref、identity、owner Issue 等条件不变。
- 额外绑定 receipt.repository、source_note_issue_number 和当前 owner Raw body SHA；不存在的 owner、Raw 漂移或相互竞争的旧 receipt 均 fail closed。

正常新 owner 仍使用默认 ID。receipt 原文与 request_sha256 不被修改，也不新增 receipt，不把推导出的请求候选伪装成找回的原授权 plan 或 journal。结果中的 `request_provenance` 明确标注摘要匹配，以及 `historical_authorization_plan_journal=UNKNOWN`。

验证命令：

```bash
node --test test/materialization-existing-request-replay.test.js test/issue-1605-materialization-plan.test.js
npm test
node --check scripts/lib/source-note-interview-materialization.js
node --check scripts/lib/issue-1605-materialization-plan.js
git diff --check
```

本地定向回放覆盖 13 个真实 SourceNote/owner/receipt 快照；其中使用默认 ID 时仍 needs_receipt_repair，使用经完整摘要验证的候选时为 already-materialized，且没有修改 receipt 对象。负例覆盖坏摘要、source/owner identity、Issue、revision/ref/body、缺失/重复 owner、重复/竞争 receipt 和 SourceNote 漂移。

`replay-issue-1658-receipt-correction.js` 保留“仅默认 ID、不调用新 selector”的对照实验，并已修正原先漏传 repository 引起的额外错误。其 default-ID 对照结果不能当作当前全量 planner 的最终状态。
