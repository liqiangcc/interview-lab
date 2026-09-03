'use strict';

const SCHEMA_VERSION = 'interview-context.v1';
const BASIS = new Set(['source-explicit', 'reviewed-inference', 'unknown']);
const ROLE_FAMILIES = new Set(['backend', 'frontend', 'client', 'algorithm', 'data', 'qa', 'product', 'other', 'unknown']);
const RECRUITMENT_TYPES = new Set(['campus', 'social', 'internship', 'unknown']);
const ROUND_RE = /^(?:[1-9]|hr|final|unknown)$/;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEvidenceFact(name, fact, errors, options = {}) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    errors.push(`${name} must be an object`);
    return;
  }
  if (!BASIS.has(fact.basis)) errors.push(`${name}.basis must be source-explicit, reviewed-inference, or unknown`);
  if (!Array.isArray(fact.evidence_refs)) errors.push(`${name}.evidence_refs must be an array`);
  else {
    if (fact.basis === 'unknown' && fact.evidence_refs.length !== 0) errors.push(`${name}.evidence_refs must be empty when basis=unknown`);
    if (fact.basis !== 'unknown' && fact.evidence_refs.length === 0) errors.push(`${name}.evidence_refs must be non-empty when fact is known`);
    if (fact.evidence_refs.some((ref) => !nonEmpty(ref))) errors.push(`${name}.evidence_refs must contain non-empty strings`);
  }
  if (options.isUnknown && !options.isUnknown(fact) && fact.basis === 'unknown') errors.push(`${name} cannot have basis=unknown when value is known`);
  if (options.isUnknown && options.isUnknown(fact) && fact.basis !== 'unknown') errors.push(`${name} unknown value requires basis=unknown`);
}

function validateTimeFact(timeFact, errors) {
  if (!timeFact || typeof timeFact !== 'object' || Array.isArray(timeFact)) {
    errors.push('interview_occurred_at must be an object');
    return;
  }
  const { precision, value } = timeFact;
  const patterns = {
    exact: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
    month: /^\d{4}-\d{2}$/,
    year: /^\d{4}$/,
    month_day: /^\d{2}-\d{2}$/,
  };

  validateEvidenceFact('interview_occurred_at', timeFact, errors, { isUnknown: (fact) => fact.precision === 'unknown' });

  if (precision === 'unknown') {
    if (value !== null) errors.push('unknown interview_occurred_at must use value=null');
    return;
  }
  if (!patterns[precision]) {
    errors.push(`unsupported interview_occurred_at precision: ${precision}`);
    return;
  }
  if (typeof value !== 'string' || !patterns[precision].test(value)) errors.push(`interview_occurred_at value does not match precision ${precision}`);
}

function validateInterviewContext(context) {
  const errors = [];
  const warnings = [];
  if (!context || typeof context !== 'object' || Array.isArray(context)) return { ok: false, errors: ['context must be an object'], warnings, context: null };

  if (context.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!nonEmpty(context.context_id)) errors.push('context_id must be a non-empty string');
  if (!nonEmpty(context.interview_note_id) || !context.interview_note_id.includes(':')) errors.push('interview_note_id must be a stable namespaced id');
  if (!nonEmpty(context.source_revision_id)) errors.push('source_revision_id must be a non-empty string');
  if (context.review_status !== 'reviewed') errors.push('review_status must be reviewed before learning discovery projection');
  if (!nonEmpty(context.reviewed_at) || Number.isNaN(Date.parse(context.reviewed_at))) errors.push('reviewed_at must be a valid timestamp');

  validateEvidenceFact('company', context.company, errors, { isUnknown: (fact) => fact.id == null });
  if (context.company && context.company.id != null && !/^[a-z0-9][a-z0-9-]*$/.test(context.company.id)) errors.push('company.id must be a normalized lowercase machine identifier');
  if (context.company && context.company.id != null && !nonEmpty(context.company.display_name)) errors.push('known company requires display_name');
  if (context.company && context.company.id == null && context.company.display_name !== null) errors.push('unknown company requires display_name=null');

  validateEvidenceFact('role', context.role, errors, { isUnknown: (fact) => fact.family === 'unknown' });
  if (context.role && !ROLE_FAMILIES.has(context.role.family)) errors.push('role.family must be a supported coarse role family');
  if (context.role && context.role.family === 'unknown' && context.role.title !== null) errors.push('unknown role requires title=null');

  validateEvidenceFact('recruitment_type', context.recruitment_type, errors, { isUnknown: (fact) => fact.value === 'unknown' });
  if (context.recruitment_type && !RECRUITMENT_TYPES.has(context.recruitment_type.value)) errors.push('recruitment_type.value must be campus, social, internship, or unknown');

  validateEvidenceFact('round', context.round, errors, { isUnknown: (fact) => fact.value === 'unknown' });
  if (context.round && !ROUND_RE.test(String(context.round.value || ''))) errors.push('round.value must be 1..9, hr, final, or unknown');

  validateTimeFact(context.interview_occurred_at, errors);
  if (context.outcome_visibility !== 'sealed-until-source-reveal') errors.push('outcome_visibility must be sealed-until-source-reveal');

  for (const forbidden of ['result', 'outcome', 'self_assessment', 'external_feedback']) {
    if (Object.prototype.hasOwnProperty.call(context, forbidden)) errors.push(`${forbidden} must not be stored in pre-learning InterviewContext`);
  }

  return { ok: errors.length === 0, errors, warnings, context };
}

