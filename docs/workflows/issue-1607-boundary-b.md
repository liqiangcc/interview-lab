# Issue #1607 Boundary B preparation

本目录对应主控 #1605 的 Boundary B 子任务，只覆盖 SourceNote Issue #393–#765 中 live labels 同时满足：

```text
type:source-note + source:xhs + status:captured + boundary:pending + task:boundary-review
```

固定 Source snapshot 为 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。编号区间本身不是选择集；区间内已经完成 boundary review 的 SourceNote、历史 Issue/PR 等排除项必须保留在 `selection.json` 的 `excluded` 中。

## 只读生成

先获取 live Issue inventory：

```sh
node scripts/prepare-issue-1607-boundary-batch.js \
  --fetch-live \
  --scope-clean \
  --cache data/issue-1607/live-issues.json
```

默认 `--prepare` 会读取并校验每个 pinned `note_desc` projection 的 byte size 与 Git object SHA。读取顺序是主控提供的非空缓存、再到单线程受控 Raw GET；每项独立重试，失败只阻塞该项，不把网络抖动升级为全批失败：

```sh
node scripts/prepare-issue-1607-boundary-batch.js \
  --prepare --scope-clean --allow-unverified-source \
  --cache data/issue-1607/live-issues.json \
  --source-cache-dir /tmp/xhs-note-desc-cache \
  --output-dir data/issue-1607
```

`--body-only` 仅保留为明确的离线诊断模式；它会把每项标记为 blocked，不能替代 pinned Source bytes。本次 B 运行复用了主控缓存，并完成 367/367 条 projection 的独立 SHA/长度校验；例如 #394 为 943 bytes，Git blob SHA 为 `94d93fb8bb42d5b1ad0adb1242cb647c3f8f0eb6`。

然后生成每条 evidence、不可执行 request template、dry-run plan、digest 和零 mutation journal：

```sh
node scripts/generate-issue-1607-boundary-evidence.js \
  --selection data/issue-1607/selection.json \
  --output-dir data/issue-1607
```

## 当前审计结论

当前产物中的 367 条都保持 `decision=pending`、`evidence_status=review-required`；Source bytes 全部已独立验证，但分类仅是基于完整 projection 文本的 deterministic proposal，不是 durable human review。proposal 统计为 `single-interview=105`、`not-interview=5`、`pending=257`，详见 `classification-ledger.json`。每条 evidence 绑定完整 projection 文本、SHA/长度与分类依据行号；`dry-run.plan.json` 的 `mutation_count` 与 `apply.journal.json` 的 `mutation_count` 均为 0，ready=0。

分类规则要求第一人称、明确已发生的过程事实和问题证据同时出现；邀约、据说、求助、经验建议、面试官分享、题库/题目列表保持 pending，明确拒面才提出 not-interview。分类仍只是 proposal，不能改变 pending 或授权 transition。

本次 rerun 为 scope-clean：fresh live snapshot 只读取 #393–#765，`scope_compliance=pass`、`out_of_scope_reads=0`、`out_of_scope_mutations=0`；历史准备运行的 #766 只读 incident 不属于本次 rerun。

这些 request template 不是 `source-note-boundary-review-transition.v1/v2` 的可执行请求：它们没有伪造 comment id/review timestamp。后续必须由独立 reviewer 完成 Source evidence 复核、生成 durable evidence comment，再依据最新 live body/labels 重新 plan；未经主控明确授权不得 POST/PATCH。

Evidence ledger 只引用 SourceNote 自己的 canonical `note_desc` artifact；不读取或升级 `note_img_txt`、`note_structured`、`note_tagged` 等 Derived projection，也不创建 InterviewNote、Source Review、InterviewContext 或学习标签。
