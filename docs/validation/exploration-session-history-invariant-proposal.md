# ExplorationSession history machine gate 提案

本文件记录本次 machine-enforcement apply 的 promotion 边界，便于在 PR review 时与正式 invariant 文档分离。

## 已有正式 invariant

当前 history validator 直接实现 / 加强以下已有规则：

- I21：sequential no-look-ahead；
- I22：machine checkpoint frontier contract；
- I31：closure state 显式且自洽。

## 新增可机器证明的跨 checkpoint 约束

```text
同一 session identity / revision 稳定
+
revealed_position 单调且最多 +1
+
advance 前 previous position 已 closure / deferred
+
同 position Source identity / phase / status 不倒退
+
fully-revealed within-unit frontier 不回退
+
completed session terminal
```

这些约束在 PR CI 与 live issue-comment probe 通过后，建议提升为新的 HARD invariant；在此之前先保持为本 PR 的 machine gate proposal，避免“代码刚写好就自动宣布协议已稳定”。

## 不提升为 machine proof 的部分

以下继续保留为 semantic review：

- 任意 `temporal_cursor` 字符串的真实语义先后关系；
- 自然语言解释是否实际偷看未来；
- Outcome / Cause / Verified Weakness 的语义归因；
- Derived interpretation 是否忠于 Source。
