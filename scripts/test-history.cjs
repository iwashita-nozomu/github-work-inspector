// Synthetic Git data and DOM fixtures; no network or native-host automation.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const prefix=path.resolve(__dirname,'../plugins/github-work-inspector-chat/skills/github-repo-review-chat/references'),bundle=fs.readFileSync(path.join(prefix,'review-selection.js'),'utf8'),ctx={TextEncoder};vm.runInNewContext(bundle,ctx);
const {GitHubReviewCore:C,GitHubReviewHistory:H,GitHubReviewHistoryGraph:G,GitHubReviewOverview:UI,GitHubReviewAcquisition:Acquire}=ctx;
const repo='example/project',at='2026-01-01T00:00:00Z',S=n=>n.toString(16).repeat(40),[R,A,B,D,E,M,F,U]=[1,2,3,4,5,6,7,8].map(S),plain=x=>JSON.parse(JSON.stringify(x));
const data=new Map([[R,[]],[A,[R]],[B,[A]],[D,[B]],[E,[B]],[M,[D,E]],[F,[E]],[U,null]]);
function record(sha,parents=data.get(sha)){return{sha,captured_at:at,result:{sha,message:'Synthetic '+sha.slice(0,2),committer:{date:at},parents:parents===null?null:parents.map(sha=>({sha}))}};}
function input(){return{repository:repo,captured_at:at,repository_metadata:{repository_full_name:repo,default_branch:'main'},branch_pages:[{branches:['topic','alias','main'].map(branch=>({branch})),cursor:null}],tip_resolutions:[['main',M],['topic',F],['alias',F]].map(([ref,sha])=>({ref,captured_at:at,result:{repository_full_name:repo,base:ref,head:ref,status:'identical',total_commits:0,files:[],base_commit:{sha}}})),history_commits:[]};}
const snapshot=x=>C.normalizeChat(x).snapshot;
function complete(x){for(let i=0;i<50;i++){const p=H.plan(snapshot(x));if(p.coverage.bounded_finished)return snapshot(x);assert.ok(p.requests.length);for(const q of p.requests)x.history_commits.push(record(q.key.slice(8)));}throw Error('No convergence');}

test('fixed Git data receipt binds repo/SHA/source and drops author/email/signature fields',()=>{
 const q=H.request(repo,M),raw={...record(M).result,author:{email:'synthetic@example.invalid'},verification:{payload:'ignored'}};
 const r=H.receipt(q,{structuredContent:{url:q.args.url,content:JSON.stringify(raw)}},at);assert.equal(r.result.parents.length,2);assert.equal(r.result.author,undefined);assert.equal(r.result.verification,undefined);const nested=H.receipt(q,{structuredContent:{structuredContent:{display_url:q.args.url,content:JSON.stringify(raw)}}},at);assert.equal(nested.result.parents.length,2);
 for(const change of [{url:'https://example.invalid'},{url:q.args.url.replace('example/project','other/repo')},{content:JSON.stringify({...raw,sha:A})}])assert.throws(()=>H.receipt(q,{structuredContent:{url:q.args.url,content:JSON.stringify(raw),...change}},at));
 assert.throws(()=>H.request('../outside',M));assert.throws(()=>H.request(repo,'shortsha'));
});

test('bounded breadth-first queue deduplicates refs/ancestors, preserves merge and shared ancestry without list-order edges',()=>{
 const x=input(),seen=[];for(let i=0;i<20;i++){const p=H.plan(snapshot(x));if(p.coverage.bounded_finished)break;seen.push(...p.requests.map(q=>q.key));for(const q of p.requests)x.history_commits.push(record(q.key.slice(8)));}
 const s=snapshot(x);assert.equal(new Set(seen).size,7);assert.equal(seen.length,7);assert.equal(s.dag.parent_fields_available,true);assert.equal(s.branch_overview.history_branch_count,3);assert.deepEqual(plain(s.dag.nodes.find(n=>n.sha===M).parents),[D,E]);
 const graph=G.layout(s.dag,s.branch_overview.items);assert.equal(graph.edges.length,7);assert.equal(graph.nodes.find(n=>n.sha===M).merge,true);assert.equal(graph.nodes.filter(n=>n.sha===B).length,1);assert.deepEqual(plain(graph.nodes.find(n=>n.sha===F).refs).sort(),['alias','topic']);
 assert.ok(!graph.edges.some(e=>e.child===F&&e.parent===M));assert.equal(s.dag.history_coverage.fully_enumerated,true);
});

