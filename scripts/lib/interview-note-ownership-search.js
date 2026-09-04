'use strict';

const MAX_SEARCH_PAGES = 10;
const PAGE_SIZE = 100;

function ownershipSearchEndpoint(repository, interviewNoteId) {
  const phrase = String(interviewNoteId).replace(/["\\]/g, '\\$&');
  const query = `repo:${repository} is:issue in:body "${phrase}"`;
  return `search/issues?q=${encodeURIComponent(query)}&per_page=${PAGE_SIZE}`;
}

function searchPages(value) {
  if (!Array.isArray(value)) return [];
  return value.length && Array.isArray(value[0]) ? value.flat() : value;
}

function candidateNumbersFromPages(pages, options = {}) {
  if (pages.some((page) => page && page.incomplete_results === true)) {
    throw new Error('InterviewNote ownership search returned incomplete results; refusing to infer ownership');
  }
  const items = pages.flatMap((page) => Array.isArray(page && page.items) ? page.items : []);
  const numbers = [...new Set(items.map((item) => Number(item && item.number))
    .filter((number) => Number.isInteger(number) && number > 0))];
  const totalCount = pages.length > 0 && Number.isInteger(pages[0].total_count)
    ? pages[0].total_count
    : null;
  if (options.verifyTotal !== false && totalCount !== null && totalCount !== numbers.length) {
    throw new Error(`InterviewNote ownership search pagination incomplete: expected ${totalCount} candidates, received ${numbers.length}`);
  }
  return numbers;
}

function searchOwnershipCandidateNumbers(readPage, options = {}) {
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages : MAX_SEARCH_PAGES;
  const pages = [];
  const beforePage = typeof options.beforePage === 'function' ? options.beforePage : () => {};
  for (let page = 1; page <= maxPages; page += 1) {
    beforePage(page);
    const result = readPage(page);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('InterviewNote ownership search page must be an object');
    pages.push(result);
    const items = Array.isArray(result.items) ? result.items : [];
    const totalCount = Number.isInteger(result.total_count) ? result.total_count : null;
    const collected = candidateNumbersFromPages(pages, { verifyTotal: false }).length;
    if (items.length === 0 || (totalCount !== null && collected >= totalCount) || items.length < PAGE_SIZE) break;
    if (page === maxPages) throw new Error(`InterviewNote ownership search exceeded ${maxPages} pages; refusing to infer ownership`);
  }
  return candidateNumbersFromPages(pages);
}

function exactOwnershipCandidates({ readPage, readIssue, interviewNoteId, matches, beforePage }) {
  if (typeof readPage !== 'function' || typeof readIssue !== 'function' || typeof matches !== 'function') throw new Error('readPage, readIssue, and matches are required for ownership candidate search');
  return searchOwnershipCandidateNumbers(readPage, { beforePage }).map((number) => readIssue(number))
    .filter((issue) => issue && !issue.pull_request)
    .filter((issue) => matches([issue], interviewNoteId).length === 1);
}

function createSearchThrottle(pauseMs, sleep) {
  const wait = Number.isFinite(pauseMs) && pauseMs >= 0 ? pauseMs : 0;
  const delay = typeof sleep === 'function' ? sleep : () => {};
  let lastQueryAt = null;
  return function throttle() {
    if (lastQueryAt !== null && wait > 0) {
      const remaining = wait - (Date.now() - lastQueryAt);
      if (remaining > 0) delay(remaining);
    }
    lastQueryAt = Date.now();
  };
}

function forEachWithThrottle(items, fn, pauseMs, sleep) {
  const wait = Number.isFinite(pauseMs) && pauseMs >= 0 ? pauseMs : 0;
  const delay = typeof sleep === 'function' ? sleep : () => {};
  for (const [index, item] of items.entries()) {
    if (index > 0 && wait > 0) delay(wait);
    fn(item, index);
  }
}

module.exports = { MAX_SEARCH_PAGES, PAGE_SIZE, ownershipSearchEndpoint, searchPages, candidateNumbersFromPages, searchOwnershipCandidateNumbers, exactOwnershipCandidates, createSearchThrottle, forEachWithThrottle };
