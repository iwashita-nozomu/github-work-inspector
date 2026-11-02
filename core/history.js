/* Fixed GitHub Git-data GET acquisition and bounded ancestor queue. No network execution. */
((root) => {
  'use strict';
  const invalid = () => { throw new Error('Invalid history observation'); };
  const hash = (v) => typeof v === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(v) ? v.toLowerCase() : invalid();
  const repo = (v) => { if (typeof v !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(v) || (['.','..'].includes(v.split('/')[1])||v.split('/')[0].includes('--'))) invalid(); return v.toLowerCase(); };
  const clean = (v) => typeof v === 'string' ? v.slice(0,8192).split('\n')[0].replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\b(?:gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+|(?:password|token|api_key)\s*[=:]\s*\S+)/ig,'[redacted]').slice(0,240) : '';
  const date = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
  function limits(input = {}) {
    const out = { max_commits:input.max_commits??96,max_depth:input.max_depth??12,per_branch:input.per_branch??32 };
    if (!Number.isInteger(out.max_commits)||out.max_commits<1||out.max_commits>256||!Number.isInteger(out.max_depth)||out.max_depth<0||out.max_depth>64||!Number.isInteger(out.per_branch)||out.per_branch<1||out.per_branch>100) invalid();
    return out;
  }
  function request(repository, sha) { return { key:'history/'+hash(sha),method:'fetch',args:{url:'https://api.github.com/repos/'+repo(repository)+'/git/commits/'+hash(sha)} }; }
  function receipt(q, response, captured_at) {
    const expected = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/commits\/([a-f\d]{40}|[a-f\d]{64})$/i.exec(q?.args?.url||'');
    if (!expected || request(expected[1],expected[2]).args.url !== q.args.url || q.key !== 'history/'+expected[2] || !date(captured_at)) invalid();
    const d = response?.structuredContent?.structuredContent ?? response?.structuredContent ?? response;
    if (response?.isError || d?.error) return {sha:expected[2],captured_at,error:'history_read_failed'};
    const sourceURL=d?.url??d?.display_url??response?.structuredContent?.url??response?.url;
    if (sourceURL !== q.args.url || typeof d.content !== 'string' || d.content.length>1024*1024) invalid();
    let parsed; try { parsed=JSON.parse(d.content); } catch (_) { invalid(); }
    if (hash(parsed.sha)!==expected[2]) invalid();
    return {sha:expected[2],captured_at,result:{sha:hash(parsed.sha),message:clean(parsed.message),parents:Array.isArray(parsed.parents)?parsed.parents.map(p=>({sha:hash(p.sha)})):null,...(parsed.tree?{tree:{sha:hash(parsed.tree.sha)}}:{}),committer:{date:date(parsed.committer?.date)}}};
  }
  function decorate(snapshot, input) {
    const records=input.history_commits||[], L=limits(input.history_limits), observed=new Map(), failed=new Map();
    if (!Array.isArray(records)||records.length>L.max_commits) invalid();
    for (const r of records) {
      const sha=hash(r.sha); if(observed.has(sha)||failed.has(sha)||!date(r.captured_at)) invalid();
      if (r.error) {failed.set(sha,{sha,captured_at:r.captured_at,code:'history_read_failed'});continue;}
      const v=r.result;if(!v||hash(v.sha)!==sha) invalid();
      if (v.parents!=null && (!Array.isArray(v.parents)||v.parents.length>256)) invalid();
      const parents=Array.isArray(v.parents)?v.parents.slice(0,16).map(p=>hash(p.sha)):null;
      if (parents && (new Set(parents).size!==parents.length||parents.includes(sha))) invalid();
      observed.set(sha,{sha,subject:clean(v.message),committed_at:date(v.committer?.date),parents,parents_complete:Array.isArray(v.parents)&&v.parents.length<=16,parents_omitted_count:Array.isArray(v.parents)?Math.max(0,v.parents.length-16):null,parent_fields_observed:Array.isArray(v.parents),source:'github_git_data_commit',captured_at:r.captured_at,url:'https://github.com/'+snapshot.repository.name_with_owner+'/commit/'+sha});
    }
    // Reject inconsistent/cyclic input, never repair it by inventing graph order or edges.
    const visiting=new Set(),done=new Set();function visit(sha){if(visiting.has(sha))invalid();if(done.has(sha)||!observed.has(sha))return;visiting.add(sha);for(const p of observed.get(sha).parents||[])visit(p);visiting.delete(sha);done.add(sha);}for(const sha of observed.keys())visit(sha);
    const base=snapshot.branch_overview.baseline.name;
    const branches=[...snapshot.branch_overview.items].sort((a,b)=>a.name===base?(b.name===base?0:-1):b.name===base?1:root.GitHubReviewSurvey.order(a.name,b.name));
    const queue=[],queued=new Set(),depths=new Map();
    for(const b of branches)if(b.tip_sha&&!queued.has(b.tip_sha)){queued.add(b.tip_sha);depths.set(b.tip_sha,0);queue.push({sha:b.tip_sha,depth:0});}
    const depthBoundary=new Set();
    for(let i=0;i<queue.length;i++){
      const q=queue[i],n=observed.get(q.sha);if(!n)continue;
      for(const p of n.parents||[]){if(q.depth>=L.max_depth){if(!observed.has(p))depthBoundary.add(p);continue;}if(!queued.has(p)){queued.add(p);depths.set(p,q.depth+1);queue.push({sha:p,depth:q.depth+1});}}
    }
    // Disconnected observations are rejected: every Git object must be reached from an observed ref.
    if([...observed.keys(),...failed.keys()].some(sha=>!queued.has(sha)&&!depthBoundary.has(sha)))invalid();
    const pending=queue.filter(q=>!observed.has(q.sha)&&!failed.has(q.sha)),attempts=records.length;
    const boundaries=new Map();
    for(const n of observed.values())for(const p of n.parents||[])if(!observed.has(p))boundaries.set(p,{sha:p,reason:failed.has(p)?'read_failed':depthBoundary.has(p)?'depth_limit':attempts>=L.max_commits?'commit_limit':'not_fetched'});
    for(const b of branches)if(b.tip_sha&&!observed.has(b.tip_sha))boundaries.set(b.tip_sha,{sha:b.tip_sha,reason:failed.has(b.tip_sha)?'read_failed':attempts>=L.max_commits?'commit_limit':'tip_not_fetched'});
    const perBranch=[];
    for(const b of branches){
      const todo=b.tip_sha?[b.tip_sha]:[],seen=new Set(),members=[],outside=new Set();let unknown=false;
      for(let i=0;i<todo.length;i++){const sha=todo[i];if(seen.has(sha))continue;seen.add(sha);const n=observed.get(sha);if(!n||members.length>=L.per_branch){outside.add(sha);continue;}members.push(sha);if(n.parents===null||!n.parents_complete)unknown=true;for(const p of n.parents||[])todo.push(p);}
      const coverage={requested_limit:L.per_branch,items_seen:members.length,fully_enumerated:!!b.tip_sha&&outside.size===0&&!unknown,has_more:outside.size>0||unknown,stopped_reason:!b.tip_sha?'tip_unresolved':members.length===0?'history_unavailable':outside.size?'bounded_window':unknown?'parent_fields_missing':'observed_roots',pagination:'not_applicable_single_git_object_endpoint',captured_at:snapshot.branches.captured_at};
      b.history={commit_shas:members,coverage,error:b.tip_sha&&failed.has(b.tip_sha)?{code:'history_read_failed'}:null,outside_window_parents:[...outside]};
      b.tip_commit=observed.get(b.tip_sha)||b.tip_commit;
      perBranch.push({branch:b.name,branch_id:b.branch_id,tip_sha:b.tip_sha,commit_shas:members,coverage});
    }
    const recent=new Map(snapshot.dag.nodes.map(n=>[n.sha,n]));for(const [sha,n]of observed)recent.set(sha,n);
    snapshot.dag={...snapshot.dag,nodes:[...recent.values()],per_branch:perBranch,outside_window_parents:[...boundaries.values()],parent_fields_available:[...observed.values()].some(n=>n.parents!==null),bounded:true,ordering:'explicit_child_parent_edges_not_search_order',edge_direction:'child_to_parent',history_coverage:{limits:L,attempted:attempts,observed:observed.size,failed:failed.size,parent_links_omitted:[...observed.values()].reduce((n,v)=>n+(v.parents_omitted_count||0),0),pending:pending.length,tip_count:branches.filter(b=>b.tip_sha).length,observed_tip_count:branches.filter(b=>observed.has(b.tip_sha)).length,unresolved_refs:branches.filter(b=>!b.tip_sha).map(b=>b.name),bounded_finished:pending.length===0||attempts>=L.max_commits,fully_enumerated:pending.length===0&&boundaries.size===0&&failed.size===0&&[...observed.values()].every(n=>n.parents_complete)&&branches.every(b=>b.tip_sha!==null),pagination:'single Git commit objects; ancestor queue resumes by SHA; no list-page completeness claim',atomic:false},history_queue:pending,history_records:[...observed.keys(),...failed.keys()]};
    snapshot.branch_overview.history_branch_count=perBranch.filter(b=>b.commit_shas.length).length;
    return snapshot;
  }
  function plan(snapshot,options={}){
    const c=snapshot.dag.history_coverage;if(!c)invalid();const budget=options.request_budget??4;if(!Number.isInteger(budget)||budget<0||budget>10000)invalid();
    const refs=snapshot.branch_overview.items.map(b=>({ref:b.name,sha:b.tip_sha})).sort((a,b)=>root.GitHubReviewSurvey.order(a.ref,b.ref));
    const saved={version:1,repository:snapshot.repository.name_with_owner,captured_at:snapshot.branches.captured_at,limits:c.limits,pinned_refs:refs,observed_shas:[...snapshot.dag.history_records].sort(),pending_shas:snapshot.dag.history_queue.map(q=>q.sha),parent_observations:snapshot.dag.nodes.filter(n=>n.source==='github_git_data_commit').map(n=>({sha:n.sha,parents:n.parents,parents_complete:n.parents_complete,parents_omitted_count:n.parents_omitted_count})).sort((a,b)=>root.GitHubReviewSurvey.order(a.sha,b.sha)),requires_observations_snapshot:true};
    const old=options.checkpoint;
    if(old){if(old.version!==1||old.repository!==saved.repository||old.captured_at!==saved.captured_at||JSON.stringify(old.limits)!==JSON.stringify(saved.limits)||!Array.isArray(old.pinned_refs)||!Array.isArray(old.observed_shas)||old.pinned_refs.some(b=>b.sha!==null&&!refs.some(r=>r.ref===b.ref&&r.sha===b.sha))||old.observed_shas.some(sha=>!saved.observed_shas.includes(sha))||!Array.isArray(old.parent_observations)||old.parent_observations.some(n=>!saved.parent_observations.some(x=>x.sha===n.sha&&JSON.stringify(x.parents)===JSON.stringify(n.parents)&&x.parents_complete===n.parents_complete&&x.parents_omitted_count===n.parents_omitted_count)))invalid();}
    const requests=c.attempted>=c.limits.max_commits?[]:snapshot.dag.history_queue.slice(0,Math.min(4,budget,c.limits.max_commits-c.attempted)).map(q=>request(snapshot.repository.name_with_owner,q.sha));
    return {phase:budget===0&&!c.bounded_finished?'history_paused':c.bounded_finished?'history_window_finished':'read_history_ancestors',requests,tasks:[],checkpoint:saved,coverage:c,max_parallel:4};
  }
  // Default orchestration preserves the existing content traversal and adds observed history.
  function acquire(snapshot,options={}){
    const saved=options.checkpoint;
    if(saved && saved.version!==1)invalid();
    const legacy=saved&&!saved.content&&saved.repository?saved:null;
    if(saved&&!legacy&&!saved.content)invalid();
    const oldContent=legacy??saved?.content;
    // Preview receipts/history remain reusable; a v1 60-line checkpoint cannot attest whole-source reading.
    const contentOptions={...options,checkpoint:oldContent?.version===1?undefined:oldContent};delete contentOptions.in_flight_keys;
    const content=root.GitHubReviewReading.plan(snapshot,contentOptions),history=plan(snapshot,{request_budget:options.request_budget,checkpoint:options.checkpoint?.history});
    const out={...content,checkpoint:{version:1,content:content.checkpoint,history:history.checkpoint},workflow_complete:false,history_coverage:history.coverage};
    if(oldContent?.version===1)out.content_checkpoint_migration='v1_preview_does_not_satisfy_full_reading;metadata_and_history_retained';
    function result(){const running=options.in_flight_keys||[];if(!Array.isArray(running)||running.length>4||running.some(k=>!out.requests.some(q=>q.key===k)))invalid();out.in_flight_keys=running;out.requests=out.requests.filter(q=>!running.includes(q.key));if(running.length&&!out.requests.length&&!out.paused)out.phase='waiting_for_receipts';return out;}
    if(content.phase==='enumerate_all_pages'||content.paused)return result();
    const b=snapshot.branch_overview.items.find(b=>b.name===content.target_ref),known=new Set(snapshot.dag.history_records);
    if(b?.tip_sha&&!known.has(b.tip_sha)&&history.coverage.attempted<history.coverage.limits.max_commits){
      out.phase=options.request_budget===0?'history_paused':'read_branch_tip_history';out.paused=options.request_budget===0;out.tasks=[];out.requests=(options.request_budget===0)?[]:[request(snapshot.repository.name_with_owner,b.tip_sha)];return result();
    }
    if(content.progress.finished_known_targets){out.phase=history.phase;out.requests=history.requests;out.tasks=[];out.known_scope_finished=history.coverage.bounded_finished;out.history_renderable=snapshot.dag.nodes.some(n=>Array.isArray(n.parents));out.workflow_complete=content.progress.complete&&history.coverage.bounded_finished&&out.history_renderable;if(!out.history_renderable&&history.coverage.bounded_finished)out.phase='history_unavailable';}
    return result();
  }
  root.GitHubReviewHistory=Object.freeze({request,receipt,decorate,plan,limits});
  root.GitHubReviewAcquisition=Object.freeze({plan:acquire});
})(globalThis);
