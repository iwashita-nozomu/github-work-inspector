// Synthetic source/prose only. No actual private repository or native Chat automation.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ctx={TextEncoder,TextDecoder};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../.agents/skills/github-work-inspector/references/review-selection.js'),'utf8'),ctx);
const {GitHubReviewCore:C,GitHubReviewReading:R,GitHubReviewAcquisition:A,GitHubReviewHistory:H}=ctx;
const repo='example/project',at='2026-01-01T00:00:00Z',S=n=>n.toString(16).padStart(40,'0'),[M,F,TM,TF,README,OLD,NEW,ANNEX,SUB,DEP]=Array.from({length:10},(_,i)=>S(i+1)),plain=x=>JSON.parse(JSON.stringify(x));
const source = (label) => Array.from({length:160},(_,i)=>i===134?`fn required_path() { ${label}_implementation(); }`:`// source line ${i+1}`).join('\n');
function setup(names=['topic','alias','main']){
 const x={repository:repo,captured_at:at,repository_metadata:{default_branch:'main'},branch_pages:[{branches:names.map(branch=>({branch})),cursor:null}],tip_resolutions:names.map(ref=>({ref,captured_at:at,result:{repository_full_name:repo,base:ref,head:ref,status:'identical',total_commits:0,files:[],base_commit:{sha:ref==='main'?M:F}}})),history_commits:[],reading:{objects:[],file_reviews:[],branch_reviews:[],file_parts:[]}};
 const tree=(sha,worker)=>({sha,truncated:false,tree:[{path:'README.md',mode:'100644',type:'blob',sha:README},{path:'worker.rs',mode:'100644',type:'blob',sha:worker},{path:'payload.gz',mode:'120000',type:'blob',sha:ANNEX}]});
 const blob=(sha,content)=>({sha,encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')});
 const data=new Map([[M,{sha:M,tree:{sha:TM},parents:[],message:'Root',committer:{date:at}}],[F,{sha:F,tree:{sha:TF},parents:[{sha:M}],message:'Feature',committer:{date:at}}],[TM,tree(TM,OLD)],[TF,tree(TF,NEW)],[README,blob(README,'# Shared README')],[OLD,blob(OLD,source('old'))],[NEW,blob(NEW,source('new'))]]);
 return{x,data,calls:[],pages:[]};
}
const snap=x=>C.normalizeChat(x).snapshot;
function apply(f,p){
 for(const q of p.requests){f.calls.push(q.key);if(q.key.startsWith('history/')){const sha=q.key.slice(8);f.x.history_commits.push({sha,captured_at:at,result:f.data.get(sha)});continue;}
  if(q.method==='search_branches')throw Error('Fixture inventory not supplied');
  const sha=q.key.split('/')[1],result=f.data.get(sha);assert.ok(result,`Missing fixture ${q.key}`);f.x.reading.objects.push(R.receipt(q,result,at));
 }
 for(const t of p.tasks){
  if(t.kind==='read_file_page_and_interpret'){f.pages.push(t);f.x.reading.file_reviews.push({blob:t.blob,kind:'model_text',spans:[[t.start_line,t.end_line]],...(t.final_page?{meaning:t.blob===README?'Shared project introduction':'The executable path after line120 dispatches the branch-specific implementation.'}:{})});}
  else if(t.kind==='interpret_branch')f.x.reading.branch_reviews.push({ref:t.ref,sha:t.sha,design:'Documented shared project goal.',implementation:'Read implementation calls the branch-specific required path after line120.',difference:t.sha===M?'Baseline source.':'Same README, changed implementation body at the fixed tip.',limits:'Observed source interpretation; no execution or full runtime proof.',evidence:t.evidence_ids,required_calls:[],claims:[{text:'The model interprets the observed source path; intent remains unconfirmed.',kind:'inference',evidence:t.evidence_ids}]});
  else throw Error(`Unhandled task ${t.kind}`);
 }
}
function finish(f){let saved;for(let n=0;n<100;n++){const p=A.plan(snap(f.x),saved?{checkpoint:saved}:{});saved=plain(p.checkpoint);if(p.workflow_complete)return p;assert.ok(p.requests.length||p.tasks.length,JSON.stringify(p));apply(f,p);}throw Error('No convergence');}

test('short input traverses default-at-end, full bodies beyond60, branch differences, shared blobs, Annex references and history',()=>{
 const f=setup(),p=finish(f);assert.equal(p.progress.all_checked,true);assert.deepEqual(plain(p.progress.order),['main','alias','topic']);
 assert.ok(f.pages.some(t=>t.blob===NEW&&t.start_line>60&&t.text.includes('new_implementation')));
 assert.equal(f.calls.filter(k=>k==='blob/'+README).length,1);assert.equal(f.calls.filter(k=>k==='blob/'+NEW).length,1);
 assert.equal(f.calls.some(k=>k==='blob/'+ANNEX),false);assert.equal(f.x.reading.branch_reviews.length,3);
 const s=snap(f.x);assert.equal(s.partial,false);assert.equal(s.branch_overview.items[0].understanding.differences[0].path,'worker.rs');assert.equal(s.dag.nodes.find(n=>n.sha===F).parents[0],M);
 assert.equal(s.branch_overview.items[0].understanding.files.find(f=>f.path==='payload.gz').method,'git_path_and_fixed_commit');
});

test('download/parse or first60line acknowledgement cannot mean full source understanding',()=>{
 const f=setup(['main']);f.x.history_commits=[{sha:M,captured_at:at,result:f.data.get(M)}];for(const sha of[TM,README,OLD])f.x.reading.objects.push({kind:sha===TM?'tree':'blob',sha,captured_at:at,result:f.data.get(sha)});
 let s=snap(f.x);assert.equal(s.branch_overview.items[0].understanding.complete,false);
 f.x.reading.file_reviews=[{blob:README,kind:'model_text',spans:[[1,1]],meaning:'Introduction'}, {blob:OLD,kind:'model_text',spans:[[1,60]],meaning:'Only a prefix read'}];
 let p=A.plan(snap(f.x));assert.equal(p.tasks[0].start_line,61);assert.ok(p.tasks[0].text.includes('old_implementation'));assert.equal(p.workflow_complete,false);
 // The rest was acquired but the model has not acknowledged it.
 assert.equal(snap(f.x).branch_overview.understanding_exploration.all_checked,false);
});

test('full tree recursion, truncation and missing subtrees do not silently settle',()=>{
 const f=setup(['main']);f.x.history_commits=[{sha:M,captured_at:at,result:f.data.get(M)}];f.data.set(TM,{sha:TM,truncated:false,tree:[{path:'src',mode:'040000',type:'tree',sha:SUB}]});f.x.reading.objects.push(R.receipt(R.request(repo,'tree',TM),f.data.get(TM),at));
 let p=A.plan(snap(f.x));assert.equal(p.requests[0].key,'tree/'+SUB);
 f.x.reading.objects.push({kind:'tree',sha:SUB,captured_at:at,result:{sha:SUB,truncated:true,tree:[]}});p=A.plan(snap(f.x));assert.equal(p.progress.complete,false);assert.equal(p.progress.rows[0].state,'partial');assert.match(p.progress.rows[0].stage,/tree_unavailable/);
});

test('pause/resume keeps pending body pages, fixedSHA and model records; lost completed meaning is rejected',()=>{
 const f=setup();let p=A.plan(snap(f.x),{request_budget:0});assert.equal(p.paused,true);assert.equal(p.workflow_complete,false);
 while(!f.pages.some(t=>t.blob===OLD)){p=A.plan(snap(f.x));apply(f,p);}
 const saved=plain(A.plan(snap(f.x)).checkpoint);p=A.plan(snap(plain(f.x)),{checkpoint:saved});assert.equal(p.tasks[0].start_line,121);
 finish(f);const done=plain(A.plan(snap(f.x)).checkpoint);f.x.reading.branch_reviews.pop();assert.throws(()=>A.plan(snap(f.x),{checkpoint:done}));
 const changed=plain(f.x);changed.tip_resolutions[0].result.base_commit.sha=S(33);assert.throws(()=>A.plan(snap(changed),{checkpoint:saved}));
});

test('all-page inventory precedes content and default branch remains first across page boundary',()=>{
 const f=setup();f.x.branch_pages=[{branches:[{branch:'topic'}],cursor:'next'}];f.x.tip_resolutions=[];
 let p=A.plan(snap(f.x));assert.equal(p.phase,'enumerate_all_pages');assert.equal(p.requests[0].args.cursor,'next');
 f.x.branch_pages.push({branches:[{branch:'main'}],cursor:null});p=A.plan(snap(f.x),{checkpoint:plain(p.checkpoint)});assert.equal(p.target_ref,'main');assert.equal(p.requests[0].args.base,'main');
});

test('same README cannot replace changed implementation; fake evidence and oldpreview completion are rejected',()=>{
 const f=setup();finish(f);const b=f.x.reading.branch_reviews.find(r=>r.ref==='topic');b.evidence=[repo+'@'+F+'/README.md'];assert.throws(()=>snap(f.x));
 b.evidence=['invented'];assert.throws(()=>snap(f.x));
 const legacy=setup();legacy.x.branch_reads=[{ref:'main',sha:M,captured_at:at,files:[{path:'README.md',start_line:1,end_line:60,captured_at:at,content:'Only preview'}]}];assert.equal(A.plan(snap(legacy.x)).workflow_complete,false);
});

test('required gitlink calls require fixed-source review evidence or explained non-use',()=>{
 const f=setup(['main']);f.data.get(TM).tree.push({path:'vendor',type:'commit',mode:'160000',sha:DEP});
 for(let n=0;n<30;n++){const p=A.plan(snap(f.x));if(p.tasks[0]?.kind==='interpret_branch'){apply(f,p);break;}apply(f,p);}
 let p=A.plan(snap(f.x));assert.equal(p.tasks[0].kind,'review_actual_required_calls');assert.equal(p.workflow_complete,false);
 const review=f.x.reading.branch_reviews[0];review.required_calls=[{target:'vendor@'+DEP,state:'reviewed',reason:'Actual required callee reviewed',evidence:['invented']}];assert.throws(()=>snap(f.x));
 review.required_calls=[{target:'vendor@'+DEP,state:'not_called',reason:'Tracked pin is not reached by this selected implementation; caller evidence inspected.',evidence:[repo+'@'+M+'/worker.rs']}];assert.equal(snap(f.x).branch_overview.items[0].understanding.complete,true);
});

test('structured full parsing and model meaning are separate; binary/generated exceptions require grounded reasons',()=>{
 const f=setup(['main']);for(let n=0;n<20;n++){const p=A.plan(snap(f.x));if(p.tasks[0]?.blob===OLD)break;apply(f,p);}
 f.x.reading.file_reviews.push({blob:OLD,kind:'structured_analysis',full_input_parsed:false,meaning:'Parse only'});assert.equal(snap(f.x).branch_overview.items[0].understanding.complete,false);
 f.x.reading.file_reviews.push({blob:OLD,kind:'excluded',reason:'unrelated_dependency',meaning:'Outside the actual call closure',evidence:['madeup']});assert.throws(()=>snap(f.x));
});

test('large text windows continue to observed empty EOF, reject gaps/identity changes and never fallback after access denial',()=>{
 const f=setup(['main']);f.data.get(TM).tree.find(e=>e.path==='worker.rs').size=400000;
 while(true){const p=A.plan(snap(f.x));if(p.requests[0]?.method==='fetch_file')break;apply(f,p);}
 let q=A.plan(snap(f.x)).requests[0];assert.equal(q.args.start_line,1);
 const response=content=>({sha:OLD,encoding:'utf-8',display_url:'https://github.com/'+repo+'/blob/'+M+'/worker.rs',content});
 f.x.reading.file_parts.push(R.pageReceipt(q,response(source('old').split('\n').slice(0,120).join('\n')),at));
 q=A.plan(snap(f.x)).requests[0];assert.equal(q.args.start_line,121);f.x.reading.file_parts.push(R.pageReceipt(q,response(source('old').split('\n').slice(120).join('\n')),at));
 q=A.plan(snap(f.x)).requests[0];assert.equal(q.args.start_line,241);assert.equal(A.plan(snap(f.x)).workflow_complete,false);f.x.reading.file_parts.push(R.pageReceipt(q,response(''),at));
 assert.equal(A.plan(snap(f.x)).tasks[0].kind,'read_file_page_and_interpret');
 const changed=plain(f.x);changed.reading.file_parts[1].start_line=122;assert.throws(()=>snap(changed));
 assert.throws(()=>R.pageReceipt(q,{...response(''),sha:NEW},at));
 const denied=setup(['main']);denied.x.reading.objects=[{kind:'commit',sha:M,captured_at:at,result:denied.data.get(M)},{kind:'tree',sha:TM,captured_at:at,result:denied.data.get(TM)},{kind:'blob',sha:OLD,captured_at:at,error:'access_denied'}];
 const s=snap(denied.x);assert.equal(s.branch_overview.items[0].understanding.files.find(f=>f.blob===OLD).state,'unavailable');assert.ok(!R.plan(s).requests.some(q=>q.key.startsWith('blobpart/'+OLD)));
});

test('host Git-data wrappers are bound to fixed URLs and drop unrelated object metadata',()=>{
 const q=R.request(repo,'commit',M),raw={...setup().data.get(M),author:{email:'synthetic@example.invalid'}};
 const r=R.receipt(q,{structuredContent:{url:q.args.url,content:JSON.stringify(raw)}},at);assert.equal(r.result.author,undefined);assert.equal(r.result.tree.sha,TM);
 assert.throws(()=>R.request('../outside','blob',OLD));assert.throws(()=>R.receipt(q,{structuredContent:{url:'https://example.invalid',content:JSON.stringify(raw)}},at));
});

class Element{constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.attrs={};this.handlers={};this.textContent='';this.value='';}appendChild(c){this.children.push(c);return c;}replaceChildren(...c){this.children=c;}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,f){this.handlers[k]=f;}async click(){if(!this.disabled)return this.handlers.click?.();}}
const doc={createElement(tag){return new Element(tag,doc);},createElementNS(ns,tag){return new Element(tag,doc);}},desc=n=>[n,...n.children.flatMap(desc)],text=n=>desc(n).map(n=>n.textContent).join('\n');
function dom(){const controls={};for(const k of ['history-graph','overview-cards','overview-details','overview-search','overview-prev','overview-next','overview-page','overview-repository','overview-baseline','overview-coverage','review-selection','review-ask','review-fallback','review-status'])controls[k]=doc.createElement('div');return{controls,element:{ownerDocument:doc,querySelector:q=>controls[q.slice(6,-1)],querySelectorAll:()=>[]}};}

