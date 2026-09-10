# Issue #1658 只读对账审计

审计时间：2026-09-10（Asia/Shanghai）。本目录只保存审计证据、核验脚本和说明，不修改 SourceNote、历史 receipt、labels、Issue 或执行器。

## 范围与证据状态

本次范围严格采用 [#1611 评论 5602915668](https://github.com/liqiangcc/interview-lab/issues/1611#issuecomment-5602915668) 授权的 13 条：

`1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458`

原授权记录 `max_create=13`、`max_receipts=13`，并包含：

- `plan_digest=294349d6dd0575ba4e78e82607f509b067ee0476def5ff1ea9adcd70d41e99ab`
- `input_plan_digest=458311b1571a959fa0b83083cdfeb093608ee35c165a41b0d3ab26a363716dd4`
- `ownership_inventory_digest=64c7a7028b7f307ccecd1d4e3011b8fcdcd7c688d792e2a44ac4fe2220e91387`

在本次查找范围内未找到与上述 digest 对应的原 bounded input plan，也未找到 issue-1658 durable journal；本地 tracked 的旧 full plan 不作替代。因此历史执行可证性统一为 `UNKNOWN`，不能据此判断旧执行有效或无效，也不能安全 resume。

[13-reconcile.json](./13-reconcile.json) 是修正后的四维结果；此前把转义 marker 解析成零 receipt 的临时文件未纳入本 PR。[repro-input.json](./repro-input.json) 保存 13 条定向核验所需的 source、owner 和 marker 评论快照。

## 四维判定

- `owner_fact`：唯一 owner、identity、body SHA、title、完整 label set 均核验通过。
- `receipt_fact`：每条恰有一个可无歧义解析的 materialization marker，且 source/owner 绑定字段与快照一致。这是 receipt 事实，不等于历史执行证明。
- `historical_execution`：因本次查找范围内未找到原授权 input plan 或 durable journal，统一为 `UNKNOWN`。
- `consumer_compatibility`：全量 planner 的已保存结果为 `FAIL`（plan `ok=false`）；通用 runner 与 bounded runner 均为 `NOT_VERIFIED`，因为本次没有执行它们。

boundary applied marker 同样作为观察事实保存：每条都有一个 marker，但其 `interview_note_ids=[]`。没有对应时点 schema/validator 证据时，本审计不将其称为数据损坏。旧 `issue-1656-materialization-*` ID 或 request SHA 与其他消费者的 expected binding 不同，也只标记为指定消费者的 binding mismatch，不作历史有效性判断。

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
| [1418](https://github.com/liqiangcc/interview-lab/issues/1418) → [1683](https://github.com/liqiangcc/interview-lab/issues/1683) | [5613920895](https://github.com/liqiangcc/interview-lab/issues/1418#issuecomment-5613920895) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1428](https://github.com/liqiangcc/interview-lab/issues/1428) → [1684](https://github.com/liqiangcc/interview-lab/issues/1428) | [5613923886](https://github.com/liqiangcc/interview-lab/issues/1428#issuecomment-5613923886) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1447](https://github.com/liqiangcc/interview-lab/issues/1447) → [1686](https://github.com/liqiangcc/interview-lab/issues/1686) | [5614172867](https://github.com/liqiangcc/interview-lab/issues/1447#issuecomment-5614172867) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |
| [1458](https://github.com/liqiangcc/interview-lab/issues/1458) → [1687](https://github.com/liqiangcc/interview-lab/issues/1458) | [5614208444](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5614208444) | PASS | PASS | UNKNOWN | FAIL | NOT_VERIFIED | NOT_VERIFIED |

## expected binding 的实际来源

代码固定树为 main 合并提交 [`e443f7d5303da500981e24c65c7a6e1ba417a7d1`](https://github.com/liqiangcc/interview-lab/commit/e443f7d5303da500981e24c65c7a6e1ba417a7d1)。三个作用域分别如下：

1. 全量 planner：`scripts/plan-issue-1611-live-materialization.js` 调用 `planIssue1605Materialization`；`scripts/lib/issue-1605-materialization-plan.js` 在 `buildMaterializationRequest(sourceIssue, repository, { caseKey })` 后调用 `planMaterialization`。其中 `scripts/lib/interview-note-materialization-batch.js` 的 `materializationId()` 生成 `xhs-note-<external_id 前 8 位>-materialization-1`。本次已保存 full plan 是这一作用域的实际运行结果。
2. 通用 runner：`scripts/issue-1658-materialization-runner.js` 从 plan 取得 request，再调用 `planMaterialization(request, ...)` 和 receipt reconciliation；它没有在本次审计中执行，结论为 `NOT_VERIFIED`。
3. bounded runner：`scripts/issue-1658-bounded-materialization-runner.js` 的 `validateFreshBoundedRows()` 直接使用 `inputPlan.rows[].request`，并在 fresh SourceNote、owner、receipt 检查时传入该 request；它不会在这里重建 `materializationId()`，且支持 exact `already-materialized`。由于原 bounded input plan 缺失，本次没有执行 bounded runner，结论为 `NOT_VERIFIED`。

因此，`issue-1656-materialization-*` 与通用 planner 生成的 `xhs-note-*-materialization-1` 的差异，只能写作 `full-live-planner-current-request-binding: MISMATCH`；不能写作“历史 receipt 失效”，也不能据此宣称 bounded runner 失败。

本次实际使用的全量 planner 参数已在原只读执行记录中固定为：

```text
node scripts/generate-issue-1611-interview-note-ownership-inventory.js --output <temp>/ownership.inventory.json
node scripts/plan-issue-1611-live-materialization.js \
  --ownership-file <temp>/ownership.inventory.json \
  --source-notes-output <temp>/source.snapshot.json \
  --boundary-report-output <temp>/boundary.report.json \
  --boundary-manifest-output <temp>/boundary.manifest.json \
  --output <temp>/materialization.plan.json
```

未执行的 bounded apply 若要进入下一阶段，必须先提供原 bounded input plan，并由授权门禁明确提供 `--plan-file`、`--apply`、`--allow-live-github`、`--max-create 13`、`--max-receipts 13`；本 PR 不执行这些参数。

## 全量计数与分页

计数单位必须分开：

- `1460` 是 SourceNote Issue 数，boundary 分类为 `776 single-interview + 29 multi-interview + 247 not-interview + 408 blocked = 1460`。
- `1507` 是 planner 展开的 action/result row 数，分类为 `247 not-interview + 776 single-interview + 76 multi-interview + 408 blocked = 1507`。29 个 multi-interview SourceNote 展开为 76 个 case row，因此不能与 1460 直接当作同一单位。
- `1099` 是 planner 产生的 distinct InterviewNote identity claim 数，来源为 `247 + 776 + 76`。
- `65` 是独立 live ownership inventory 中实际存在的 InterviewNote owner Issue 数。它与 1099 是“计划 identity claim”对“已存在 owner Issue”的不同单位，差额不是缺失计数的直接证明。

当前全量 plan：`skip-not-interview=247`、`already-materialized=47`、`would-materialize=789`、`blocked=424`，合计 1507；共 28 errors：#910 缺 exact evidence、#910 SourceRevision ref drift，以及 13 条各一条 current matching boundary-evidence error 和 receipt identity mismatch。plan `ok=false`，但 `mutation_performed=false`、`patch=0`、`post=0`、`create=0`。

page14 EOF 是瞬态错误，已重试完成。最终 boundary evidence 为 27 页、SourceNote snapshot 为 15 页，均有短终页；`ownership_search_errors=[]`。分页恢复为 `PASS`，不改变 planner `ok=false` 的结论。详细计数、errors、终页字段和 digest 见 [full-plan-summary.json](./full-plan-summary.json)。

## 可复现核验

核验脚本 [verify-13-reconcile.js](./verify-13-reconcile.js) 是离线脚本，只读 `repro-input.json`，不访问 GitHub，不写业务数据。它会重新校验：

- SourceNote body SHA、identity、boundary status 和 SourceRevision；
- projection body SHA、title 和完整 labels；
- owner identity 唯一性、owner body SHA、title、完整 label set 和 owner validator；
- boundary applied marker 的唯一性和字段；
- materialization receipt 的唯一性、source/owner/body/revision/ref/identity/owner number 字段；
- 通用 planner 的 request binding，并将 bounded runner 明确标为 `NOT_VERIFIED`。

实际复核命令及结果：

```text
node audit/issue-1658/verify-13-reconcile.js audit/issue-1658/repro-input.json audit/issue-1658/13-reconcile.json
13 rows
owner_fact PASS=13 FAIL=0
receipt_fact PASS=13 FAIL=0
historical_execution UNKNOWN=13
full_live_planner FAIL=13
generic_runner NOT_VERIFIED=13
bounded_runner NOT_VERIFIED=13
```

本 PR 未保存原授权 input plan 或 journal 的替代品，也未将缺失的锁当作失败证据；缺失项只影响历史可证性和后续 resume 门禁。