function interviewYear(timeFact) {
  if (!timeFact || !['exact', 'month', 'year'].includes(timeFact.precision)) return null;
  if (typeof timeFact.value !== 'string') return null;
  const match = timeFact.value.match(/^(\d{4})/);
  return match ? match[1] : null;
}

function deriveLearningLabels(context) {
  const result = validateInterviewContext(context);
  if (!result.ok) return { ok: false, errors: result.errors, labels: [] };
  const labels = [];
  if (context.company.id != null) labels.push(`company:${context.company.id}`);
  if (context.role.family !== 'unknown') labels.push(`role:${context.role.family}`);
  if (context.recruitment_type.value !== 'unknown') labels.push(`recruitment:${context.recruitment_type.value}`);
  if (context.round.value !== 'unknown') labels.push(`round:${context.round.value}`);
  const year = interviewYear(context.interview_occurred_at);
  if (year) labels.push(`interview-year:${year}`);
  return { ok: true, errors: [], labels };
}

function roundDisplay(value) {
  const chinese = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '七', '8': '八', '9': '九' };
  if (chinese[value]) return `${chinese[value]}面`;
  if (value === 'hr') return 'HR面';
  if (value === 'final') return '终面';
  return null;
}

function recruitmentDisplay(value) {
  return { campus: '校招', social: '社招', internship: '实习' }[value] || null;
}

function roleDisplay(family, title) {
  const familyNames = { backend: '后端', frontend: '前端', client: '客户端', algorithm: '算法', data: '数据', qa: '测试', product: '产品', other: '其他' };
  return familyNames[family] || title || null;
}

function timeDisplay(timeFact) {
  return timeFact && timeFact.precision !== 'unknown' ? timeFact.value : null;
}

function buildNonSpoilerTitle(context) {
  const validation = validateInterviewContext(context);
  if (!validation.ok) return { ok: false, errors: validation.errors, title: null };
  const parts = [];
  if (context.company.display_name) parts.push(`[${context.company.display_name}]`);
  const role = roleDisplay(context.role.family, context.role.title);
  if (role) parts.push(role);
  const recruitment = recruitmentDisplay(context.recruitment_type.value);
  if (recruitment) parts.push(recruitment);
  const round = roundDisplay(context.round.value);
  if (round) parts.push(round);
  const time = timeDisplay(context.interview_occurred_at);
  if (time) parts.push(time);
  const shortId = context.interview_note_id.split(':').pop().slice(0, 8);
  parts.push(shortId);
  const [first, ...rest] = parts;
  return { ok: true, errors: [], title: `${first}${rest.length ? ` ${rest.join(' · ')}` : ''}` };
}

function buildLearningDiscovery(context) {
  const validation = validateInterviewContext(context);
  if (!validation.ok) return { ok: false, errors: validation.errors, warnings: validation.warnings, context: null };
  const labelResult = deriveLearningLabels(context);
  const titleResult = buildNonSpoilerTitle(context);
  return {
    ok: true,
    errors: [],
    warnings: validation.warnings,
    context,
    learning_labels: labelResult.labels,
    non_spoiler_title: titleResult.title,
    pre_learning_display: {
      company: context.company.display_name,
      role: roleDisplay(context.role.family, context.role.title),
      recruitment_type: recruitmentDisplay(context.recruitment_type.value),
      round: roundDisplay(context.round.value),
      interview_occurred_at: timeDisplay(context.interview_occurred_at),
      outcome: 'sealed',
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  validateInterviewContext,
  deriveLearningLabels,
  buildNonSpoilerTitle,
  buildLearningDiscovery,
};