test('meaning view retains actual SVG/selection, pages all file evidence and never embeds full source in the view',async()=>{
 const f=setup(['main']);for(let n=0;n<24;n++){const sha=S(100+n);f.data.get(TM).tree.push({path:'part'+String(n).padStart(2,'0')+'.txt',mode:'100644',type:'blob',sha});f.data.set(sha,{sha,encoding:'base64',size:4,content:Buffer.from('text').toString('base64')});}
 finish(f);const s=snap(f.x),d=dom(),ui=ctx.GitHubReviewOverview.mount(d.element,{captured_at:at,snapshot:s},()=>undefined);
 assert.ok(text(d.controls['overview-cards']).includes('実装:'));assert.ok(text(d.controls['overview-coverage']).includes('根拠付き解釈'));
 ui.select(s.branch_overview.items[0].branch_id);assert.ok(text(d.controls['overview-details']).includes('[GPT推定]'));assert.ok(text(d.controls['overview-details']).includes('1–20/27'));
 await desc(d.controls['overview-details']).find(n=>n.tag==='button'&&n.textContent==='次の根拠').click();assert.ok(text(d.controls['overview-details']).includes('21–27/27'));assert.ok(text(d.controls['overview-details']).includes('worker.rs'));
 const before=JSON.stringify(s);assert.ok(!before.includes('source line 100'));assert.ok(!before.includes('encoding":"base64'));assert.ok(!before.includes('old_implementation()'));
 const button=desc(d.controls['overview-details']).find(n=>n.tag==='button'&&n.textContent==='このファイルを選択');await button.click();assert.equal(ui.selection.selected().sha,M);await d.controls['review-ask'].click();assert.equal(d.controls['review-fallback'].hidden,false);
 assert.ok(desc(d.controls['history-graph']).some(n=>n.tag==='svg'));
});

