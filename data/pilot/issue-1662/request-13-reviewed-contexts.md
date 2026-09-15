<!-- interview-context-batch-review
{
  "schema_version": "interview-context-batch-review.v1",
  "batch_id": "issue-1662-learning-contexts-13",
  "repository": "liqiangcc/interview-lab",
  "dependency_issues": [
    917,
    920,
    921,
    922
  ],
  "dependency_gate_file": "data/pilot/issue-923/dependency-gate.json",
  "expected_dependency_gate_sha256": "d6b613fc08fca91162b48d01acdd10f593add4300573fee1b8bb70257c2635a5",
  "completion_dependencies": [
    {
      "issue_number": 1539,
      "evidence": "https://github.com/liqiangcc/interview-lab/issues/1539#issuecomment-5571358634",
      "body_sha256": "31e3a3a50aaf4e2c947fd7884d5bc4264223640f89912d5d76111fd27429209c",
      "required_markers": [
        "Expansion complete — exact 50 source-ready InterviewNotes",
        "No InterviewNote/SourceNote bodies, source evidence, non-lifecycle labels, or learning labels were changed"
      ]
    },
    {
      "issue_number": 1577,
      "evidence": "https://github.com/liqiangcc/interview-lab/issues/1577#issuecomment-5571294171",
      "body_sha256": "13b73c97d013517519d32acac206969c23a1722cb2494696d8682572414b0bb8",
      "required_markers": [
        "Completed — 17 InterviewNotes are source-ready",
        "No InterviewNote/SourceNote bodies, evidence comments, non-lifecycle labels, or learning labels were changed"
      ]
    }
  ],
  "fixed_inventory_issue_numbers": [
    3,
    4,
    915,
    1509,
    1510,
    1511,
    1512,
    1513,
    1514,
    1515,
    1516,
    1517,
    1518,
    1519,
    1520,
    1521,
    1522,
    1523,
    1524,
    1525,
    1526,
    1527,
    1528,
    1529,
    1530,
    1531,
    1532,
    1533,
    1534,
    1535,
    1536,
    1537,
    1538,
    1558,
    1559,
    1562,
    1563,
    1564,
    1565,
    1566,
    1567,
    1568,
    1569,
    1570,
    1571,
    1572,
    1573,
    1574,
    1575,
    1576,
    1674,
    1675,
    1676,
    1677,
    1678,
    1679,
    1680,
    1681,
    1682,
    1683,
    1684,
    1686,
    1687
  ],
  "pilot_size": 13,
  "items": [
    {
      "issue_number": 1674,
      "expected_body_sha256": "06c835ae9453b14d7bb300664484321d0a3264c7bb2c34de6bdbbf3578562bd8",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68c40288000000001b03ecd6:context-v1",
        "interview_note_id": "xhs:68c40288000000001b03ecd6",
        "source_revision_id": "xhs-note:68c40288000000001b03ecd6:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "kuaishou",
          "display_name": "快手",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:2025/9/12快手 Java应用研发"
          ]
        },
        "role": {
          "family": "backend",
          "title": "Java应用研发",
          "basis": "reviewed-inference",
          "evidence_refs": [
            "raw-title:2025/9/12快手 Java应用研发"
          ]
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "note-desc:快手 9.12一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "exact",
          "value": "2025-09-12",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:2025/9/12快手 Java应用研发"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68c40288000000001b03ecd6.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "08e9a8193b28d96b891d2b9270c92f71b181cbd9163928fcffcb18bc61e032b9"
      }
    },
    {
      "issue_number": 1675,
      "expected_body_sha256": "26d5fa70f7aea12062986f2ad9a2f2f2881062945de4f6651f4eadf71ae43766",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68c8d776000000001d037905:context-v1",
        "interview_note_id": "xhs:68c8d776000000001d037905",
        "source_revision_id": "xhs-note:68c8d776000000001d037905:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "bytedance",
          "display_name": "字节跳动",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:字节后端开发一面面经"
          ]
        },
        "role": {
          "family": "backend",
          "title": "后端开发",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:字节后端开发一面面经"
          ]
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:字节后端开发一面面经"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-15",
          "basis": "source-explicit",
          "evidence_refs": [
            "note-desc:9.15  字节跳动后端开发一面面经"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68c8d776000000001d037905.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "8801c353f5914e16190439dac5bc0117a6577a2c0b04a2d4ded932c7e106d9e2"
      }
    },
    {
      "issue_number": 1676,
      "expected_body_sha256": "b2ee2133fd2eb916f2ea07cca45635087b81809021dca0341ab98f6e7fba4c5a",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68c93440000000001203319b:context-v1",
        "interview_note_id": "xhs:68c93440000000001203319b",
        "source_revision_id": "xhs-note:68c93440000000001203319b:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "deepal",
          "display_name": "深蓝汽车",
          "basis": "source-explicit",
          "evidence_refs": [
            "note-desc:深蓝汽车-大数据开发岗"
          ]
        },
        "role": {
          "family": "data",
          "title": "大数据开发",
          "basis": "source-explicit",
          "evidence_refs": [
            "note-desc:深蓝汽车-大数据开发岗"
          ]
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "interview_occurred_at": {
          "precision": "unknown",
          "value": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68c93440000000001203319b.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "3962c6f52c9f6f741762e0c6dc6655632fd193b5b01d31486ee88b3c93ae7711"
      }
    },
    {
      "issue_number": 1677,
      "expected_body_sha256": "8fc810a06cbf1f11d27605d6029575c2506f005661277922cad9a090cc7718b2",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68ced1a80000000011015ae0:context-v1",
        "interview_note_id": "xhs:68ced1a80000000011015ae0",
        "source_revision_id": "xhs-note:68ced1a80000000011015ae0:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "tencent",
          "display_name": "腾讯",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.11 腾讯csig一面"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.11 腾讯csig一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-11",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.11 腾讯csig一面"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68ced1a80000000011015ae0.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "d2e5a0f90bd9ba03a110125a4a933d4122c64d296b6a3e38720861084e871dd1"
      }
    },
    {
      "issue_number": 1678,
      "expected_body_sha256": "1fc449270f66675ac7f946bdeb9efda676faa589aa7b77f614efdf430e35f9f1",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68d16a2d000000001101fea1:context-v1",
        "interview_note_id": "xhs:68d16a2d000000001101fea1",
        "source_revision_id": "xhs-note:68d16a2d000000001101fea1:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "ant-group",
          "display_name": "蚂蚁",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.22 蚂蚁一面"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.22 蚂蚁一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-22",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.22 蚂蚁一面"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68d16a2d000000001101fea1.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "4614148bd3eb9256de91464b7f51b5347215c9c26d74e324d2c74d3322f4bf02"
      }
    },
    {
      "issue_number": 1679,
      "expected_body_sha256": "dfb4d11f43944f60430eef987c9169e8720971c3552e43924dc4d3011466e161",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68d16a7d000000000e031041:context-v1",
        "interview_note_id": "xhs:68d16a7d000000000e031041",
        "source_revision_id": "xhs-note:68d16a7d000000000e031041:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "alibaba",
          "display_name": "阿里巴巴",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.22 阿里智能信息部一面"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.22 阿里智能信息部一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-22",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.22 阿里智能信息部一面"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68d16a7d000000000e031041.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "8bca2a82bbe4b166b01781bd2d7b0579a7b7b5316b344e0fb25495f65cecda58"
      }
    },
    {
      "issue_number": 1680,
      "expected_body_sha256": "4d8fbd08429ee2fdfb8adba6c5fc173f603da1a89739f2feedfcb628643b6286",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68d25947000000000b03ea1e:context-v1",
        "interview_note_id": "xhs:68d25947000000000b03ea1e",
        "source_revision_id": "xhs-note:68d25947000000000b03ea1e:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "baidu",
          "display_name": "百度",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.23 百度c++一面"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.23 百度c++一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-23",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.23 百度c++一面"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68d25947000000000b03ea1e.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "2cfe2d69cac386801b045ff8a67fdf46214f1ec2e51ac262dc6154a0ef7a2db1"
      }
    },
    {
      "issue_number": 1681,
      "expected_body_sha256": "5326f79e9d39fde125d8f1291433d84b7b63ff5541b5a0469cc002998eb1db99",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68d682d00000000011014a18:context-v1",
        "interview_note_id": "xhs:68d682d00000000011014a18",
        "source_revision_id": "xhs-note:68d682d00000000011014a18:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "didi",
          "display_name": "滴滴",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.26 滴滴一面"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.26 滴滴一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-26",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.26 滴滴一面"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68d682d00000000011014a18.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "6b5f45d34ff62fba89a9766bd0b8fc15a98833cb8a9af851e71077ff719b19d7"
      }
    },
    {
      "issue_number": 1682,
      "expected_body_sha256": "106a1838b7a81a038a98f7c9a1e5d0bd2a8846692c34260471a6aaa57f06ef9e",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68d9021d000000000e032bea:context-v1",
        "interview_note_id": "xhs:68d9021d000000000e032bea",
        "source_revision_id": "xhs-note:68d9021d000000000e032bea:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "baidu",
          "display_name": "百度",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.28 百度二面"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "2",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.28 百度二面"
          ]
        },
        "interview_occurred_at": {
          "precision": "month_day",
          "value": "09-28",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:9.28 百度二面"
          ]
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68d9021d000000000e032bea.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "97f77b6b5ba61ccc0572a157c329fae4ea01f95ab1a1bb9b636ad1a74555eb54"
      }
    },
    {
      "issue_number": 1683,
      "expected_body_sha256": "cd200b11428e57dfadfb0d17af9e2eff7f3068c7edf63aac740988778d182c6a",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68da4876000000001101eebb:context-v1",
        "interview_note_id": "xhs:68da4876000000001101eebb",
        "source_revision_id": "xhs-note:68da4876000000001101eebb:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "didi",
          "display_name": "滴滴",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:滴滴后端实习一面"
          ]
        },
        "role": {
          "family": "backend",
          "title": "后端",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:滴滴后端实习一面"
          ]
        },
        "recruitment_type": {
          "value": "internship",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:滴滴后端实习一面"
          ]
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:滴滴后端实习一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "unknown",
          "value": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68da4876000000001101eebb.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "a4962e55c08df9f0c16b7ae1eb6f8a148228e7bfd1c4ebd19fb3b00e67502998"
      }
    },
    {
      "issue_number": 1684,
      "expected_body_sha256": "582f8985cc32cf7e79bb4d163f54c185b2827bea8205c5f9cf92f1ebb1e38968",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68dfb89900000000030124a1:context-v1",
        "interview_note_id": "xhs:68dfb89900000000030124a1",
        "source_revision_id": "xhs-note:68dfb89900000000030124a1:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "meituan",
          "display_name": "美团",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:美团后端实习一面"
          ]
        },
        "role": {
          "family": "backend",
          "title": "后端",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:美团后端实习一面"
          ]
        },
        "recruitment_type": {
          "value": "internship",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:美团后端实习一面"
          ]
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:美团后端实习一面"
          ]
        },
        "interview_occurred_at": {
          "precision": "unknown",
          "value": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68dfb89900000000030124a1.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "4dacef3a8fd099c99ee381ee4bbd1bdeee272d736ddda4a61ad37565f724903b"
      }
    },
    {
      "issue_number": 1686,
      "expected_body_sha256": "5b4b8dc8dcefc036064b4d6768402cfce8cfd617273702d6c61f59332439c933",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68e7a288000000000301b7aa:context-v1",
        "interview_note_id": "xhs:68e7a288000000000301b7aa",
        "source_revision_id": "xhs-note:68e7a288000000000301b7aa:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "baidu",
          "display_name": "百度",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:百度Java开发一面面经"
          ]
        },
        "role": {
          "family": "unknown",
          "title": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "1",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:百度Java开发一面面经"
          ]
        },
        "interview_occurred_at": {
          "precision": "unknown",
          "value": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68e7a288000000000301b7aa.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "7f052dd9d92b2faf08e08e433dbc97e32561b91e4a4fbcc11d6befc7ae616a3a"
      }
    },
    {
      "issue_number": 1687,
      "expected_body_sha256": "a80a5dd1fb87407f63c0bed72f382152728334cf414965952fa501b3643338d9",
      "context": {
        "schema_version": "interview-context.v1",
        "context_id": "xhs:68ea11580000000003038e9b:context-v1",
        "interview_note_id": "xhs:68ea11580000000003038e9b",
        "source_revision_id": "xhs-note:68ea11580000000003038e9b:snapshot-95b77bb26104",
        "review_status": "reviewed",
        "reviewed_at": "2026-09-12T04:55:43.398Z",
        "company": {
          "id": "pinduoduo",
          "display_name": "拼多多",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:拼多多 交易部门 后端二面"
          ]
        },
        "role": {
          "family": "backend",
          "title": "后端",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:拼多多 交易部门 后端二面"
          ]
        },
        "recruitment_type": {
          "value": "unknown",
          "basis": "unknown",
          "evidence_refs": []
        },
        "round": {
          "value": "2",
          "basis": "source-explicit",
          "evidence_refs": [
            "raw-title:拼多多 交易部门 后端二面"
          ]
        },
        "interview_occurred_at": {
          "precision": "unknown",
          "value": null,
          "basis": "unknown",
          "evidence_refs": []
        },
        "outcome_visibility": "sealed-until-source-reveal"
      },
      "context_artifact": {
        "repository": "liqiangcc/interview-lab",
        "path": "data/interview-contexts/xhs-68ea11580000000003038e9b.v1.json",
        "ref": "refs/heads/main",
        "commit": "e91aebb3e2006de5890102117cdb02a16238c959",
        "sha256": "d3ff2a32e71703f1761b2fd30d2361f57b46f100718502aa5a54f074020fc822"
      }
    }
  ]
}
-->
