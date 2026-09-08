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

dry-run plan digest：`e29e1dce3f3232e0dbae8bc34cf31cdc5dd80ce4bb05883bc45b6be84a2e0041`

pinned artifact manifest digest：`77cbbff0b093e1407aa62ccf71d4760c78bfe583610797b7f69f12b8cf7d72a5`，2/2 item verified。

两项均保持 `blocked`；source-ready candidate 为 0；live independent evidence comment 为 0；recovered image 为 0。四个原始 URL GET 都返回 HTTP 403、0 bytes，响应 body SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，因此没有生成 image artifact。

每项独立 candidate evidence：

- #1：`data/issue-1610/evidence/issue-1.json`，subject SHA `11af8386a1310feaa8fcdfb9c329c093a2374ff655241cf1edc2246257c4e61f`
- #2：`data/issue-1610/evidence/issue-2.json`，subject SHA `8cbc901047e554080fecff05f6a3e1092b5b808c4f21a06d2ef4ab1e4ba10c83`

两项共同 fail：`source_revision_binding`、`artifact_reference_integrity`、`raw_projection_traceability`、`known_limitations_recorded`、`boundary_disposition`、`image_recovery`。exact ownership 各自只有固定 InterviewNote owner；现有 live comments 没有可复用的独立 Source Review evidence marker。

## 主控边界

candidate evidence 尚未发布到 Issue comment，不能当作 live receipt；主控需先评审上述 digest 与逐项证据，再决定是否授权任何后续 SourceNote boundary、SourceRevision/body 修复或 Source Review apply。当前不得生成 InterviewContext、learning label、source-ready 或修改 Raw/Derived 层。

## 隔离说明

#1610 使用专用 `scripts/lib/issue-1610-pinned-artifact-manifest.js`；本变更不修改 `scripts/lib/issue-1539-pinned-artifact-manifest.js`，也不增加 `package.json` script。planner 仅提供只读 dry-run，无 `--apply` 入口；GitHub API 网络重试有固定上限，未启用高并发或无界重试。