test('v0.3 preview checkpoint retains parent records but upgrades to whole-reading pending',()=>{
 const f=setup();f.x.history_commits=[{sha:M,captured_at:at,result:f.data.get(M)}];const prior=plain(ctx.GitHubReviewSurvey.plan(snap(f.x)).checkpoint);
 const p=A.plan(snap(f.x),{checkpoint:{version:1,content:prior,history:plain(H.plan(snap(f.x)).checkpoint)}});assert.ok(p.content_checkpoint_migration);assert.equal(p.progress.all_checked,false);assert.equal(snap(f.x).dag.nodes[0].sha,M);
});

test('an unread baseline counterpart prevents a changed branch from claiming comparison understanding',()=>{
 const f=setup();let settled;
 for(let n=0;n<100;n++){const p=A.plan(snap(f.x));if(p.progress.finished_known_targets){settled=p;break;}if(p.requests[0]?.key==='blob/'+OLD){f.x.reading.objects.push({kind:'blob',sha:OLD,captured_at:at,error:'access_denied'});}else apply(f,p);}
 assert.ok(settled);assert.equal(settled.workflow_complete,false);assert.equal(settled.progress.counts.checked,0);const u=snap(f.x).branch_overview.items.find(b=>b.name==='topic').understanding;assert.equal(u.baseline_changed_bodies_reviewed,false);
});

