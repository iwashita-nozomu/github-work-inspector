// Offline executable traversal acceptance tests. All repository/file contents are synthetic.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const context = { TextEncoder };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../.agents/skills/github-work-inspector/references/review-selection.js'), 'utf8'), context);
const { GitHubReviewCore: core, GitHubReviewSurvey: survey } = context;
const repo='example/project', at='2026-01-01T00:00:00Z', A='a'.repeat(40), B='b'.repeat(40), D='d'.repeat(40);
const plain = (x) => JSON.parse(JSON.stringify(x));
function input(names=['topic/z','topic/a','main'], paginated=false) {
  return { repository:repo,captured_at:at,repository_metadata:{repository_full_name:repo,default_branch:'main'},branch_pages:paginated?[]:[{branches:names.map(branch=>({branch})),cursor:null}],tip_resolutions:[],branch_reads:[],branch_summaries:[] };
}
const snap = (x) => core.normalizeChat(x).snapshot;
const tip = (ref) => ref==='main'?A:ref==='topic/z'?D:B;
function apply(x, p, options={}) {
  for (const q of p.requests) {
    if (q.method==='search_branches') { const second=q.args.cursor==='second';x.branch_pages.push({branches:(second?['main']:['topic/z','topic/a']).map(branch=>({branch})),cursor:second?null:'second'});continue; }
    const ref=p.target_ref;
    if (q.key.startsWith('tip/')) { x.tip_resolutions.push(options.fail_tip===ref?{ref,captured_at:at,error:'synthetic_not_found'}:{ref,captured_at:at,result:{repository_full_name:repo,base:ref,head:ref,status:'identical',total_commits:0,files:[],base_commit:{sha:tip(ref)}}});continue; }
    let r=x.branch_reads.find(r=>r.ref===ref);
    if (!r) {r={ref,sha:tip(ref),captured_at:at,files:[],baseline_files:[]};x.branch_reads.push(r);}
    if (q.method==='compare_commits') { r.comparison={repository_full_name:repo,base:A,head:tip(ref),status:ref==='main'?'identical':'ahead',ahead_by:ref==='main'?0:1,behind_by:0,files:ref==='main'?[]:[{filename:'src/worker.rs',status:'modified'}]};continue; }
    const f={path:q.args.path,start_line:1,end_line:60,captured_at:at};
    if(options.fail_file===ref+'/'+q.args.path && q.args.ref===tip(ref))f.error='synthetic_not_found';else f.content=q.args.path==='README.md'?'# Shared project\nSame README does not establish branch differences.':'// observed at '+q.args.ref+'\nfn bounded_worker() {}';
    if(q.args.ref===A&&tip(ref)!==A)r.baseline_files.push({...f,sha:A});else r.files.push(f);
  }
  for (const task of p.tasks) x.branch_summaries.push({ref:task.ref,sha:task.sha,status:task.difference_state==='comparison_unavailable'||task.difference_state==='branch_difference_not_read'?'insufficient':'recorded',purpose:{text:'限定範囲のworker実装',kind:'inference',evidence:task.evidence_ids.slice(0,1)},difference:{text:'観測した二つのtipの限定行範囲に基づく説明',kind:'inference',evidence:task.evidence_ids.slice(0,6)}});
}
function finish(x, options={}) {
  const visits=[];for(let i=0;i<150;i++){const p=survey.plan(snap(x));if(p.target_ref&&!visits.includes(p.target_ref))visits.push(p.target_ref);if(p.progress.complete)return{p,visits};assert.ok(p.requests.length||p.tasks.length,'unfinished traversal must have explained work');apply(x,p,options);}throw Error('Traversal did not converge');
}

