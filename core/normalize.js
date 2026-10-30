/* Pure shared view normalization. No acquisition, shell, network, storage or AI calls. */
((root) => {
  'use strict';
  const contract = root.GitHubReviewCoreContract;
  const fail = () => { throw new Error('Invalid review observation'); };
  const repo = (v) => {
    if (typeof v !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(v) || ['.', '..'].includes(v.split('/')[1]) || v.split('/')[0].includes('--')) fail();
    return v.toLowerCase();
  };
  const sha = (v) => typeof v === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(v) ? v.toLowerCase() : fail();
  const time = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : fail();
  const optionalTime = (v) => { try { return time(v); } catch (_) { return null; } };
  const clean = (s, limit = 240) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\b(?:gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+)\b/ig, '[redacted]').replace(/\b(?:password|token|api_key)\s*[=:]\s*\S+/ig, '[redacted]').slice(0, limit) : '';
  const validPath = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.startsWith('/') && !v.includes('\\') && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v) && !/\b(?:gh[pousr]_|github_pat_|password\s*[=:]|api_key\s*[=:])/i.test(v) && !v.split('/').some((p) => !p || p === '.' || p === '..');
  const validRef = (v) => validPath(v) && !/[\s~^:?*\[\]]/.test(v) && !v.includes('..') && !v.endsWith('.') && !v.endsWith('.lock');
  const id = (ref) => validRef(ref) ? 'ref/' + encodeURIComponent(ref) : fail();
  const core = () => ({ contract_version: contract.contract_version, adapter: 'chat_github', capabilities: { ...contract.profiles.chat_github } });
  const sameRepo = (actual, expected) => actual == null || repo(actual) === expected;
  function normalizeChat(input) {
    const repository = repo(input.repository), captured = time(input.captured_at);
    const metadata = input.repository_metadata || {};
    if (metadata.repository_full_name && !sameRepo(metadata.repository_full_name, repository)) fail();
    const defaultBranch = validRef(metadata.default_branch) ? metadata.default_branch : null;
    if (!Array.isArray(input.branch_pages) || input.branch_pages.length > contract.limits.branch_pages) fail();
    const names = new Set(), cursors = new Set();
    let ended = false, repeated = false, branchError = null, pages = 0;
    for (const page of input.branch_pages) {
      if (ended) fail();
      pages += 1;
      if (page.error) { branchError = 'connector_branch_read_failed'; break; }
      if (!Array.isArray(page.branches) || page.branches.length > 100) fail();
      for (const row of page.branches) { if (!validRef(row.branch)) fail(); names.add(row.branch); }
      if (!Object.hasOwn(page, 'cursor')) fail();
      if (page.cursor === null) { ended = true; break; }
      if (typeof page.cursor !== 'string' || page.cursor.length > 1024) fail();
      if (cursors.has(page.cursor)) { repeated = true; break; }
      cursors.add(page.cursor);
      // A non-null cursor alone, even with an empty page, does not prove exhaustion.
    }
    const retained = Array.from(names).slice(0, contract.limits.branch_cards);
    if (defaultBranch && names.has(defaultBranch) && !retained.includes(defaultBranch)) retained[retained.length - 1] = defaultBranch;
    const complete = ended && names.size <= contract.limits.branch_cards && !branchError;
    const coverage = { requested_limit: contract.limits.branch_cards, max_pages: contract.limits.branch_pages, pages_fetched: pages, items_seen: names.size, items_skipped: 0, has_more: branchError ? null : !complete, fully_enumerated: complete, stopped_reason: branchError ? 'error' : complete ? 'end' : repeated ? 'repeated_cursor' : 'limit' };
    const tips = new Map();
    const resolutions = input.tip_resolutions || [];
    if (!Array.isArray(resolutions) || resolutions.length > contract.limits.tip_resolutions) fail();
    for (const observation of resolutions) {
      const ref = observation.ref, r = observation.result;
      if (!validRef(ref) || (!names.has(ref) && ref !== defaultBranch) || !r || !sameRepo(r.repository_full_name, repository)) fail();
      if (r.base !== ref || r.head !== ref || r.status !== 'identical' || r.total_commits !== 0 || !Array.isArray(r.files) || r.files.length !== 0) fail();
      tips.set(ref, { sha: sha(r.base_commit?.sha), captured_at: time(observation.captured_at) });
    }
    const rawCommits = input.recent_commits || [];
    if (!Array.isArray(rawCommits) || rawCommits.length > contract.limits.recent_commits) fail();
    const nodes = rawCommits.map((c) => {
      if (!sameRepo(c.repository_full_name, repository)) fail();
      return { sha: sha(c.sha), subject: clean(typeof c.message === 'string' ? c.message.split('\n')[0] : ''), committed_at: optionalTime(c.created_at), parents: null };
    });
    const rawPulls = input.pull_requests || [];
    if (!Array.isArray(rawPulls) || rawPulls.length > 20) fail();
    const pulls = rawPulls.map((p) => {
      if (!Number.isInteger(p.number) || p.number < 1) fail();
      return { number: p.number, title: clean(p.title), body_excerpt: typeof p.body === 'string' ? clean(p.body) : null, state: ['open','closed'].includes(p.state) ? p.state : 'unknown', merged: typeof p.merged === 'boolean' ? p.merged : null, merged_at: optionalTime(p.merged_at), base_branch: typeof p.base === 'string' ? clean(p.base) : null, head_branch: validRef(p.head) ? p.head : null, head_sha: p.head_sha == null ? null : sha(p.head_sha), head_repository: p.head_repo_full_name == null ? null : repo(p.head_repo_full_name), url: `https://github.com/${repository}/pull/${p.number}` };
    });
    const pullCoverage = { requested_limit: 20, pages_fetched: null, items_seen: pulls.length, fully_enumerated: false, has_more: null, stopped_reason: 'connector_search_sample_no_cursor' };
    const branches = retained.map((name) => ({ name, branch_id: id(name), sha: tips.get(name)?.sha ?? null, protected: null }));
    const items = branches.map((b) => ({ name: b.name, branch_id: b.branch_id, tip_sha: b.sha, tip_commit: nodes.find((c) => c.sha === b.sha) || null, history: null, comparison: { relation: b.name === defaultBranch && b.sha ? 'same_tip' : 'unavailable_parent_fields', child_to_parent_evidence_path: null, unmerged_changes: 'not_determined', ahead_behind: 'not_queried' }, related_pull_requests: pulls.filter((p) => p.head_repository === repository && p.head_branch === b.name).map((p) => ({ pull: p, association: 'same_repository_and_exact_head_ref', head_matches_tip: b.sha === null || p.head_sha === null ? null : b.sha === p.head_sha })) }));
    return { schema_version: 1, captured_at: captured, ok: !branchError, snapshot: { review_core: core(), repository: { name_with_owner: repository, url: `https://github.com/${repository}`, default_branch: defaultBranch }, atomic: false, partial: !!branchError, inferences: [], branches: { items: branches, coverage, error: branchError && { code: branchError }, captured_at: captured }, branch_overview: { items, baseline: { name: defaultBranch, branch_id: defaultBranch ? id(defaultBranch) : null, tip_sha: tips.get(defaultBranch)?.sha ?? null, observation: { source: defaultBranch ? 'connector_repository_metadata_and_optional_same_ref_compare' : 'default_branch_unavailable', captured_at: tips.get(defaultBranch)?.captured_at ?? captured, error: null } }, branch_coverage: coverage, branch_error: branchError && { code: branchError }, branches_captured_at: captured, pull_coverage: pullCoverage, pull_error: null, pulls_captured_at: captured, history_branch_count: 0, atomic: false, inferences: [] }, dag: { nodes, per_branch: [], outside_window_parents: [], edge_direction: 'child_to_parent', parent_fields_available: false, bounded: true, ordering: 'connector_search_order_not_topology' }, pull_requests: { items: pulls, coverage: pullCoverage, captured_at: captured, error: null } } };
  }
  function normalizeChatCommit(input) {
    const repository = repo(input.repository), reference = sha(input.sha), captured = time(input.captured_at);
    const c = input.response?.commit;
    if (!c || sha(c.sha) !== reference || !sameRepo(c.repository_full_name, repository) || !Array.isArray(c.files)) fail();
    const selected = input.selected_path ?? null;
    if (selected !== null && !validPath(selected)) fail();
    const candidates = c.files.filter((f) => validPath(f.filename));
    const chosen = selected === null ? null : candidates.find((f) => f.filename === selected);
    if (selected !== null && !chosen) fail();
    const files = (chosen ? [chosen] : candidates.slice(0, 20)).map((f) => ({ filename: f.filename, status: null, previous_filename: null, additions: null, deletions: null, file_id: null, index: null, selection: { kind: 'file', sha: reference, path: f.filename } }));
    let patch = null;
    if (chosen) {
      const raw = chosen.patch;
      const sensitive = /(?:^|\/)\.(?:env|ssh|aws)(?:[/.]|$)|\.(?:pem|key)$/i.test(selected) || (typeof raw === 'string' && /\b(?:gh[pousr]_|github_pat_|password\s*[=:]|api_key\s*[=:]|BEGIN [A-Z ]*PRIVATE KEY)/i.test(raw));
      const reason = sensitive ? 'sensitive_display_content' : typeof raw !== 'string' || !raw ? 'connector_patch_unavailable_binary_large_or_not_provided' : raw.length > 512 * 1024 ? 'display_scan_limit' : null;
      let text = null;
      if (!reason) {
        const safe = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
        const limited = safe.split('\n').slice(0, contract.limits.display_patch_lines).join('\n');
        const encoder = new TextEncoder(); let bytes = 0; text = '';
        for (const c of limited) { const n = encoder.encode(c).length; if (bytes + n > contract.limits.display_patch_bytes) break; text += c; bytes += n; }
      }
      patch = { text, omission_reason: reason, truncated: text !== null && text !== raw, api_completeness: 'not_guaranteed', binary: null, pre_model_redaction: false };
    }
    return { schema_version: 1, captured_at: captured, ok: true, commit_details: { review_core: core(), repository, mode: chosen ? 'patch' : 'files', commit: { sha: reference, url: `https://github.com/${repository}/commit/${reference}`, subject: clean(typeof c.message === 'string' ? c.message.split('\n')[0] : ''), parents: null, comparison: { kind: 'connector_commit_parent_unspecified', parent_sha: null, per_parent_comparison_performed: false } }, files, patch, coverage: { fully_enumerated: false, has_more: null, stopped_reason: 'connector_provider_not_bounded', provider_file_only_transfer: false }, source_transfer: 'Raw whole-commit payload may already have reached the host; filtering here limits display only.', inferences: [] } };
  }
  root.GitHubReviewCore = Object.freeze({ contract, normalizeChat, normalizeChatCommit, validPath, validRef });
})(globalThis);
