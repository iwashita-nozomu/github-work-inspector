/* Pure receipt validation/cache. Acquisition and interpretation remain host responsibilities. */
((root) => {
  'use strict';
  const C = root.GitHubReviewCore, L = C.contract.limits;
  const invalid = () => { throw new Error('Invalid branch survey'); };
  const full = (v) => typeof v === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(v);
  const safePath = (p) => C.validPath(p) && !/(?:^|\/)(?:\.[^/]+|data|vendor|third-party|node_modules|target|secrets?|credentials?)(?:\/|$)|(?:secret|credential|password|token)|\.(?:key|pem|p12|pfx|onnx|csv|nc|zip|gz)$/i.test(p) && /(?:\.(?:md|rst|txt|toml|json|ya?ml|py|rs|cpp|cc|c|hpp|h|cmake)|(?:^|\/)CMakeLists\.txt)$/i.test(p);
  const clean = (s) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '') : '';
  const order = (a, b) => a < b ? -1 : a > b ? 1 : 0; // Locale-independent exact ref/path order.
  function key(repository, sha, path, start = 1, end = L.content_lines) {
    if (!full(sha) || !safePath(path) || start !== 1 || end !== L.content_lines) invalid();
    return repository + '@' + sha.toLowerCase() + '/' + path + '#L' + start + '-L' + end;
  }
  function representative(comparison) {
    const files = Array.isArray(comparison?.files) ? comparison.files : [];
    const candidates = files.filter((f) => f.status !== 'removed' && safePath(f.filename));
    const rank = (p) => /\.(?:rs|py|cpp|hpp|c|h|cc)$/i.test(p) ? 0 : /(?:config|CMakeLists|\.toml|\.cmake|\.ya?ml|\.json)/i.test(p) ? 1 : /^readme(?:\.|$)/i.test(p) ? 3 : 2;
    candidates.sort((a, b) => rank(a.filename) - rank(b.filename) || order(a.filename, b.filename));
    return candidates[0]?.filename || null;
  }
  function paths(comparison) {
    const selected = representative(comparison);
    return ['README.md', selected && selected !== 'README.md' ? selected : 'CMakeLists.txt'];
  }
  function decorate(snapshot, input) {
    const repository = snapshot.repository.name_with_owner, base = snapshot.branch_overview.baseline.tip_sha;
    const reads = input.branch_reads || [], byRef = new Map(), cache = new Map(), comparisons = new Map();
    if (!Array.isArray(reads) || reads.length > L.branch_cards) invalid();
    function put(f, sha) {
      const k = key(repository, sha, f.path, f.start_line, f.end_line);
      if (typeof f.captured_at !== 'string' || !Number.isFinite(Date.parse(f.captured_at))) invalid();
      if (f.error) {
        if (!cache.has(k)) cache.set(k, { id: k, path: f.path, sha, captured_at: f.captured_at, state: 'unavailable', reason: 'file_read_failed', excerpt: null });
        return;
      }
      if (typeof f.content !== 'string' || f.content.length > 128 * 1024) invalid();
      const sensitive = /\b(?:gh[pousr]_|github_pat_|password\s*[=:]|api_key\s*[=:])/i.test(f.content) || f.content.includes('PRIVATE KEY');
      let excerpt = sensitive ? null : clean(f.content).split('\n').slice(0, L.content_lines).join('\n');
      if (excerpt !== null) { let n = 0, out = ''; for (const ch of excerpt) { n += new TextEncoder().encode(ch).length; if (n > L.content_bytes) break; out += ch; } excerpt = out; }
      const receipt = { id: k, path: f.path, sha: sha.toLowerCase(), start_line: 1, requested_end_line: L.content_lines, captured_at: f.captured_at, state: sensitive ? 'omitted_sensitive' : excerpt.trim() ? 'read' : 'empty', reason: sensitive ? 'sensitive_display_content' : null, excerpt, truncated: !sensitive && excerpt !== f.content, url: 'https://github.com/' + repository + '/blob/' + sha.toLowerCase() + '/' + f.path.split('/').map(encodeURIComponent).join('/') + '#L1-L' + L.content_lines, pre_model_redaction: false };
      const previous = cache.get(k);
      if (previous?.state === 'read' && receipt.state === 'read' && previous.excerpt !== receipt.excerpt) invalid();
      cache.set(k, receipt);
    }
    for (const r of reads) {
      if (!C.validRef(r.ref) || byRef.has(r.ref) || !snapshot.branches.items.some((b) => b.name === r.ref && b.sha === r.sha) || !full(r.sha)) invalid();
      if (!Array.isArray(r.files) || r.files.length > L.content_files || typeof r.captured_at !== 'string' || !Number.isFinite(Date.parse(r.captured_at))) invalid();
      byRef.set(r.ref, r);
      for (const f of r.files) put(f, r.sha);
      const baselineFiles = r.baseline_files || [];
      if (!Array.isArray(baselineFiles) || baselineFiles.length > 1) invalid();
      for (const f of baselineFiles) { if (!base || f.sha !== base) invalid(); put(f, base); }
      const cmp = r.comparison;
      if (cmp) {
        if (!base || cmp.base !== base || cmp.head !== r.sha || cmp.repository_full_name?.toLowerCase() !== repository || !['identical', 'ahead', 'behind', 'diverged'].includes(cmp.status) || !Array.isArray(cmp.files) || cmp.files.length > 3000 || !Number.isInteger(cmp.ahead_by) || !Number.isInteger(cmp.behind_by) || cmp.ahead_by < 0 || cmp.behind_by < 0 || (cmp.base === cmp.head && cmp.status !== 'identical') || (cmp.status === 'identical' && (cmp.base !== cmp.head || cmp.ahead_by !== 0 || cmp.behind_by !== 0 || cmp.files.length !== 0))) invalid();
        const previous = comparisons.get(r.sha);
        if (previous && (previous.result.status !== cmp.status || previous.result.ahead_by !== cmp.ahead_by || previous.result.behind_by !== cmp.behind_by)) invalid();
        if (!previous) comparisons.set(r.sha, { result: { ...cmp, files: [...cmp.files].sort((a, b) => order(a.filename, b.filename)) }, captured_at: r.captured_at });
        else {
          const files = new Map(previous.result.files.map((f) => [f.filename, f]));
          for (const f of cmp.files) { if (files.has(f.filename) && files.get(f.filename).status !== f.status) invalid(); files.set(f.filename, f); }
          if (files.size > 3000) invalid();
          previous.result.files = [...files.values()].sort((a, b) => order(a.filename, b.filename));
          if (Date.parse(r.captured_at) < Date.parse(previous.captured_at)) previous.captured_at = r.captured_at;
        }
      }
    }
    const summaries = input.branch_summaries || [];
    if (!Array.isArray(summaries) || summaries.length > L.branch_cards) invalid();
    const summaryByRef = new Map();
    for (const s of summaries) {
      if (summaryByRef.has(s.ref) || !snapshot.branches.items.some((b) => b.name === s.ref && b.sha === s.sha) || !['recorded', 'insufficient'].includes(s.status)) invalid();
      summaryByRef.set(s.ref, s);
    }
    let readCount = 0, attempted = 0, unresolved = 0;
    for (const item of snapshot.branch_overview.items) {
      const r = byRef.get(item.name), observed = comparisons.get(item.tip_sha), cmp = observed?.result;
      if (!item.tip_sha) unresolved++;
      const comparison = cmp ? { base_sha: base, head_sha: item.tip_sha, status: cmp.status, ahead_by: cmp.ahead_by, behind_by: cmp.behind_by, files_observed: cmp.files.length, files_complete: false, captured_at: observed.captured_at, source: 'connector_compare_full_shas', parent_edges: false } : null;
      const expected = paths(cmp), evidence = item.tip_sha ? expected.map((p) => cache.get(key(repository, item.tip_sha, p))).filter(Boolean) : [];
      const selected = representative(cmp), branchFile = selected && item.tip_sha ? cache.get(key(repository, item.tip_sha, selected)) : null;
      const baseFile = selected && base ? cache.get(key(repository, base, selected)) : null;
      const deltaEvidence = [branchFile, baseFile].filter((f, i, a) => f && a.findIndex((x) => x?.id === f.id) === i);
      const deltaState = cmp?.status === 'identical' ? 'identical_tips_observed' : branchFile?.state === 'read' && baseFile?.state === 'read' ? 'bounded_file_pair_observed' : cmp ? 'branch_difference_not_read' : 'comparison_unavailable';
      const successful = evidence.filter((f) => f.state === 'read');
      const summary = summaryByRef.get(item.name);
      const allowed = new Set([...evidence, ...deltaEvidence].filter((f) => f.state === 'read').map((f) => f.id));
      const validPart = (s) => s && typeof s.text === 'string' && s.text.trim().length > 0 && s.text.length <= 480 && !/\b(?:gh[pousr]_|github_pat_|password\s*[=:]|api_key\s*[=:])|PRIVATE KEY/i.test(s.text) && ['inference', 'author_claim'].includes(s.kind) && Array.isArray(s.evidence) && s.evidence.length > 0 && s.evidence.length <= 6 && s.evidence.every((id) => allowed.has(id));
      const deltaReady = ['identical_tips_observed', 'bounded_file_pair_observed'].includes(deltaState);
      const deltaIds = deltaEvidence.filter((f) => f.state === 'read').map((f) => f.id);
      const summaryValid = summary?.status === 'recorded' && validPart(summary.purpose) && validPart(summary.difference) && deltaReady && (cmp.status === 'identical' || deltaIds.every((id) => summary.difference.evidence.includes(id)));
      if (summary?.status === 'recorded' && !summaryValid) invalid();
      if (r || evidence.length) attempted++;
      if (successful.length) readCount++;
      item.content_review = {
        tip_error: (input.tip_resolutions || []).some((t) => t.ref === item.name && t.error) ? 'tip_resolution_failed' : null,
        state: !item.tip_sha ? 'unresolved' : successful.length === L.content_files && comparison && ['identical_tips_observed', 'bounded_file_pair_observed'].includes(deltaState) ? 'inspected' : successful.length ? 'partial' : evidence.length || r ? 'unavailable' : 'unread',
        evidence, comparison, comparison_error: !cmp && r?.comparison_error ? 'comparison_unavailable' : null, expected_paths: expected,
        delta: { state: deltaState, representative_path: selected, baseline_sha: base, evidence: deltaEvidence, scope: 'same_path_two_tip_line_window_not_commit_patch_or_full_diff' },
        summary: { status: summaryValid ? 'recorded' : summary?.status === 'insufficient' ? 'insufficient' : 'pending', purpose: summaryValid ? { ...summary.purpose, text: clean(summary.purpose.text) } : null, difference: summaryValid ? { ...summary.difference, text: clean(summary.difference.text) } : null },
        scope: 'bounded_readme_and_one_representative_file_not_full_branch_audit', reused_revision: !r && evidence.length > 0,
        missing_reason: !item.tip_sha ? 'tip_not_resolved' : successful.length < L.content_files ? 'missing_or_unread_content' : !comparison ? 'comparison_not_observed' : deltaState === 'branch_difference_not_read' ? 'baseline_file_pair_not_read' : null,
      };
      if (comparison) item.comparison = { ...item.comparison, observed_compare: comparison, ahead_behind: 'observed_full_sha_comparison', unmerged_changes: comparison.ahead_by > 0 ? 'ahead_commits_observed_not_completion' : 'no_ahead_commits_at_observed_tips' };
    }
    snapshot.branch_overview.content_coverage = { target_branches: snapshot.branch_overview.items.length, attempted, with_file_evidence: readCount, inspected: snapshot.branch_overview.items.filter((b) => b.content_review.state === 'inspected').length, unresolved, unique_file_reads: cache.size, complete: snapshot.branch_overview.items.every((b) => b.content_review.state === 'inspected'), scope: 'bounded_content_evidence_only', pre_model_redaction: false };
    snapshot.branch_overview.exploration = root.GitHubReviewExploration.progress(snapshot);
    return snapshot;
  }
  const plan = (snapshot, options) => root.GitHubReviewExploration.plan(snapshot, options);
  root.GitHubReviewSurvey = Object.freeze({ decorate, plan, paths, representative, safePath, key, order });
})(globalThis);