test('enumeration completes all pages before default-at-end and stable ref traversal, including page boundary',()=>{
  const x=input(undefined,true);let p=survey.plan(snap(x));assert.equal(p.phase,'enumerate_all_pages');assert.equal(p.requests[0].method,'search_branches');apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.phase,'enumerate_all_pages');assert.equal(p.requests[0].args.cursor,'second');assert.equal(p.progress.inventory_complete,false);apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.target_ref,'main');assert.equal(p.requests[0].args.base,'main');assert.equal(p.progress.counts.acquired,3);
  const done=finish(x);assert.deepEqual(done.visits,['main','topic/a','topic/z']);assert.equal(done.p.progress.counts.processed,3);assert.equal(done.p.progress.counts.remaining,0);assert.equal(done.p.progress.counts.checked,3);
});

test('baseline content and summary settle before another branch tip; README alone never confirms branch difference',()=>{
  const x=input();let p=survey.plan(snap(x));apply(x,p);p=survey.plan(snap(x));apply(x,p); // baseline tip, comparison
  p=survey.plan(snap(x));assert.equal(p.target_ref,'main');assert.equal(p.requests.length,2);apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.tasks[0].kind,'summarize_branch');assert.equal(p.target_ref,'main');assert.equal(p.progress.counts.processed,0);apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.target_ref,'topic/a');apply(x,p);p=survey.plan(snap(x));apply(x,p);
  p=survey.plan(snap(x),{request_budget:1});assert.equal(p.requests[0].args.path,'README.md');apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.progress.rows[1].state,'in_progress');assert.equal(p.requests[0].args.path,'src/worker.rs');apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.requests[0].args.ref,A);assert.equal(p.requests[0].args.path,'src/worker.rs');assert.equal(snap(x).branch_overview.items.find(b=>b.name==='topic/a').content_review.delta.state,'branch_difference_not_read');apply(x,p);
  p=survey.plan(snap(x));assert.equal(p.tasks.length,1);assert.equal(p.progress.counts.checked,1);apply(x,p);assert.equal(survey.plan(snap(x)).progress.counts.checked,2);
});

test('mid-traversal failures are explicit terminal states and do not strand later unread branches',()=>{
  const x=input(['topic/z','topic/a','topic/b','main']);const result=finish(x,{fail_tip:'topic/b',fail_file:'topic/a/src/worker.rs'});
  const c=result.p.progress.counts;assert.equal(c.acquired,4);assert.equal(c.processed,4);assert.equal(c.remaining,0);assert.equal(c.checked,2,JSON.stringify(result.p.progress.rows));assert.equal(c.partial,1);assert.equal(c.unavailable,1);assert.equal(c.not_confirmed,2);
  assert.deepEqual(result.visits,['main','topic/a','topic/b','topic/z']);assert.equal(result.p.progress.complete,true);assert.equal(result.p.progress.all_checked,false);
});

test('pause/budget preserves unstarted refs, pending stage and pinned revisions; resume does not skip or refetch settled work',()=>{
  let x=input();let p=survey.plan(snap(x),{request_budget:0});assert.equal(p.phase,'paused');assert.equal(p.checkpoint.resume_ref,'main');assert.equal(p.requests.length,0);assert.equal(p.progress.counts.processed,0);
  let saved=plain(p.checkpoint);p=survey.plan(snap(x),{checkpoint:saved,request_budget:1});apply(x,p);
  p=survey.plan(snap(x),{checkpoint:saved});apply(x,p);p=survey.plan(snap(x),{request_budget:1});assert.equal(p.pending_request_keys.length,2);apply(x,p);
  p=survey.plan(snap(x),{stop_reason:'time'});assert.equal(p.phase,'paused');assert.equal(p.checkpoint.resume_stage,'read_branch_content');saved=plain(p.checkpoint);
  x=plain(x);p=survey.plan(snap(x),{checkpoint:saved});assert.equal(p.requests.length,1);assert.equal(p.requests[0].args.path,'CMakeLists.txt');assert.deepEqual(plain(p.progress.order),['main','topic/a','topic/z']);
  assert.equal(finish(x).p.progress.counts.checked,3);
  const changed=plain(x);changed.tip_resolutions[0].result.base_commit.sha=D;assert.throws(()=>survey.plan(snap(changed),{checkpoint:saved}));
});

