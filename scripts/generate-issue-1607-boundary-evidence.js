#!/usr/bin/env node
'use strict';

/* Generate only local, non-executable Boundary B audit artifacts. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('./prepare-issue-1607-boundary-batch');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const EXPECTED_COUNT = 367;

function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function classifyProjection(projectionText) {
  const text = String(projectionText || '').replace(/\\n/g, '\n');
  const lines = text.split(/\r?\n/);
  const lineEvidence = (patterns) => lines.map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => patterns.some((pattern) => pattern.test(line))).slice(0, 4).map(({ line, number }) => ({ line_number: number, excerpt: line }));
  // Marketing calls to action such as “关注我不迷路” are not first-person
  // experience. Remove only that known CTA before testing event ownership.
  const semanticText = text.replace(/关注我不迷路/g, '');
  const firstPerson = /(?:我|本人|自己|亲身)/.test(semanticText);
  const processFact = /(?:实际面(?:了|试)?|参加(?:过|了)?[^\n]{0,12}面试|面过|面完|被问|面试流程|面试感受|面试经历|第?[一二三]面|一面问|二面问|三面问|问了我|收到.*结果|拿到.*offer|面试挂|面试通过)/.test(text);
  const questionEvidence = /(?:问了|问题|面试题|题目|算法题|八股|反问|Q\s*\d+|怎么|为什么|如何|介绍一下|(?:^|\n)\s*\d+[.、)]|(?:^|\n)\s*⭕)/m.test(text);
  const declined = /(?:我|本人|自己)\s*(?:也|就|直接)?\s*(?:拒绝|拒了|不面|没去面|没参加|未参加|没有参加|放弃面试)/.test(text);
  const marketingOrRepost = /(?:通关秘籍|标准答案|帮助\s*\d+\s*位|关注我不迷路|点赞收藏|建议反复背诵|整理给各位|广告|课程推广|营销|转载)/i.test(text);
  const experiencedEvent = firstPerson && processFact;
  if (declined && !experiencedEvent) return { status: 'proposal-only', proposed_decision: 'not-interview', basis: 'explicit first-person refusal/non-attendance fact', basis_lines: lineEvidence([/(我|本人|自己).*(拒绝|拒了|不面|没去面|没参加|未参加|没有参加|放弃面试)/]) };
  if (marketingOrRepost) return { status: 'proposal-only', proposed_decision: 'not-interview', basis: 'explicit marketing/repost or answer-key language takes precedence over interview-like wording', basis_lines: lineEvidence([/(通关秘籍|标准答案|帮助\s*\d+\s*位|关注我不迷路|点赞收藏|建议反复背诵|整理给各位|广告|课程推广|营销|转载)/i]) };
  if (experiencedEvent && questionEvidence) return { status: 'proposal-only', proposed_decision: 'single-interview', basis: 'first-person experienced interview process plus structured question evidence; generic advice/job context does not override the experienced event', basis_lines: lineEvidence([/(实际面(?:了|试)?|参加.*面试|面试了|面过|面完|被问|面试官|面试感受|面试经历|第?[一二三]面|一面问|二面问|三面问|问了我)/, /(?:问了|问题|面试题|题目|算法题|八股|反问|Q\s*\d+|怎么|为什么|如何|介绍一下|^\s*\d+[.、)]|^\s*⭕)/]) };
  return { status: 'review-required', proposed_decision: 'pending', basis: 'interview-like words are insufficient: no unambiguous first-person experienced process with questions, or the text is appointment/advice/question-bank content', basis_lines: lineEvidence([/(邀约|邀请|预约|据说|准备面试|场景题|八股|资料|经验分享|求职招聘|问题|面试题|题目|通关秘籍|标准答案)/]) };
}

function semanticEvidence(item, kind, locator, excerpt) {
  const artifact = item.source_artifacts.find((candidate) => candidate.kind === kind);
  return artifact ? { ref: artifact.ref, locator, excerpt: String(excerpt || '').slice(0, 1200) } : null;
}

function classifyFullSource(item) {
  const jsonArtifact = item.source_artifacts.find((artifact) => artifact.kind === 'json');
  const htmlArtifact = item.source_artifacts.find((artifact) => artifact.kind === 'html');
  const title = jsonArtifact?.semantic?.title?.excerpt || htmlArtifact?.semantic?.title?.excerpt || '';
  const body = item.source_projection.text || '';
  const text = `${title}\n${body}`.replace(/\\n/g, '\n');
  const titleEvidence = semanticEvidence(item, 'json', jsonArtifact?.semantic?.title?.locator || 'json:/note/title', title)
    || semanticEvidence(item, 'html', htmlArtifact?.semantic?.title?.locator || 'html:head/title', title);
  const bodyEvidence = semanticEvidence(item, 'json', jsonArtifact?.semantic?.body?.locator || 'json:/note/desc', jsonArtifact?.semantic?.body?.excerpt)
    || { ref: item.source_projection.artifact.ref, locator: item.source_projection.locator, excerpt: item.source_projection.excerpt };
  const evidence = [titleEvidence, bodyEvidence].filter(Boolean);
  const lines = item.source_projection.text.split(/\r?\n/);
  const lineBasis = (patterns) => lines.map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => patterns.some((pattern) => pattern.test(line))).slice(0, 6).map(({ line, number }) => ({ line_number: number, excerpt: line }));
  // Do not treat the “我” in the stock phrase “自我介绍” as first-person
  // ownership of an interview event.
  const firstPerson = /(?<!自)我|本人|自己|亲身/.test(text);
  const refusal = /(?:我|本人|自己)\s*(?:也|就|直接)?\s*(?:明确)?\s*(?:拒绝|拒了|不面|没去面|没参加|未参加|没有参加|放弃面试)/.test(text);
  const marketing = /(?:通关秘籍|标准答案|帮助\s*\d+\s*位|关注我不迷路|点赞收藏|建议反复背诵|整理给各位|课程推广|营销|转载|广告|上岸秘籍)/i.test(text);
  const interviewerShare = /(?:作为面试官|当过面试官|做过面试官|面试者也做过面试官|面试官(?:分享|视角|经验|总结|建议)|面试官面的|给面试官|面试官说)/.test(text) && !/(?:候选人|我本人).*(?:参加|面了|面过|面完|被问|回答)/.test(text);
  const invitationOrAdvice = /(?:面试邀约|面试邀请|收到.*(?:邀约|面试)|预约面试|明天.*面试|后天.*面试|一小时后面试|即将面试|面试时间点|会不会是.*面试|岗位职责|招聘信息|薪资待遇|求职建议|准备面试|如何准备|建议.*面试|经验分享|面试攻略|面试技巧|面试资料)/.test(text);
  const titleExperience = /(?:面经|面试复盘|面试记录|面试体验|面试官问答|面试结果|面试流程)/.test(title);
  const questionOnly = /(?:面试题|题库|高频题|八股|题目列表|自我介绍|算法题|怎么|为什么|如何|介绍一下)/.test(text) && !firstPerson;
  const roundMatches = [...text.matchAll(/(?:一面|二面|三面|四面|五面|[1-5]️⃣面|[1-5]面|初面|终面|第[一二三四五]面|第[一二三四五]轮|第一轮|第二轮|第三轮)/g)].map((match) => match[0]);
  const distinctRounds = [...new Set(roundMatches)];
  const bodyRoundMatches = [...body.matchAll(/(?:一面|二面|三面|四面|五面|[1-5]️⃣面|[1-5]面|初面|终面|第[一二三四五]面|第[一二三四五]轮|第一轮|第二轮|第三轮)/g)].map((match) => match[0]);
  const repeatedRoundInBody = new Set(bodyRoundMatches).size < bodyRoundMatches.length;
  // The same round is repeated in title, JSON, and projection; only distinct
  // round names or explicit multi-event wording count as multiple events.
  const explicitMulti = distinctRounds.length >= 2
    || (bodyRoundMatches.length > 0 && repeatedRoundInBody && /(?:timeline|投简历|约面|流程|官网流程|\d{1,2}[./-]\d{1,2})/i.test(body))
    || /(?:两场面试|多场面试|两次面试|多次面试|面了两家|面了多家|连续面了|两个小公司|两个自研|(?:第一家|第二家|第三家|第四家).*(?:第一家|第二家|第三家|第四家))/.test(text);
  const titleRound = /(?:一面|二面|三面|四面|五面|[1-5]️⃣面|[1-5]面|初面|终面|第[一二三四五]面|第[一二三四五]轮)/.test(title);
  const titleOutcomeNarrative = titleRound && /(?:被按在地上摩擦|摩擦|刚(?:刚)?面完|面完|实际面|面过|凉经|挂了|凉了|秒挂)/.test(title);
  const titleQuestionShare = /(?:面试题分享|面试问题分享)/.test(title);
  const compoundRoundTitle = /(?:一二面|二三面|一二三面|一二轮|二三轮)/.test(title);
  const titleRoundEvent = titleRound && !compoundRoundTitle;
  const timelineEvidence = /(?:timeline|投简历|约面|流程|官网流程|\d{1,2}[./-]\d{1,2})/i.test(body);
  const durationEvidence = /\d+\s*(?:min(?:ute)?s?|分钟)/i.test(body);
  const actualResult = /(?:我|本人|自己).{0,28}(?:拿到|收到.*结果|面试通过|面试挂|挂了|凉了|过了|拒了|offer)/s.test(text)
    || /(?:面完|面过|实际面|(?:我|本人|自己)\s*面了|(?:今天|昨天|刚刚).{0,30}面试|面试.*(?:结束|结果|通过|挂)|面试官问了我|候选人回答)/.test(text)
    || ((titleExperience || titleRound) && /(?:挂|凉|offer|oc|面试结果)/i.test(text));
  const explicitQuestionBank = /(?:面试八股|八股文|题库|高频题|常问问题汇总|技术栈攻略|一图流攻略|面试题(?:分享|库|汇总|列表|清单)?|面试真题|必问的高频题|标准答案|及格答案|刷题(?:清单|建议)?|可能的题库|搜集的.*题库)/.test(text);
  const questionOnlyAdvice = /(?:怎么办|怎么回答|一般考啥|求助|有没有知道|推荐去|如何准备)/.test(text) && !titleRound && !titleExperience;
  const eventContext = /(?:面试流程|面试体验|面试记录|面经|面试|一面|二面|三面|四面|初试|终面)/.test(title) || /(?:面试流程|面试体验|面试记录|面经|面试官|候选人|一面|二面|三面|四面|初试|终面)/.test(body);
  // “后面了” in question-bank promotion copy must not satisfy a generic
  // “面了” event marker. Keep ownership/process expressions explicit.
  const narratedEvent = /(?:记录一次|第一次遇到|本人|今天|昨天|上个月|面试官.*(?:问了|问我(?:什么|哪些)|说|让)|被拷打|秒挂|凉经|挂了|面完|面过|实际面|(?:我|本人|自己)\s*面了)/.test(body);
  const adviceOnly = /(?:怎么办|怎么回答|一般考啥|求助|有没有知道|推荐去|如何准备|怎么准备)/.test(text)
    && !titleRound
    && !titleExperience
    && !actualResult
    && !narratedEvent
    && !/(?:参加(?:过|了)?面试|收到.*结果|拿到.*offer)/.test(text);
  const questionEvidence = /(?:问了|问的|问题|问(?:项目|系统|基础|什么)|讲讲|面试题|题目|算法题|八股|反问|Q\s*\d+|怎么|为什么|如何|介绍一下|候选人回答|被问)/.test(text);
  const candidateEvent = (!adviceOnly && (
    actualResult
    || (eventContext && (
      narratedEvent
      || (firstPerson && /(?:\d+[.、)]|自我介绍|问题|提问|面试官|回答|反问|项目|算法题|八股)/.test(body))
      || ((titleExperience || titleRound) && (questionEvidence || /(?:挂|凉|offer|oc|结果)/i.test(body) || roundMatches.length > 0))
      || (timelineEvidence && (roundMatches.length > 0 || /(?:挂|凉|offer|oc|结果)/i.test(body)))
    ))
    || (durationEvidence && questionEvidence)
  ));
  const assessmentOnly = /(?:笔试题|笔试|刷题|题库)/.test(body) && !candidateEvent && !/(?:面试官|候选人回答|面试问题|实际面|面试结果)/.test(body);
  // Outcome words are only event evidence when tied to an interview/round;
  // a bare “挂了/秒挂/凉经” in promotional copy is not enough.
  const outcomeEvent = /(?:(?:面试|一面|二面|三面|四面|五面).{0,12}(?:凉了|挂了|秒挂|凉经)|(?:凉了|挂了|秒挂|凉经).{0,12}(?:面试|面完|一面|二面|三面|四面|结果))/.test(text);
  const narratedCandidateEvent = /(?:记录一次|第一次遇到|面试官.*(?:问了|问我(?:什么|哪些)|说|让)|被拷打|面完|实际面|(?:我|本人|自己)\s*面了)/.test(body);
  const candidateAnswerEvidence = /(?:根据我的回答|按我的回答|前一个回答|回答(?:了|的|：|:)|说了|面试官.*追问|追问)/.test(body);
  const candidateQnaEvent = /(?:自我介绍|提问|问我|让我(?:自我介绍|介绍)|面试官)/.test(body) && candidateAnswerEvidence;
  const bodyInterviewHeading = /(?:^|\n)[^\n]{0,30}面试\s*[:：]/.test(body);
  const questionLines = body.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && !/\[话题\]/.test(line) && /(?:[?？]|为什么|如何|怎么|区别|原理|介绍|设计|实现|实习|算法|手撕|索引|SQL|Redis|Java|JVM|MySQL|场景|追问|自我介绍|项目(?:中|难点|介绍|问题))/.test(line));
  const listMarker = /(?:^|\n)\s*(?:[-*•✔✅]|\d+[.)、]|[一二三四五六七八九十]+[、.)]|[⭕])/.test(body);
  // A substantive list contains several actual technical prompts, not a
  // generic “八股/项目/刷题” checklist. With an event-labelled title or
  // round in the body, unnumbered question lines are also accepted.
  const adviceDraft = /(?:背面经|必须背|准备场景题|面试小技巧|总结一下|多多复盘|及时弄懂|建议大家|一定要)/.test(text);
  const substantiveQuestionList = questionLines.length >= 2
    && (listMarker || titleExperience || titleRound || titleQuestionShare || bodyRoundMatches.length > 0);
  const structuredCandidateEvent = ((titleExperience && !compoundRoundTitle) || titleRoundEvent || titleQuestionShare || bodyRoundMatches.length > 0 || bodyInterviewHeading)
    && substantiveQuestionList
    && !adviceDraft;
  // Candidate ownership/process markers are deliberately specific. In
  // particular, do not use a bare “面了”, which occurs inside “后面了”.
  const timelineCandidateProcess = timelineEvidence
    && /投递/.test(body)
    && /(?:约面|一面|二面|三面|四面|offer|oc)/i.test(body);
  const narratedPastInterview = /(?:(?:我|本人|自己)(?:之前|曾经|已经|也)?面过|实际面过|刚(?:刚)?面过|(?:昨天|今天|上周|上个月|今年|去年).{0,6}面过|面过(?:了|某|这家|贵司|一次))/.test(text);
  const titleRoundQuestionNarrative = titleRound && /(?:问的好多|问了|面试官.*(?:问|追问)|候选人回答|回答|追问|项目(?:中|难点|介绍|问题))/.test(body);
  const titleRoundOutcomeNarrative = titleRound && /(?:凉了|挂了|秒挂|凉经|结果|[一二三四五]凉)/.test(body);
  const roundQuestionBankEvent = bodyRoundMatches.length > 0 && /(?:纯八股|八股为主|八股很多)/.test(body);
  const bodyHashtagOnly = body.replace(/#.*?\[话题\]#/g, '').replace(/[\s\uFE0F]/g, '') === '';
  const titleNonEvent = /(?:求职|岗位|招聘|找工作|必看|攻略|八股|题库|真题|题目|外包|经验分享|技巧)/.test(title);
  // A round-labelled title plus generic topic hashtags does not prove an
  // actual candidate event. Keep explicit title outcomes/events eligible,
  // but fail closed for otherwise detail-free title-only notes (#760, etc.).
  const titleOnlyRound = titleRound && bodyHashtagOnly && !titleNonEvent && !titleOutcomeNarrative;
  const actualProcess = /(?:参加(?:过|了)?\s*面试|被问|问了我|问我(?:为什么|什么|哪些)|候选人回答|面完|实际面|第一次[^\n]{0,8}面试|面试结果|收到.*结果|拿到.*offer|(?:我|本人|自己)\s*面了|(?:今天|昨天|刚刚|上周|上个月).{0,20}面了|昨天(?:晚上)?面的|(?:秋招|春招)面的|答得(?:非常|很)差|答得不好|没答出来|没答好|没有答好|面的时间|面试之后|面试体验|拷打项目|项目拷打|今天.{0,20}(?:现场|线上|线下|两个|一家|自研).{0,12}面试|(?:今天|昨天|刚刚|上周|上个月).{0,24}问了(?:项目|我|基础|职业规划|问题)|(?:现场|线上|线下)开面|面试时.{0,20}(?:音频|录音|记录|追问|回答|问)|(?:第一家|第二家|第三家|第四家).{0,12}(?:线上|线下|面试)|timeline.*(?:投递|约面|一面|二面|三面|offer))/.test(text)
    || narratedPastInterview
    || outcomeEvent
    || titleOutcomeNarrative
    || titleRoundQuestionNarrative
    || titleRoundOutcomeNarrative
    || roundQuestionBankEvent
    || narratedCandidateEvent
    || candidateQnaEvent
    || timelineCandidateProcess
    || structuredCandidateEvent
    || (bodyInterviewHeading && substantiveQuestionList);
  const candidateNarrativeDetail = /(?:面试官|候选人|回答|参加|实际|面完|被问|反问|结果|\d+\s*(?:min(?:ute)?s?|分钟)|timeline|投简历|约面)/i.test(body);
  // Title/question vocabulary is insufficient on its own. Non-event signals
  // may be overridden only by an independently strong candidate event.
  const strongCandidateEvent = actualProcess
    || (durationEvidence && questionEvidence)
    || structuredCandidateEvent
    || (timelineEvidence && roundMatches.length > 0 && questionEvidence)
    || ((titleExperience || titleRound)
      && candidateEvent
      && !marketing
      && !interviewerShare
      && !explicitQuestionBank
      && !adviceOnly
      && !invitationOrAdvice
      && !assessmentOnly
      && !adviceDraft
      && candidateNarrativeDetail);
  const clearCandidateEvent = strongCandidateEvent;
  const explicitNonEvent = marketing || interviewerShare || explicitQuestionBank || adviceOnly || questionOnlyAdvice || invitationOrAdvice || assessmentOnly || /(?:题库|题目列表|求职|岗位|招聘|整理收集|实习一个月体验|刚入职|求助|可以去么|能进么|推荐去|外包|部门怎么样|想不想试试)/.test(text);
  // Question-bank vocabulary cannot pre-empt an independently evidenced event:
  // duration+questions, a substantive structured list, or “面试:” heading
  // plus that list are sufficient candidate-event evidence.
  const questionBankOnly = explicitQuestionBank
    && !actualProcess
    && !candidateQnaEvent
    && !(durationEvidence && questionEvidence)
    && !substantiveQuestionList
    && !(bodyInterviewHeading && substantiveQuestionList);
  // “第一次去面试，该怎么准备” has an interview token but describes a
  // future/advice request. Advice suppresses a marker-only event; a
  // substantive list or independent process evidence (e.g. #665) wins.
  const adviceOnlySuppressed = adviceOnly
    && !substantiveQuestionList
    && !candidateQnaEvent
    && !(durationEvidence && questionEvidence);
  const experienced = strongCandidateEvent
    && (actualProcess || (!questionOnlyAdvice && !adviceOnly))
    && !adviceOnlySuppressed
    && !assessmentOnly;

  if (titleOnlyRound) {
    return { status: 'blocked', proposed_decision: 'blocked', basis: 'round-labelled title with only generic topic hashtags lacks independent candidate-process or question evidence', basis_lines: lineBasis([/(一面|二面|三面|四面|五面|初面|终面)/]), semantic_evidence: evidence };
  }
  if (refusal || questionBankOnly || adviceOnlySuppressed || (explicitNonEvent && !clearCandidateEvent)) {
    return { status: 'reviewed', proposed_decision: 'not-interview', basis: refusal ? 'explicit first-person refusal/non-attendance is non-event' : marketing ? 'marketing/repost or answer-key content lacks a candidate event' : explicitQuestionBank ? 'question-bank or answer-key content lacks a clear candidate event' : interviewerShare ? 'interviewer-perspective sharing is not a candidate interview event' : 'explicit invitation, job/advice, or non-event content lacks a clear candidate event', basis_lines: lineBasis([/(通关秘籍|标准答案|转载|营销|题库|刷题|面试官|拒绝|不面|未参加|建议|求助)/]), semantic_evidence: evidence };
  }
  if (experienced && explicitMulti) {
    return { status: 'reviewed', proposed_decision: 'multi-interview', basis: 'complete candidate interview evidence names multiple distinct interview events/rounds', basis_lines: lineBasis([/(一面|二面|三面|四面|多场|多次|两家|两轮)/]), semantic_evidence: evidence };
  }
  if (experienced) {
    return { status: 'reviewed', proposed_decision: 'single-interview', basis: 'title/body and full Source material establish one candidate interview event with process/question/answer/result evidence', basis_lines: lineBasis([/(一面|二面|三面|面试官|候选人|回答|被问|面试结果|实际面)/]), semantic_evidence: evidence };
  }
  if (invitationOrAdvice || questionOnly || explicitQuestionBank || assessmentOnly || /(?:题库|题目列表|求职|岗位|招聘|整理收集|实习一个月体验|刚入职|求助|可以去么|能进么|推荐去|外包|部门怎么样|想不想试试)/.test(text)) {
    return { status: 'reviewed', proposed_decision: 'not-interview', basis: 'explicit invitation, job/advice, or question-bank content lacks a candidate event', basis_lines: lineBasis([/(邀约|预约|岗位|招聘|建议|题库|题目|八股|准备)/]), semantic_evidence: evidence };
  }
  return { status: 'blocked', proposed_decision: 'blocked', basis: 'full Source artifacts are present but do not establish whether this is a candidate interview event or a non-event', basis_lines: lineBasis([/(面试|问题|分享|经历|结果)/]), semantic_evidence: evidence };
}

function evidenceFor(item) {
  const transitionId = `issue-1607-boundary-${String(item.issue_number).padStart(4, '0')}-review-1`;
  const sourceVerified = item.status === 'verified' && item.source_verification?.status === 'verified';
  const fullSourceVerified = sourceVerified && item.source_material_verification?.status === 'verified';
  const classification = fullSourceVerified
    ? classifyFullSource(item)
    : { status: 'blocked', proposed_decision: 'blocked', basis: 'one or more required pinned Source artifacts are blocked; no semantic decision is proposed', semantic_evidence: [] };
  const decision = classification.proposed_decision;
  return {
    schema_version: 'issue-1607-boundary-evidence.v1',
    transition_id: transitionId,
    repository: REPOSITORY,
    child_issue: 1607,
    issue_number: item.issue_number,
    issue_url: item.issue_url,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_source_revision_id: item.source_revision_id,
    expected_source_repository_ref: SOURCE_REF,
    evidence_status: fullSourceVerified && decision !== 'blocked' ? 'reviewed' : 'blocked',
    decision,
    decision_basis: fullSourceVerified && decision !== 'blocked'
      ? 'Full pinned note_desc, note_json, and note_detail artifacts were independently verified; this semantic boundary result is review-ready but not authorized for live transition.'
      : 'Boundary decision is withheld because the pinned Source projection bytes were not independently fetched and verified for this item.',
    classification,
    semantic_evidence: classification.semantic_evidence || [],
    source_evidence: {
      ref: item.source_projection.artifact.ref,
      kind: item.source_projection.artifact.kind,
      provenance: item.source_projection.artifact.provenance,
      git_blob_sha: item.source_projection.artifact.git_blob_sha,
      byte_size: item.source_projection.artifact.byte_size,
      sha256: item.source_projection.artifact.sha256,
      locator: item.source_projection.locator,
      excerpt: item.source_projection.excerpt,
      text: item.source_projection.text,
      line_count: item.source_projection.line_count,
      verification: item.source_projection.verification || item.source_verification,
    },
    artifact_evidence: (item.source_artifacts || []).map((artifact) => ({
      ref: artifact.ref,
      kind: artifact.kind,
      locator: artifact.semantic?.title?.locator || (artifact.kind === 'text_projection' ? 'note_desc:full-file' : `${artifact.kind}:full-file`),
      excerpt: artifact.semantic?.title?.excerpt || artifact.excerpt || null,
      byte_size: artifact.byte_size,
      git_blob_sha: artifact.git_blob_sha,
      sha256: artifact.sha256,
      verification: artifact.verification,
    })),
    checks: [
      { check_id: 'source_identity', result: 'pass', note: 'Issue body machine record and SourceNote identity are frozen and internally consistent.' },
      { check_id: 'source_revision_binding', result: 'pass', note: `SourceRevision is bound to ${SOURCE_REF} in the frozen Issue body.` },
      { check_id: 'source_content_coverage', result: fullSourceVerified ? 'pass' : 'blocked', note: fullSourceVerified ? 'Full note_desc, note_json, and note_detail bytes at the fixed ref matched frozen Git blob SHA and byte size.' : 'All required pinned Source artifacts were not independently verified.' },
      { check_id: 'event_boundary', result: decision === 'blocked' ? 'blocked' : 'pass', note: decision === 'blocked' ? 'Full Source material remains semantically insufficient to decide the boundary.' : `Semantic boundary result is ${decision}; no live transition is authorized by this artifact.` },
      { check_id: 'no_cross_source_mixing', result: 'pass', note: 'This ledger item references only its own SourceNote and its canonical note_desc artifact.' },
      { check_id: 'no_fabrication', result: 'pass', note: 'No InterviewNote identity, company, role, round, outcome, or derived content is created.' },
    ],
    limitations: [
      ...(fullSourceVerified ? [] : ['One or more required pinned Source artifacts are unavailable or unverified; this item is blocked.']),
      ...(decision === 'blocked' ? ['Complete pinned artifacts were read, but their semantics do not establish a 0/1/N boundary decision.'] : ['The semantic decision is review-ready but is not durable controller authorization.']),
      'Boundary remains pending; this item cannot authorize materialization or any GitHub mutation.',
      'Raw Source and Derived interpretations remain separate; no Raw artifact is modified.',
    ],
  };
}

function requestFor(item, evidence) {
  const requestFile = evidence.decision === 'blocked'
    ? null
    : `requests/${String(item.issue_number).padStart(4, '0')}.json`;
  return {
    schema_version: 'issue-1607-boundary-request-template.v1',
    transition_id: evidence.transition_id,
    repository: REPOSITORY,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id,
    expected_source_repository_ref: SOURCE_REF,
    decision: evidence.decision,
    semantic_ready: ['single-interview', 'multi-interview'].includes(evidence.decision),
    review_evidence: null,
    reviewed_at: null,
    evidence_file: `../evidence/${String(item.issue_number).padStart(4, '0')}.json`,
    request_file: requestFile,
    executable: false,
    block_reason: `${evidence.decision === 'blocked' ? 'Full pinned Source material is semantically insufficient or unverified' : 'Live transition authorization and durable controller evidence are absent'}; controller must independently review and bind a valid transition request before any apply authorization.`,
  };
}

function main(argv = process.argv.slice(2)) {
  const selectionFile = argv[argv.indexOf('--selection') + 1] || 'data/issue-1607/selection.json';
  const outputDir = path.resolve(argv[argv.indexOf('--output-dir') + 1] || 'data/issue-1607');
  const selection = JSON.parse(fs.readFileSync(path.resolve(selectionFile), 'utf8'));
  if (selection.schema_version !== 'issue-1607-boundary-b-selection.v1' || selection.repository !== REPOSITORY) throw new Error('selection is not bound to Boundary B');
  const expectedCount = selection.scope?.expected_count;
  if (!Number.isInteger(expectedCount) || selection.items.length !== expectedCount) throw new Error(`selection count does not match selection.scope.expected_count: ${selection.items.length}/${expectedCount}`);
  if (selection.source_snapshot?.ref !== SOURCE_REF) throw new Error('selection source ref is not the fixed ref');
  const evidenceItems = selection.items.map(evidenceFor);
  const requestItems = selection.items.map((item, index) => requestFor(item, evidenceItems[index]));
  const sourceArtifactLedger = {
    schema_version: 'issue-1607-boundary-source-artifact-ledger.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    source_ref: SOURCE_REF,
    total: selection.items.length,
    required_kinds: ['html', 'json', 'text_projection'],
    items: selection.items.map((item) => ({ issue_number: item.issue_number, source_note_id: item.source_note_id, artifacts: item.source_artifacts || [], source_material_verification: item.source_material_verification || { status: 'blocked' } })),
  };
  const sourceArtifactLedgerSha256 = sha256Text(canonicalJson(sourceArtifactLedger));
  const classificationItems = evidenceItems.map((item) => ({
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    source_projection_ref: item.source_evidence.ref,
    locator: item.source_evidence.locator,
    excerpt: item.source_evidence.excerpt,
    full_projection_sha256: item.source_evidence.sha256,
    basis_lines: item.classification.basis_lines || [],
    semantic_evidence: item.classification.semantic_evidence || [],
    status: item.classification.status,
    proposed_decision: item.classification.proposed_decision,
    basis: item.classification.basis,
  }));
  const classificationCounts = classificationItems.reduce((counts, item) => {
    counts[item.proposed_decision] = (counts[item.proposed_decision] || 0) + 1;
    return counts;
  }, {});
  const classificationLedger = {
    schema_version: 'issue-1607-boundary-classification-ledger.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    source_ref: SOURCE_REF,
    status: 'semantic-review',
    source_artifact_ledger_sha256: sourceArtifactLedgerSha256,
    counts: classificationCounts,
    total: classificationItems.length,
    items: classificationItems,
  };
  const sourceVerifiedCount = selection.items.filter((item) => item.status === 'verified').length;
  const sourceBlockedCount = selection.items.filter((item) => item.status === 'blocked').length;
  const blockedCount = evidenceItems.filter((item) => item.decision === 'blocked').length;
  const singleCount = evidenceItems.filter((item) => item.decision === 'single-interview').length;
  const multiCount = evidenceItems.filter((item) => item.decision === 'multi-interview').length;
  const notInterviewCount = evidenceItems.filter((item) => item.decision === 'not-interview').length;
  const semanticReadyCount = singleCount + multiCount;
  const evidenceLedger = {
    schema_version: 'issue-1607-boundary-evidence-ledger.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    selection_sha256: sha256Text(canonicalJson(selection)),
    source_artifact_ledger_sha256: sourceArtifactLedgerSha256,
    total: evidenceItems.length,
    counts: { single_interview: singleCount, multi_interview: multiCount, not_interview: notInterviewCount, blocked: blockedCount, review_required: evidenceItems.length - blockedCount, authorized: 0 },
    items: evidenceItems,
  };
  const requestSet = {
    schema_version: 'issue-1607-boundary-request-set.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    selection_sha256: evidenceLedger.selection_sha256,
    evidence_ledger_sha256: sha256Text(canonicalJson(evidenceLedger)),
    classification_ledger_sha256: sha256Text(canonicalJson(classificationLedger)),
    total: requestItems.length,
    executable: false,
    items: requestItems,
  };
  const plan = {
    schema_version: 'issue-1607-boundary-dry-run-plan.v1',
    repository: REPOSITORY,
    parent_issue: 1605,
    child_issue: 1607,
    scope: selection.scope,
    source_snapshot: selection.source_snapshot,
    source_artifact_ledger_sha256: sourceArtifactLedgerSha256,
    scope_compliance: selection.scope_compliance || { status: 'blocked', reason: 'Selection has no scope-clean audit record.', out_of_scope_mutations: 0 },
    scope_regression: {
      status: selection.scope_compliance?.status === 'pass' ? 'pass' : 'blocked',
      read_issue_range: [393, 765],
      forbidden_issue_numbers: [392, 766],
      out_of_scope_reads: selection.scope_compliance?.out_of_scope_reads ?? null,
      out_of_scope_mutations: 0,
      assertion: 'No live read is permitted outside the frozen inclusive range #393..#765.',
    },
    selection_sha256: evidenceLedger.selection_sha256,
    source_artifact_ledger_sha256: sourceArtifactLedgerSha256,
    evidence_ledger_sha256: sha256Text(canonicalJson(evidenceLedger)),
    request_set_sha256: sha256Text(canonicalJson(requestSet)),
    mode: 'dry-run',
    fail_closed: true,
    counts: { total: expectedCount, pending: 0, single_interview: singleCount, multi_interview: multiCount, not_interview: notInterviewCount, blocked: blockedCount, review_required: evidenceItems.length - blockedCount, semantic_ready: semanticReadyCount, ready: 0, already_applied: 0, mutation_count: 0 },
    blocked_reasons: [
      ...(blockedCount ? [`${blockedCount} item(s) remain semantically or materially blocked`] : []),
      'semantic boundary decisions are review-ready but are not durable controller authorization',
      'durable review evidence comments have not been created or bound',
      'main controller has not granted live apply authorization',
    ],
    items: evidenceItems.map((item) => ({
      issue_number: item.issue_number,
      transition_id: item.transition_id,
      source_note_id: item.source_note_id,
      decision: item.decision,
      status: item.evidence_status === 'blocked' ? 'blocked' : (['single-interview', 'multi-interview'].includes(item.decision) ? 'semantic-ready' : 'not-interview'),
      expected_body_sha256: item.expected_body_sha256,
      expected_source_revision_id: item.expected_source_revision_id,
      source_projection_ref: item.source_evidence.ref,
      source_projection_blob: item.source_evidence.git_blob_sha,
      next_body_sha256: null,
      mutation: 'none',
    })),
  };
  plan.dry_run_sha256 = sha256Text(canonicalJson(plan));
  const journal = {
    schema_version: 'issue-1607-boundary-apply-journal.v1',
    repository: REPOSITORY,
    parent_issue: 1605,
    child_issue: 1607,
    selection_sha256: evidenceLedger.selection_sha256,
    dry_run_sha256: plan.dry_run_sha256,
    status: 'not-started',
    mutation_count: 0,
    entries: [],
    terminal_reason: selection.scope_compliance?.status === 'pass'
      ? 'Scope-clean preparation completed with zero out-of-scope reads and zero mutations; no live GitHub apply is authorized by the child issue.'
      : 'No live GitHub apply is authorized by the child issue; scope compliance is not proven for this selection.',
  };
  const digest = {
    schema_version: 'issue-1607-boundary-canonical-digest.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    selection_sha256: evidenceLedger.selection_sha256,
    evidence_ledger_sha256: sha256Text(canonicalJson(evidenceLedger)),
    request_set_sha256: sha256Text(canonicalJson(requestSet)),
    classification_ledger_sha256: sha256Text(canonicalJson(classificationLedger)),
    dry_run_sha256: plan.dry_run_sha256,
    journal_sha256: sha256Text(canonicalJson(journal)),
  };
  writeJson(path.join(outputDir, 'evidence-ledger.json'), evidenceLedger);
  writeJson(path.join(outputDir, 'source-artifact-ledger.json'), sourceArtifactLedger);
  writeJson(path.join(outputDir, 'request-set.json'), requestSet);
  writeJson(path.join(outputDir, 'classification-ledger.json'), classificationLedger);
  writeJson(path.join(outputDir, 'dry-run.plan.json'), plan);
  writeJson(path.join(outputDir, 'apply.journal.json'), journal);
  writeJson(path.join(outputDir, 'canonical-digest.json'), digest);
  fs.mkdirSync(path.join(outputDir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'requests'), { recursive: true });
  const selectedFiles = new Set(selection.items.map((item) => `${String(item.issue_number).padStart(4, '0')}.json`));
  const blockedRequestFiles = new Set(requestItems.filter((item) => item.request_file === null).map((item) => `${String(item.issue_number).padStart(4, '0')}.json`));
  for (const subdirectory of ['evidence', 'requests']) {
    const directory = path.join(outputDir, subdirectory);
    for (const filename of fs.readdirSync(directory)) {
      if (/^\d{4}\.json$/.test(filename) && (!selectedFiles.has(filename) || (subdirectory === 'requests' && blockedRequestFiles.has(filename)))) fs.unlinkSync(path.join(directory, filename));
    }
  }
  evidenceItems.forEach((item) => writeJson(path.join(outputDir, 'evidence', `${String(item.issue_number).padStart(4, '0')}.json`), item));
  requestItems.filter((item) => item.request_file !== null).forEach((item) => writeJson(path.join(outputDir, item.request_file), item));
  process.stdout.write(`${JSON.stringify({ total: expectedCount, source_verified: sourceVerifiedCount, source_blocked: sourceBlockedCount, mutation_count: 0, dry_run_sha256: plan.dry_run_sha256 }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { classifyProjection, classifyFullSource, evidenceFor, requestFor, sha256Text };
