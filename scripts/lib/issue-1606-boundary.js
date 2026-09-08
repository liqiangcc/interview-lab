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

const SCHEDULED_RE = /(约面|约.{0,12}(?:面试|[一二三四五]面)|预约.{0,12}面试|待面试|面试安排|安排.{0,12}面试|面试时间)/i;
const COMPLETED_RE = /(?:(?:周|上周|昨天|今天|当天|当日|刚才|刚刚|此前|之前).{0,8}面的|面[了完]|(?:一面|二面|三面|四面|五面|hr面|HR面).{0,8}(?:完|结束|通过|挂|拒|凉)|面试(?:完|结束|通过)|结束.{0,8}面试|经历.{0,8}面试|已OC|收到.{0,12}offer|挂了|凉经)/i;
const QUESTION_RE = /(面试题|面试.{0,3}问题|面试官提问|问了什么|被问到|题目|算法题|手撕|在线IDE|问了|过程中.{0,10}问|(?:做一下|简述|介绍|说一下|说说|如何|什么是|了解哪些|为什么).{0,30})/i;
const OUTCOME_RE = /(等通知|挂了|拒信|通过了|面试通过|收到.{0,12}offer|感谢信|流程结束|谈薪资|结果|求助|靠谱吗|oc|offer)/i;
const HELP_REQUEST_RE = /(?:想知道|靠谱吗|求助|求问|有人知道|有上班的大佬|求佬|帮忙看看|说一下)/i;
const AGGREGATE_RE = /(多家公司|几家公司|多场面试|几场面试|这几天的面试|面试了?\s*(?:30\+|\d+|[一二三四五六七八九十]+)家|30\+公司|不同公司|累计|分别.{0,10}面试|面完.{0,12}所有大厂|所有大厂|两个(?:公司|组)|两家(?:公司|公司流程)|多个公司|前后面了两个组|面了不少公司|拿了\d+家offer)/i;
const MULTI_PROCESS_RE = /(?:前后面了两个组|两个(?:公司|组|流程)|两家(?:公司|公司流程)|(?:美团|百度|字节|TT(?![A-Za-z])|TikTok|抖音|腾讯|阿里|京东|小米|快手|贝壳|Meta|Shopee|华为)[^\n]{0,80}(?:和|与|、|以及|及|vs|VS)[^\n]{0,80}(?:美团|百度|字节|TT(?![A-Za-z])|TikTok|抖音|腾讯|阿里|京东|小米|快手|贝壳|Meta|Shopee|华为))/i;
const MULTI_BOUNDARY_RE = /(?:前后面了两个组|两个(?:公司|组|流程)|两家(?:公司|公司流程)|^\s*某[^\n]{0,20}面试|^\s*[12][.、].*(?:美团|百度|字节|TT(?![A-Za-z])|TikTok|抖音|腾讯|阿里|京东|小米|快手|贝壳|Meta|Shopee|华为)|(?:美团|百度|字节|TT(?![A-Za-z])|TikTok|抖音|腾讯|阿里|京东|小米|快手|贝壳|Meta|Shopee|华为)[^\n]{0,80}(?:和|与|、|以及|及|vs|VS)[^\n]{0,80}(?:美团|百度|字节|TT(?![A-Za-z])|TikTok|抖音|腾讯|阿里|京东|小米|快手|贝壳|Meta|Shopee|华为)[^\n]*(?:一面|二面|三面|hr面|流程|offer|oc|挂|结束|通过|进行中)|(?:美团|百度|字节|TT(?![A-Za-z])|TikTok|抖音|腾讯|阿里|京东|小米|快手|贝壳|Meta|Shopee|华为)[^\n]*(?:一面|二面|三面|hr面|流程|offer|oc|挂|结束|通过|进行中))/i;
const NON_EVENT_RE = /(模拟面试|模拟一下|题库|刷题|每日积累|代面试|面试诈骗|培训机构|提醒.{0,20}面试|面试辅导|有人知道这个是面试什么|帮公司面试|招聘要求|最新内部信息|面试题合集|面试题大全)/i;
const CURATED_RE = /(投稿|自己带的同学|同学投稿|资料|知识合集|面试真题|面经一致吗|有没有面过.{0,20}说说|参考下面|供大家参考|内容来自|来源[:：]|牛友|牛客网|面试经验分享|面试宝典|常考的题目|可以帮到大家|答案整理|猜一下.{0,12}候选人)/i;
const THIRD_PARTY_RE = /(投稿|自己带的同学|同学投稿|内容来自|来源[:：]|牛友|牛客网|猜一下.{0,12}候选人)/i;
const ADVICE_RE = /(参加面试需要|面试前突击|知识合集|面试宝典|面试题库|面试题|八股文|题库|真题|答案解析|常考的题目|可以帮到大家|整理一份.*面经|最新.*面试题|提供的面试题|答案整理|分享.*面经|分享.*面试系列|面经来喽|欢迎.*答案|面试资料整理|供大家参考|提醒一下同学|面试辅导|简历修改|面试指南|面试轮次不同|提前预判|offer基本稳|需要.*(?:资料|籽料)|内推资源|培训内容|新人保护期|销售任务|每次面试.*分享|面试机会不多|准备得不好|接下来我要.*学习|整体难度不大|基础八股|提前准备好|展示自己|Java面试，看这些就够了|准备改改简历|整理项目问答|认真学一遍|整理项目问答.*薄弱|选择题.{0,8}编程题|轮转.*部门)/i;
const RECRUITING_RE = /(宣讲|内推|岗位|秋招|社招|筛完|快投|日程|内推码|招聘会|招聘信息|招聘公告|在招|面试时间：|找工作|销售|招不到|招聘|要求现场面试|外包公司|套经验)/i;
const PROCESS_CONTEXT_RE = /(面试官|项目|自我介绍|算法|数据库|问题|问了|面试过程|面试流程|面经|聊了|简历|手撕|现场|小时|分钟|电话|视频|反问|邮箱|流程)/i;
const CANDIDATE_AUTHOR_RE = /(我|本人|自己|我的)/i;
const ROUND_RE = /(?:一面|二面|三面|四面|五面|hr面|HR面|技术面|电话一面|面试的一家公司|面试了|面试一共|第一场面试|第一次面试)/i;
const INTERACTION_RE = /(?:面试官|面试体验|面试时长|时长\s*\d+|\d+\s*(?:min|分钟|小时)|反问|拷打|手撕|电话面试\s*\d|线上面试|面试过程中|答得|我答|我回答|交流提问|直接开始|询问|提问|问了|回答|答题|边想边说|面试官.{0,20}(?:问|引导|很好|友好|提醒)|面的(?:还|得|一般|感觉|不错|很|挺))/i;
const DIRECT_EVENT_RE = /(?:面试官|面试体验|面试时长|时长\s*\d+|自我介绍|反问|拷打|手撕|电话面试|电话一面|线上面试|面试过程中|面试结束|面试完|面试了|面试一共|面试的一家公司|第一次面试|第一场面试|一面|二面|三面|hr面|HR面|技术面|答得|我答|回答了)/i;
const IN_PROGRESS_RE = /(?:开始面试|(?:已经|目前|正在).{0,4}面试中|正在面试|马上面试|即将面试|收到面试邀请|约上了面试|等hr面|等通知|准备二面|约了二面|已约二面|待入职)/i;
const FUTURE_COMPLETION_RE = /(?:明天|今天|今晚|后天|希望|准备|要|还得|即将).{0,16}面完/i;
const FUTURE_EVENT_RE = /(?:(?:明天|后天|即将).{0,20}面试|(?:希望|准备).{0,16}面完|(?:准备|打算).{0,8}(?:去|参加|开始).{0,8}面试)/i;
const CANDIDATE_EXCHANGE_RE = /(?:我(?:答|回答|说|写|做)|答不上来|答得|直接.*回答|回答.*就|被问|问(?:是否|怎么|哪些|什么)|面试是按照简历|面试官(?:问了|问我|提问|提示|引导|提醒|自己出的题目)|反问|手撕|面试官.{0,12}(?:很友好|有耐心)|面试时长)/i;
const DIRECT_CANDIDATE_EXCHANGE_RE = /(?:我(?:答|回答|说|写|做)|答不上来|答得|直接.*回答|被问|面试是按照简历|面试官(?:问了|问我|提问|提示|引导|提醒|自己出的题目)|反问|手撕)/i;
const EXPLICIT_COMPLETED_EVENT_RE = /(?:参加(?:了|过)面试|参加面试并完成|完成现场沟通|去面试|面试实录|面了(?:一下|.{0,20}(?:分钟|小时))|面试.{0,20}(?:分钟|小时)|(?:一面|二面|三面|四面|五面|hr面|HR面).{0,20}(?:分钟|小时|通关|通过|结束|挂|凉|拒|被|总结|还凑合|完成|答得|答的|好难)|面试一共[一二三四五\d]+轮|面试过程|面试体验(?:一般|不错|很好|很差)|总计.{0,12}(?:分钟|小时)|总计.{0,12}完成|高强度拷打|面试官.{0,20}(?:很随和|态度都很好|拷打)|第一次面试.{0,12}(?:被|拷打)|第一次两轮技术面|撑到三面|第[一二三四五\d]+家撑到三面|\d+轮面试.{0,12}(?:offer|通过|斩获)|面的(?:还凑合|还行|一般|不错|很)|流程结束)/i;
const EMPTY_PROJECTION_RE = /^\s*$/;

