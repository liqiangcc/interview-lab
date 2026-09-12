# 13 条历史 applied receipt 的 correction 消费规则

本实现接入 #1690 提案中的 `source-note-boundary-review-applied-correction.v1`，只改变只读 planner 如何解释一条已存在的 correction。没有 POST/PATCH/create 路径，不覆盖旧回执。它是全量标签化流程中解除已知上游回执阻塞的一步，不代表 Source Review 或标签化完成。

## 接入位置

`source-note-boundary-receipt-correction.js` 保存从提案原样提取的字段验证器；提案继续复用同一个 runtime validator。`issue-1658-receipt-correction-consumer.js` 把 correction 与受审的固定 13 条绑定及当前 source/owner/comments 比较。`exactAppliedBoundaryEvidence()` 只在 correction 验证通过后消除该行精确的 `receipt interview_note_ids mismatch`；其他错误全部保留。

固定绑定来自已合并的 `audit/issue-1658-receipt-repair/repair-plan.json`，整文件 SHA-256 为 `3cf92f9403640e1aed0a32d3d30910457574db19ebc90c24a37cef231e413d84`。这不是 apply 授权，也不是泛化的历史 receipt 自动修正机制。文件或 scope 改变会 fail closed。

必须同时满足：

- 对应 Issue 上恰好一个 dedicated correction marker comment；其 JSON、locator 和全部字段符合既定 schema。坏 JSON/未闭合/第二个 marker 不得被过滤掉。
- 当前 SourceNote 通过现有 validator，并精确绑定固定 source/body/revision/ref、single-interview identity。
- 原 applied receipt、issue-1608 evidence、materialization receipt 各唯一，comment ID/Issue URL/body SHA/marker SHA 与固定提案完全相等。历史回执没有被修写。
- full planner 提供完整校验且逐条 fresh GET 的 owner 集合；目标 identity 和 Issue number 均唯一，owner Raw body SHA 不变，并通过已有 ownership validator。
- correction 内所有 source、owner、旧 receipt/evidence/materialization 字段与固定提案精确相等；其他 boundary/evidence 校验仍由原函数执行，包含跨 schema 重复证据的拒绝。

## labels 的时间语义

correction 的 `owner_binding.labels` 锁定修复时受审的历史 owner labels，必须与固定提案完整相等，不能改写。当前 owner 的 Raw body/identity/revision 也必须精确保持。当前 title/lifecycle labels 后续可由原有 Source Review / Learning 流程推进，并继续受 `validateExistingOwnership()` 约束；否则合法的下游标签变化会反过来使历史 correction 失效。

这个区分不授权任何 label 写入，也不证明某个当前 source-ready label 具有 Source Review receipt。未来 correction writer 仍必须在 POST 前 fresh GET/CAS 核对当次获准的完整 labels；独立 Source Review 和 Context apply 门禁不变。

## 可复核回放

```bash
node --test test/issue-1658-receipt-correction-consumer.test.js test/issue-1658-receipt-repair.test.js
node scripts/replay-issue-1658-receipt-correction.js
npm test
git diff --check
```

回放结果保存在 `data/pilot/issue-1658/receipt-correction/counterfactual-replay.json`，输入是完整的 13 条三评论原始快照。新增 correction comment 使用显式模拟 ID，仅在进程内创建；它不是 live comment，也未伪造原 bounded request/plan/journal。

实际离线结果：before errors=13；追加模拟 correction 后 errors=0、13/13 boundary check 通过。但该对照实验只使用默认生成 ID，不调用后续新增的 existing-receipt request selector；其 `needs_receipt_repair=13` 不是当前全量 planner 最终状态。参见 `materialization-existing-request-replay.md`。历史执行仍 UNKNOWN。#910 不属于本 consumer 的修复 scope，其错误继续保留。

## 后续执行边界

接下来须完成独立 receipt-repair-only 写入协议的执行实现：精确计划摘要及 scope、fresh GET/CAS、单锁/durable journal、每条至多一次 POST、未知响应 bounded paginated reconcile。不能因本地回放通过就假装 correction 已发布，也不能触发 owner create 或覆盖旧评论。用户已委托当前执行端推进全量标签化，执行端继续完成这些步骤，不以缺少重复口头授权作为暂停原因。
