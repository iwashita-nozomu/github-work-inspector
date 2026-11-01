/* Concrete offline view. No fetch, storage, tool calls or implicit follow-up. */
((root) => {
  'use strict';
  function mount(element, model, getHost) {
    const snapshot = model.snapshot, overview = snapshot?.branch_overview;
    if (!overview || !Array.isArray(overview.items) || overview.items.length > root.GitHubReviewCore.contract.limits.branch_cards) throw new Error('Invalid overview model');
    const doc = element.ownerDocument, query = (name) => { const e = element.querySelector('[data-' + name + ']'); if (!e) throw new Error('Incomplete overview template'); return e; };
    const cards = query('overview-cards'), details = query('overview-details'), search = query('overview-search'), prev = query('overview-prev'), next = query('overview-next'), pageLabel = query('overview-page');
    const clean = (s) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 8192) : '';
    const text = (parent, tag, value) => { const n = doc.createElement(tag); n.textContent = clean(value); parent.appendChild(n); return n; };
    const repository = snapshot.repository.name_with_owner, adapter = snapshot.review_core?.adapter;
    const targets = overview.items.map((b) => ({ kind: 'branch', branch_ref: b.name, sha: b.tip_sha }));
    const commitShas = new Set(snapshot.dag.nodes.map(n=>n.sha));
    for(const b of overview.items) if(b.tip_sha) commitShas.add(b.tip_sha);
    for(const b of snapshot.dag.outside_window_parents||[]) commitShas.add(typeof b==='string'?b:b.sha);
    for(const sha of [...commitShas].slice(0,512)) if(targets.length < root.GitHubReviewCore.contract.limits.selection_targets) targets.push({kind:'commit',sha});
    const filesOf = (b) => [...(b.content_review?.evidence || []), ...(b.content_review?.delta?.evidence || [])].filter((f, i, a) => a.findIndex((other) => other.id === f.id) === i);
    // File selection is revision/path based in the connector adapter; never invent Work file_id.
    if (adapter === 'chat_github') {
      const seen = new Set();
      for (const b of overview.items) for (const f of filesOf(b)) if (f.state === 'read') {
        const key = f.sha + '/' + f.path;
        if (!seen.has(key)) { seen.add(key); if (targets.length < root.GitHubReviewCore.contract.limits.selection_targets) targets.push({ kind: 'file', sha: f.sha, path: f.path }); }
      }
    }
    const selection = root.GitHubReviewSelection.bind(element, { repository, captured_at: model.captured_at, source_adapter: adapter, targets }, getHost);
    const summaries = Array.isArray(model.summaries) ? model.summaries : [];
    if (summaries.length > root.GitHubReviewCore.contract.limits.branch_cards) throw new Error('Too many summaries');
    for (const b of overview.items) {
      const files = filesOf(b);
      if (!Array.isArray(files) || files.length > 3) throw new Error('Invalid content evidence');
      for (const f of files) if ((f.sha !== b.tip_sha && f.sha !== snapshot.branch_overview.baseline.tip_sha) || !root.GitHubReviewSurvey.safePath(f.path) || !['read', 'empty', 'unavailable', 'omitted_sensitive'].includes(f.state) || f.id !== root.GitHubReviewSurvey.key(repository, f.sha, f.path) || (f.state === 'read' && (typeof f.excerpt !== 'string' || f.excerpt.length > 8192 || f.requested_end_line !== 60))) throw new Error('Invalid content evidence');
    }

    function summary(b, field = 'purpose') {
      const s = summaries.find((s) => s.branch_id === b.branch_id && s.tip_sha === b.tip_sha)?.[field] ?? b.content_review?.summary?.[field];
      const evidence = new Set(filesOf(b).filter((f) => f.state === 'read').map((f) => f.id));
      if (s && ['inference', 'author_claim'].includes(s.kind) && typeof s.text === 'string' && s.text.length <= 480 && Array.isArray(s.evidence) && s.evidence.length && s.evidence.every((id) => evidence.has(id))) return clean(s.text) + (s.kind === 'inference' ? ' [GPT推定]' : ' [著者の説明]');
      if (field === 'difference') return '内容の違いは未確認（行数・枝名だけで意味を断定しません）';
      const file = (b.content_review?.evidence || []).find((f) => f.state === 'read');
      return file ? '内容取得済み・意味要約未生成。' + file.path + ': ' + clean(file.excerpt).split('\n').filter((s) => s.trim() && !s.startsWith('<!--')).slice(0, 2).join(' ').slice(0, 160) : '内容未確認（' + (b.content_review?.state || 'unread') + '）。枝名から目的を推測しません。';
    }
    const base = overview.baseline || {};
    query('overview-repository').textContent = repository + ' · ' + adapter + ' · 取得 ' + clean(model.captured_at);
    query('overview-baseline').textContent = '常時表示する既定基準: ' + (base.name || '不明') + ' · ' + (base.tip_sha || 'tip未取得');
    const bc = overview.branch_coverage || {}, cc = overview.content_coverage || {}, exploration = overview.exploration;
    const stateNames = {not_started:'未着手',in_progress:'進行中',checked:'確認済（限定範囲）',partial:'部分確認',unavailable:'取得不能'};
    const coverage = query('overview-coverage');
    let page = 0, selected = null;
    const pageSize = root.GitHubReviewCore.contract.limits.overview_page_size;
    const graphElement=element.querySelector('[data-history-graph]');
    if(!graphElement) throw new Error('Missing history graph template');
    const graph=root.GitHubReviewHistoryGraph.mount(graphElement,snapshot.dag,overview.items,{onRef:(ref)=>{if(ref)show(overview.items.find(b=>b.name===ref));else{selected=null;details.hidden=true;selection.clear();paint();}},onCommit:showCommit});
    function showCommit(sha){
      const target=selection.targets.find(t=>t.kind==='commit'&&t.sha===sha);
      details.hidden=false;details.replaceChildren();const node=snapshot.dag.nodes.find(n=>n.sha===sha);
      text(details,'h3','commit '+sha);text(details,'p',node?.subject||'commit内容は取得範囲外です。');
      text(details,'p',Array.isArray(node?.parents)?'観測parents: '+(node.parents.join(' · ')||'0（root）'):'親SHAは未取得です。');
      text(details,'p','ref tip: '+(overview.items.filter(b=>b.tip_sha===sha).map(b=>b.name).join(' · ')||'現在tipのラベルなし'));
      const link=text(details,'a','GitHubの完全SHA根拠');link.setAttribute('href','https://github.com/'+repository+'/commit/'+sha);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');
      text(details,'p','選択だけではdiffを取得しません。「詳しく聞く」で対象commitの根拠を追加確認します。');if(target)selection.select(target.id);else{selection.clear();text(details,'p','選択参照の上限に達したため、このcommitの質問送信は無効です。上記の完全SHAを手動で指定してください。');}
    }
    function show(b) {
      graph.focus(b.name);
      selected = b.branch_id; details.hidden = false; details.replaceChildren();
      text(details, 'h3', b.name + ' · ' + (b.tip_sha || 'tip不明'));
      text(details, 'p', summary(b)); text(details, 'p', '他枝との違い: ' + summary(b, 'difference'));
      const review = b.content_review;
      text(details, 'p', '内容状態: ' + (review?.state || 'unread') + ' · READMEと代表1ファイルの限定読取り。全内容を監査した意味ではありません。');
      const cmp = review?.comparison;
      text(details, 'p', cmp ? '比較: ' + cmp.status + ' · ahead ' + cmp.ahead_by + ' / behind ' + cmp.behind_by + ' · 基準 ' + cmp.base_sha + ' → ' + cmp.head_sha + ' · 差分ファイル一覧の完全性は未保証' : '基準との比較未取得・取得不能');
      text(details, 'p', b.history ? '観測履歴: ' + (b.history.commit_shas || []).join(' · ') : '枝の履歴・親SHAは未取得。以下のfileはtipの内容でありcommit差分ではありません。');
      for (const f of filesOf(b)) {
        const section = text(details, 'section', ''); text(section, 'h3', f.path + (f.sha !== b.tip_sha ? '（基準SHA側）' : '') + ' · ' + f.state);
        if (f.state !== 'read') { text(section, 'p', f.reason || '取得不能'); continue; }
        const link = text(section, 'a', f.sha + ' · L1–' + f.requested_end_line);
        // Derive links from validated selection data; never trust a supplied external URL.
        link.setAttribute('href', 'https://github.com/' + repository + '/blob/' + f.sha + '/' + f.path.split('/').map(encodeURIComponent).join('/') + '#L1-L' + f.requested_end_line); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
        text(section, 'pre', f.excerpt); text(section, 'p', '表示は短い抜粋。詳しい内容・実差分は参照付き質問で確認。');
        const target = selection.targets.find((t) => t.kind === 'file' && t.sha === f.sha && t.path === f.path);
        if (target) { const button = text(section, 'button', 'このファイルを選択'); button.type = 'button'; button.addEventListener('click', () => selection.select(target.id)); }
      }
      const target = selection.targets.find((t) => t.kind === 'branch' && t.branch_ref === b.name);
      selection.select(target.id);
      paint();
    }
    function filtered() { const term = clean(search.value || '').toLowerCase(); return overview.items.filter((b) => [b.name, summary(b), ...(b.content_review?.evidence || []).map((f) => f.path)].join('\n').toLowerCase().includes(term)); }
    function paint() {
      const items = filtered(); page = Math.max(0, Math.min(page, Math.ceil(items.length / pageSize) - 1));
      const visible = items.slice(page * pageSize, (page + 1) * pageSize);
      cards.replaceChildren();
      for (const b of visible) {
        const card = text(cards, 'article', ''); card.dataset.branchId = b.branch_id; card.dataset.default = String(b.name === base.name);
        const step = exploration?.rows.find((r) => r.ref === b.name);
        if (step) text(card, 'p', '探索 ' + (step.index + 1) + ' · ' + stateNames[step.state] + ' · ' + step.stage);
        text(card, 'h3', (b.name === base.name ? '● 既定枝 · ' : '● ') + b.name);
        text(card, 'p', summary(b)); text(card, 'p', '他枝との違い: ' + summary(b, 'difference')); text(card, 'p', '内容: ' + (b.content_review?.state || 'unread') + ' · tip ' + (b.tip_sha?.slice(0, 12) || '未取得'));
        const cmp = b.content_review?.comparison;
        text(card, 'p', cmp ? '基準比較: ' + cmp.status + ' / +' + cmp.ahead_by + ' −' + cmp.behind_by : '基準比較: 未確認');
        const button = text(card, 'button', '内容・根拠を選択'); button.type = 'button'; button.setAttribute('aria-pressed', String(selected === b.branch_id)); button.addEventListener('click', () => show(b));
      }
      prev.disabled = page === 0; next.disabled = (page + 1) * pageSize >= items.length;
      pageLabel.textContent = 'ページ ' + (page + 1) + '/' + Math.max(1, Math.ceil(items.length / pageSize)) + ' · 検索結果 ' + items.length + '枝';
      coverage.textContent = '一覧取得 ' + (bc.items_seen ?? overview.items.length) + ' / 正規化 ' + overview.items.length + ' / 表示対象 ' + overview.items.length + '枝 · この頁 ' + visible.length + '枝 · 一覧終端 ' + (bc.fully_enumerated ? '確認' : '未確認 (' + bc.stopped_reason + ')') + ' · 内容根拠あり ' + (cc.with_file_evidence ?? 0) + '/' + overview.items.length + ' · 未読・失敗も全件表示。親情報なしからDAGは生成しません。';
      if (exploration) coverage.textContent += ' · 処理済 ' + exploration.counts.processed + ' / 残り ' + exploration.counts.remaining + ' / 未確認 ' + exploration.counts.not_confirmed + ' · 次 ' + (exploration.resume_ref || '取得済み対象の巡回終了') + ' · 全枝確認 ' + (exploration.all_checked ? '限定範囲で確認' : '未完了/部分確認あり');
    }
    search.addEventListener('input', () => { page = 0; paint(); }); prev.addEventListener('click', () => { page--; paint(); }); next.addEventListener('click', () => { page++; paint(); });
    paint();
    return Object.freeze({ graph, select: (id) => { const b = overview.items.find((b) => b.branch_id === id); if (!b) throw new Error('Unknown branch'); show(b); }, selection, state: () => ({ page, matched: filtered().length, total: overview.items.length, selected }) });
  }
  function buildFragment(template, bundle, model) {
    if (typeof template !== 'string' || !template.includes('/*__REVIEW_BUNDLE__*/') || !template.includes('/*__REVIEW_MODEL__*/') || typeof bundle !== 'string' || /<\/script/i.test(bundle)) throw new Error('Invalid overview template');
    const json = JSON.stringify(model, (key, value) => key === 'excerpt' && typeof value === 'string' ? value.slice(0, 480) : value).replace(/[<>&\u2028\u2029]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    return template.replace('/*__REVIEW_MODEL__*/', () => json).replace('/*__REVIEW_BUNDLE__*/', () => bundle);
  }
  root.GitHubReviewOverview = Object.freeze({ mount, buildFragment });
})(globalThis);
