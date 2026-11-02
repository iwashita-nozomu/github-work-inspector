/* Whole-tree reading coordinator. Pure fixed-GET plans, never network or code execution.
 * Receipts prove acquisition; model reviews are explicit attestations, not proof of comprehension. */
((root) => {
  'use strict';
  const states = new WeakMap();
  const bad = () => { throw new Error('Invalid whole-tree reading evidence'); };
  const full = (s) => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
  const core = () => root.GitHubReviewCore;
  const clean = (s, n = 800) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, n) : '';
  const sensitive = (s) => /\b(?:gh[pousr]_|github_pat_|password\s*[=:]|api_key\s*[=:])|PRIVATE KEY/i.test(s);
  const note = (s) => typeof s === 'string' && s.trim().length && s.length <= 4000 && !sensitive(s);
  const objectKey = (kind, sha) => kind + '/' + sha;
  const fileId = (repo, commit, path) => repo + '@' + commit + '/' + path;
  const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function request(repository, kind, sha) {
    if (!core().validRepository(repository) || !['commit', 'tree', 'blob'].includes(kind) || !full(sha)) bad();
    return { key: objectKey(kind, sha), method: 'fetch', args: { url: 'https://api.github.com/repos/' + repository + '/git/' + kind + 's/' + sha } };
  }
  function receipt(q, response, captured_at) {
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/(commits|trees|blobs)\/([a-f0-9]{40}|[a-f0-9]{64})$/.exec(q?.args?.url || '');
    if (!m || q.key !== objectKey(m[2].slice(0, -1), m[3]) || !Number.isFinite(Date.parse(captured_at))) bad();
    const value = response?.structuredContent?.structuredContent ?? response?.structuredContent ?? response;
    const base = { kind: m[2].slice(0, -1), sha: m[3], repository: m[1], captured_at };
    if (response?.isError || value?.error) return { ...base, error: 'object_unavailable' };
    let parsed;
    if (typeof value?.content === 'string' && value?.sha == null) {
      if ((value.url ?? value.display_url ?? response?.structuredContent?.url) !== q.args.url) bad();
      // The connected app currently decodes Git blobs to text and omits API fields.
      // Keep that source as data, including JSON-looking source; do not parse it as an API envelope.
      if (base.kind === 'blob') parsed = { sha: m[3], size: new TextEncoder().encode(value.content).length, encoding: 'utf-8', content: value.content, provider_decoded_text: true };
      else try { parsed = JSON.parse(value.content); } catch (_) { bad(); }
    } else parsed = value;
    if (!parsed || parsed.sha !== m[3]) bad();
    const result = base.kind === 'commit' ? { sha: parsed.sha, tree: { sha: parsed.tree?.sha } } : base.kind === 'tree' ? { sha: parsed.sha, truncated: parsed.truncated, tree: parsed.tree?.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, ...(e.size == null ? {} : { size: e.size }) })) } : { sha: parsed.sha, size: parsed.size, encoding: parsed.encoding, content: parsed.content, ...(parsed.provider_decoded_text ? { provider_decoded_text: true } : {}) };
    return { ...base, result };
  }
  function pageRequest(repository, f, start = 1) {
    if (!core().validRepository(repository) || !full(f?.commit) || !full(f?.blob) || !core().validPath(f?.path) || !Number.isSafeInteger(start) || start < 1) bad();
    return { key: 'blobpart/' + f.blob + '/' + start, method: 'fetch_file', args: { repository_full_name: repository, ref: f.commit, path: f.path, start_line: start, end_line: start + 119 } };
  }
  function pageReceipt(q, response, captured_at) {
    const a = q?.args, match = /^blobpart\/([a-f0-9]{40}|[a-f0-9]{64})\/([0-9]+)$/.exec(q?.key || '');
    const value = response?.structuredContent?.structuredContent ?? response?.structuredContent ?? response;
    if (!match || q.method !== 'fetch_file' || !core().validRepository(a.repository_full_name) || !core().validPath(a.path) || !full(a.ref) || a.start_line !== Number(match[2]) || a.end_line !== a.start_line + 119 || !Number.isFinite(Date.parse(captured_at))) bad();
    const expected = 'https://github.com/' + a.repository_full_name + '/blob/' + a.ref + '/' + a.path.split('/').map(encodeURIComponent).join('/');
    if (response?.isError || value?.error) return { repository: a.repository_full_name, commit: a.ref, path: a.path, blob: match[1], start_line: a.start_line, end_line: a.end_line, captured_at, error: 'file_page_unavailable' };
    const literalPathURL = 'https://github.com/' + a.repository_full_name + '/blob/' + a.ref + '/' + a.path;
    if (value.sha !== match[1] || ![expected, literalPathURL].includes(value.display_url) || value.encoding !== 'utf-8' || typeof value.content !== 'string' || value.content.length > 128 * 1024) bad();
    return { repository: a.repository_full_name, commit: a.ref, path: a.path, blob: match[1], start_line: a.start_line, end_line: a.end_line, captured_at, content: value.content, eof: value.content === '' };
  }
  // No arbitrary URL, supplied API links, OS symlink following or extension-based source skipping.
  function objects(snapshot, input) {
    const repository = snapshot.repository.name_with_owner, map = new Map();
    const observations = [...(input.reading?.objects || [])];
    if (!Array.isArray(observations) || observations.length > 20000) bad();
    for (const o of observations) {
      if (!['commit', 'tree', 'blob'].includes(o.kind) || !full(o.sha) || (o.repository != null && o.repository !== repository) || !Number.isFinite(Date.parse(o.captured_at))) bad();
      const k = objectKey(o.kind, o.sha);
      if (map.has(k)) bad();
      if (o.error) { map.set(k, { error: o.error === 'too_large' ? 'too_large' : 'object_unavailable' }); continue; }
      const r = o.result;
      if (!r || r.sha !== o.sha) bad();
      if (o.kind === 'commit') {
        if (!full(r.tree?.sha)) bad();
        map.set(k, { tree: r.tree.sha });
      } else if (o.kind === 'tree') {
        if (!Array.isArray(r.tree) || r.tree.length > 100000 || typeof r.truncated !== 'boolean') bad();
        const paths = new Set();
        const entries = r.tree.map((e) => {
          if (!core().validPath(e.path) || e.path.includes('/') || paths.has(e.path) || !full(e.sha) || !['blob', 'tree', 'commit'].includes(e.type) || !['100644', '100755', '120000', '040000', '160000'].includes(e.mode) || (e.type === 'tree') !== (e.mode === '040000') || (e.type === 'commit') !== (e.mode === '160000')) bad();
          if (e.size != null && (!Number.isSafeInteger(e.size) || e.size < 0)) bad();
          paths.add(e.path); return { path: e.path, sha: e.sha, type: e.type, mode: e.mode, size: e.size ?? null };
        });
        map.set(k, { entries, truncated: r.truncated });
      } else {
        if (!['base64', 'utf-8'].includes(r.encoding) || r.encoding === 'utf-8' && r.provider_decoded_text !== true || !Number.isSafeInteger(r.size) || r.size < 0 || r.size > 2 * 1024 * 1024 || typeof r.content !== 'string') bad();
        if (r.encoding === 'utf-8') {
          if (new TextEncoder().encode(r.content).length !== r.size) bad();
          const redacted = sensitive(r.content);
          map.set(k, { size: r.size, text: redacted ? null : r.content, sensitive: redacted, binary: false, lines: r.content.split('\n').length, provider_decoded_text: true });
          continue;
        }
        const encoded = r.content.replace(/\s/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) bad();
        // Small portable base64 decoder; never eval/import the observed source.
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = [];
        let acc = 0, bits = 0;
        for (const ch of encoded.replace(/=+$/, '')) { acc = (acc << 6) | alphabet.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255); } }
        if (bytes.length !== r.size) bad();
        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); if (text.includes('\0')) text = null; } catch (_) { /* binary is explicit */ }
        const redacted = text !== null && sensitive(text);
        map.set(k, { size: r.size, text: redacted ? null : text, sensitive: redacted, binary: text === null, lines: text === null ? null : text.split('\n').length });
      }
    }
    for (const h of input.history_commits || []) if (!h.error && h.result?.tree) {
      if (!full(h.sha) || h.result.sha !== h.sha || !full(h.result.tree.sha)) bad();
      const key = objectKey('commit', h.sha), previous = map.get(key);
      if (previous && previous.tree !== h.result.tree.sha) bad();
      map.set(key, { tree: h.result.tree.sha });
    }
    return map;
  }
  function inventory(repository, sha, map) {
    const commit = map.get(objectKey('commit', sha)), requests = [], files = [], problems = [];
    if (!commit) return { requests: [request(repository, 'commit', sha)], files, problems, complete: false };
    if (commit.error) return { requests, files, problems: ['commit_tree_unavailable'], complete: false };
    const queue = [{ sha: commit.tree, path: '', ancestors: [] }];
    for (let n = 0; n < queue.length; n++) {
      if (queue.length > 10000 || files.length > 100000) { problems.push('tree_budget'); break; }
      const at = queue[n];
      if (at.ancestors.includes(at.sha)) bad();
      const tree = map.get(objectKey('tree', at.sha));
      if (!tree) { requests.push(request(repository, 'tree', at.sha)); continue; }
      if (tree.error) { problems.push('tree_unavailable:' + at.path); continue; }
      if (tree.truncated) problems.push('tree_truncated:' + at.path);
      for (const e of tree.entries) {
        const path = at.path + e.path;
        if (!core().validPath(path)) bad();
        if (e.type === 'tree') queue.push({ sha: e.sha, path: path + '/', ancestors: [...at.ancestors, at.sha] });
        else files.push({ path, blob: e.sha, mode: e.mode, type: e.type, size: e.size, commit: sha, id: fileId(repository, sha, path) });
      }
    }
    files.sort((a, b) => lex(a.path, b.path));
    return { requests: [...new Map(requests.map((q) => [q.key, q])).values()], files, problems, complete: requests.length === 0 && problems.length === 0 };
  }
  function fileReview(f, map, reviews) {
    if (/(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials?(?:\.json)?|secrets?(?:\.[^/]+)?|id_rsa)$|\.(?:key|pem|p12|pfx)$/i.test(f.path)) return { state: 'reference', method: 'sensitive_path_reference_only', reason: 'Potential credentials: path/commit only; content not requested', meaning: null, excerpt: null };
    if (f.mode === '120000') return { state: 'reference', method: 'git_path_and_fixed_commit', reason: 'Git symlink/Annex reference only; payload acquisition excluded', meaning: null, excerpt: null };
    if (f.type === 'commit') return { state: 'dependency', method: 'pinned_gitlink', reason: 'Host must resolve actual required call paths or explain non-use', meaning: null, excerpt: null };
    const blob = map.get(objectKey('blob', f.blob)), entries = reviews.filter((x) => x.blob === f.blob);
    if (blob?.provider_decoded_text && (f.size == null || f.size !== blob.size)) return { state: 'unavailable', method: 'provider_decoded_text_not_hash_verified', reason: f.size == null ? 'tree_blob_size_missing' : 'decoded_text_tree_size_mismatch', meaning: null, excerpt: null };
    const disposition = entries.find((x) => x.kind === 'excluded');
    if (disposition) return { state: 'excluded', method: disposition.reason, reason: disposition.meaning, meaning: disposition.meaning, excerpt: null };
    if (!blob) return { state: 'unread', method: null, meaning: null, excerpt: null };
    if (blob.partial || blob.error === 'too_large') return { state: 'acquiring_pages', method: 'fixed_blob_line_windows_until_explicit_empty_eof', next_page: blob.next_page || 1, meaning: null, excerpt: null };
    if (blob.error || blob.sensitive) return { state: 'unavailable', method: null, reason: blob.sensitive ? 'sensitive_content_omitted' : 'blob_unavailable', meaning: null, excerpt: null };
    const structured = /\.(?:json|jsonl|csv|tsv|npy|npz|log|svg)$/i.test(f.path) && entries.find((x) => x.kind === 'structured_analysis' && x.full_input_parsed === true && x.meaning);
    if (structured) return { state: 'understood', method: 'complete_machine_parse_plus_model_interpretation_not_cellwise', meaning: structured.meaning, excerpt: blob.text === null ? null : clean(blob.text, 480) };
    const artifact = entries.find((x) => x.kind === 'artifact_interpretation');
    if (blob.binary) return artifact ? { state: 'understood', method: 'artifact_interpretation_attestation', meaning: artifact.meaning, excerpt: null } : { state: 'artifact_pending', method: 'bytes_acquired_only', meaning: null, excerpt: null };
    const spans = entries.filter((x) => x.kind === 'model_text').flatMap((x) => x.spans || []).sort((a, b) => a[0] - b[0]);
    let cursor = 1;
    for (const [start, end] of spans) { if (start > cursor) break; cursor = Math.max(cursor, end + 1); }
    const meaning = entries.find((x) => x.kind === 'model_text' && x.meaning)?.meaning;
    return { state: cursor > blob.lines && meaning ? 'understood' : 'acquired_not_understood', method: 'model_full_text_attestation_not_proof', meaning: meaning || null, next_line: cursor, lines: blob.lines, excerpt: clean(blob.text, 480) };
  }
  function decorate(snapshot, input) {
    const map = objects(snapshot, input), repository = snapshot.repository.name_with_owner;
    const reviews = input.reading?.file_reviews || [], branchReviews = input.reading?.branch_reviews || [], dependencies = input.reading?.dependency_reviews || [];
    if (!Array.isArray(reviews) || reviews.length > 50000 || !Array.isArray(branchReviews) || branchReviews.length > 1000) bad();
    for (const r of reviews) {
      if (!full(r.blob) || !['model_text', 'structured_analysis', 'artifact_interpretation', 'excluded'].includes(r.kind) || (r.meaning != null && !note(r.meaning))) bad();
      if (r.kind === 'excluded' && (!['unrelated_dependency', 'generated_companion', 'binary_out_of_scope'].includes(r.reason) || !note(r.meaning) || !Array.isArray(r.evidence) || !r.evidence.length)) bad();
      if (r.kind === 'model_text' && (!Array.isArray(r.spans) || r.spans.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isSafeInteger) || p[0] < 1 || p[1] < p[0]))) bad();
      if (r.kind === 'model_text' && map.get(objectKey('blob', r.blob))?.lines != null && r.spans.some((p) => p[1] > map.get(objectKey('blob', r.blob)).lines)) bad();
      if (['artifact_interpretation', 'structured_analysis'].includes(r.kind) && !note(r.meaning)) bad();
    }
    if (new Set(branchReviews.map((b) => b.ref)).size !== branchReviews.length) bad();
    for (const b of branchReviews) if (!snapshot.branch_overview.items.some((item) => item.name === b.ref && item.tip_sha === b.sha)) bad();
    if (!Array.isArray(dependencies) || dependencies.length > 10000) bad();
    const dependencyIds = new Set();
    for (const d of dependencies) {
      if (!core().validRepository(d.repository) || !full(d.commit) || !full(d.blob) || !core().validPath(d.path) || !['model_full_text', 'model_full_baseline_and_complete_delta', 'structured_parse_and_interpretation'].includes(d.method) || !note(d.meaning) || d.source_observed !== true) bad();
      dependencyIds.add(fileId(d.repository, d.commit, d.path));
    }
    const inventories = new Map(), base = snapshot.branch_overview.baseline.tip_sha;
    for (const b of snapshot.branch_overview.items) if (b.tip_sha && !inventories.has(b.tip_sha)) inventories.set(b.tip_sha, inventory(repository, b.tip_sha, map));
    const parts = input.reading?.file_parts || [];
    if (!Array.isArray(parts) || parts.length > 50000) bad();
    const grouped = new Map();
    for (const part of parts) {
      if (part.repository !== repository || !full(part.blob) || !full(part.commit) || !core().validPath(part.path) || !Number.isSafeInteger(part.start_line) || part.start_line < 1 || part.end_line !== part.start_line + 119 || !Number.isFinite(Date.parse(part.captured_at)) || ![...inventories.values()].some((inv) => inv.files.some((f) => f.commit === part.commit && f.path === part.path && f.blob === part.blob))) bad();
      if (!part.error && (typeof part.content !== 'string' || part.content.length > 128 * 1024 || part.eof !== (part.content === '') || part.content.split('\n').length > 121)) bad();
      const list = grouped.get(part.blob) || []; if (list.some((p) => p.start_line === part.start_line)) bad(); list.push(part); grouped.set(part.blob, list);
    }
    for (const [sha, list] of grouped) {
      list.sort((a, b) => a.start_line - b.start_line); let next = 1, text = '', ended = false, error = false;
      for (const part of list) { if (ended || part.start_line !== next) bad(); if (part.error) { error = true; break; } if (part.eof) ended = true; else { if (text && !text.endsWith('\n')) text += '\n'; text += part.content; next = part.end_line + 1; } }
      if (map.has(objectKey('blob', sha)) && map.get(objectKey('blob', sha)).error !== 'too_large') bad();
      map.set(objectKey('blob', sha), error ? { error: 'object_unavailable' } : { text: sensitive(text) ? null : text, sensitive: sensitive(text), binary: false, lines: text.split('\n').length, partial: !ended, next_page: next, transport: 'provider_line_windows_and_explicit_empty_eof_not_byte_hash_verification' });
    }
    const state = { map, reviews, branchReviews, inventories, repository, base };
    states.set(snapshot, state);
    for (const b of snapshot.branch_overview.items) {
      const inv = inventories.get(b.tip_sha), baseline = inventories.get(base), summary = branchReviews.find((r) => r.ref === b.name);
      const files = (inv?.files || []).map((f) => ({ ...f, ...fileReview(f, map, reviews) }));
      const before = new Map((baseline?.files || []).map((f) => [f.path, f]));
      const after = new Map((inv?.files || []).map((f) => [f.path, f]));
      const differences = inv?.complete && baseline?.complete ? [...new Set([...before.keys(), ...after.keys()])].sort(lex).filter((p) => before.get(p)?.blob !== after.get(p)?.blob || before.get(p)?.mode !== after.get(p)?.mode).map((path) => ({ path, before: before.get(path)?.blob ?? null, after: after.get(path)?.blob ?? null, status: !before.has(path) ? 'added' : !after.has(path) ? 'removed' : 'modified', rename_inferred: false })) : null;
      if (summary && (summary.sha !== b.tip_sha || !note(summary.design) || !note(summary.implementation) || !note(summary.difference) || !Array.isArray(summary.evidence) || !Array.isArray(summary.required_calls) || !Array.isArray(summary.claims) || !summary.claims.length || !note(summary.limits))) bad();
      const allowed = new Set([...files, ...(baseline?.files || []).map((f) => ({ ...f, ...fileReview(f, map, reviews) }))].filter((f) => ['understood', 'reference'].includes(f.state)).map((f) => f.id));
      if (inv?.complete) allowed.add('tree:' + repository + '@' + b.tip_sha);
      for (const f of files.filter((f) => f.state === 'excluded')) { const e = reviews.find((e) => e.blob === f.blob && e.kind === 'excluded'); if (e.evidence.some((id) => !allowed.has(id) && !dependencyIds.has(id))) bad(); }
      if (summary && (!summary.evidence.length || summary.evidence.some((id) => !allowed.has(id)) || summary.required_calls.some((c) => !note(c.target) || !note(c.reason) || !['reviewed', 'not_called', 'unavailable'].includes(c.state) || !Array.isArray(c.evidence) || (c.state !== 'unavailable' && !c.evidence.length) || c.evidence.some((id) => !allowed.has(id) && !dependencyIds.has(id))))) bad();
      if (summary?.claims.some((c) => !note(c.text) || !['observed', 'author_claim', 'inference', 'unknown'].includes(c.kind) || !Array.isArray(c.evidence) || (c.kind !== 'unknown' && !c.evidence.length) || c.evidence.some((id) => !allowed.has(id) && !dependencyIds.has(id)))) bad();
      if (summary && differences?.length) {
        const changedIds = new Set(differences.flatMap((d) => [d.after && fileId(repository, b.tip_sha, d.path), d.before && base && fileId(repository, base, d.path)].filter(Boolean)));
        if (!summary.evidence.some((id) => changedIds.has(id))) bad();
      }
      // Every changed textual body is already queued independently; a shared README cannot settle it.
      const ready = inv?.complete && files.every((f) => ['understood', 'reference', 'excluded', 'dependency'].includes(f.state));
      const baselineReady = differences !== null && differences.filter((d) => d.before !== null).every((d) => { const f = baseline.files.find((f) => f.path === d.path); return ['understood', 'reference', 'excluded', 'dependency'].includes(fileReview(f, map, reviews).state); });
      const dependencyResolved = files.filter((f) => f.state === 'dependency').every((f) => summary?.required_calls.some((c) => c.target === f.path + '@' + f.blob && (c.state === 'not_called' || c.state === 'reviewed' && dependencies.some((d) => d.commit === f.blob && c.evidence.includes(fileId(d.repository, d.commit, d.path))))));
      const complete = !!(ready && baselineReady && summary && dependencyResolved && summary.required_calls.every((c) => c.state !== 'unavailable'));
      b.understanding = { state: complete ? 'reviewed' : inv?.problems.length || files.some((f) => f.state === 'unavailable') ? 'partial' : 'pending', tree_complete: inv?.complete === true, baseline_changed_bodies_reviewed: baselineReady, problems: inv?.problems || [], files, differences, summary: summary ? { design: clean(summary.design), implementation: clean(summary.implementation), difference: clean(summary.difference), limits: clean(summary.limits), evidence: summary.evidence, required_calls: summary.required_calls, display_truncated: [summary.design, summary.implementation, summary.difference, summary.limits, ...summary.claims.map((c) => c.text)].some((s) => s.length > 800), claims: summary.claims.map((c) => ({ ...c, text: clean(c.text) })) } : null, complete, model_review_is_attestation_not_proof: true, preview_is_not_understanding: true };
    }
    snapshot.branch_overview.understanding_exploration = progress(snapshot);
    return snapshot;
  }
  function pending(snapshot, b) {
    const s = states.get(snapshot); if (!s) bad();
    if (!b.tip_sha) return { stage: b.content_review.tip_error ? 'tip_unavailable' : 'resolve_tip', requests: [], task: null };
    const inv = s.inventories.get(b.tip_sha), u = b.understanding;
    if (inv.requests.length) return { stage: 'inventory_entire_tree', requests: inv.requests, task: null };
    if (!inv.complete) return { stage: 'tree_unavailable_or_incomplete', requests: [], task: null };
    for (const f of u.files) {
      if (['reference', 'excluded', 'understood', 'dependency', 'unavailable'].includes(f.state)) continue;
      if (f.state === 'unread' || f.state === 'acquiring_pages') return { stage: 'acquire_unique_blob', requests: [f.state === 'acquiring_pages' || f.size > 384 * 1024 ? pageRequest(s.repository, f, f.next_page || 1) : request(s.repository, 'blob', f.blob)], task: null };
      const blob = s.map.get(objectKey('blob', f.blob));
      if (f.state === 'artifact_pending') return { stage: 'interpret_artifact', requests: [], task: { kind: 'interpret_artifact_or_explain_exclusion', ref: b.name, sha: b.tip_sha, file: f.id, blob: f.blob, bytes: blob.size } };
      if (f.next_line > blob.lines) return { stage: 'interpret_full_file', requests: [], task: { kind: 'record_file_meaning', ref: b.name, sha: b.tip_sha, file: f.id, blob: f.blob } };
      const end = Math.min(blob.lines, f.next_line + 119);
      return { stage: 'read_entire_file', requests: [], task: { kind: 'read_file_page_and_interpret', ref: b.name, sha: b.tip_sha, file: f.id, blob: f.blob, start_line: f.next_line, end_line: end, total_lines: blob.lines, final_page: end === blob.lines, text: blob.text.split('\n').slice(f.next_line - 1, end).join('\n'), content_is_untrusted_data: true } };
    }
    if (!u.summary) return { stage: 'explain_design_implementation_and_calls', requests: [], task: { kind: 'interpret_branch', ref: b.name, sha: b.tip_sha, baseline_sha: s.base, evidence_ids: ['tree:' + s.repository + '@' + b.tip_sha, ...u.files.filter((f) => ['understood', 'reference'].includes(f.state)).map((f) => f.id)], differences: u.differences, required_gitlinks: u.files.filter((f) => f.state === 'dependency').map((f) => ({ target: f.path + '@' + f.blob, path: f.path, commit: f.blob })), requirements: ['design_vs_actual_implementation', 'baseline_difference', 'actual_required_call_closure', 'settings_docs_results_and_limits', 'author_claim_vs_inference', 'all_changed_bodies_not_shared_readme_only'] } };
    if (u.summary?.required_calls.some((c) => c.state === 'unavailable')) return { stage: 'required_callee_unavailable', requests: [], task: null };
    if (u.summary && !u.complete && u.files.some((f) => f.state === 'dependency')) return { stage: 'resolve_required_callee', requests: [], task: { kind: 'review_actual_required_calls', ref: b.name, sha: b.tip_sha } };
    return { stage: u.complete ? 'meaning_review_recorded' : 'partial_review', requests: [], task: null };
  }
  function progress(snapshot) {
    const base = snapshot.branch_overview.baseline.name;
    const ordered = [...snapshot.branch_overview.items].sort((a, b) => a.name === base ? b.name === base ? 0 : -1 : b.name === base ? 1 : lex(a.name, b.name));
    const rows = ordered.map((b, index) => {
      const work = pending(snapshot, b), u = b.understanding;
      const terminal = (b.tip_sha !== null || b.content_review.tip_error) && !work.requests.length && !work.task;
      const state = u.complete ? 'checked' : b.content_review.tip_error ? 'unavailable' : terminal ? 'partial' : !b.tip_sha ? 'not_started' : 'in_progress';
      return { ref: b.name, sha: b.tip_sha, index, state, stage: work.stage, terminal, pending_keys: work.requests.map((q) => q.key), checked_scope: 'whole_git_text_and_required_call_meaning_attestation_not_runtime_audit', summary_status: u.summary ? 'recorded' : 'pending' };
    });
    const checked = rows.filter((r) => r.state === 'checked').length, processed = rows.filter((r) => r.terminal).length;
    const counts = { acquired: rows.length, checked, processed, remaining: rows.length - processed, not_confirmed: rows.length - checked, partial: rows.filter((r) => r.state === 'partial').length, unavailable: rows.filter((r) => r.state === 'unavailable').length, not_started: rows.filter((r) => r.state === 'not_started').length, in_progress: rows.filter((r) => r.state === 'in_progress').length };
    const next = rows.find((r) => !r.terminal);
    return { rows, counts, order: rows.map((r) => r.ref), resume_ref: next?.ref ?? null, resume_stage: next?.stage ?? null, inventory_complete: snapshot.branches.coverage.fully_enumerated, finished_known_targets: processed === rows.length, complete: checked === rows.length && snapshot.branches.coverage.fully_enumerated, all_checked: checked === rows.length && snapshot.branches.coverage.fully_enumerated, atomic: false, count_is_not_understanding: true };
  }
  function plan(snapshot, options = {}) {
    const s = states.get(snapshot); if (!s) bad();
    const p = progress(snapshot), old = options.checkpoint;
    if (old && (old.version !== 2 || old.repository !== s.repository || old.captured_at !== snapshot.branches.captured_at || !Array.isArray(old.pinned_tips) || !Array.isArray(old.reviewed_refs) || new Set(old.pinned_tips.map((t) => t[0])).size !== old.pinned_tips.length || old.pinned_tips.some(([ref, sha]) => !p.rows.some((r) => r.ref === ref && (sha === null || r.sha === sha))) || (old.inventory_frozen && JSON.stringify(old.pinned_tips.map((t) => t[0])) !== JSON.stringify(p.order)) || old.reviewed_refs.some((ref) => !p.rows.some((r) => r.ref === ref && r.state === 'checked')))) bad();
    const budget = options.request_budget ?? 4;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 10000 || options.stop_reason != null && !['budget', 'time', 'user', 'connection'].includes(options.stop_reason)) bad();
    const inv = root.GitHubReviewExploration.plan(snapshot, { request_budget: budget });
    let work, ref = null;
    if (inv.phase === 'enumerate_all_pages') work = { requests: inv.requests, task: null, stage: inv.phase };
    else {
      const b = snapshot.branch_overview.items.find((b) => b.name === p.resume_ref);
      ref = b?.name ?? null;
      work = b ? !b.tip_sha ? { stage: b.content_review.tip_error ? 'tip_unavailable' : 'resolve_tip', requests: b.content_review.tip_error ? [] : [{ key: 'tip/' + b.branch_id, method: 'compare_commits', args: { repo_full_name: s.repository, base: b.name, head: b.name } }], task: null } : pending(snapshot, b) : { stage: p.complete ? 'meaning_review_complete' : 'partial_review_finished', requests: [], task: null };
    }
    const paused = !!options.stop_reason || budget === 0 && (work.requests.length > 0 || work.task !== null);
    const inFlight = options.in_flight_keys || [];
    if (!Array.isArray(inFlight) || inFlight.length > 4 || inFlight.some((k) => !work.requests.some((q) => q.key === k))) bad();
    const requests = paused ? [] : work.requests.filter((q) => !inFlight.includes(q.key)).slice(0, Math.min(4, budget));
    return { phase: paused ? 'paused' : inFlight.length && !requests.length ? 'waiting_for_receipts' : work.stage, target_ref: ref, requests, tasks: paused || !work.task ? [] : [work.task], pending_request_keys: work.requests.map((q) => q.key), in_flight_keys: inFlight, paused, progress: p, max_parallel: 4, checkpoint: { version: 2, repository: s.repository, captured_at: snapshot.branches.captured_at, inventory_frozen: inv.checkpoint.inventory_frozen, pinned_tips: p.rows.map((r) => [r.ref, r.sha]), reviewed_refs: p.rows.filter((r) => r.state === 'checked').map((r) => r.ref), requires_all_observations_and_review_attestations: true } };
  }
  root.GitHubReviewReading = Object.freeze({ request, receipt, pageRequest, pageReceipt, decorate, plan, progress });
})(globalThis);
