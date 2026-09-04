# Boundary Review 批处理

批处理只处理已进入 SourceNote 的 Boundary Review transition；它不创建 InterviewNote Issue，也不把 SourceNote 当作 InterviewNote。每个 transition 仍然单独经过 body/state/SourceRevision CAS、证据校验、SourceNote validator 和 receipt。

## Dry-run gate

批次使用 `source-note-boundary-review-batch.v1` manifest，按稳定 Issue number + transition request 文件列出输入：

```text
node scripts/plan-source-note-boundary-review-batch.js \
  --manifest boundary-batch.json \
  --report boundary-batch.dry-run.json
```

默认只读取 GitHub 并输出报告。报告固定记录 total、按 decision 的数量、ready、blocked、already-applied、每条 SourceNote 的 body digest、next body digest 和 child identities。只要一条记录 blocked，批次 dry-run 就 fail closed；不得按“成功的部分”先写入。

## Apply gate

apply 必须同时提供：

```text
--confirm-dry-run <dry_run_sha256>
--gate-proof <dependency-gate.json>
--max-mutations <N>
--pause-ms <milliseconds>
```

dependency proof 必须证明父 Epic #919 的前置 #917 和 #920 已通过 acceptance，且 live GitHub Issue 均为 closed。apply 会在第一笔写入前重新读取所有 Issue、评论和依赖 gate；任何 body、label、evidence、receipt 或 gate 变化都会整体停止。

评论分页使用显式 `page=1..N` 请求并逐页汇总；不依赖本机可能不支持的 `gh api --paginate --slurp` 组合。每页必须是数组，短页结束，超过 100 页 fail closed；因此分页兼容性和上限不会被 Search API 的 1000 条结果假设掩盖。

## 限速与恢复

apply 按 manifest 顺序串行执行，每笔 mutation 后等待 `pause-ms`，报告逐笔落盘。中断后重新 dry-run：

```text
0 owner / pending → 仍为 ready
目标 boundary + receipt → already-applied，跳过写入
目标 boundary + 无 receipt → 只补 durable receipt
```

不会根据上次 index 猜测剩余项，也不会并发重试绕过 GitHub secondary limit。post-write body/label/validator 任一失败立即停止，保留已完成项并依赖下一次幂等恢复。

## Stable child identity and evidence boundary

multi-interview 的每个 child case 必须用持久、不可变的 `case_key` + 精确 Source artifact ref/locator。`case_key` 不得来自显示标题、措辞、数组顺序或 Issue number；重排和重命名只影响展示，不得生成新 key。实现按 key 排序后持久化，测试覆盖重排、措辞编辑、已有 decision 幂等和 v1 backward compatibility。artifact provenance 只能是 Raw 或 Source projection；OCR、structured、tagged 等 Derived-only 引用不能授权分类。一个 SourceNote 内 locator 必须全局不重复；重复 locator、重复 case key 或 child identity collision 均 fail closed。child identity 由完整 SHA-256 contract 机械派生，调用方不能提交 `interview_note_id`，也不会创建 InterviewNote Issue。
