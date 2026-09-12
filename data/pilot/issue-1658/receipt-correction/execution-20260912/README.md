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
