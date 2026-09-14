#!/usr/bin/env node
'use strict';
// GET-only independent Source Review preparation. No publishing/apply path.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {paginateInterviewNotes,buildInventory}=require('./generate-issue-1611-interview-note-ownership-inventory');
const {parseSourceNoteIssue}=require('./lib/source-note-issue');
const {buildManifest,validateManifest}=require('./lib/issue-1539-pinned-artifact-manifest');
const {computeChecks,planSourceReview,evidenceSubjectSha256}=require('./lib/interview-note-source-review-transition');
const {exactAppliedBoundaryEvidence,materializationReceiptsBySourceIssue}=require('./plan-issue-1611-live-materialization');
const {buildMaterializationRequest}=require('./lib/interview-note-materialization-batch');
const {planMaterialization,selectExistingMaterializationRequest}=require('./lib/source-note-interview-materialization');
const pinned=require('../audit/issue-1658-receipt-repair/repair-plan.json');
const REPO='liqiangcc/interview-lab',SOURCE='liqiangcc/xhs',REF='95b77bb261048059846273688e4b90a2e108b437';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function get(endpoint){let last;for(let i=0;i<3;i++){try{return JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024}));}catch(e){last=e;}}throw last;}
function comments(number){const all=[];for(let p=1;p<=20;p++){const page=get(`repos/${REPO}/issues/${number}/comments?per_page=100&page=${p}`);if(!Array.isArray(page))throw Error('comments response is not an array');all.push(...page);if(page.length<100)return all;}throw Error('comments pagination incomplete');}
function ensure(ok,message){if(!ok)throw Error(message);}
function main(argv=process.argv.slice(2)){
 let output='data/pilot/issue-1661/source-review-13';
 for(let i=0;i<argv.length;i++){if(argv[i]==='--output-dir')output=argv[++i];else throw Error(`unknown argument: ${argv[i]}`);}
 fs.mkdirSync(output,{recursive:true});
 const owners=paginateInterviewNotes(REPO),inventory=buildInventory(owners,REPO);
 const live=[];
 for(const target of pinned.rows){
  const source=get(`repos/${REPO}/issues/${target.source_issue}`),sourceComments=comments(target.source_issue),owner=owners.find(x=>x.number===target.owner_issue);
  ensure(owner,'owner missing');
  ensure(sha(source.body)===target.source_body_sha256&&sha(owner.body)===target.owner_body_sha256,'source/owner body drift');
  const boundary=exactAppliedBoundaryEvidence(source,sourceComments,{ownerIssues:owners,ownerInventoryComplete:true});ensure(boundary.ok,boundary.errors.join('; '));
  const receipts=materializationReceiptsBySourceIssue(new Map([[source.number,sourceComments]])).get(source.number)||[];
  const options={repository:REPO,sourceIssue:source,issues:owners,receipts};const selected=selectExistingMaterializationRequest(buildMaterializationRequest(source,REPO),options);
  const mat=planMaterialization(selected.request,options);ensure(mat.ok&&mat.already_materialized,'materialization not verified');
  live.push({source,owner,owner_comments:comments(owner.number),record:parseSourceNoteIssue(source.body).record,materialization_request:selected.request});
 }
 const commit=get(`repos/${SOURCE}/git/commits/${REF}`);ensure(commit.sha===REF,'source commit mismatch');
 const trees=new Map();
 function tree(id){if(!trees.has(id)){const t=get(`repos/${SOURCE}/git/trees/${id}`);ensure(t.sha===id&&t.truncated===false&&Array.isArray(t.tree),'incomplete/mismatched tree');trees.set(id,t);}return trees.get(id).tree;}
 function locate(file){let id=commit.tree.sha;const parts=file.split('/');for(let i=0;i<parts.length;i++){ensure(parts[i]&&parts[i]!=='.'&&parts[i]!=='..','invalid artifact path');const matches=tree(id).filter(e=>e.path===parts[i]);ensure(matches.length===1,'missing/duplicate tree path '+file);const entry=matches[0];if(i===parts.length-1){ensure(entry.type==='blob','artifact not a blob');return entry;}ensure(entry.type==='tree','parent path not tree');id=entry.sha;}}
 const treeEntries=[],verified=[],entries=[];
 for(const item of live){
  const artifacts=item.record.artifacts;
  for(const artifact of artifacts){
   const match=artifact.ref.match(/^([^:]+):(.+)@([a-f0-9]{40})$/);ensure(match&&match[1]===SOURCE&&match[3]===REF,'artifact repo/ref mismatch');
   const entry=locate(match[2]);ensure(entry.sha===artifact.git_blob_sha&&entry.size===artifact.byte_size,'tree SHA/byte_size mismatch '+artifact.ref);
   const blob=get(`repos/${SOURCE}/git/blobs/${entry.sha}`);ensure(blob.sha===entry.sha&&blob.encoding==='base64','invalid blob response');
   const bytes=Buffer.from(blob.content,'base64');const gitSha=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
   ensure(gitSha===entry.sha&&bytes.length===entry.size&&blob.size===bytes.length,'blob content digest/size mismatch');
   if(artifact.kind==='json')JSON.parse(bytes.toString('utf8'));
   treeEntries.push({path:match[2],type:'blob',sha:entry.sha,size:entry.size});
   verified.push({source_issue:item.source.number,ref:artifact.ref,git_blob_sha:gitSha,byte_size:bytes.length,content_sha256:sha(bytes),json_parse:artifact.kind==='json'?'PASS':null});
  }
  entries.push({interview_issue_number:item.owner.number,source_note_issue_number:item.source.number,source_note_id:item.record.source_note_id,source_revision_id:item.record.source_revision.id,artifacts});
 }
 const manifest=buildManifest({repository:REPO,sourceSnapshot:{repository:SOURCE,ref:REF},entries,treeEntries,treeSha:commit.tree.sha,scope:'explicit-selection'});
 const validation=validateManifest(manifest);ensure(validation.ok,validation.errors.join('; '));
 const reviewedAt=new Date().toISOString();const requests=[],results=[];
 for(const item of live){
  const r={schema_version:'interview-note-source-review-transition.v1',transition_id:`issue-1661-source-review-${item.owner.number}-20260912`,repository:REPO,issue_number:item.owner.number,interview_note_id:item.record.boundary_review.interview_note_ids[0],expected_interview_body_sha256:sha(item.owner.body),expected_initial_status:'captured',expected_source_revision_id:item.record.source_revision.id,source_note_issue_number:item.source.number,expected_source_note_body_sha256:sha(item.source.body),expected_manifest_sha256:null,expected_source_repository_ref:REF,decision:'source-ready',reviewed_at:reviewedAt,reviewer_kind:'ai-assisted',provenance_mode:'pinned-source-artifact',provenance_statement:'pinned-source-artifact; raw-lineage-unproven',pinned_artifact_manifest_sha256:manifest.digest,checks:[],limitations:[...item.record.limitations,'Source Review verifies pinned commit/tree/blob bytes; Source projection to Raw lineage is not proven.']};
  r.checks=computeChecks(r,item.owner,item.source,owners);r.evidence_subject_sha256=evidenceSubjectSha256(r,r.checks);
  const p=planSourceReview(r,item.owner,{planningOnly:true,sourceIssue:item.source,allIssues:owners,pinnedArtifactManifest:manifest});ensure(p.ok,p.errors.join('; '));
  requests.push(r);results.push({source_issue:item.source.number,owner_issue:item.owner.number,ok:p.ok,source_ready_gate:p.source_ready_gate,checks:r.checks,evidence_published:false,transition_applied:false});
 }
 const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n');
 write('pinned-artifact-manifest.json',manifest);write('artifact-verification.json',{captured_at:reviewedAt,mode:'GET-only',source_commit:REF,source_tree:commit.tree.sha,commit,trees:[...trees.values()],blobs:verified});
 write('source-review-requests.json',{mode:'prepared-requests-not-applied',reviewed_at:reviewedAt,requests});write('source-review-preflight.json',{recorded_at:reviewedAt,mutation_performed:false,writes:0,ownership_inventory_digest:inventory.canonical_digest,manifest_digest:manifest.digest,counts:{rows:results.length,passed:results.filter(r=>r.ok).length,blobs:verified.length},rows:results});
 write('live-input.json',{captured_at:reviewedAt,ownership_inventory:inventory,rows:live});
 console.log(JSON.stringify({prepared:results.length,blobs_verified:verified.length,manifest_digest:manifest.digest,writes:0,output},null,2));
}
if(require.main===module){try{main();}catch(e){console.error(e.stack||e.message);process.exitCode=1;}}
module.exports={main};
