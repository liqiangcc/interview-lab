# 2026-09-12 correction 执行范围

用户在当前任务会话明确委托：“后续不需要授权，所有的工作都由你完成，我会恢复目标，目标完成后再停止”，并恢复目标“完成所有面经标签化，可以进入直接进入逐层分析的状态”。

`authorization.json` 是执行端据此委托编制的受限操作契约，只允许固定 13 条追加 correction，max_mutations=max_receipts=13，绑定 #1690 提案的精确摘要。它不是用户逐项签署摘要的声明，不是旧 #1611 materialization-only 评论，也不补造任何历史授权、原 bounded plan 或 journal。`source_tree_sha=f01716f...` 是受审输入基线；实际执行代码 SHA 会由 CLI 单独记录。

本批次绝不覆盖旧 applied receipt，也不进行 owner create、boundary/evidence 修改、materialization receipt、Source Review 或 learning 写入。全量目标的其余阶段仍须分别通过对应的技术门禁。

执行命令：

```bash
node scripts/issue-1658-receipt-correction.js --output /tmp/correction-dry-run.json
node scripts/issue-1658-receipt-correction.js \
  --apply --allow-live-github \
  --authorization-file data/pilot/issue-1658/receipt-correction/execution-20260912/authorization.json \
  --confirm-plan-digest 1966615b17237b52978059ca3db0a65554fef8c9840ce18118994140e2e54592 \
  --output /tmp/correction-apply.json
```

默认只读。apply 要求写入代码已经提交且 tracked tree 干净；所有 worktree 共用 `.git/operation-locks/issue-1658-receipt-correction.lock` 和 `.git/operation-journals/issue-1658-receipt-correction.json`，不允许通过另一个临时目录重置执行状态。

执行器先预检全部 13 条，每条写入前 fresh GET source/comments/完整 owner inventory 并核对完整 owner labels；intent 必须 fsync 落盘后才调用一次 POST。无论 POST 响应如何都通过 fresh GET 确认；响应未知只允许最多三轮有界分页 GET，不能自动重发。uncertain journal 重启后只能对账；旧 correction 消失不能重建。最终再读全部 13 条确认后才标记 complete。

22 个定向测试覆盖 dry-run 零写入、授权范围/摘要/操作/上限错误、全批次预检、body/labels 漂移、重复 owner、锁冲突、intent 落盘、响应丢失、延迟可见、歧义、journal 损坏、已完成 correction 消失和最终 audit 漂移。

本文件是操作范围和命令，不是成功回执；实际执行结果和当前评论 ID 由 apply 输出、durable journal 和 GET-only post-audit 证明。generic request ID 差异与历史执行 UNKNOWN 仍需单列处理。

## 实际执行结果

执行 SHA：`af8813997c9733280f6e461d08923a758f34ab62`，执行时工作树干净。实际 POST=13，确认响应=13，final post-audit=13/13；journal=complete，锁已释放。完成时间：2026-09-12T05:18:16.578Z。owner inventory digest 保持 `1dd140f82a7656b47ca09cde7cb2e96538cbf3397b77a6fc7cec3dcb7be49f95`。

| SourceNote | correction comment | 状态 |
|---:|---|---|
| #1309 | [5643694061](https://github.com/liqiangcc/interview-lab/issues/1309#issuecomment-5643694061) | 已 GET 核验 |
| #1325 | [5643694995](https://github.com/liqiangcc/interview-lab/issues/1325#issuecomment-5643694995) | 已 GET 核验 |
| #1333 | [5643700992](https://github.com/liqiangcc/interview-lab/issues/1333#issuecomment-5643700992) | 已 GET 核验 |
| #1363 | [5643702800](https://github.com/liqiangcc/interview-lab/issues/1363#issuecomment-5643702800) | 已 GET 核验 |
| #1375 | [5643703518](https://github.com/liqiangcc/interview-lab/issues/1375#issuecomment-5643703518) | 已 GET 核验 |
| #1376 | [5643704149](https://github.com/liqiangcc/interview-lab/issues/1376#issuecomment-5643704149) | 已 GET 核验 |
| #1380 | [5643705168](https://github.com/liqiangcc/interview-lab/issues/1380#issuecomment-5643705168) | 已 GET 核验 |
| #1401 | [5643706287](https://github.com/liqiangcc/interview-lab/issues/1401#issuecomment-5643706287) | 已 GET 核验 |
| #1406 | [5643709211](https://github.com/liqiangcc/interview-lab/issues/1406#issuecomment-5643709211) | 已 GET 核验 |
| #1418 | [5643711383](https://github.com/liqiangcc/interview-lab/issues/1418#issuecomment-5643711383) | 已 GET 核验 |
| #1428 | [5643713058](https://github.com/liqiangcc/interview-lab/issues/1428#issuecomment-5643713058) | 已 GET 核验 |
| #1447 | [5643714536](https://github.com/liqiangcc/interview-lab/issues/1447#issuecomment-5643714536) | 已 GET 核验 |
| #1458 | [5643715018](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5643715018) | 已 GET 核验 |

`apply-result.json` 记录执行代码摘要和所有实际 comment ID；`journal.snapshot.json` 是 durable journal 的完整副本；`live-corrections.json` 是执行后额外 GET 的 13 条评论正文快照。旧 applied/evidence/materialization 评论摘要在每条 preflight、reconcile 和最终 audit 中继续校验，未覆盖旧评论、未创建 owner、未修改正文或 labels。两次 GET TLS 超时由有界重试恢复，POST 响应全部确认，未重发 POST。

`materialization-request-digest-replay.json` 是新构造的当前 request 候选，不是找回的原 bounded plan/journal。将当前 SourceNote 构造出的 request 的 materialization_id 取为对应已有 receipt ID，13/13 request SHA 与 receipt.request_sha256 完全相等。这提供下一步精确幂等兼容的证据；当前 generic planner 尚未使用它，不能据此宣称整个 materialization 完成。历史执行仍 UNKNOWN。

离线核验实际评论快照与 journal（不写 GitHub）：

```bash
node - <<'NODE'
const fs=require('fs'), assert=require('node:assert/strict');
const dir='./data/pilot/issue-1658/receipt-correction/execution-20260912/';
const read=f=>JSON.parse(fs.readFileSync(dir+f));
const {correctionBody,SCOPE}=require('./scripts/lib/issue-1658-receipt-correction-apply');
const {pinnedRow}=require('./scripts/lib/issue-1658-receipt-correction-consumer');
const {canonicalDigest,sha256Text}=require('./scripts/lib/aggregate-downstream-pipeline');
const journal=read('journal.snapshot.json'), capture=read('live-corrections.json');
const {canonical_digest,...input}=journal;
assert.equal(canonical_digest,canonicalDigest(input));
assert.equal(journal.status,'complete');
assert.deepEqual(capture.rows.map(r=>r.source_issue),SCOPE);
for(const row of capture.rows){
  assert.equal(row.comment.body,correctionBody(pinnedRow(row.source_issue)));
  assert.equal(row.body_sha256,sha256Text(row.comment.body));
  assert.equal(row.comment.id,journal.rows.find(r=>r.source_issue===row.source_issue).comment_id);
}
console.log('PASS: 13 exact correction comments and complete journal digest');
NODE
```
