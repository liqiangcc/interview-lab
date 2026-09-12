'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const snapshot = require('../audit/issue-1658-receipt-repair/current-live-snapshot.json');
const { exactAppliedBoundaryEvidence } = require('../scripts/plan-issue-1611-live-materialization');
const { strictMarkers, validateAppliedReceiptCorrection } = require('../scripts/lib/issue-1658-receipt-correction-consumer');
const SCHEMA = 'source-note-boundary-review-applied-correction.v1';
const clone = value => structuredClone(value);
function fixture(number = 1458) {
  const row = clone(snapshot.rows.find(r => r.source_issue === number));
  const value = clone(row.correction_template);
  const comment = {id:9000000000000+number,issue_url:`https://api.github.com/repos/liqiangcc/interview-lab/issues/${number}`,body:`<!-- ${SCHEMA}\n${JSON.stringify(value,null,2)}\n-->`};
  return {row,value,comment,comments:[...row.comments,comment],options:{ownerIssues:snapshot.rows.map(r=>clone(r.owner)),ownerInventoryComplete:true}};
}
function setValue(f,fn) { fn(f.value); f.comment.body=`<!-- ${SCHEMA}\n${JSON.stringify(f.value,null,2)}\n-->`; }
for (const original of snapshot.rows) test(`complete three-comment #${original.source_issue} replay: only the ids mismatch is reconciled`, () => {
  const f = fixture(original.source_issue);
  const before = exactAppliedBoundaryEvidence(f.row.source,f.row.comments,f.options);
  assert.deepEqual(before.errors,[`#${original.source_issue} receipt interview_note_ids mismatch`]);
  const after = exactAppliedBoundaryEvidence(f.row.source,f.comments,f.options);
  assert.equal(after.ok,true,after.errors.join('; '));
  assert.equal(after.correction_comment_id,f.comment.id);
  assert.deepEqual(f.row.comments,original.comments); // never rewrites original receipts
});
const negatives = [
 ['missing correction', f=>{f.comments.pop();}],
 ['duplicate correction',f=>{f.comments.push({...f.comment,id:f.comment.id+1});}],
 ['duplicate marker same comment',f=>{f.comment.body+='\n'+f.comment.body;}],
 ['malformed correction JSON',f=>{f.comment.body=`<!-- ${SCHEMA}\n{broken}\n-->`;}],
 ['unterminated correction',f=>{f.comment.body=`<!-- ${SCHEMA}\n{`;}],
 ['source body drift',f=>{f.row.source.body+='\n';}],
 ['source ref drift',f=>{f.row.source.body=f.row.source.body.replaceAll('95b77bb261048059846273688e4b90a2e108b437','1'.repeat(40));}],
 ['owner body drift',f=>{f.options.ownerIssues.find(x=>x.number===f.row.owner_issue).body+='\n';}],
 ['duplicate owner identity',f=>{f.options.ownerIssues.push({...f.row.owner,number:9999});}],
 ['missing full owner inventory',f=>{f.options.ownerInventoryComplete=false;}],
 ['wrong correction issue URL',f=>{f.comment.issue_url='https://api.github.com/repos/liqiangcc/interview-lab/issues/1309';}],
 ['wrong correction identity',f=>setValue(f,v=>{v.owner_binding.interview_note_id='xhs:other';})],
 ['wrong source correction id',f=>setValue(f,v=>{v.correction_id='issue-1658-receipt-repair-1309-v1';})],
 ['bad digest',f=>setValue(f,v=>{v.evidence_binding.marker_sha256='bad';})],
 ['changed historical owner label binding',f=>setValue(f,v=>{v.owner_binding.labels.push('status:source-ready');})],
 ['top-level unknown field',f=>setValue(f,v=>{v.unknown=true;})],
 ['nested unknown field',f=>setValue(f,v=>{v.original_receipt.unknown=true;})],
 ['wrong original receipt locator',f=>setValue(f,v=>{v.original_receipt.comment_id++;})],
 ['historical receipt modified',f=>{f.comments.find(c=>c.id===f.row.applied_comment_id).body+='\n';}],
 ['materialization receipt modified',f=>{f.comments.find(c=>c.id===f.row.materialization_comment_id).body+='\n';}],
 ['duplicate original receipt',f=>{f.comments.push({...f.comments.find(c=>c.id===f.row.applied_comment_id),id:999999});}],
 ['duplicate materialization receipt',f=>{f.comments.push({...f.comments.find(c=>c.id===f.row.materialization_comment_id),id:999999});}],
 ['duplicate same-schema evidence',f=>{f.comments.push({...f.comments.find(c=>c.id===f.row.evidence_comment_id),id:999999});}],
 ['duplicate cross-schema evidence',f=>{f.comments.push({id:999999,body:`<!-- boundary-review-evidence.v1\n${JSON.stringify({issue_number:f.row.source_issue,transition_id:f.row.transition_id})}\n-->`});}],
];
for (const [name,mutate] of negatives) test(`correction rejects ${name}`,()=>{
 const f=fixture();mutate(f);const result=exactAppliedBoundaryEvidence(f.row.source,f.comments,f.options);assert.equal(result.ok,false,JSON.stringify(result));assert.ok(result.errors.length>0);
});
test('historical label binding does not prevent valid downstream lifecycle changes',()=>{
 const f=fixture();const owner=f.options.ownerIssues.find(o=>o.number===f.row.owner_issue);owner.labels=owner.labels.map(l=>l==='status:captured'?'status:source-ready':l);owner.title='[拼多多] 后端 · 二面';
 const r=validateAppliedReceiptCorrection(f.row.source,f.comments,f.options);assert.equal(r.ok,true,r.errors.join('; '));
});
test('malformed duplicate original marker is not silently filtered',()=>{
 const f=fixture(); f.comments.push({id:999,body:'<!-- source-note-boundary-review-applied\n{bad}\n-->'});assert.equal(validateAppliedReceiptCorrection(f.row.source,f.comments,f.options).ok,false);
 assert.throws(()=>strictMarkers(f.comments,'source-note-boundary-review-applied'));
});