const COMPANY_NAMES = ['美团', '百度', '字节', 'TT', 'TikTok', '抖音', '腾讯', '阿里', '京东', '小米', '快手', '贝壳', 'Meta', 'Shopee', '华为'];

function distinctCompanyCount(text) {
  return COMPANY_NAMES.filter((name) => (name === 'TT' ? /TT(?![A-Za-z])/i : new RegExp(name, 'i')).test(text)).length;
}

function hasMultiProcessEvidence(inventoryItem, normalized) {
  if (/(?:前后面了两个组|两个(?:公司|组|流程)|两家(?:公司|公司流程))/.test(normalized)) return true;
  const lines = (inventoryItem.lines || []).map((line) => stripHashtags(line.text));
  if (lines.some((line) => MULTI_PROCESS_RE.test(line) && distinctCompanyCount(line) >= 2)) return true;
  if (lines.filter((line) => /^\s*某[^\n]{0,20}面试/.test(line)).length >= 2) return true;
  const numberedCompanies = lines.filter((line) => /^\s*[12][.、]/.test(line) && distinctCompanyCount(line) >= 1)
    .flatMap((line) => COMPANY_NAMES.filter((name) => (name === 'TT' ? /TT(?![A-Za-z])/i : new RegExp(name, 'i')).test(line)));
  if (new Set(numberedCompanies).size >= 2) return true;
  const processCompanies = lines.filter((line) => /(?:一面|二面|三面|四面|hr面|HR面|流程|offer|oc|挂|结束|通过|进行中)/i.test(line))
    .flatMap((line) => COMPANY_NAMES.filter((name) => (name === 'TT' ? /TT(?![A-Za-z])/i : new RegExp(name, 'i')).test(line)));
  return new Set(processCompanies).size >= 2;
}

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
  const hasMultiBoundary = hasMultiProcessEvidence(inventoryItem, normalized);
  const hasNonEvent = NON_EVENT_RE.test(normalized);
  const hasThirdParty = THIRD_PARTY_RE.test(text);
  const hasAdvice = ADVICE_RE.test(normalized);
  const hasCurated = CURATED_RE.test(normalized) || hasThirdParty || hasAdvice;
  const hasRecruiting = RECRUITING_RE.test(normalized);
  const hasScheduled = SCHEDULED_RE.test(normalized);
  const hasFutureEvent = FUTURE_EVENT_RE.test(normalized);
  const hasCompleted = COMPLETED_RE.test(normalized) && !FUTURE_COMPLETION_RE.test(normalized);
  const hasQuestion = QUESTION_RE.test(normalized);
  const hasOutcome = OUTCOME_RE.test(normalized);
  const hasProcessContext = PROCESS_CONTEXT_RE.test(normalized);
  const hasTemporalCompleted = /(?:周|上周|昨天|今天|当天|当日|刚才|刚刚|此前|之前).{0,8}面的/i.test(normalized);
  const hasCandidateAuthor = CANDIDATE_AUTHOR_RE.test(normalized);
  const hasDirectEvent = DIRECT_EVENT_RE.test(normalized);
  const hasInteraction = INTERACTION_RE.test(normalized);
  const hasCandidateExchange = CANDIDATE_EXCHANGE_RE.test(normalized);
  const hasDirectCandidateExchange = DIRECT_CANDIDATE_EXCHANGE_RE.test(normalized);
  const hasExplicitCompletedEvent = EXPLICIT_COMPLETED_EVENT_RE.test(normalized);
  const hasStrongCompletedEvent = hasExplicitCompletedEvent && !/面试实录/i.test(normalized);
  const hasQuestionList = inventoryItem.lines.filter((line) => /(?:^\s*\d+[.、]|^\s*[•●])/.test(stripHashtags(line.text)) && stripHashtags(line.text).length > 4).length >= 3;
  const hasStrongCandidateMarker = hasCandidateAuthor || hasCandidateExchange || hasQuestion || /(?:体验|拷打|被八股|面的(?:还|得|一般|不错)|面了一下|面试官|斩获.*offer|答得|答的|总结|流程结束|撑到三面|两轮技术面)/i.test(normalized);
  const hasRound = ROUND_RE.test(normalized);
  const hasInProgress = IN_PROGRESS_RE.test(normalized);
  const hasStructuredProcess = hasInteraction || (hasRound && (hasQuestion || hasProcessContext));
  const hasCompletedCandidate = (hasCompleted && (hasCandidateExchange || hasQuestion || (hasExplicitCompletedEvent && (hasProcessContext || hasQuestion || hasCandidateExchange)) || (hasTemporalCompleted && hasOutcome)))
    || (!hasCompleted && hasExplicitCompletedEvent && (hasProcessContext || hasQuestion || hasCandidateExchange))
    || (hasStrongCompletedEvent && !hasScheduled && hasStrongCandidateMarker)
    || (hasCandidateExchange && (hasQuestion || /(?:介绍项目|面试官.{0,20}(?:很好|好|问|引导|提醒|提示))/i.test(normalized)));
  const hasNonHashtagText = inventoryItem.lines.some((line) => !EMPTY_PROJECTION_RE.test(stripHashtags(line.text)));

  if (hasFutureEvent && !hasCompletedCandidate && !hasCompleted) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection describes preparation for or a hoped-for future interview; no completed candidate interview event is evidenced.',
      evidence_line: firstEvidenceLine(inventoryItem, FUTURE_EVENT_RE),
    };
  }

  if (hasInProgress && !hasCompletedCandidate && !hasCompleted) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection records an invitation, appointment, or in-progress interview state; no completed candidate interview event is evidenced.',
      evidence_line: firstEvidenceLine(inventoryItem, IN_PROGRESS_RE),
    };
  }

  if (hasThirdParty) {
    return {
      status: 'ready',
      decision: 'not-interview',
      rationale: 'Source projection explicitly attributes the material to a third party, student submission, or external source; it is not evidence of the repository note author completing a candidate interview.',
      evidence_line: firstEvidenceLine(inventoryItem, THIRD_PARTY_RE),
    };
  }
  if (hasAdvice && !hasCompleted && !hasDirectCandidateExchange) {
    return {
      status: 'ready',
      decision: 'not-interview',
      rationale: 'Source projection is advice, a question-bank compilation, or recruiting guidance rather than a bounded candidate-completed interview event.',
      evidence_line: firstEvidenceLine(inventoryItem, ADVICE_RE),
    };
  }
  if (hasQuestionList && !hasCompletedCandidate && !hasCompleted && !hasRound && !hasCandidateExchange) {
    return {
      status: 'ready',
      decision: 'not-interview',
      rationale: 'Source projection is an unbounded multi-question compilation without candidate-specific completed interaction or a named interview round; treat it as question-bank/advice material, not an InterviewNote case.',
      evidence_line: firstEvidenceLine(inventoryItem, QUESTION_RE),
    };
  }
  if (hasAdvice && !hasCompletedCandidate && (hasOutcome || hasCompleted) && !hasInteraction && !hasQuestion) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection combines an outcome with advice or a question-bank compilation, but supplies no independent candidate-interview process evidence; retain boundary:pending.',
      evidence_line: firstEvidenceLine(inventoryItem, OUTCOME_RE),
    };
  }
  if (hasRound && hasDirectEvent && !hasRecruiting && !hasCompletedCandidate && !hasCompleted && !hasQuestion && !hasCandidateExchange && !hasExplicitCompletedEvent) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection names an interview round but does not provide completed candidate interaction, interviewer exchange, or bounded process evidence; title/round label alone is insufficient.',
      evidence_line: firstEvidenceLine(inventoryItem, ROUND_RE),
    };
  }
  if (hasExplicitCompletedEvent && /面试实录/i.test(normalized) && !hasCompletedCandidate) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection contains only a title/label claiming an interview record; the projection has no candidate interaction, interviewer exchange, or bounded process excerpt to verify completion.',
      evidence_line: firstEvidenceLine(inventoryItem, EXPLICIT_COMPLETED_EVENT_RE),
    };
  }
  if (hasMultiBoundary && (hasCompletedCandidate || hasCompleted || hasOutcome || hasProcessContext)) {
    return {
      status: 'ready',
      decision: 'multi-interview',
      rationale: 'Source projection separately names multiple company/process boundaries and records completed candidate activity; retain N rather than collapsing independent processes into one case.',
      evidence_line: firstEvidenceLine(inventoryItem, MULTI_BOUNDARY_RE),
    };
  }

  if (hasOutcome && HELP_REQUEST_RE.test(normalized) && !hasDirectCandidateExchange && !hasProcessContext && !hasStrongCompletedEvent) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection contains an outcome/result followed by a help or advice request, but no candidate-interview process, interviewer exchange, or bounded completion evidence is present; retain boundary:pending.',
      evidence_line: firstEvidenceLine(inventoryItem, OUTCOME_RE),
    };
  }

  if (hasAggregate) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection describes aggregate or multiple interview activity without separately bounded case evidence; retain boundary:pending.',
      evidence_line: firstEvidenceLine(inventoryItem, AGGREGATE_RE),
    };
  }
  if ((hasNonEvent || (hasCurated && !hasStructuredProcess)) && !hasCompletedCandidate && !(hasRound && hasStructuredProcess)) {
    return {
      status: 'ready',
      decision: 'not-interview',
      rationale: 'Source projection explicitly identifies a simulation, curated or third-party submission, knowledge/advice, repost, warning, or other non-candidate-interview context.',
      evidence_line: firstEvidenceLine(inventoryItem, hasNonEvent ? NON_EVENT_RE : CURATED_RE),
    };
  }
  if ((hasCompletedCandidate || (hasRound && hasStructuredProcess && !hasInProgress && !hasScheduled && (hasQuestion || hasCandidateExchange || hasExplicitCompletedEvent || hasCompleted))) && (!hasRecruiting || hasCandidateAuthor || hasCompletedCandidate || hasCompleted)) {
    return {
      status: 'ready',
      decision: 'single-interview',
      rationale: 'Source projection explicitly records a completed candidate interview event; no independent multi-event boundary is evidenced in the reviewed projection. Same-process rounds remain one case.',
      evidence_line: firstEvidenceLine(inventoryItem, hasExplicitCompletedEvent ? EXPLICIT_COMPLETED_EVENT_RE : (hasInteraction ? INTERACTION_RE : (hasCompleted ? COMPLETED_RE : (hasQuestion ? QUESTION_RE : DIRECT_EVENT_RE)))),
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
  if (hasInProgress || hasScheduled) {
    return {
      status: 'blocked',
      decision: null,
      block_reason: 'Source projection records only a scheduled or contacted interview; no completed candidate interview event is evidenced.',
      evidence_line: firstEvidenceLine(inventoryItem, SCHEDULED_RE),
    };
  }
  if (hasQuestion || hasOutcome || hasCompleted) {
    const evidenceLine = firstEvidenceLine(inventoryItem, hasQuestion ? QUESTION_RE : OUTCOME_RE);
    return {
      status: 'blocked',
      decision: null,
      block_reason: hasQuestion
        ? 'Source projection contains an isolated question bank or question list, but no candidate-specific completed interaction, interviewer exchange, or bounded process is evidenced.'
        : 'Source projection contains only an outcome/result or request for advice; the completed candidate-interview process needed for 0/1/N identity is not evidenced.',
      evidence_line: evidenceLine,
    };
  }
  const evidenceLine = firstEvidenceLine(inventoryItem, SCHEDULED_RE);
  return {
    status: 'blocked',
    decision: null,
    block_reason: !hasNonHashtagText
      ? 'Source projection contains no non-hashtag event text; title/labels cannot establish a candidate interview boundary.'
      : hasScheduled
        ? 'Source projection records an invitation, appointment, pending, or in-progress state but no completed candidate-interview event.'
        : 'Source projection has interview-adjacent language but lacks a direct completed candidate interaction, bounded process, or reliable outcome context; retain boundary:pending.',
    evidence_line: evidenceLine || firstEvidenceLine(inventoryItem, /./),
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
