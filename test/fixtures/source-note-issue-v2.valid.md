<!-- source-note: id=xhs-note:runtime-fixture-1 schema=source-note-issue.v2 -->
<!-- source-note-record
{
  "schema_version": "source-note-issue.v2",
  "source_note_id": "xhs-note:runtime-fixture-1",
  "source": {
    "system": "xhs",
    "external_id": "runtime-fixture-1",
    "url": "https://www.xiaohongshu.com/explore/runtime-fixture-1"
  },
  "source_revision": {
    "id": "xhs:runtime-fixture-1:r1",
    "captured_at": "2026-09-04T00:00:00Z",
    "producer": "liqiangcc/source-acquisition-runtime",
    "source_capture_schema": "source-capture.v1",
    "storage_kind": "runtime-artifact-store",
    "manifest_ref": "source-capture:xhs:runtime-fixture-1:r1#manifest.json",
    "manifest_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "manifest_byte_size": 1234,
    "reason": "source-capture.v1 runtime intake"
  },
  "source_published_at": {
    "precision": "unknown",
    "value": null
  },
  "source_edited_at": {
    "precision": "unknown",
    "value": null
  },
  "artifacts": [
    {
      "kind": "page_a11y_snapshot",
      "ref": "source-capture:xhs:runtime-fixture-1:r1#raw/page.a11y.txt",
      "git_blob_sha": null,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "provenance": "raw_capture",
      "byte_size": 100,
      "integrity": "present",
      "content_type": "text/plain; charset=utf-8"
    },
    {
      "kind": "image",
      "ref": "source-capture:xhs:runtime-fixture-1:r1#raw/images/1.webp",
      "git_blob_sha": null,
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "provenance": "raw_capture",
      "byte_size": 200,
      "integrity": "present",
      "sequence": 1,
      "content_type": "image/webp"
    },
    {
      "kind": "text_projection",
      "ref": "source-capture:xhs:runtime-fixture-1:r1#projection/readable.txt",
      "git_blob_sha": null,
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "provenance": "source_projection",
      "byte_size": 50,
      "integrity": "present",
      "content_type": "text/plain; charset=utf-8"
    }
  ],
  "observed_metadata": {
    "title": "Runtime fixture",
    "author": "fixture-author",
    "source_display_time": "1天前 上海",
    "gallery_count": 1
  },
  "access_boundary": null,
  "anomalies": [],
  "limitations": [
    "SourceNote intake only records the captured Source identity."
  ],
  "boundary_review": {
    "status": "pending",
    "reviewed_at": null,
    "interview_note_ids": []
  }
}
-->

## 来源身份

- 来源系统：XHS
- SourceNote id：`xhs-note:runtime-fixture-1`
- SourceRevision：`xhs:runtime-fixture-1:r1`

## 原始标题

Runtime fixture

## 原始正文

> Runtime source projection fixture.

## 原始附件

- Raw accessibility snapshot
- Raw image
- Source text projection

## Intake 异常

- 无

## 边界审核

- 状态：`pending`
- 当前不创建 InterviewNote identity。

## 来源限制

- SourceNote intake only records the captured Source identity.

## 派生链接

- 尚未生成 Interview-derived 数据。
