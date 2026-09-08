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
  --cache data/issue-1607/live-issues.json
```

默认 `--prepare` 会继续读取并校验每个 pinned `note_desc` blob 的 Git object SHA；任意网络或内容校验失败都会整体 fail closed。当前网络审计运行使用了显式 body-only fallback，它只冻结 live body digest 和 Issue 中声明的 artifact ref/blob，不把 body copy 当作已验证 Source bytes：

```sh
node scripts/prepare-issue-1607-boundary-batch.js \
  --prepare --body-only \
  --cache data/issue-1607/live-issues.json \
  --output-dir data/issue-1607
```

然后生成每条 evidence、不可执行 request template、dry-run plan、digest 和零 mutation journal：

```sh
node scripts/generate-issue-1607-boundary-evidence.js \
  --selection data/issue-1607/selection.json \
  --output-dir data/issue-1607
```

## 当前审计结论

当前产物中的 367 条都保持 `decision=pending`、`evidence_status=blocked`。原因是本次 pinned Source projection bytes 未完成独立复核，且子 issue 没有授予 live GitHub apply 权限。另已记录一次早期抽样阶段对 #766 的只读越界探测；无写入，但因此本运行不是 scope-clean，必须由主控审计后重新执行。`dry-run.plan.json` 的 `mutation_count` 与 `apply.journal.json` 的 `mutation_count` 均为 0。

这些 request template 不是 `source-note-boundary-review-transition.v1/v2` 的可执行请求：它们没有伪造 comment id/review timestamp。后续必须由独立 reviewer 完成 Source evidence 复核、生成 durable evidence comment，再依据最新 live body/labels 重新 plan；未经主控明确授权不得 POST/PATCH。

Evidence ledger 只引用 SourceNote 自己的 canonical `note_desc` artifact；不读取或升级 `note_img_txt`、`note_structured`、`note_tagged` 等 Derived projection，也不创建 InterviewNote、Source Review、InterviewContext 或学习标签。
