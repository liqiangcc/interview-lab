#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {execute} = require('./lib/issue-1658-receipt-correction-apply');
const {atomicWriteJson} = require('./lib/issue-1658-materialization-runner');
const REPO='liqiangcc/interview-lab';
function get(endpoint) {
  let error;
  for(let attempt=0;attempt<3;attempt++) {
    try{return JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024}));}
    catch(caught){error=caught;}
  }
  throw error;
}
function paged(endpoint) {
  const items=[];
  for(let page=1;page<=20;page++) {
    const batch=get(`${endpoint}&per_page=100&page=${page}`);
    if(!Array.isArray(batch))throw new Error('paginated GET must return an array');
    items.push(...batch);
    if(batch.length<100)return items;
  }
  throw new Error('pagination incomplete: no short terminal page after 20 pages');
}
function main(argv=process.argv.slice(2)) {
  const args={apply:false,allowLiveGithub:false};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(flag==='--apply')args.apply=true;
    else if(flag==='--allow-live-github')args.allowLiveGithub=true;
    else if(flag==='--authorization-file')args.authorizationFile=argv[++i];
    else if(flag==='--confirm-plan-digest')args.confirmPlanDigest=argv[++i];
    else if(flag==='--output')args.output=argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  const root=path.resolve(__dirname,'..');
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  const common=path.resolve(root,git(['rev-parse','--git-common-dir']));
  const executionSha=git(['rev-parse','HEAD']);
  if(args.apply) {
    if(!args.authorizationFile)throw new Error('explicit --authorization-file required');
    if(git(['status','--porcelain','--untracked-files=no']))throw new Error('apply requires clean committed tracked files');
    // A commit SHA must describe this exact writer/consumer, not an untracked replacement.
    for(const file of ['scripts/issue-1658-receipt-correction.js','scripts/lib/issue-1658-receipt-correction-apply.js'])git(['ls-files','--error-unmatch',file]);
  }
  const journalFile=path.join(common,'operation-journals/issue-1658-receipt-correction.json');
  const lockFile=path.join(common,'operation-locks/issue-1658-receipt-correction.lock');
  const api={
    readOwners:()=>paged(`repos/${REPO}/issues?state=all&labels=type%3Ainterview-note`).filter(i=>!i.pull_request),
    readSource:number=>get(`repos/${REPO}/issues/${number}`),
    readComments:number=>paged(`repos/${REPO}/issues/${number}/comments?sort=created&direction=asc`),
    postCorrection:(number,body)=>JSON.parse(execFileSync('gh',['api',`repos/${REPO}/issues/${number}/comments`,'--method','POST','--input','-'],{input:JSON.stringify({body}),encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024})),
  };
  const result=execute({...args,executionSha,journalFile,lockFile,authorization:args.authorizationFile?JSON.parse(fs.readFileSync(args.authorizationFile,'utf8')):undefined,api});
  const codeFiles=['scripts/issue-1658-receipt-correction.js','scripts/lib/issue-1658-receipt-correction-apply.js','scripts/lib/issue-1658-receipt-correction-consumer.js','scripts/lib/source-note-boundary-receipt-correction.js'];
  const output={execution_sha:executionSha,execution_tree_clean:!git(['status','--porcelain']),code_sha256:Object.fromEntries(codeFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),journal_file:args.apply?journalFile:null,...result};
  if(args.output)atomicWriteJson(args.output,output);
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
}
if(require.main===module){try{main();}catch(error){process.stderr.write(`ERROR: ${error.stack||error.message}\n`);process.exitCode=1;}}
module.exports={main,paged};