test('commit/depth/per-ref windows expose missing parents and never invent roots or hide partial coverage',()=>{
 const x=input();x.history_limits={max_commits:2,max_depth:12,per_branch:2};let p=H.plan(snapshot(x));for(const q of p.requests)x.history_commits.push(record(q.key.slice(8)));let s=snapshot(x);p=H.plan(s);assert.equal(p.requests.length,0);assert.equal(p.coverage.bounded_finished,true);assert.equal(p.coverage.fully_enumerated,false);
 const graph=G.layout(s.dag,s.branch_overview.items);assert.equal(graph.boundaries.length,2);assert.equal(graph.edges.filter(e=>e.boundary).length,3);assert.ok(graph.boundaries.every(b=>b.reason==='commit_limit'));assert.equal(s.branch_overview.items[0].history.coverage.fully_enumerated,false);
 const y=input();y.history_limits={max_depth:0};y.history_commits=[record(M),record(F)];s=snapshot(y);assert.ok(s.dag.outside_window_parents.every(b=>b.reason==='depth_limit'));assert.equal(H.plan(s).coverage.bounded_finished,true);
});

test('missing parent fields, explicit roots, read failures and invalid cycles remain distinct',()=>{
 const x=input();x.history_commits=[record(M,null),{sha:F,captured_at:at,error:'not_found'}];let s=snapshot(x);assert.equal(s.dag.nodes.find(n=>n.sha===M).parents,null);assert.equal(G.layout(s.dag,s.branch_overview.items).edges.length,0);assert.equal(s.dag.history_coverage.failed,1);assert.equal(H.plan(s).requests.length,0);assert.equal(s.dag.history_coverage.fully_enumerated,false);
 const y=input();y.history_commits=[record(M,[F]),record(F,[M])];assert.throws(()=>snapshot(y));
 const z=input();z.history_commits=[record(M,[M])];assert.throws(()=>snapshot(z));
 const all=complete(input());assert.deepEqual(plain(all.dag.nodes.find(n=>n.sha===R).parents),[]);assert.equal(all.dag.nodes.find(n=>n.sha===R).parents_complete,true);
});

test('history budget/resume preserves pending queue and rejects lost/altered parent evidence',()=>{
 const x=input();let p=H.plan(snapshot(x),{request_budget:0});assert.equal(p.phase,'history_paused');assert.equal(p.checkpoint.pending_shas.length,2);const first=plain(p.checkpoint);
 p=H.plan(snapshot(x),{checkpoint:first,request_budget:1});assert.equal(p.requests.length,1);x.history_commits.push(record(p.requests[0].key.slice(8)));const saved=plain(H.plan(snapshot(x)).checkpoint);
 assert.ok(H.plan(snapshot(plain(x)),{checkpoint:saved}).requests.length);const altered=plain(x);altered.history_commits[0].result.parents=[];assert.throws(()=>H.plan(snapshot(altered),{checkpoint:saved}));assert.throws(()=>H.plan(snapshot(input()),{checkpoint:saved}));
});

class Element{constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.attrs={};this.handlers={};this.textContent='';this.value='';}appendChild(c){this.children.push(c);return c;}replaceChildren(...c){this.children=c;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,f){this.handlers[k]=f;}async click(){if(!this.disabled)return this.handlers.click?.();}}
const doc={createElement(tag){return new Element(tag,doc);},createElementNS(ns,tag){return new Element(tag,doc);}};
const descendants=n=>[n,...n.children.flatMap(descendants)],text=n=>descendants(n).map(n=>n.textContent).join('\n');
function dom(){const controls={};for(const k of ['history-graph','overview-cards','overview-details','overview-search','overview-prev','overview-next','overview-page','overview-repository','overview-baseline','overview-coverage','review-selection','review-ask','review-fallback','review-status'])controls[k]=doc.createElement('div');return{controls,element:{ownerDocument:doc,querySelector:q=>controls[q.slice(6,-1)],querySelectorAll:()=>[]}};}

test('real SVG paths/labels and ref selection connect to immutable commit details and explicit question fallback',async()=>{
 const s=complete(input()),{controls:c,element}=dom(),calls=[],ui=UI.mount(element,{captured_at:at,snapshot:s},()=>({sendFollowUpMessage:p=>calls.push(p)}));
 const graph=c['history-graph'];assert.equal(descendants(graph).filter(n=>n.tag==='path').length,7);assert.ok(text(graph).includes('merge 2 parents'));assert.ok(text(graph).includes('ref: alias'));
 const select=descendants(graph).find(n=>n.tag==='select');select.value='topic';select.handlers.change();assert.equal(ui.graph.state().selectedRef,'topic');assert.ok(!ui.graph.state().layout.nodes.some(n=>n.sha===M));assert.equal(calls.length,0);
 const group=descendants(graph).find(n=>n.dataset.commitSha===F);await group.click();assert.ok(text(c['overview-details']).includes(F));assert.ok(text(c['overview-details']).includes(E));assert.equal(ui.selection.selected().kind,'commit');assert.equal(ui.selection.selected().sha,F);assert.equal(calls.length,0);await c['review-ask'].click();assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].prompt.split('\n').at(-1)).selection.sha,F);
 const d=dom(),manual=UI.mount(d.element,{captured_at:at,snapshot:s},()=>undefined);manual.graph.select(M);await d.controls['review-ask'].click();assert.equal(d.controls['review-fallback'].hidden,false);assert.equal(JSON.parse(d.controls['review-fallback'].value.split('\n').at(-1)).selection.sha,M);
});

