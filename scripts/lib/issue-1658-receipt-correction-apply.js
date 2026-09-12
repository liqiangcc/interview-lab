'use strict';
const fs = require('node:fs');
const { canonicalDigest } = require('./aggregate-downstream-pipeline');
const { atomicWriteJson, acquireExclusiveLock } = require('./issue-1658-materialization-runner');
const { buildInventory } = require('../generate-issue-1611-interview-note-ownership-inventory');
const { exactAppliedBoundaryEvidence } = require('../plan-issue-1611-live-materialization');
const { pinnedRow, strictMarkers, validateAppliedReceiptCorrection } = require('./issue-1658-receipt-correction-consumer');
const plan = require('../../audit/issue-1658-receipt-repair/repair-plan.json');
const contract = require('../../audit/issue-1658-receipt-repair/receipt-repair-authorization.schema.json');
const MARKER = 'source-note-boundary-review-applied-correction.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const SCOPE = Object.freeze([1309,1325,1333,1363,1375,1376,1380,1401,1406,1418,1428,1447,1458]);
const same = (a,b) => canonicalDigest(a) === canonicalDigest(b);
const assert = (ok,message) => { if (!ok) throw new Error(message); };
const correctionBody = row => `<!-- ${MARKER}\n${JSON.stringify(row.correction_template,null,2)}\n-->`;
function expectedAuthorization() {
  const result = {};
  for (const [key,schema] of Object.entries(contract.properties)) result[key] = Object.hasOwn(schema,'const') ? structuredClone(schema.const) : plan.authorization_binding[key];
  return result;
}
function validateAuthorization(auth, confirmPlanDigest, allowLiveGithub) {
  assert(allowLiveGithub === true,'explicit allowLiveGithub is required');
  assert(confirmPlanDigest === plan.plan_digest,'explicit plan digest confirmation mismatch');
  assert(auth && same(auth,expectedAuthorization()),'receipt-repair-only authorization schema/scope/digests/operations mismatch');
}
function readOwners(api) {
  const owners = api.readOwners(); // CLI obtains full bounded pagination, never search snippets.
  const inventory = buildInventory(owners,REPOSITORY);
  return {owners,inventory};
}
function freshRow(api,number,ownerSnapshot = readOwners(api)) {
  const row = pinnedRow(number);
  const source = api.readSource(number);
  const comments = api.readComments(number);
  const options = {ownerIssues:ownerSnapshot.owners,ownerInventoryComplete:true};
  const found = strictMarkers(comments,MARKER);
  assert(found.length <= 1,`#${number} ambiguous corrections`);
  const actual = exactAppliedBoundaryEvidence(source,comments,options);
  if (found.length) {
    assert(actual.ok,`#${number} existing correction failed: ${actual.errors.join('; ')}`);
    return {number,status:'already-reconciled',comment_id:actual.correction_comment_id,source,comments,options};
  }
  assert(same(actual.errors,[`#${number} receipt interview_note_ids mismatch`]),`#${number} other boundary errors: ${actual.errors.join('; ')}`);
  const owner = ownerSnapshot.owners.find(o=>o.number===row.owner_issue);
  assert(owner && same((owner.labels||[]).map(l=>typeof l==='string'?l:l.name).sort(),row.owner_labels),`#${number} pre-POST owner labels CAS mismatch`);
  const simulated = {id:9000000000000+number,issue_url:`https://api.github.com/repos/${REPOSITORY}/issues/${number}`,body:correctionBody(row)};
  const validation = validateAppliedReceiptCorrection(source,[...comments,simulated],options);
  assert(validation.ok,`#${number} correction preflight failed: ${validation.errors.join('; ')}`);
  return {number,status:'would-post-correction',source,comments,options,body:simulated.body};
}
function preflight(api) {
  assert(same(plan.scope,SCOPE),'fixed proposal scope mismatch');
  const owners = readOwners(api);
  const rows = SCOPE.map(number=>freshRow(api,number,owners));
  return {plan_digest:plan.plan_digest,owner_inventory_digest:owners.inventory.canonical_digest,rows};
}
function journalDigest(journal) {
  const {canonical_digest,...value} = journal;
  return canonicalDigest(value);
}
function loadJournal(file,executionSha,auth) {
  if (!fs.existsSync(file)) return {schema_version:'issue-1658-receipt-correction-journal.v1',execution_sha:executionSha,plan_digest:plan.plan_digest,authorization_digest:canonicalDigest(auth),scope:SCOPE,status:'running',rows:SCOPE.map(source_issue=>({source_issue,phase:'pending',post_attempted:false,comment_id:null}))};
  const journal = JSON.parse(fs.readFileSync(file,'utf8'));
  assert(journal.canonical_digest===journalDigest(journal),'journal digest mismatch');
  assert(journal.schema_version==='issue-1658-receipt-correction-journal.v1' && journal.execution_sha===executionSha && journal.plan_digest===plan.plan_digest && journal.authorization_digest===canonicalDigest(auth) && same(journal.scope,SCOPE),'journal execution/authorization/scope binding mismatch');
  assert(Array.isArray(journal.rows) && same(journal.rows.map(r=>r.source_issue),SCOPE),'journal rows mismatch');
  for(const row of journal.rows) {
    assert(['pending','post-intent','uncertain','complete'].includes(row.phase) && typeof row.post_attempted==='boolean','invalid journal phase');
    assert(row.phase==='complete' ? Number.isSafeInteger(row.comment_id)&&row.comment_id>0 : row.comment_id===null,'invalid journal comment id');
    assert(row.phase!=='pending'||row.post_attempted===false,'attempted row cannot be pending');
    assert(!['post-intent','uncertain'].includes(row.phase)||row.post_attempted===true,'uncertain row must record intent');
  }
  return journal;
}
function persist(file,journal,lock) {
  lock.assertHeld();
  journal.updated_at = new Date().toISOString();
  journal.canonical_digest = journalDigest(journal);
  atomicWriteJson(file,journal);
}
function reconcile(api,number) {
  let lastError;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const row=freshRow(api,number);
      if(row.status==='already-reconciled')return row;
      lastError=new Error(`#${number} correction not observed after POST intent`);
    } catch(error) {lastError=error;}
  }
  throw lastError;
}
function execute({api,apply=false,authorization,confirmPlanDigest,allowLiveGithub=false,executionSha,journalFile,lockFile}) {
  if(!apply) {
    const result=preflight(api);
    return {...result,mode:'GET-only-dry-run',rows:result.rows.map(({number,status,comment_id})=>({source_issue:number,status,comment_id:comment_id||null})),mutation_performed:false,writes:0};
  }
  validateAuthorization(authorization,confirmPlanDigest,allowLiveGithub);
  assert(/^[a-f0-9]{40}$/.test(executionSha||''),'committed execution SHA required');
  assert(journalFile && lockFile && journalFile!==lockFile,'distinct durable journal/lock paths required');
  const lock=acquireExclusiveLock(lockFile,plan.plan_digest);
  try {
    // All 13 must pass before the first POST. No partial batch on known drift.
    preflight(api);
    const journal=loadJournal(journalFile,executionSha,authorization);
    persist(journalFile,journal,lock);
    let writes=0;let attempts=0;
    for(const item of journal.rows) {
      lock.assertHeld();
      const before=freshRow(api,item.source_issue);
      if(before.status==='already-reconciled') {
        assert(item.phase!=='complete'||item.comment_id===before.comment_id,'completed journal correction locator drift');
        item.phase='complete';item.comment_id=before.comment_id;persist(journalFile,journal,lock);continue;
      }
      if(item.phase==='complete')throw new Error('completed correction disappeared; refusing recreate');
      if(item.phase!=='pending') {
        try {const found=reconcile(api,item.source_issue);item.phase='complete';item.comment_id=found.comment_id;persist(journalFile,journal,lock);continue;}
        catch(error){journal.status='uncertain';item.phase='uncertain';persist(journalFile,journal,lock);throw error;}
      }
      assert(journal.rows.filter(r=>r.post_attempted).length<13,'mutation ceiling exceeded');
      item.post_attempted=true;item.phase='post-intent';persist(journalFile,journal,lock);
      lock.assertHeld();
      // At most one call. A timeout/invalid response never causes a second POST.
      let postError=null;
      try {attempts++;api.postCorrection(item.source_issue,before.body);writes++;}
      catch(error){postError=error.message;}
      try {
        const found=reconcile(api,item.source_issue);
        item.phase='complete';item.comment_id=found.comment_id;
        item.response_error=postError;persist(journalFile,journal,lock);
      } catch(error) {
        item.phase='uncertain';item.response_error=postError;journal.status='uncertain';persist(journalFile,journal,lock);throw error;
      }
    }
    let postAudit;
    try {
      postAudit=preflight(api);
      assert(postAudit.rows.every(row=>row.status==='already-reconciled' && journal.rows.find(item=>item.source_issue===row.number).comment_id===row.comment_id),'post-apply audit did not confirm all exact correction locators');
    } catch(error) {journal.status='audit-blocked';persist(journalFile,journal,lock);throw error;}
    journal.status='complete';persist(journalFile,journal,lock);
    return {mode:'apply',plan_digest:plan.plan_digest,status:'complete',post_audit:{verified_rows:postAudit.rows.length,owner_inventory_digest:postAudit.owner_inventory_digest},writes_acknowledged_this_run:writes,post_attempted_this_run:attempts,post_attempted_total:journal.rows.filter(r=>r.post_attempted).length,rows:journal.rows,mutation_performed:attempts>0};
  } finally {lock.release();}
}
module.exports={SCOPE,expectedAuthorization,validateAuthorization,correctionBody,freshRow,preflight,execute};