test('complete machine parsing of source code cannot substitute for the model reading its body',()=>{
 const f=setup(['main']);for(let n=0;n<20;n++){const p=A.plan(snap(f.x));if(p.tasks[0]?.blob===OLD)break;apply(f,p);}
 f.x.reading.file_reviews.push({blob:OLD,kind:'structured_analysis',full_input_parsed:true,meaning:'A parser scanned every byte, but the model has not read the implementation.'});
 const p=A.plan(snap(f.x));assert.equal(p.tasks[0].kind,'read_file_page_and_interpret');assert.equal(p.tasks[0].start_line,1);assert.equal(p.workflow_complete,false);
});

test('failed default tip does not strand later refs or invent a default from another branch parent',()=>{
 const f=setup();f.x.tip_resolutions=f.x.tip_resolutions.map(t=>t.ref==='main'?{ref:'main',captured_at:at,error:'access_denied'}:t);let settled;
 for(let n=0;n<100;n++){const p=A.plan(snap(f.x));if(p.progress.finished_known_targets){settled=p;break;}apply(f,p);}
 assert.ok(settled);assert.equal(settled.progress.counts.unavailable,1);assert.equal(settled.progress.counts.partial,2);assert.equal(settled.workflow_complete,false);assert.equal(snap(f.x).branch_overview.baseline.tip_sha,null);
});

