/* Bounded, deterministic survey planning/receipt validation. Host executes only returned reads. */
((root) => {
  'use strict';
  const C = root.GitHubReviewCore, L = C.contract.limits;
  const invalid = () => { throw new Error('Invalid branch survey'); };
  const full = (v) => typeof v === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(v);
  const safePath = (p) => C.validPath(p) && !/(?:^|\/)(?:\.[^/]+|data|vendor|third-party|node_modules|target|secrets?|credentials?)(?:\/|$)|(?:secret|credential|password|token)|\.(?:key|pem|p12|pfx|onnx|csv|nc|zip|gz)$/i.test(p) && /(?:\.(?:md|rst|txt|toml|json|ya?ml|py|rs|cpp|cc|c|hpp|h|cmake)|(?:^|\/)CMakeLists\.txt)$/i.test(p);
  const clean = (s) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '') : '';
  function key(repository, sha, path, start = 1, end = L.content_lines) {
    if (!full(sha) || !safePath(path) || start !== 1 || end !== L.content_lines) invalid();
    return repository + '@' + sha.toLowerCase() + '/' + path + '#L' + start + '-L' + end;
  }
  // A comparison supplies candidate paths, never a parent edge or executable instruction.
  function paths(comparison) {
    const files = Array.isArray(comparison?.files) ? comparison.files : [];
    const candidates = files.filter((f) => f.status !== 'removed' && safePath(f.filename) && !/^readme(?:\.|$)/i.test(f.filename));
    candidates.sort((a, b) => {
      const rank = (p) => /\.(?:rs|py|cpp|hpp|c|h|cc)$/i.test(p) ? 0 : /(?:config|CMakeLists|\.toml|\.cmake|\.ya?ml|\.json)/i.test(p) ? 1 : 2;
      return rank(a.filename) - rank(b.filename) || a.filename.localeCompare(b.filename);
    });
    return ['README.md', candidates[0]?.filename || 'CMakeLists.txt'];
  }
  function decorate(snapshot, input) {
    const repository = snapshot.repository.name_with_owner, base = snapshot.branch_overview.baseline.tip_sha;
    const reads = input.branch_reads || [], byRef = new Map(), cache = new Map();
    if (!Array.isArray(reads) || reads.length > L.branch_cards) invalid();
    for (const r of reads) {
      if (!C.validRef(r.ref) || byRef.has(r.ref) || !snapshot.branches.items.some((b) => b.name === r.ref && b.sha === r.sha) || !full(r.sha)) invalid();
      if (!Array.isArray(r.files) || r.files.length > L.content_files || typeof r.captured_at !== 'string' || !Number.isFinite(Date.parse(r.captured_at))) invalid();
      byRef.set(r.ref, r);
      for (const f of r.files) {
        const k = key(repository, r.sha, f.path, f.start_line, f.end_line);
        if (typeof f.captured_at !== 'string' || !Number.isFinite(Date.parse(f.captured_at))) invalid();
        if (f.error) { cache.set(k, { id: k, path: f.path, sha: r.sha, captured_at: f.captured_at, state: 'unavailable', reason: 'file_read_failed', excerpt: null }); continue; }
        if (typeof f.content !== 'string' || f.content.length > 128 * 1024) invalid();
        const sensitive = /\b(?:gh[pousr]_|github_pat_|password\s*[=:]|api_key\s*[=:])/i.test(f.content) || f.content.includes('PRIVATE KEY');
        let excerpt = sensitive ? null : clean(f.content).split('\n').slice(0, L.content_lines).join('\n');
        if (excerpt !== null) { let n = 0, out = ''; for (const ch of excerpt) { n += new TextEncoder().encode(ch).length; if (n > L.content_bytes) break; out += ch; } excerpt = out; }
        const receipt = { id: k, path: f.path, sha: r.sha.toLowerCase(), start_line: 1, requested_end_line: L.content_lines, captured_at: f.captured_at, state: sensitive ? 'omitted_sensitive' : excerpt.trim() ? 'read' : 'empty', reason: sensitive ? 'sensitive_display_content' : null, excerpt, truncated: !sensitive && excerpt !== f.content, url: 'https://github.com/' + repository + '/blob/' + r.sha.toLowerCase() + '/' + f.path.split('/').map(encodeURIComponent).join('/') + '#L1-L' + L.content_lines, pre_model_redaction: false };
        const previous = cache.get(k);
        if (previous?.state === 'read' && receipt.state === 'read' && previous.excerpt !== receipt.excerpt) invalid();
        cache.set(k, receipt);
      }
    }
    let readCount = 0, attempted = 0, unresolved = 0;
    for (const item of snapshot.branch_overview.items) {
      const r = byRef.get(item.name), cmp = r?.comparison;
      if (!item.tip_sha) unresolved++;
      let comparison = null;
      if (cmp) {
        if (!base || cmp.base !== base || cmp.head !== item.tip_sha || cmp.repository_full_name?.toLowerCase() !== repository || !['identical', 'ahead', 'behind', 'diverged'].includes(cmp.status) || !Array.isArray(cmp.files) || cmp.files.length > 3000 || !Number.isInteger(cmp.ahead_by) || !Number.isInteger(cmp.behind_by) || cmp.ahead_by < 0 || cmp.behind_by < 0) invalid();
        comparison = { base_sha: base, head_sha: item.tip_sha, status: cmp.status, ahead_by: cmp.ahead_by, behind_by: cmp.behind_by, files_observed: cmp.files.length, files_complete: false, captured_at: r.captured_at, source: 'connector_compare_full_shas', parent_edges: false };
      }
      const expected = paths(cmp), evidence = item.tip_sha ? expected.map((p) => cache.get(key(repository, item.tip_sha, p))).filter(Boolean) : [];
      const successful = evidence.filter((f) => f.state === 'read');
      if (r || evidence.length) attempted++;
      if (successful.length) readCount++;
      item.content_review = { tip_error: (input.tip_resolutions || []).some((t) => t.ref === item.name && t.error) ? 'tip_resolution_failed' : null, state: !item.tip_sha ? 'unresolved' : successful.length === L.content_files && comparison ? 'inspected' : successful.length ? 'partial' : evidence.length || r ? 'unavailable' : 'unread', evidence, comparison, comparison_error: r?.comparison_error ? 'comparison_unavailable' : null, expected_paths: expected, scope: 'bounded_readme_and_one_representative_file_not_full_branch_audit', reused_revision: !r && evidence.length > 0, missing_reason: !item.tip_sha ? 'tip_not_resolved' : successful.length < L.content_files ? 'missing_or_unread_content' : !comparison ? 'comparison_not_observed' : null };
      if (comparison) item.comparison = { ...item.comparison, observed_compare: comparison, ahead_behind: 'observed_full_sha_comparison', unmerged_changes: comparison.ahead_by > 0 ? 'ahead_commits_observed_not_completion' : 'no_ahead_commits_at_observed_tips' };
    }
    snapshot.branch_overview.content_coverage = { target_branches: snapshot.branch_overview.items.length, attempted, with_file_evidence: readCount, inspected: snapshot.branch_overview.items.filter((b) => b.content_review.state === 'inspected').length, unresolved, unique_file_reads: cache.size, complete: snapshot.branch_overview.items.every((b) => b.content_review.state === 'inspected'), scope: 'bounded_content_evidence_only', pre_model_redaction: false };
    return snapshot;
  }
  function plan(snapshot) {
    const repository = snapshot.repository.name_with_owner, baseline = snapshot.branch_overview.baseline.tip_sha;
    const requests = [], seen = new Set();
    const add = (key, method, args) => { if (!seen.has(key)) { seen.add(key); requests.push({ key, method, args }); } };
    for (const b of snapshot.branch_overview.items) if (!b.tip_sha && !b.content_review?.tip_error) add('tip/' + b.branch_id, 'compare_commits', { repo_full_name: repository, base: b.name, head: b.name });
    if (requests.length) return { phase: 'resolve_all_tips', requests, max_parallel: 4 };
    for (const b of snapshot.branch_overview.items) {
      if (!b.tip_sha) continue;
      if (baseline && !b.content_review?.comparison && !b.content_review?.comparison_error) add('compare/' + baseline + '/' + b.tip_sha, 'compare_commits', { repo_full_name: repository, base: baseline, head: b.tip_sha });
      // Wait for comparisons before choosing representative paths. Same-SHA content reads deduplicate.
      if (!b.tip_sha || (baseline && !b.content_review?.comparison && !b.content_review?.comparison_error)) continue;
      const evidence = b.content_review?.evidence || [];
      for (const path of b.content_review.expected_paths) if (!evidence.some((f) => f.path === path)) {
        const k = key(repository, b.tip_sha, path);
        add(k, 'fetch_file', { repository_full_name: repository, ref: b.tip_sha, path, start_line: 1, end_line: L.content_lines });
      }
    }
    return { phase: requests.length ? 'inspect_all_branch_contents' : 'finished_or_explicit_failures', requests, max_parallel: 4 };
  }
  root.GitHubReviewSurvey = Object.freeze({ decorate, plan, paths, safePath, key });
})(globalThis);
