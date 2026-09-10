# Issue #1658 只读对账审计

审计时间：2026-09-10（Asia/Shanghai）。本目录只保存审计证据、核验脚本和说明，不修改 SourceNote、历史 receipt、labels、Issue 或执行器。

## 范围与证据状态

本次范围严格采用 [#1611 评论 5602915668](https://github.com/liqiangcc/interview-lab/issues/1611#issuecomment-5602915668) 授权的 13 条：

`1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458`

原授权记录 `max_create=13`、`max_receipts=13`，并包含：

- `plan_digest=294349d6dd0575ba4e78e82607f509b067ee0476def5ff1ea9adcd70d41e99ab`
- `input_plan_digest=458311b1571a959fa0b83083cdfeb093608ee35c165a41b0d3ab26a363716dd4`
- `ownership_inventory_digest=64c7a7028b7f307ccecd1d4e3011b8fcdcd7c688d792e2a44ac4fe2220e91387`

在本次查找范围内未找到与上述 digest 对应的原 bounded input plan，也未找到 issue-1658 durable journal；本地 tracked 的旧 full plan 不作替代。因此历史执行可证性统一为 `UNKNOWN`。正常缺少 lock 不作为失败证据，只说明无法从本机证明运行过程。

[13-reconcile.json](./13-reconcile.json) 是四维结果；此前把转义 marker 解析成零 receipt 的临时文件未纳入本 PR。[repro-input.json](./repro-input.json) 保存 13 条定向核验所需的 source、owner 和 marker 评论快照。[owner-inventory.json](./owner-inventory.json) 保存当时已抓取的完整 65-owner identity/Issue 最小快照。

## 四维判定

- `owner_fact`：基于 65-owner inventory 的全仓库覆盖快照核验唯一 owner、identity、body SHA、title、完整 label set。
- `receipt_fact`：每条恰有一个可无歧义解析的 materialization marker，且 source/owner 绑定字段与快照一致。这是 receipt 事实，不等于历史执行证明。
- `historical_execution`：因本次查找范围内未找到原授权 input plan 或 durable journal，统一为 `UNKNOWN`。
- `consumer_compatibility.full_live_planner`：按 full plan 的 `errors` 精确映射到对应 SourceNote；本次 13 条各有对应错误，所以各为 `FAIL`。全局 #910 错误不会传播到这 13 条。
- `consumer_compatibility.generic_runner`：`NOT_VERIFIED`，本次未执行。
- `consumer_compatibility.bounded_runner`：`NOT_VERIFIED`，本次未执行，也没有伪造原 bounded input plan。

boundary applied marker 同样作为观察事实保存：每条都有一个 marker，但其 `interview_note_ids=[]`。没有对应时点 schema/validator 证据时，本审计不将其称为数据损坏。旧 `issue-1656-materialization-*` ID 或 request SHA 与某一消费者的 expected binding 不同，只标记为该消费者的 binding mismatch，不作历史有效性判断。

| SourceNote → Owner | Receipt 评论 | owner_fact | receipt_fact | historical_execution | full planner | generic runner | bounded runner |
|---|---:|---|---|---|---|---|---|
| [1309](https://github.com/liqiangcc/interview-lab/issues/1309) → [1674](https://github.com/liqiangcc/interview-lab/issues/1674) | [5613888065](https://github.com/liqiangcc/interview-lab/issues/1309#issuecomment-5613888065) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1325](https://github.com/liqiangcc/interview-lab/issues/1325) → [1675](https://github.com/liqiangcc/interview-lab/issues/1675) | [5613892926](https://github.com/liqiangcc/interview-lab/issues/1325#issuecomment-5613892926) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1333](https://github.com/liqiangcc/interview-lab/issues/1333) → [1676](https://github.com/liqiangcc/interview-lab/issues/1676) | [5613896228](https://github.com/liqiangcc/interview-lab/issues/1333#issuecomment-5613896228) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1363](https://github.com/liqiangcc/interview-lab/issues/1363) → [1677](https://github.com/liqiangcc/interview-lab/issues/1677) | [5613898735](https://github.com/liqiangcc/interview-lab/issues/1363#issuecomment-5613898735) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1375](https://github.com/liqiangcc/interview-lab/issues/1375) → [1678](https://github.com/liqiangcc/interview-lab/issues/1678) | [5613903360](https://github.com/liqiangcc/interview-lab/issues/1375#issuecomment-5613903360) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1376](https://github.com/liqiangcc/interview-lab/issues/1376) → [1679](https://github.com/liqiangcc/interview-lab/issues/1679) | [5613905233](https://github.com/liqiangcc/interview-lab/issues/1376#issuecomment-5613905233) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1380](https://github.com/liqiangcc/interview-lab/issues/1380) → [1680](https://github.com/liqiangcc/interview-lab/issues/1680) | [5613908279](https://github.com/liqiangcc/interview-lab/issues/1380#issuecomment-5613908279) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1401](https://github.com/liqiangcc/interview-lab/issues/1401) → [1681](https://github.com/liqiangcc/interview-lab/issues/1681) | [5613911802](https://github.com/liqiangcc/interview-lab/issues/1401#issuecomment-5613911802) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1406](https://github.com/liqiangcc/interview-lab/issues/1406) → [1682](https://github.com/liqiangcc/interview-lab/issues/1682) | [5613915850](https://github.com/liqiangcc/interview-lab/issues/1406#issuecomment-5613915850) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1418](https://github.com/liqiangcc/interview-lab/issues/1418) → [1683](https://github.com/liqiangcc/interview-lab/issues/1418) | [5613920895](https://github.com/liqiangcc/interview-lab/issues/1418#issuecomment-5613920895) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1428](https://github.com/liqiangcc/interview-lab/issues/1428) → [1684](https://github.com/liqiangcc/interview-lab/issues/1684) | [5613923886](https://github.com/liqiangcc/interview-lab/issues/1428#issuecomment-5613923886) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1447](https://github.com/liqiangcc/interview-lab/issues/1447) → [1686](https://github.com/liqiangcc/interview-lab/issues/1686) | [5614172867](https://github.com/liqiangcc/interview-lab/issues/1447#issuecomment-5614172867) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1458](https://github.com/liqiangcc/interview-lab/issues/1458) → [1687](https://github.com/liqiangcc/interview-lab/issues/1687) | [5614208444](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5614208444) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |

## expected binding 的实际来源

代码固定树为 main 合并提交 [`e443f7d5303da500981e24c65c7a6e1ba417a7d1`](https://github.com/liqiangcc/interview-lab/commit/e443f7d5303da500981e24c65c7a6e1ba417a7d1)：

1. 全量 planner：`scripts/plan-issue-1611-live-materialization.js` 调用 `planIssue1605Materialization`；`scripts/lib/issue-1605-materialization-plan.js` 调用 `buildMaterializationRequest(sourceIssue, repository, { caseKey })` 和 `planMaterialization`。`scripts/lib/interview-note-materialization-batch.js` 的 `materializationId()` 生成 `xhs-note-<external_id 前 8 位>-materialization-1`。
2. 通用 runner：`scripts/issue-1658-materialization-runner.js` 从 plan 取得 request，再调用 `planMaterialization(request, ...)` 和 receipt reconciliation。本次未执行，标记 `NOT_VERIFIED`。
3. bounded runner：`scripts/issue-1658-bounded-materialization-runner.js` 的 `validateFreshBoundedRows()` 直接使用 `inputPlan.rows[].request`，并在 fresh SourceNote、owner、receipt 检查时传入该 request；不会在此处重建 `materializationId()`，且支持 exact `already-materialized`。原 bounded input plan 缺失，本次未执行，标记 `NOT_VERIFIED`。

因此，`issue-1656-materialization-*` 与通用 planner 的 `xhs-note-*-materialization-1` 差异，只能写作 `full-live-planner-current-request-binding: MISMATCH`；不能写作历史 receipt 失效，也不能宣称 bounded runner 失败。

## 全量计数与分页

计数单位必须分开：

- `1460` 是 SourceNote Issue 数，boundary 分类为 `776 single-interview + 29 multi-interview + 247 not-interview + 408 blocked = 1460`。
- `1507` 是 planner 展开的 action/result row 数，分类为 `247 not-interview + 776 single-interview + 76 multi-interview + 408 blocked = 1507`。29 个 multi-interview SourceNote 展开为 76 个 case row。
- `1099` 是 planner 产生的 distinct InterviewNote identity claim 数，来源为 `247 + 776 + 76`。
- `65` 是完整 ownership inventory 中实际存在的 InterviewNote owner Issue 数。它与 1099 是不同计数单位。

当前全量 plan：`skip-not-interview=247`、`already-materialized=47`、`would-materialize=789`、`blocked=424`，合计 1507；共 28 errors。plan `ok=false`，但 `mutation_performed=false`、`patch=0`、`post=0`、`create=0`。

page14 EOF 是瞬态错误，已重试完成。最终 boundary evidence 为 27 页、SourceNote snapshot 为 15 页，均有短终页；`ownership_search_errors=[]`。分页恢复为 `PASS`，不改变 planner 全局 `ok=false`，也不把 #910 错误传播到无关行。详细数据见 [full-plan-summary.json](./full-plan-summary.json)。

## 可复现核验

核验脚本 [verify-13-reconcile.js](./verify-13-reconcile.js) 默认是 `check` 模式：读取 `repro-input.json`、`owner-inventory.json`、`full-plan-summary.json`，重算结果并与已提交的 `13-reconcile.json` 做精确比较；不写文件。只有显式 `--write` 才生成结果文件。

脚本检查：

- SourceNote 编号恰好等于 13 条授权 scope，且无重复；
- 65-owner inventory 的 schema、完整覆盖、canonical digest、identity 唯一性和 Issue 编号唯一性；
- source body SHA、identity、boundary status 和 SourceRevision；
- projection body SHA、title 和完整 labels；
- owner identity 全仓库唯一性、owner body SHA、title、完整 label set 和 owner validator；
- boundary applied marker 和 materialization receipt 的唯一性及字段；
- full plan errors 按精确 `#<source>` 映射，顶层计数从 13 行结果计算；
- owner/receipt 事实失败或已提交结果不一致时以非零退出；历史 `UNKNOWN`、runner `NOT_VERIFIED` 和 planner 全局错误不会单独造成核验失败。

实际复核命令及结果：

```text
node --check audit/issue-1658/verify-13-reconcile.js
node audit/issue-1658/verify-13-reconcile.js
```

结果：`mode=check`、13 rows、owner_fact PASS=13、receipt_fact PASS=13、historical_execution UNKNOWN=13、full_live_planner FAIL=13、generic_runner NOT_VERIFIED=13、bounded_runner NOT_VERIFIED=13、owner_inventory uniqueness PASS、errors=[]，退出码 0。

定向失败核验也已完成：

- 修改 owner body：退出码 1，报告 `owner_fact failed`；
- 修改 receipt owner number：退出码 1，报告 `receipt_fact failed`；
- 在 65-owner inventory 加入同 identity 第二 owner：退出码 1，报告 inventory/owner_fact 失败；
- full plan 只保留 #910 两条全局错误：退出码 0，13 行 `full_live_planner=PASS`，全局错误仍单独保留，未传播到 13 行。

本 PR 不保存缺失的原授权 input plan 或 journal 的替代品，也不将缺失 lock 当作失败证据。