test('standard acquisition keeps in-flight GETs pending without duplicate dispatch or success',()=>{
 const f=setup();let p=A.plan(snap(f.x));p=A.plan(snap(f.x),{in_flight_keys:p.requests.map(q=>q.key)});assert.equal(p.phase,'waiting_for_receipts');assert.equal(p.requests.length,0);assert.equal(p.workflow_complete,false);assert.equal(p.progress.counts.checked,0);
});

test('large display projection keeps every ref/parent and executes the shipped view without embedding acquisition code',()=>{
 const f=setup();finish(f);const s=snap(f.x),base=s.branch_overview.items[0],main=s.branch_overview.items.find(b=>b.name==='main');
 s.branch_overview.items=Array.from({length:45},(_,i)=>{const original=i===44?main:base,b=plain(original);b.name=i===44?'main':'topic/'+i;b.branch_id='ref/'+encodeURIComponent(b.name);b.understanding.files=Array.from({length:200},(_,j)=>({...original.understanding.files[0],path:'file'+j+'.rs',id:repo+'@'+b.tip_sha+'/file'+j+'.rs',excerpt:'x'.repeat(480),meaning:'Meaning '.repeat(100)}));return b;});
 s.branch_overview.understanding_exploration.rows=s.branch_overview.items.map((b,index)=>({ref:b.name,index,state:'checked',stage:'meaning_review_recorded'}));s.branch_overview.understanding_exploration.counts={acquired:45,checked:45,processed:45,remaining:0,not_confirmed:0};s.branch_overview.branch_coverage={...s.branch_overview.branch_coverage,items_seen:45,display_target_count:45};
 const template=fs.readFileSync(path.join(__dirname,'../core/overview.fragment.html'),'utf8'),bundle=fs.readFileSync(path.join(__dirname,'../.agents/skills/github-work-inspector/references/review-selection.js'),'utf8'),model={captured_at:at,snapshot:s};
 const html=ctx.GitHubReviewOverview.buildFragment(template,bundle,model);assert.ok(Buffer.byteLength(html)<=262144);assert.ok(!html.includes('root.GitHubReviewReading ='));assert.ok(html.includes('not_a_reading_checkpoint'));
 const d=dom(),script=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));const viewContext={TextEncoder,document:{...doc,getElementById:()=>d.element}};vm.runInNewContext(script,viewContext);
 assert.equal(d.controls['overview-cards'].children.length,20);assert.ok(d.controls['overview-coverage'].textContent.includes('表示対象 45'));
 viewContext.GitHubReviewOverview.mount(d.element,JSON.parse(html.slice(html.lastIndexOf('const gwiModel = ')+17,html.lastIndexOf(';\nGitHubReviewOverview.mount'))),()=>undefined).select(s.branch_overview.items[0].branch_id);
 assert.ok(text(d.controls['overview-details']).includes('この図から省略'));assert.ok(desc(d.controls['history-graph']).some(n=>n.tag==='path'));assert.equal(s.branch_overview.items[0].understanding.files.length,200);
});