test('same SHA evidence and comparison reuse still requires a summary/status for each acquired ref',()=>{
  const x=input(['topic/b','topic/a','main']);const calls=[];for(let i=0;i<100;i++){const p=survey.plan(snap(x));if(p.progress.complete)break;calls.push(...p.requests.map(q=>q.key));apply(x,p);}
  assert.equal(new Set(calls).size,calls.length);assert.equal(x.branch_summaries.length,3);assert.equal(survey.plan(snap(x)).progress.counts.checked,3);
  x.branch_summaries.pop();let p=survey.plan(snap(x));assert.equal(p.progress.complete,false);assert.equal(p.tasks.length,1);assert.equal(p.progress.counts.remaining,1);
  const old=plain(survey.plan(snap({...x,branch_summaries:[...x.branch_summaries,{ref:p.target_ref,sha:tip(p.target_ref),status:'insufficient'}]})).checkpoint);
  assert.throws(()=>survey.plan(snap(x),{checkpoint:old})); // lost processed summary cannot be hidden by a cursor
});

test('ref order is reproducible across page/source order and locale, while incomplete inventory never becomes globally complete',()=>{
  const a=input(['topic/2','topic/10','main','topic/1']),b=input(['topic/1','main','topic/2','topic/10']);
  assert.deepEqual(plain(survey.plan(snap(a)).progress.order),plain(survey.plan(snap(b)).progress.order));assert.deepEqual(plain(survey.plan(snap(a)).progress.order),['main','topic/1','topic/10','topic/2']);
  const x=input();x.branch_pages[0].cursor='repeat';x.branch_pages.push({branches:[],cursor:'repeat'});
  for(let i=0;i<100;i++){const p=survey.plan(snap(x));if(p.progress.finished_known_targets){assert.equal(p.phase,'finished_known_targets_partial_inventory');assert.equal(p.progress.complete,false);assert.equal(p.progress.inventory_complete,false);return;}apply(x,p);}
  assert.fail('Known partial targets did not settle');
});

test('in-flight tip stays in progress without success, and a fresh unread ref prevents termination',()=>{
  const x=input();let p=survey.plan(snap(x));p=survey.plan(snap(x),{in_flight_keys:p.pending_request_keys});assert.equal(p.phase,'waiting_for_receipts');assert.equal(p.progress.rows[0].state,'in_progress');assert.equal(p.progress.counts.processed,0);
  const done=finish(x).p;x.branch_pages[0].branches.push({branch:'topic/unread'});p=survey.plan(snap(x));assert.equal(p.progress.complete,false);assert.equal(p.target_ref,'topic/unread');assert.equal(p.progress.counts.remaining,1);assert.equal(p.requests[0].args.base,'topic/unread');assert.throws(()=>survey.plan(snap(x),{checkpoint:done.checkpoint}));
});

test('failed default tip leaves comparisons unknown while later refs still receive bounded content inspection',()=>{
  const x=input();const {p}=finish(x,{fail_tip:'main'});assert.equal(p.progress.counts.processed,3);assert.equal(p.progress.counts.unavailable,1);assert.equal(p.progress.counts.partial,2);assert.equal(p.progress.all_checked,false);assert.ok(x.branch_reads.every(r=>!r.comparison));
});

test('page-limit freezes only known targets and preserves the unconsumed cursor separately from content progress',()=>{
  const x=input();x.branch_pages=Array.from({length:10},(_,i)=>({branches:[{branch:i===9?'main':'topic/'+i}],cursor:'cursor-'+i}));const p=survey.plan(snap(x));assert.equal(p.phase,'inspect_default_branch_first');assert.equal(p.progress.inventory_complete,false);assert.equal(p.checkpoint.inventory_cursor,'cursor-9');assert.equal(p.checkpoint.inventory_frozen,true);assert.equal(p.progress.counts.acquired,10);
});
