#!/usr/bin/env node
'use strict';
// Local counterfactual replay. Simulated corrections are never sent to GitHub.
const snapshot = require('../audit/issue-1658-receipt-repair/current-live-snapshot.json');
const { exactAppliedBoundaryEvidence, materializationReceiptsBySourceIssue } = require('./plan-issue-1611-live-materialization');
const { buildMaterializationRequest } = require('./lib/interview-note-materialization-batch');
const { planMaterialization } = require('./lib/source-note-interview-materialization');
const rows = snapshot.rows.map(row => {
  const options={ownerIssues:snapshot.rows.map(r=>r.owner),ownerInventoryComplete:true};
  const before=exactAppliedBoundaryEvidence(row.source,row.comments,options);
  const simulated={id:9000000000000+row.source_issue,issue_url:`https://api.github.com/repos/liqiangcc/interview-lab/issues/${row.source_issue}`,body:`<!-- source-note-boundary-review-applied-correction.v1\n${JSON.stringify(row.correction_template,null,2)}\n-->`};
  const after=exactAppliedBoundaryEvidence(row.source,[...row.comments,simulated],options);
  const request=buildMaterializationRequest(row.source,'liqiangcc/interview-lab');
  const receipts=materializationReceiptsBySourceIssue(new Map([[row.source_issue,row.comments]])).get(row.source_issue);
  const generic=planMaterialization(request,{sourceIssue:row.source,issues:options.ownerIssues,receipts});
  return {source_issue:row.source_issue,owner_issue:row.owner_issue,before_errors:before.errors,simulated_after_errors:after.errors,simulated_after_ok:after.ok,generic_request_id:request.materialization_id,historical_materialization_id:row.materialization_id,generic_needs_receipt_repair:generic.needs_receipt_repair,generic_errors:generic.errors,historical_execution:'UNKNOWN'};
});
process.stdout.write(JSON.stringify({mode:'offline-counterfactual',snapshot_captured_at:snapshot.captured_at,input_snapshot:'audit/issue-1658-receipt-repair/current-live-snapshot.json',mutation_performed:false,live_correction_posted:false,ownership_coverage:'13-owner fixture; production requires complete validated inventory',counts:{rows:rows.length,before_errors:rows.reduce((n,r)=>n+r.before_errors.length,0),simulated_after_errors:rows.reduce((n,r)=>n+r.simulated_after_errors.length,0),simulated_after_ok:rows.filter(r=>r.simulated_after_ok).length,generic_receipt_repair_remaining:rows.filter(r=>r.generic_needs_receipt_repair).length},rows},null,2)+'\n');
if(rows.some(r=>!r.simulated_after_ok || !r.generic_needs_receipt_repair))process.exitCode=1;
