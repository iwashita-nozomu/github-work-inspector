/* Deterministic native SVG DAG. Only observed child->parent SHA edges; no acquisition. */
((root) => {
  'use strict';
  const bad=()=>{throw new Error('Invalid history graph');};
  const sha=v=>typeof v==='string'&&/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(v)?v.toLowerCase():bad();
  const clean=v=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,240):'';
  const fit=(value,budget=50)=>{let out='',used=0;for(const ch of clean(value)){const n=ch.codePointAt(0)>255?2:1;if(used+n>budget)return out+'…';out+=ch;used+=n;}return out;};
  function layout(dag, branches, selectedRef=null){
    if(!Array.isArray(dag?.nodes)||dag.nodes.length>4000||!Array.isArray(branches)||branches.length>1000)bad();
    const all=new Map(),refs=new Map();
    for(const b of branches){if(!root.GitHubReviewCore.validRef(b.name))bad();if(b.tip_sha){const h=sha(b.tip_sha);refs.set(h,[...(refs.get(h)||[]),b.name]);}}
    for(const labels of refs.values())labels.sort((a,b)=>root.GitHubReviewSurvey.order(a,b));
    for(const n of dag.nodes){const h=sha(n.sha);if(all.has(h))bad();if(n.parents!==null&&!Array.isArray(n.parents))bad();const parents=n.parents===null?null:n.parents.map(sha);if(parents&&(parents.length>256||new Set(parents).size!==parents.length||parents.includes(h)))bad();if(parents!==null||refs.has(h))all.set(h,{...n,sha:h,parents});}
    let chosen=all;
    if(selectedRef!==null){const b=branches.find(b=>b.name===selectedRef);if(!b)bad();const keep=new Set(),q=b.tip_sha?[b.tip_sha]:[];if(Array.isArray(b.history?.commit_shas)){for(const h of b.history.commit_shas)keep.add(h);}else for(let i=0;i<q.length;i++){const h=q[i];if(keep.has(h))continue;keep.add(h);for(const p of all.get(h)?.parents||[])q.push(p);}chosen=new Map([...all].filter(([h])=>keep.has(h)));}
    const children=new Map([...chosen.keys()].map(h=>[h,0]));for(const n of chosen.values())for(const p of n.parents||[])if(children.has(p))children.set(p,children.get(p)+1);
    const cmp=(a,b)=>root.GitHubReviewSurvey.order(a,b),ready=[...children].filter(([,n])=>n===0).map(([h])=>h).sort(cmp),ordered=[];
    while(ready.length){const h=ready.shift();ordered.push(chosen.get(h));for(const p of chosen.get(h).parents||[])if(children.has(p)){children.set(p,children.get(p)-1);if(children.get(p)===0){ready.push(p);ready.sort(cmp);}}}if(ordered.length!==chosen.size)bad();
    const shown=ordered.slice(0,128),shownSet=new Set(shown.map(n=>n.sha)),positions=new Map(),active=[],boundary=new Map();
    const boundaryReasons=new Map((dag.outside_window_parents||[]).map(b=>[typeof b==='string'?b:b.sha,typeof b==='string'?'outside_window':b.reason]));
    const slot=h=>{let n=active.indexOf(h);if(n>=0)return n;n=active.indexOf(null);if(n<0)n=active.length;active[n]=h;return n;};
    let maxLane=0;
    for(let i=0;i<shown.length;i++){
      const n=shown[i],lane=slot(n.sha);maxLane=Math.max(maxLane,lane);positions.set(n.sha,{x:24+lane*28,y:28+i*48,lane,row:i});
      const parents=n.parents||[];active[lane]=null;
      parents.forEach((p,j)=>{if(!active.includes(p)){if(j===0&&active[lane]===null)active[lane]=p;else slot(p);}maxLane=Math.max(maxLane,active.indexOf(p));if(!shownSet.has(p))boundary.set(p,boundaryReasons.get(p)||'display_window_limit');});
    }
    const applicable=selectedRef===null?branches:branches.filter(b=>b.name===selectedRef);
    for(const b of applicable)if(b.tip_sha&&!shownSet.has(b.tip_sha))boundary.set(b.tip_sha,boundaryReasons.get(b.tip_sha)||'tip_not_in_window');
    const boundaries=[...boundary].slice(0,root.GitHubReviewCore.contract.limits.history_boundary_display??24).map(([h,reason],i)=>{const lane=slot(h);maxLane=Math.max(maxLane,lane);const item={sha:h,reason,refs:refs.get(h)||[],x:24+lane*28,y:28+(shown.length+i)*48,lane};positions.set(h,item);return item;});
    const edges=[];for(const n of shown)for(const p of n.parents||[])if(positions.has(p))edges.push({child:n.sha,parent:p,boundary:!shownSet.has(p)});
    return {nodes:shown.map(n=>({...n,...positions.get(n.sha),refs:refs.get(n.sha)||[],merge:(n.parents?.length||0)>1})),edges,boundaries,omitted_nodes:ordered.length-shown.length,omitted_boundaries:boundary.size-boundaries.length,width:Math.max(360,(maxLane+1)*28+400),height:Math.max(100,(shown.length+boundaries.length)*48+30),label_x:(maxLane+1)*28+24,selected_ref:selectedRef};
  }
  function mount(element,dag,branches,options={}){
    const doc=element.ownerDocument;let selectedRef=null,selectedCommit=null,current;
    const svg=(tag,attrs={})=>{const n=doc.createElementNS?doc.createElementNS('http://www.w3.org/2000/svg',tag):doc.createElement(tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
    const text=(p,tag,value)=>{const n=doc.createElement(tag);n.textContent=clean(value);p.appendChild(n);return n;};
    element.replaceChildren();text(element,'h3','コミット履歴 · 分岐とmerge');
    const select=text(element,'select','');select.setAttribute('aria-label','履歴で表示する枝');let option=text(select,'option','全枝の観測履歴');option.value='';
    for(const b of branches){option=text(select,'option',b.name);option.value=b.name;}
    const status=text(element,'p',''),legend=text(element,'p','上の子 → 下の親。実親SHAだけを接続。点線は親SHA観測済み・親nodeは取得/表示範囲外。laneは配置、refは取得時tip。');legend.setAttribute('class','gwi-muted');
    const viewport=text(element,'div','');viewport.setAttribute('class','gwi-history-scroll');
    const groups=new Map();
    function paint(){
      current=layout(dag,branches,selectedRef);viewport.replaceChildren();groups.clear();
      const figure=svg('svg',{viewBox:`0 0 ${current.width} ${current.height}`,width:current.width,height:current.height,role:'img','aria-label':'観測したcommit親子関係とbranch tip'});viewport.appendChild(figure);
      const points=new Map([...current.nodes,...current.boundaries].map(n=>[n.sha,n]));
      for(const e of current.edges){const a=points.get(e.child),b=points.get(e.parent),path=svg('path',{d:`M ${a.x} ${a.y} C ${a.x} ${a.y+24}, ${b.x} ${b.y-24}, ${b.x} ${b.y}`,fill:'none',stroke:'var(--accent)','stroke-width':1.5,'data-child':e.child,'data-parent':e.parent});if(e.boundary)path.setAttribute('stroke-dasharray','4 3');figure.appendChild(path);}
      for(const n of [...current.nodes,...current.boundaries]){
        const boundary=!!n.reason,g=svg('g',{tabindex:0,role:'button','aria-label':n.sha+' '+(n.subject||n.reason||''),'aria-pressed':String(selectedCommit===n.sha),'data-commit-sha':n.sha});g.dataset.commitSha=n.sha;groups.set(n.sha,g);
        const title=svg('title');title.textContent=n.sha+' '+clean(n.subject||'')+' parents: '+(Array.isArray(n.parents)?n.parents.length+(n.parents_omitted_count?' + '+n.parents_omitted_count+' omitted':''):'unknown')+' · '+n.refs.slice(0,8).map(clean).join(' · ')+(n.refs.length>8?' · 他'+(n.refs.length-8)+' refs':'');g.appendChild(title);
        g.appendChild(svg('circle',{cx:n.x,cy:n.y,r:n.merge?6:4,fill:boundary?'var(--bg)':'var(--accent)',stroke:'var(--accent)','stroke-width':selectedCommit===n.sha?4:1.5}));
        const label=svg('text',{x:current.label_x,y:n.y+3,fill:'var(--text)','font-size':12});label.textContent=n.sha.slice(0,10)+' · '+fit(n.subject||('範囲外: '+n.reason),32);g.appendChild(label);
        const meta=svg('text',{x:current.label_x,y:n.y+18,fill:'var(--muted)','font-size':11});meta.textContent=fit((n.merge?'merge '+n.parents.length+(n.parents_omitted_count?'+'+n.parents_omitted_count+'省略':'')+' parents · ':!boundary&&n.parents===null?'親未取得 · ':!boundary&&n.parents?.length===0?'観測root · ':'')+(n.refs.length?'ref: '+n.refs.join(' · '):''));g.appendChild(meta);
        const choose=()=>{selectedCommit=n.sha;for(const[h,node]of groups)node.setAttribute('aria-pressed',String(h===n.sha));options.onCommit?.(n.sha);};g.addEventListener('click',choose);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault?.();choose();}});figure.appendChild(g);
      }
      const c=dag.history_coverage;
      status.textContent=`表示 ${current.nodes.length} commits / ${current.edges.length} 観測辺 · 境界 ${current.boundaries.length}（他${current.omitted_boundaries}） · 表示上限省略 ${current.omitted_nodes}`+(c?` · 取得 ${c.observed}/${c.limits.max_commits}, 深さ${c.limits.max_depth}, 未取得queue ${c.pending}, 失敗${c.failed}, 親リンク省略${c.parent_links_omitted||0} · 単一Git object取得（ページングなし、SHA queue再開）`:' · 既存アダプタの有限履歴')+(current.nodes.some(n=>Array.isArray(n.parents))?'':' · 親付き履歴データがなく、履歴図の取得は未達です。');
    }
    select.addEventListener('change',()=>{selectedRef=select.value||null;selectedCommit=null;paint();options.onRef?.(selectedRef);});paint();
    return Object.freeze({focus:(ref)=>{if(ref!==null&&!branches.some(b=>b.name===ref))bad();selectedRef=ref;select.value=ref||'';selectedCommit=null;paint();},select:(h)=>{h=sha(h);if(!groups.has(h))bad();selectedCommit=h;for(const[k,n]of groups)n.setAttribute('aria-pressed',String(k===h));options.onCommit?.(h);},state:()=>({selectedRef,selectedCommit,layout:current})});
  }
  root.GitHubReviewHistoryGraph=Object.freeze({layout,mount});
})(globalThis);
