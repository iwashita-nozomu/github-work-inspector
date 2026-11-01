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
    // File selection is revision/path based in the connector adapter; never invent Work file_id.
    if (adapter === 'chat_github') {
      const seen = new Set();
      for (const b of overview.items) for (const f of b.content_review?.evidence || []) if (f.state === 'read') {
        const key = f.sha + '/' + f.path;
        if (!seen.has(key)) { seen.add(key); if (targets.length < root.GitHubReviewCore.contract.limits.selection_targets) targets.push({ kind: 'file', sha: f.sha, path: f.path }); }
      }
    }
    const selection = root.GitHubReviewSelection.bind(element, { repository, captured_at: model.captured_at, source_adapter: adapter, targets }, getHost);
    const summaries = Array.isArray(model.summaries) ? model.summaries : [];
    if (summaries.length > root.GitHubReviewCore.contract.limits.branch_cards) throw new Error('Too many summaries');
    for (const b of overview.items) {
      const files = b.content_review?.evidence || [];
      if (!Array.isArray(files) || files.length > 2) throw new Error('Invalid content evidence');
      for (const f of files) if (f.sha !== b.tip_sha || !root.GitHubReviewSurvey.safePath(f.path) || !['read', 'empty', 'unavailable', 'omitted_sensitive'].includes(f.state) || f.id !== root.GitHubReviewSurvey.key(repository, f.sha, f.path) || (f.state === 'read' && (typeof f.excerpt !== 'string' || f.excerpt.length > 8192 || f.requested_end_line !== 60))) throw new Error('Invalid content evidence');
    }

    function summary(b, field = 'purpose') {
      const s = summaries.find((s) => s.branch_id === b.branch_id && s.tip_sha === b.tip_sha)?.[field];
      const evidence = new Set((b.content_review?.evidence || []).filter((f) => f.state === 'read').map((f) => f.id));
      if (s && ['inference', 'author_claim'].includes(s.kind) && typeof s.text === 'string' && s.text.length <= 480 && Array.isArray(s.evidence) && s.evidence.length && s.evidence.every((id) => evidence.has(id))) return clean(s.text) + (s.kind === 'inference' ? ' [GPT推定]' : ' [著者の説明]');
      if (field === 'difference') return '内容の違いは未確認（行数・枝名だけで意味を断定しません）';
      const file = (b.content_review?.evidence || []).find((f) => f.state === 'read');
      return file ? '内容取得済み・意味要約未生成。' + file.path + ': ' + clean(file.excerpt).split('\n').filter((s) => s.trim() && !s.startsWith('<!--')).slice(0, 2).join(' ').slice(0, 160) : '内容未確認（' + (b.content_review?.state || 'unread') + '）。枝名から目的を推測しません。';
    }
    const base = overview.baseline || {};
    query('overview-repository').textContent = repository + ' · ' + adapter + ' · 取得 ' + clean(model.captured_at);
    query('overview-baseline').textContent = '常時表示する既定基準: ' + (base.name || '不明') + ' · ' + (base.tip_sha || 'tip未取得');
    const bc = overview.branch_coverage || {}, cc = overview.content_coverage || {};
    const coverage = query('overview-coverage');
    let page = 0, selected = null;
    const pageSize = root.GitHubReviewCore.contract.limits.overview_page_size;
    function show(b) {
      selected = b.branch_id; details.hidden = false; details.replaceChildren();
      text(details, 'h3', b.name + ' · ' + (b.tip_sha || 'tip不明'));
      text(details, 'p', summary(b)); text(details, 'p', '他枝との違い: ' + summary(b, 'difference'));
      const review = b.content_review;
      text(details, 'p', '内容状態: ' + (review?.state || 'unread') + ' · READMEと代表1ファイルの限定読取り。全内容を監査した意味ではありません。');
      const cmp = review?.comparison;
      text(details, 'p', cmp ? '比較: ' + cmp.status + ' · ahead ' + cmp.ahead_by + ' / behind ' + cmp.behind_by + ' · 基準 ' + cmp.base_sha + ' → ' + cmp.head_sha + ' · 差分ファイル一覧の完全性は未保証' : '基準との比較未取得・取得不能');
      text(details, 'p', b.history ? '観測履歴: ' + (b.history.commit_shas || []).join(' · ') : '枝の履歴・親SHAは未取得。以下のfileはtipの内容でありcommit差分ではありません。');
      for (const f of review?.evidence || []) {
        const section = text(details, 'section', ''); text(section, 'h3', f.path + ' · ' + f.state);
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
        text(card, 'h3', (b.name === base.name ? '● 既定枝 · ' : '● ') + b.name);
        text(card, 'p', summary(b)); text(card, 'p', '他枝との違い: ' + summary(b, 'difference')); text(card, 'p', '内容: ' + (b.content_review?.state || 'unread') + ' · tip ' + (b.tip_sha?.slice(0, 12) || '未取得'));
        const cmp = b.content_review?.comparison;
        text(card, 'p', cmp ? '基準比較: ' + cmp.status + ' / +' + cmp.ahead_by + ' −' + cmp.behind_by : '基準比較: 未確認');
        const button = text(card, 'button', '内容・根拠を選択'); button.type = 'button'; button.setAttribute('aria-pressed', String(selected === b.branch_id)); button.addEventListener('click', () => show(b));
      }
      prev.disabled = page === 0; next.disabled = (page + 1) * pageSize >= items.length;
      pageLabel.textContent = 'ページ ' + (page + 1) + '/' + Math.max(1, Math.ceil(items.length / pageSize)) + ' · 検索結果 ' + items.length + '枝';
      coverage.textContent = '一覧取得 ' + (bc.items_seen ?? overview.items.length) + ' / 正規化 ' + overview.items.length + ' / 表示対象 ' + overview.items.length + '枝 · この頁 ' + visible.length + '枝 · 一覧終端 ' + (bc.fully_enumerated ? '確認' : '未確認 (' + bc.stopped_reason + ')') + ' · 内容根拠あり ' + (cc.with_file_evidence ?? 0) + '/' + overview.items.length + ' · 未読・失敗も全件表示。親情報なしからDAGは生成しません。';
    }
    search.addEventListener('input', () => { page = 0; paint(); }); prev.addEventListener('click', () => { page--; paint(); }); next.addEventListener('click', () => { page++; paint(); });
    paint();
    return Object.freeze({ select: (id) => { const b = overview.items.find((b) => b.branch_id === id); if (!b) throw new Error('Unknown branch'); show(b); }, selection, state: () => ({ page, matched: filtered().length, total: overview.items.length, selected }) });
  }
  function buildFragment(template, bundle, model) {
    if (typeof template !== 'string' || !template.includes('/*__REVIEW_BUNDLE__*/') || !template.includes('/*__REVIEW_MODEL__*/') || typeof bundle !== 'string' || /<\/script/i.test(bundle)) throw new Error('Invalid overview template');
    const json = JSON.stringify(model, (key, value) => key === 'excerpt' && typeof value === 'string' ? value.slice(0, 480) : value).replace(/[<>&\u2028\u2029]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    return template.replace('/*__REVIEW_MODEL__*/', () => json).replace('/*__REVIEW_BUNDLE__*/', () => bundle);
  }
  root.GitHubReviewOverview = Object.freeze({ mount, buildFragment });
})(globalThis);
