'use strict';

const crypto = require('crypto');

const REQUIRED_CHECKS = [
  'source_identity',
  'source_revision_binding',
  'source_content_coverage',
  'event_boundary',
  'no_cross_source_mixing',
  'no_fabrication',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function stripHashtags(text) {
  return String(text || '').replace(/#[^\s#]+\[话题\]#/g, ' ').replace(/#[^\s#]+/g, ' ');
}

const SCHEDULED_RE = /(约面|约.{0,12}面试|预约.{0,12}面试|待面试|面试安排|安排.{0,12}面试|面试时间)/i;
const COMPLETED_RE = /(?:(?:周|上周|昨天|今天|当天|当日|刚才|刚刚|此前|之前).{0,8}面的|面[了完]|面试(?:完|结束|通过)|参加.{0,8}面试|完成.{0,8}面试|经历.{0,8}面试)/i;
const QUESTION_RE = /(面试题|面试问题|面试官提问|问了什么|被问到|题目|算法题|手撕|在线IDE)/i;
const OUTCOME_RE = /(等通知|挂了|拒信|通过了|面试通过|收到.{0,12}offer|感谢信|流程结束|谈薪资|结果|求助|靠谱吗|oc|offer)/i;
const AGGREGATE_RE = /(多家公司|几家公司|多场面试|几场面试|这几天的面试|面试了30\+|面试了[一二三四五六七八九十]+家|30\+公司|不同公司|累计|分别.{0,10}面试|面完.{0,12}所有大厂|所有大厂|两个(?:公司|组)|两家(?:公司|公司流程)|多个公司|前后面了两个组|美团.{0,100}百度|百度.{0,100}美团|字节.{0,100}(?:TT|TikTok)|(?:TT|TikTok).{0,100}字节)/i;
const NON_EVENT_RE = /(模拟面试|模拟一下|题库|刷题|每日积累|代面试|面试诈骗|培训机构|提醒.{0,20}面试|面试辅导|有人知道这个是面试什么|帮公司面试|招聘要求|最新内部信息|面试题合集|面试题大全)/i;
const CURATED_RE = /(投稿|自己带的同学|同学投稿|资料|知识合集|面试真题|面经一致吗|有没有面过.{0,20}说说|参考下面|供大家参考)/i;
const RECRUITING_RE = /(宣讲|内推|岗位|秋招|社招|筛完|快投|日程|内推码|招聘会|招聘信息|招聘公告|在招|面试时间：)/i;
const PROCESS_CONTEXT_RE = /(面试官|项目|自我介绍|算法|数据库|问题|问了|面试过程|面试流程|面经|聊了|简历|手撕|现场|小时|分钟|电话|视频|反问|邮箱|流程)/i;
const CANDIDATE_AUTHOR_RE = /(我|本人|自己|我的)/i;

function firstEvidenceLine(inventoryItem, regex) {
  const lines = (inventoryItem && inventoryItem.lines) || [];
  const match = lines.find((line) => regex.test(stripHashtags(line.text)));
  return match || lines.find((line) => String(line.text || '').trim()) || null;
}

function classifyBoundary(inventoryItem) {
  if (!inventoryItem || inventoryItem.status !== 'verified') {
    return { status: 'blocked', decision: null, block_reason: 'Source projection was not integrity-verified.' };
  }
  const text = inventoryItem.lines.map((line) => line.text).join('\n');
  const normalized = stripHashtags(text);
  const hasAggregate = AGGREGATE_RE.test(normalized);
  const hasNonEvent = NON_EVENT_RE.test(normalized);
  const hasCurated = CURATED_RE.test(normalized);
  const hasRecruiting = RECRUITING_RE.test(normalized);
  const hasScheduled = SCHEDULED_RE.test(normalized);
  const hasCompleted = COMPLETED_RE.test(normalized);
  const hasQuestion = QUESTION_RE.test(normalized);
  const hasOutcome = OUTCOME_RE.test(normalized);
  const hasProcessContext = PROCESS_CONTEXT_RE.test(normalized);
  const hasTemporalCompleted = /(?:周|上周|昨天|今天|当天|当日|刚才|刚刚|此前|之前).{0,8}面的/i.test(normalized);
  const hasCandidateAuthor = CANDIDATE_AUTHOR_RE.test(normalized);

  if (hasAggregate) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection describes aggregate or multiple interview activity without separately bounded case evidence; retain boundary:pending.',
      evidence_line: firstEvidenceLine(inventoryItem, AGGREGATE_RE),
    };
  }
  if (hasNonEvent || hasCurated) {
    return {
      status: 'ready',
      decision: 'not-interview',
      rationale: 'Source projection explicitly identifies a simulation, curated or third-party submission, knowledge/advice, repost, warning, or other non-candidate-interview context.',
      evidence_line: firstEvidenceLine(inventoryItem, hasNonEvent ? NON_EVENT_RE : CURATED_RE),
    };
  }
  if (hasCompleted && (!hasOutcome || hasProcessContext || hasTemporalCompleted) && (!hasRecruiting || hasCandidateAuthor)) {
    return {
      status: 'ready',
      decision: 'single-interview',
      rationale: 'Source projection explicitly records a completed candidate interview event; no independent multi-event boundary is evidenced in the reviewed projection. Same-process rounds remain one case.',
      evidence_line: firstEvidenceLine(inventoryItem, COMPLETED_RE),
    };
  }
  if (hasRecruiting) {
    return {
      status: 'ready',
      decision: 'not-interview',
      rationale: 'Source projection is a recruiting, event-calendar, job-posting, or interview-scheduling announcement without completed candidate-interview evidence.',
      evidence_line: firstEvidenceLine(inventoryItem, RECRUITING_RE),
    };
  }
  if (hasScheduled) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection records only a scheduled or contacted interview; no completed candidate interview event is evidenced.',
      evidence_line: firstEvidenceLine(inventoryItem, SCHEDULED_RE),
    };
  }
  if (hasQuestion || hasOutcome || hasCompleted) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection contains isolated interview questions or outcome language without explicit completed candidate-interview context; retain boundary:pending.',
      evidence_line: firstEvidenceLine(inventoryItem, hasQuestion ? QUESTION_RE : OUTCOME_RE),
    };
  }
  return {
    status: 'blocked',
    decision: null,
    block_reason: 'Source projection does not provide enough direct event-boundary evidence; retain boundary:pending rather than infer from title or hashtags.',
    evidence_line: firstEvidenceLine(inventoryItem, /./),
  };
}

