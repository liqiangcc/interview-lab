<!-- interview-note-source-review-transition
{
  "schema_version": "interview-note-source-review-transition.v1",
  "transition_id": "issue-1661-source-review-1683-20260912",
  "repository": "liqiangcc/interview-lab",
  "issue_number": 1683,
  "interview_note_id": "xhs:68da4876000000001101eebb",
  "expected_interview_body_sha256": "cd200b11428e57dfadfb0d17af9e2eff7f3068c7edf63aac740988778d182c6a",
  "expected_initial_status": "captured",
  "expected_source_revision_id": "xhs-note:68da4876000000001101eebb:snapshot-95b77bb26104",
  "source_note_issue_number": 1418,
  "expected_source_note_body_sha256": "29abf9daab5b0925e23f3107b52f93ab9419e183eca6bb6b6fb08288df363222",
  "expected_manifest_sha256": null,
  "expected_source_repository_ref": "95b77bb261048059846273688e4b90a2e108b437",
  "decision": "source-ready",
  "reviewed_at": "2026-09-15T08:13:50.302Z",
  "reviewer_kind": "ai-assisted",
  "provenance_mode": "pinned-source-artifact",
  "provenance_statement": "pinned-source-artifact; raw-lineage-unproven",
  "pinned_artifact_manifest_sha256": "5ba5a02a29c2bd77bdecf2e8dd7af3e3b25a6a0573609b9543fa479030c244bc",
  "checks": [
    {
      "check_id": "source_identity",
      "result": "pass",
      "note": "InterviewNote identity matches reviewed SourceNote single-interview identity."
    },
    {
      "check_id": "source_revision_binding",
      "result": "pass",
      "note": "InterviewNote and SourceNote bind the exact requested SourceRevision/manifest."
    },
    {
      "check_id": "artifact_reference_integrity",
      "result": "pass",
      "note": "Every InterviewNote artifact ref/hash/provenance resolves to SourceNote evidence."
    },
    {
      "check_id": "raw_projection_traceability",
      "result": "fail",
      "note": "Raw lineage is absent or not proven; no derived_from claim is made."
    },
    {
      "check_id": "source_artifact_provenance",
      "result": "pass",
      "note": "Source projection has a recorded pinned reference at liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437; lineage status=pinned-source-artifact."
    },
    {
      "check_id": "known_limitations_recorded",
      "result": "pass",
      "note": "All SourceNote limitations are retained by InterviewNote."
    },
    {
      "check_id": "duplicate_ownership",
      "result": "pass",
      "note": "Exactly one InterviewNote owner exists: #1683."
    },
    {
      "check_id": "no_fabrication",
      "result": "pass",
      "note": "Source time/URL facts are mechanically preserved; interview time remains unknown."
    }
  ],
  "limitations": [
    "note_desc readable projection 缺失；SourceNote 只登记现有 Source artifact。",
    "SourceNote intake 只证明一条 XHS Source 的采集身份，不判断它是否等于一次真实面试事件。",
    "题库、经验总结、模拟面试、非目标岗位以及一帖多场面试都允许进入 SourceNote；必须经过 boundary review 才能产生 0..N InterviewNote。",
    "note_img_txt / note_structured / note_tagged 等历史数据属于 Derived，不得反向补写 Raw Source。",
    "Source Review verifies pinned commit/tree/blob bytes; Source projection to Raw lineage is not proven."
  ],
  "evidence_subject_sha256": "84f88866bb586db9b1519ea50e1026ff45dc527364f12fffc98b2356aecf8f51",
  "review_evidence": {
    "repository": "liqiangcc/interview-lab",
    "issue_number": 1683,
    "comment_id": 5677047959
  }
}
-->