test('default acquisition plan inserts actual tip history before content and does not finish with cards alone',()=>{
 const x=input();let p=Acquire.plan(snapshot(x));assert.equal(p.phase,'read_branch_tip_history');assert.equal(p.requests[0].args.url,H.request(repo,M).args.url);assert.equal(p.workflow_complete,false);
 x.history_commits.push(record(M));p=Acquire.plan(snapshot(x));assert.equal(p.phase,'inspect_default_branch_first');assert.equal(p.requests[0].method,'compare_commits');
 const paused=input();assert.equal(Acquire.plan(snapshot(paused),{request_budget:0}).paused,true);
});

test('parent order drives topological layout and unsafe labels stay text while no-parent history is explicitly unmet',()=>{
 const s=complete(input());const g=G.layout(s.dag,s.branch_overview.items);for(const e of g.edges){const child=g.nodes.find(n=>n.sha===e.child),parent=g.nodes.find(n=>n.sha===e.parent);assert.ok(child.y<parent.y);}
 const unknown=snapshot(input()),d=dom();UI.mount(d.element,{captured_at:at,snapshot:unknown});assert.equal(descendants(d.controls['history-graph']).filter(n=>n.tag==='path').length,0);assert.ok(text(d.controls['history-graph']).includes('未達'));
 const hostile=complete(input());hostile.dag.nodes[0].subject='<img onerror="bad()">';const f=dom();UI.mount(f.element,{captured_at:at,snapshot:hostile});assert.equal(descendants(f.controls['history-graph']).filter(n=>n.tag==='img').length,0);
 const template=fs.readFileSync(path.join(prefix,'overview.fragment.html'),'utf8');const html=UI.buildFragment(template,bundle,{captured_at:at,snapshot:hostile});assert.ok(!html.includes('<img onerror'));assert.ok(html.includes('data-history-graph'));
});

test('full default workflow retains all-ref content traversal, history queue and checkpoints before finishing',()=>{
 const x=input();x.branch_reads=[];x.branch_summaries=[];let checkpoint=null,requests=0,finished=false;
 for(let i=0;i<150;i++){
  const p=Acquire.plan(snapshot(x),checkpoint?{checkpoint}:{});checkpoint=plain(p.checkpoint);
  if(p.workflow_complete){assert.equal(p.progress.counts.acquired,3);assert.equal(p.progress.counts.checked,3);assert.equal(p.history_coverage.observed,7);finished=true;break;}
  assert.ok(p.requests.length||p.tasks.length,'no silent completion without history');
  for(const q of p.requests){requests++;if(q.method==='fetch'){x.history_commits.push(record(q.key.slice(8)));continue;}
   const ref=p.target_ref,tip=ref==='main'?M:F;let r=x.branch_reads.find(r=>r.ref===ref);if(!r){r={ref,sha:tip,captured_at:at,files:[],baseline_files:[]};x.branch_reads.push(r);}
   if(q.method==='compare_commits'){r.comparison={repository_full_name:repo,base:M,head:tip,status:tip===M?'identical':'diverged',ahead_by:tip===M?0:1,behind_by:tip===M?0:2,files:tip===M?[]:[{filename:'src/worker.rs',status:'modified'}]};continue;}
   const f={path:q.args.path,start_line:1,end_line:60,captured_at:at,content:'Synthetic bounded file at '+q.args.ref};if(q.args.ref===M&&tip!==M)r.baseline_files.push({...f,sha:M});else r.files.push(f);
  }
  for(const t of p.tasks)x.branch_summaries.push({ref:t.ref,sha:t.sha,status:'recorded',purpose:{text:'有限範囲の実装という推定',kind:'inference',evidence:t.evidence_ids.slice(0,1)},difference:{text:'両tipの観測fileに基づく違い',kind:'inference',evidence:t.evidence_ids.slice(0,6)}});
 }
 assert.equal(finished,true);assert.ok(requests<30);assert.equal(snapshot(x).dag.per_branch.length,3);assert.equal(snapshot(x).partial,false);
});

test('octopus parent cap exposes omitted counts and never describes a truncated parent list as a complete merge',()=>{
 const x=input(),parents=Array.from({length:20},(_,i)=>(i+20).toString(16).padStart(40,'0'));x.history_commits=[record(M,parents),record(F,[])];const s=snapshot(x),n=s.dag.nodes.find(n=>n.sha===M);assert.equal(n.parents.length,16);assert.equal(n.parents_omitted_count,4);assert.equal(n.parents_complete,false);assert.equal(s.dag.history_coverage.parent_links_omitted,4);assert.equal(s.dag.history_coverage.fully_enumerated,false);
 const d=dom();UI.mount(d.element,{captured_at:at,snapshot:s});assert.ok(text(d.controls['history-graph']).includes('16+4省略'));assert.ok(text(d.controls['history-graph']).includes('親リンク省略4'));
});
