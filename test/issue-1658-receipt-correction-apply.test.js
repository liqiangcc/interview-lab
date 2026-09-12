'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const snapshot=require('../audit/issue-1658-receipt-repair/current-live-snapshot.json');
const {execute,expectedAuthorization}=require('../scripts/lib/issue-1658-receipt-correction-apply');
const plan=require('../audit/issue-1658-receipt-repair/repair-plan.json');
function fixture(t,postBehavior=null){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-correction-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const rows=structuredClone(snapshot.rows),posts=[];
 const api={readOwners:()=>rows.map(r=>structuredClone(r.owner)),readSource:n=>structuredClone(rows.find(r=>r.source_issue===n).source),readComments:n=>structuredClone(rows.find(r=>r.source_issue===n).comments),postCorrection:(n,body)=>{posts.push(n);const row=rows.find(r=>r.source_issue===n);const comment={id:8000000000000+n,issue_url:`https://api.github.com/repos/liqiangcc/interview-lab/issues/${n}`,body};if(postBehavior)return postBehavior({row,comment,n,posts});row.comments.push(comment);return comment;}};
 const args={api,apply:true,authorization:expectedAuthorization(),confirmPlanDigest:plan.plan_digest,allowLiveGithub:true,executionSha:'1'.repeat(40),journalFile:path.join(dir,'journal.json'),lockFile:path.join(dir,'lock')};
 return {args,rows,posts,dir};
}
test('default dry-run performs no POST and creates no journal',t=>{
 const f=fixture(t);const out=execute({api:f.args.api});assert.equal(out.rows.length,13);assert.equal(out.writes,0);assert.equal(f.posts.length,0);assert.equal(fs.existsSync(f.args.journalFile),false);
});
test('successful apply is exactly-once and a second apply is a verified no-op',t=>{
 const f=fixture(t);const out=execute(f.args);assert.equal(out.post_attempted_this_run,13);assert.equal(out.status,'complete');assert.equal(f.posts.length,13);
 const replay=execute(f.args);assert.equal(replay.post_attempted_this_run,0);assert.equal(replay.mutation_performed,false);assert.equal(f.posts.length,13);assert.equal(fs.existsSync(f.args.lockFile),false);
});
for(const [name,change] of [
 ['no authorization',a=>{delete a.authorization;}],
 ['wrong plan digest',a=>{a.confirmPlanDigest='0'.repeat(64);}],
 ['missing CLI opt-in',a=>{a.allowLiveGithub=false;}],
 ['extra operation',a=>{a.authorization.allowed_operations.push('create-owner');}],
 ['scope expanded',a=>{a.authorization.scope.push(910);}],
 ['wrong body binding digest',a=>{a.authorization.owner_bindings_digest='0'.repeat(64);}],
 ['unknown contract property',a=>{a.authorization.other=true;}],
 ['mutation ceiling changed',a=>{a.authorization.max_receipts=14;}],
])test(`authorization rejects ${name} before writes`,t=>{const f=fixture(t);change(f.args);assert.throws(()=>execute(f.args));assert.equal(f.posts.length,0);});
test('last-row source drift stops the entire batch before the first POST',t=>{const f=fixture(t);f.rows.at(-1).source.body+='\n';assert.throws(()=>execute(f.args));assert.equal(f.posts.length,0);});
test('owner label drift fails pre-POST CAS',t=>{const f=fixture(t);f.rows[0].owner.labels.push('task:source-review');assert.throws(()=>execute(f.args));assert.equal(f.posts.length,0);});
test('duplicate owner inventory fails before writes',t=>{const f=fixture(t);const original=f.args.api.readOwners;f.args.api.readOwners=()=>{const owners=original();return [...owners,{...owners[0],number:99999}];};assert.throws(()=>execute(f.args));assert.equal(f.posts.length,0);});
test('known-held lock is not deleted or bypassed',t=>{const f=fixture(t);fs.writeFileSync(f.args.lockFile,'held');assert.throws(()=>execute(f.args),/lock/);assert.equal(f.posts.length,0);assert.equal(fs.readFileSync(f.args.lockFile,'utf8'),'held');});
test('POST accepted then response lost reconciles without a second POST',t=>{const f=fixture(t,({row,comment})=>{row.comments.push(comment);throw new Error('response lost');});const out=execute(f.args);assert.equal(out.post_attempted_this_run,13);assert.equal(out.writes_acknowledged_this_run,0);assert.equal(f.posts.length,13);assert.equal(out.rows.every(r=>r.phase==='complete'),true);});
test('POST intent is durable before invoking API',t=>{
 const f=fixture(t);const post=f.args.api.postCorrection;f.args.api.postCorrection=(n,b)=>{const j=JSON.parse(fs.readFileSync(f.args.journalFile));const row=j.rows.find(r=>r.source_issue===n);assert.equal(row.phase,'post-intent');assert.equal(row.post_attempted,true);return post(n,b);};execute(f.args);
});
test('unresolved response remains uncertain on resume and never retries POST',t=>{
 const f=fixture(t,()=>{throw new Error('unknown response');});assert.throws(()=>execute(f.args));assert.equal(f.posts.length,1);const j=JSON.parse(fs.readFileSync(f.args.journalFile));assert.equal(j.status,'uncertain');assert.equal(j.rows[0].phase,'uncertain');assert.throws(()=>execute(f.args));assert.equal(f.posts.length,1);
});
test('uncertain response later visible resumes by reconciliation only',t=>{
 let lost;
 const f=fixture(t,({row,comment})=>{lost={row,comment};throw new Error('unknown response');});assert.throws(()=>execute(f.args));lost.row.comments.push(lost.comment);
 f.args.api.postCorrection=(n,body)=>{f.posts.push(n);const comment={id:8000000000000+n,issue_url:`https://api.github.com/repos/liqiangcc/interview-lab/issues/${n}`,body};f.rows.find(r=>r.source_issue===n).comments.push(comment);return comment;};
 const out=execute(f.args);assert.equal(out.status,'complete');assert.equal(f.posts.length,13);assert.equal(out.post_attempted_this_run,12);
});
test('ambiguous POST reconcile stops and preserves uncertain journal',t=>{
 const f=fixture(t,({row,comment})=>{row.comments.push(comment,{...comment,id:comment.id+100000});return comment;});assert.throws(()=>execute(f.args),/ambiguous/);assert.equal(f.posts.length,1);assert.equal(JSON.parse(fs.readFileSync(f.args.journalFile)).status,'uncertain');
});
test('corrupted durable journal prevents POST',t=>{const f=fixture(t);fs.writeFileSync(f.args.journalFile,'{"canonical_digest":"bad"}');assert.throws(()=>execute(f.args),/digest/);assert.equal(f.posts.length,0);});
test('a completed correction disappearing does not authorize recreation',t=>{const f=fixture(t);execute(f.args);f.rows[0].comments.pop();assert.throws(()=>execute(f.args),/disappeared/);assert.equal(f.posts.length,13);});
test('final batch audit detects a previously completed correction disappearing',t=>{
 const f=fixture(t);const post=f.args.api.postCorrection;
 f.args.api.postCorrection=(n,b)=>{const r=post(n,b);if(n===1458)f.rows[0].comments.pop();return r;};
 assert.throws(()=>execute(f.args),/post-apply audit/);assert.equal(f.posts.length,13);assert.equal(JSON.parse(fs.readFileSync(f.args.journalFile)).status,'audit-blocked');
});
