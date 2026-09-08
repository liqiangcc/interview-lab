# Issue #1610 recovery evidence

本目录只记录 #1610 的 dry-run candidate；没有 GitHub POST/PATCH、label/body mutation、Raw artifact 覆盖或 source-ready transition。

## 固定范围

- controller：#1605，body SHA-256 `71e8bb8423a81e15c217c9377a522e018d38e3df55e2129f9fdbbd28e44b9ef7`
- scope：#1610，body SHA-256 `4af575a842616b1a814b687f44248b265172e544050a7629293075971dece53d`
- InterviewNote：仅 #1/#2
- SourceNote：#903/#904
- pinned source：`liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`
- selection digest：`066b44006e2d3047073b702c22e531a6edcf4735ae32027fc181fb7546cc73a7`

## 结果

dry-run plan digest：`2cd225aa680d93f4dcc9fdb39b2e4e65a1f481db79d53ff13164bf6a84d440b8`

pinned artifact manifest digest：`b6a1b8b6bc216f37c7f86d0727b8abec0335eccdd047dcf8d75833d8ae8d09c4`，2/2 item verified。

两项均保持 `blocked`；source-ready candidate 为 0；live independent evidence comment 为 0；recovered image 为 0。四个原始 URL GET 都返回 HTTP 403、0 bytes，响应 body SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，因此没有生成 image artifact。

每项独立 candidate evidence：

- #1：`data/issue-1610/evidence/issue-1.json`，subject SHA `8a1dee6d34250a300b984aa121d0d8af3658b4e249441103922baf41179f76fc`
- #2：`data/issue-1610/evidence/issue-2.json`，subject SHA `5181de82b599fb03c1a5b878e6a4664f0608fadabd6598adba81774f6977a739`

两项共同 fail：`source_revision_binding`、`artifact_reference_integrity`、`raw_projection_traceability`、`known_limitations_recorded`、`boundary_disposition`、`image_recovery`。exact ownership 各自只有固定 InterviewNote owner；现有 live comments 没有可复用的独立 Source Review evidence marker。

## 主控边界

candidate evidence 尚未发布到 Issue comment，不能当作 live receipt；主控需先评审上述 digest 与逐项证据，再决定是否授权任何后续 SourceNote boundary、SourceRevision/body 修复或 Source Review apply。当前不得生成 InterviewContext、learning label、source-ready 或修改 Raw/Derived 层。
