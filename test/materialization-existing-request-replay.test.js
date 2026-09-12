'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const snapshot=require('../audit/issue-1658-receipt-repair/current-live-snapshot.json');
const {buildMaterializationRequest}=require('../scripts/lib/interview-note-materialization-batch');
const {planMaterialization,selectExistingMaterializationRequest,requestSha256}=require('../scripts/lib/source-note-interview-materialization');
const {materializationReceiptsBySourceIssue}=require('../scripts/plan-issue-1611-live-materialization');
function fixture(number=1458){const row=structuredClone(snapshot.rows.find(r=>r.source_issue===number));return {request:buildMaterializationRequest(row.source,'liqiangcc/interview-lab'),options:{repository:'liqiangcc/interview-lab',sourceIssue:row.source,issues:[row.owner],receipts:materializationReceiptsBySourceIssue(new Map([[number,row.comments]])).get(number)}};}
for(const row of snapshot.rows)test(`#${row.source_issue} exact existing request digest yields already-materialized without a new receipt`,()=>{
 const f=fixture(row.source_issue), before=planMaterialization(f.request,f.options), original=structuredClone(f.options.receipts);
 assert.equal(before.ok,true,before.errors.join('; '));assert.equal(before.needs_receipt_repair,true);
 const selected=selectExistingMaterializationRequest(f.request,f.options),after=planMaterialization(selected.request,f.options);
 assert.equal(after.ok,true,after.errors.join('; '));assert.equal(after.already_materialized,true);assert.equal(after.needs_receipt_repair,false);
 assert.equal(requestSha256(selected.request),original[0].request_sha256);assert.equal(selected.request.materialization_id,original[0].materialization_id);
 assert.equal(selected.provenance.historical_authorization_plan_journal,'UNKNOWN');assert.deepEqual(f.options.receipts,original);
});
for(const [name,mutate] of [
 ['bad request digest',f=>{f.options.receipts[0].request_sha256='0'.repeat(64);}],
 ['wrong source identity',f=>{f.options.receipts[0].source_note_id='xhs-note:other';}],
 ['wrong source Issue',f=>{f.options.receipts[0].source_note_issue_number=1309;}],
 ['wrong source revision',f=>{f.options.receipts[0].source_revision_id='other';}],
 ['wrong source ref',f=>{f.options.receipts[0].source_repository_ref='0'.repeat(40);}],
 ['wrong source body',f=>{f.options.receipts[0].source_note_body_sha256='0'.repeat(64);}],
 ['wrong owner identity',f=>{f.options.receipts[0].interview_note_id='xhs:other';}],
 ['wrong owner Issue',f=>{f.options.receipts[0].interview_issue_number=1674;}],
 ['wrong repository',f=>{f.options.receipts[0].repository='liqiangcc/other';}],
 ['owner raw body drift',f=>{f.options.issues[0].body+='\n';}],
 ['missing owner',f=>{f.options.issues=[];}],
 ['duplicate owner',f=>{f.options.issues.push({...f.options.issues[0],number:99999});}],
 ['duplicate receipts',f=>{f.options.receipts.push({...f.options.receipts[0],comment_id:999});}],
 ['competing different historical IDs',f=>{f.options.receipts.push({...f.options.receipts[0],materialization_id:'another-operation'});}],
 ['fresh source body drift',f=>{f.options.sourceIssue.body+='\n';f.request=buildMaterializationRequest(f.options.sourceIssue,f.options.repository);}],
])test(`request replay refuses ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>selectExistingMaterializationRequest(f.request,f.options));});
test('an exact default-ID receipt retains ordinary strict validation',()=>{
 const f=fixture();f.options.receipts[0].materialization_id=f.request.materialization_id;f.options.receipts[0].request_sha256='0'.repeat(64);
 const selected=selectExistingMaterializationRequest(f.request,f.options);assert.deepEqual(selected,{request:f.request});assert.equal(planMaterialization(selected.request,f.options).ok,false);
});
test('absence of receipts keeps the default creation request',()=>{const f=fixture();f.options.receipts=[];f.options.issues=[];assert.deepEqual(selectExistingMaterializationRequest(f.request,f.options),{request:f.request});});
test('valid owner lifecycle/title changes do not invent a new materialization operation',()=>{
 const f=fixture();f.options.issues[0].labels=f.options.issues[0].labels.map(x=>x==='status:captured'?'status:source-ready':x);f.options.issues[0].title='[拼多多] 后端 · 二面';const selected=selectExistingMaterializationRequest(f.request,f.options);assert.equal(planMaterialization(selected.request,f.options).already_materialized,true);
});