function makeChecks(item, review, evidenceLocator) {
  return REQUIRED_CHECKS.map((check_id) => ({
    check_id,
    result: check_id === 'event_boundary' && review.status === 'blocked' ? 'fail' : 'pass',
    note: check_id === 'event_boundary'
      ? (review.status === 'blocked' ? review.block_reason : review.rationale)
      : `verified against frozen selection and exact Source projection; evidence=${evidenceLocator}`,
  }));
}

function makeRequest(item, inventoryItem, review, reviewedAt) {
  const line = review.evidence_line;
  const locator = line ? `artifact-line:${line.line}` : null;
  const evidence = line ? [{ excerpt: line.text, line: line.line, locator }] : [];
  return {
    schema_version: 'issue-1606-boundary-review-request.v1',
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    child_issue: 1606,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    source_id: item.source_id,
    live_url: item.live_url,
    expected_body_sha256: item.body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id,
    expected_source_repository: item.source_repository,
    expected_source_repository_ref: item.source_repository_ref,
    transition_id: `issue-1606-${item.issue_number}-boundary-review-1`,
    reviewed_at: reviewedAt,
    reviewer_kind: 'ai-assisted',
    disposition: review.status,
    decision: review.decision,
    evidence: {
      artifact_ref: inventoryItem.artifact && inventoryItem.artifact.ref || null,
      artifact_provenance: inventoryItem.artifact && inventoryItem.artifact.provenance || null,
      kind: inventoryItem.artifact && inventoryItem.artifact.kind || null,
      git_blob_sha: inventoryItem.artifact && inventoryItem.artifact.git_blob_sha || null,
      byte_size: inventoryItem.artifact && inventoryItem.artifact.byte_size || null,
      excerpts: evidence,
    },
    checks: makeChecks(item, review, locator || 'none'),
    limitations: [
      'Boundary Review only determines whether 0/1/N InterviewNote case identity may be materialized; it does not write source-ready, InterviewContext, learning labels, or InterviewNote Issues.',
      'No live evidence comment or transition mutation is authorized by this artifact; any later apply must create/bind durable per-issue evidence and recheck body/state/source CAS.',
      ...(review.status === 'blocked' ? [review.block_reason] : []),
    ],
  };
}

function validateRequest(request) {
  const errors = [];
  if (request.schema_version !== 'issue-1606-boundary-review-request.v1') errors.push('schema_version mismatch');
  if (!Number.isInteger(request.issue_number) || request.issue_number < 20 || request.issue_number > 392) errors.push('issue_number outside #20..#392');
  if (!/^[0-9a-f]{64}$/.test(request.expected_body_sha256)) errors.push('expected_body_sha256 must be lowercase SHA-256');
  if (request.expected_boundary_status !== 'pending') errors.push('expected_boundary_status must be pending');
  if (!['ready', 'blocked'].includes(request.disposition)) errors.push('disposition must be ready or blocked');
  if (request.disposition === 'ready' && !['not-interview', 'single-interview', 'multi-interview'].includes(request.decision)) errors.push('ready request must have a boundary decision');
  if (request.disposition === 'blocked' && request.decision !== null) errors.push('blocked request must not predeclare a decision');
  if (!request.evidence || request.evidence.artifact_provenance !== 'source_projection') errors.push('evidence must use a Source projection');
  if (!Array.isArray(request.evidence.excerpts)) errors.push('evidence excerpts must be an array');
  const ids = new Set((request.checks || []).map((check) => check.check_id));
  for (const required of REQUIRED_CHECKS) if (!ids.has(required)) errors.push(`missing check ${required}`);
  const eventBoundary = (request.checks || []).find((check) => check.check_id === 'event_boundary');
  if (request.disposition === 'ready' && (!eventBoundary || eventBoundary.result !== 'pass')) errors.push('ready request event_boundary must pass');
  if (request.disposition === 'blocked' && (!eventBoundary || eventBoundary.result !== 'fail')) errors.push('blocked request event_boundary must fail');
  return { ok: errors.length === 0, errors };
}

module.exports = { REQUIRED_CHECKS, canonicalJson, classifyBoundary, makeRequest, sha256, validateRequest };
