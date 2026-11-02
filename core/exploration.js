/* Deterministic exhaustive finite-target traversal. No network, storage or model execution. */
((root) => {
  'use strict';
  const invalid = () => { throw new Error('Invalid exploration checkpoint'); };
  const survey = () => root.GitHubReviewSurvey;
  function ordered(snapshot) {
    const base = snapshot.branch_overview.baseline.name;
    return [...snapshot.branch_overview.items].sort((a, b) => a.name === base ? b.name === base ? 0 : -1 : b.name === base ? 1 : survey().order(a.name, b.name));
  }
  function inventoryRequest(snapshot) {
    const c = snapshot.branches.coverage;
    if (c.fully_enumerated || c.pages_fetched >= root.GitHubReviewCore.contract.limits.branch_pages || ['error', 'repeated_cursor'].includes(c.stopped_reason)) return null;
    if (c.pages_fetched > 0 && c.next_cursor == null) return null;
    const [owner, repo_name] = snapshot.repository.name_with_owner.split('/');
    return { key: 'inventory/' + (c.next_cursor ?? 'first'), method: 'search_branches', args: { owner, repo_name, query: '', page_size: 100, ...(c.next_cursor == null ? {} : { cursor: c.next_cursor }) } };
  }
  function pending(snapshot, b) {
    const repository = snapshot.repository.name_with_owner, baseline = snapshot.branch_overview.baseline.tip_sha, r = b.content_review;
    if (!r) invalid();
    if (!b.tip_sha) return { stage: r.tip_error ? 'tip_unavailable' : 'resolve_tip', requests: r.tip_error ? [] : [{ key: 'tip/' + b.branch_id, method: 'compare_commits', args: { repo_full_name: repository, base: b.name, head: b.name } }], task: null };
    if (baseline && !r.comparison && !r.comparison_error) return { stage: 'compare_tips', requests: [{ key: 'compare/' + baseline + '/' + b.tip_sha, method: 'compare_commits', args: { repo_full_name: repository, base: baseline, head: b.tip_sha } }], task: null };
    const requests = [];
    for (const path of r.expected_paths) if (!r.evidence.some((f) => f.path === path)) requests.push({ key: survey().key(repository, b.tip_sha, path), method: 'fetch_file', args: { repository_full_name: repository, ref: b.tip_sha, path, start_line: 1, end_line: root.GitHubReviewCore.contract.limits.content_lines } });
    if (requests.length) return { stage: 'read_branch_content', requests, task: null };
    const delta = r.delta;
    if (baseline && r.comparison?.status !== 'identical' && delta.representative_path && !delta.evidence.some((f) => f.sha === baseline)) {
      const path = delta.representative_path;
      return { stage: 'read_baseline_counterpart', requests: [{ key: survey().key(repository, baseline, path), method: 'fetch_file', args: { repository_full_name: repository, ref: baseline, path, start_line: 1, end_line: root.GitHubReviewCore.contract.limits.content_lines } }], task: null };
    }
    const evidence = [...r.evidence, ...delta.evidence].filter((f, i, a) => f.state === 'read' && a.findIndex((x) => x.id === f.id) === i);
    if (evidence.length && r.summary.status === 'pending') return { stage: 'record_summary', requests: [], task: { kind: 'summarize_branch', ref: b.name, sha: b.tip_sha, branch_id: b.branch_id, evidence_ids: evidence.map((f) => f.id), difference_state: delta.state, allowed_statuses: ['recorded', 'insufficient'] } };
    return { stage: 'settled', requests: [], task: null };
  }
  function progress(snapshot) {
    const rows = ordered(snapshot).map((b, index) => {
      const p = pending(snapshot, b), r = b.content_review;
      const readable = [...r.evidence, ...r.delta.evidence].some((f) => f.state === 'read');
      const terminal = p.requests.length === 0 && !p.task;
      const started = b.tip_sha != null || r.tip_error != null || r.evidence.length > 0;
      const state = !started ? 'not_started' : !terminal ? 'in_progress' : !readable ? 'unavailable' : r.state === 'inspected' && r.summary.status === 'recorded' ? 'checked' : 'partial';
      return { ref: b.name, sha: b.tip_sha, index, state, terminal, stage: p.stage, pending_keys: p.requests.map((q) => q.key), summary_status: readable ? r.summary.status : 'unknown_no_readable_evidence', checked_scope: 'bounded_readme_representative_and_comparison_not_full_code_audit' };
    });
    const processed = rows.filter((r) => r.terminal).length, checked = rows.filter((r) => r.state === 'checked').length;
    const counts = { acquired: rows.length, processed, remaining: rows.length - processed, checked, not_confirmed: rows.length - checked, partial: rows.filter((r) => r.state === 'partial').length, unavailable: rows.filter((r) => r.state === 'unavailable').length, not_started: rows.filter((r) => r.state === 'not_started').length, in_progress: rows.filter((r) => r.state === 'in_progress').length };
    if (counts.acquired !== counts.checked + counts.partial + counts.unavailable + counts.not_started + counts.in_progress || counts.acquired !== counts.processed + counts.remaining || snapshot.branches.coverage.items_seen !== rows.length) invalid();
    const next = rows.find((r) => !r.terminal);
    return { preview_only: true, scope: 'legacy_60_line_preview_not_whole_reading', order_rule: 'observed_default_first_then_exact_ref_utf16_lexicographic', order: rows.map((r) => r.ref), rows, counts, resume_ref: next?.ref ?? null, resume_stage: next?.stage ?? null, inventory_complete: snapshot.branches.coverage.fully_enumerated === true, finished_known_targets: processed === rows.length, complete: processed === rows.length && snapshot.branches.coverage.fully_enumerated === true, all_checked: checked === rows.length && snapshot.branches.coverage.fully_enumerated === true, atomic: false };
  }
  function checkpoint(snapshot, p) {
    return { version: 1, requires_observations_snapshot: true, repository: snapshot.repository.name_with_owner, captured_at: snapshot.branches.captured_at, inventory_frozen: inventoryRequest(snapshot) === null, inventory_complete: p.inventory_complete, inventory_cursor: snapshot.branches.coverage.next_cursor ?? null, ordered_refs: [...p.order], pinned_tips: p.rows.map((r) => ({ ref: r.ref, sha: r.sha })), baseline_sha: snapshot.branch_overview.baseline.tip_sha, resume_ref: p.resume_ref, resume_stage: p.resume_stage, processed_refs: p.rows.filter((r) => r.terminal).map((r) => r.ref) };
  }
  function validateCheckpoint(snapshot, saved) {
    if (!saved || typeof saved.inventory_frozen !== 'boolean' || saved.version !== 1 || saved.repository !== snapshot.repository.name_with_owner || saved.captured_at !== snapshot.branches.captured_at || !Array.isArray(saved.ordered_refs) || !Array.isArray(saved.pinned_tips) || saved.pinned_tips.length !== saved.ordered_refs.length || new Set(saved.pinned_tips.map((t) => t.ref)).size !== saved.pinned_tips.length) invalid();
    const refs = ordered(snapshot).map((b) => b.name);
    if (new Set(saved.ordered_refs).size !== saved.ordered_refs.length || saved.ordered_refs.some((ref) => !refs.includes(ref)) || (saved.inventory_frozen && JSON.stringify(refs) !== JSON.stringify(saved.ordered_refs))) invalid();
    if (saved.baseline_sha !== null && saved.baseline_sha !== snapshot.branch_overview.baseline.tip_sha) invalid();
    for (const t of saved.pinned_tips) if (!saved.ordered_refs.includes(t.ref) || (t.sha !== null && snapshot.branch_overview.items.find((b) => b.name === t.ref)?.tip_sha !== t.sha)) invalid();
    const now = progress(snapshot);
    // A checkpoint cannot hide a lost receipt/summary or skip an unread branch on resume.
    if (!Array.isArray(saved.processed_refs) || saved.processed_refs.some((ref) => !now.rows.some((r) => r.ref === ref && r.terminal))) invalid();
  }
  function plan(snapshot, options = {}) {
    if (options.checkpoint) validateCheckpoint(snapshot, options.checkpoint);
    const budget = options.request_budget ?? 4;
    if (!Number.isInteger(budget) || budget < 0 || budget > 10000 || (options.stop_reason != null && !['budget', 'time', 'user', 'connection'].includes(options.stop_reason))) invalid();
    const p = progress(snapshot), saved = checkpoint(snapshot, p), inventory = inventoryRequest(snapshot);
    let phase, requests = [], tasks = [], branch = null;
    if (inventory) { phase = 'enumerate_all_pages'; requests = [inventory]; }
    else {
      branch = ordered(snapshot).find((b) => b.name === p.resume_ref);
      if (branch) {
        const work = pending(snapshot, branch);
        phase = branch.name === snapshot.branch_overview.baseline.name ? 'inspect_default_branch_first' : 'inspect_next_branch';
        requests = work.requests;
        if (work.task) tasks = [work.task];
      } else phase = p.inventory_complete ? 'finished_all_targets' : 'finished_known_targets_partial_inventory';
    }
    const inFlight = options.in_flight_keys || [];
    if (!Array.isArray(inFlight) || inFlight.length > 4 || inFlight.some((k) => !requests.some((q) => q.key === k))) invalid();
    const paused = options.stop_reason != null || (budget === 0 && requests.length > 0);
    const dispatch = paused ? [] : requests.filter((q) => !inFlight.includes(q.key)).slice(0, Math.min(budget, 4));
    const output = { phase: paused ? 'paused' : inFlight.length && !dispatch.length ? 'waiting_for_receipts' : phase, target_ref: branch?.name ?? null, requests: dispatch, tasks: paused ? [] : tasks, pending_request_keys: requests.map((q) => q.key), in_flight_keys: [...inFlight], max_parallel: 4, paused, stopped_reason: options.stop_reason ?? (paused ? 'budget' : null), progress: p, checkpoint: saved };
    // In-flight is a dispatch fact, never evidence of a successful read.
    if (inFlight.length && branch) output.progress = { ...p, rows: p.rows.map((r) => r.ref === branch.name && r.state === 'not_started' ? { ...r, state: 'in_progress' } : r), counts: { ...p.counts, not_started: p.counts.not_started - (p.rows.find((r) => r.ref === branch.name)?.state === 'not_started' ? 1 : 0), in_progress: p.counts.in_progress + (p.rows.find((r) => r.ref === branch.name)?.state === 'not_started' ? 1 : 0) } };
    return output;
  }
  root.GitHubReviewExploration = Object.freeze({ progress, plan, validateCheckpoint });
})(globalThis);
