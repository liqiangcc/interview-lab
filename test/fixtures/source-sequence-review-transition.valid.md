## SourceSequenceReview transition

<!-- source-sequence-review-transition
{
  "schema_version": "source-sequence-review-transition.v1",
  "transition_id": "fixture-review-transition-2",
  "manifest_id": "xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1",
  "manifest_sha256": "829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad",
  "expected_effective_review_id": "xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1",
  "new_review_id": "xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-fixture-2",
  "decision": "approved",
  "reviewed_at": "2026-09-03T10:00:00Z",
  "reviewer_kind": "ai-assisted",
  "review_evidence": {
    "repository": "liqiangcc/interview-lab",
    "issue_number": 3,
    "comment_id": 9999999999
  },
  "checks": [
    {"check_id": "evidence_stream_binding", "result": "pass"},
    {"check_id": "unit_boundaries", "result": "pass"},
    {"check_id": "unit_order", "result": "pass"},
    {"check_id": "unit_types", "result": "pass"},
    {"check_id": "fragment_boundaries", "result": "pass"},
    {"check_id": "fragment_order", "result": "pass"},
    {"check_id": "no_fabrication", "result": "pass"}
  ],
  "limitations": [
    "fixture only; no review file is written"
  ]
}
-->

该 fixture 只做 transition preflight 与 predicted impact，不修改正式 review chain。