test('real connector decoded blob text stays source data and must match fixed tree byte size',()=>{
 const f=setup(['main']),body=source('old')+'\n// 日本語';f.data.get(TM).tree.find(e=>e.path==='worker.rs').size=Buffer.byteLength(body);
 for(const sha of [M,TM,README])f.x.reading.objects.push(R.receipt(R.request(repo,sha===M?'commit':sha===TM?'tree':'blob',sha),f.data.get(sha),at));
 const q=R.request(repo,'blob',OLD),response={structuredContent:{structuredContent:{content:body,display_url:q.args.url}}};
 const r=R.receipt(q,response,at);assert.equal(r.result.encoding,'utf-8');assert.equal(r.result.provider_decoded_text,true);f.x.reading.objects.push(r);
 assert.equal(snap(f.x).branch_overview.items[0].understanding.files.find(f=>f.path==='worker.rs').state,'acquired_not_understood');
 const shortened=plain(f.x);shortened.reading.objects.at(-1).result.content='prefix';shortened.reading.objects.at(-1).result.size=6;
 const u=snap(shortened).branch_overview.items[0].understanding.files.find(f=>f.path==='worker.rs');assert.equal(u.state,'unavailable');assert.equal(u.reason,'decoded_text_tree_size_mismatch');
 const missing=plain(f.x);delete missing.reading.objects.find(o=>o.sha===TM).result.tree.find(e=>e.path==='worker.rs').size;assert.equal(snap(missing).branch_overview.items[0].understanding.files.find(f=>f.path==='worker.rs').reason,'tree_blob_size_missing');
 const jsonSource=JSON.stringify({sha:OLD,encoding:'base64',content:'not an API response'});assert.equal(R.receipt(q,{content:jsonSource,display_url:q.args.url},at).result.content,jsonSource);
 assert.throws(()=>R.receipt(q,{content:body,display_url:'https://github.com/example/other'},at));
});
