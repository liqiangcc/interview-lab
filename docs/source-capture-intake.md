# source-capture.v1 → SourceNote v2

## Purpose

这是 `source-acquisition-runtime` 到 `interview-lab` 的 producer/consumer contract。

目标不是让 `interview-lab` 控制浏览器，而是让它只消费一个已经完成、可内容寻址验证的 SourceRevision：

```text
source-acquisition-runtime
  → source-capture.v1
  → materialized revision + manifest SHA-256
  → interview-lab intake adapter
  → source-note-issue.v2
  → boundary:pending
```

## Trust boundary

consumer 必须获得：

- materialized capture root；
- producer 提供的 expected manifest SHA-256。

adapter 先验证 manifest SHA，再按 manifest 对每个 artifact 重算 `size` 与 `sha256`。验证完成前不生成可信 SourceNote projection。

consumer 不需要也不允许依赖：

- Chrome / CDP；
- `chrome-devtools-mcp`；
- localhost MCP Gateway；
- Secure MCP Tunnel；
- XHS 临时访问参数。

## CLI

```bash
node scripts/intake-source-capture.js \
  --capture-root /path/to/materialized/revision \
  --expected-manifest-sha256 <sha256> \
  --output /tmp/source-note.md
```

命令只生成/验证 SourceNote draft，不写 GitHub。

## Provenance rule

Runtime artifact 不是 Git artifact：

```text
git_blob_sha = null
sha256       = required
byte_size    = required
```

禁止把 `source-acquisition-runtime` 的代码 commit 当成 capture artifact snapshot commit。

## Pilot compatibility

当前 handoff 使用三类真实样本作为 gate：

- Case 1 text-dominant：验证最小 SourceNote v2 intake；
- Case 2 image-dominant：验证 5 张 Raw image 顺序以及 `derived_projection` 不丢失；
- Case 5 access-context boundary：验证 `ref/path` normalization、carousel Raw evidence 与 `300031` non-inference limitation。

只有 Source intake 完成后，才进入 Boundary Review；本 adapter 不创建 InterviewNote。
