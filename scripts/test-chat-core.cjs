// Synthetic connector fixtures; no network, model turn, browser or account mutation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = { TextEncoder }; vm.runInNewContext(fs.readFileSync(path.join(root, '.agents/skills/github-work-inspector/references/review-selection.js'), 'utf8'), context);
const core = context.GitHubReviewCore, selection = context.GitHubReviewSelection;
const A = 'a'.repeat(40), B = 'b'.repeat(40), at = '2026-01-01T00:00:00Z';
function input() {
  return { repository: 'example/project', captured_at: at,
    repository_metadata: { repository_full_name: 'example/project', default_branch: 'stable/release' },
    branch_pages: [{ branches: [{ branch: 'experiment/timeout' }, { branch: 'stable/release' }], cursor: 'Mg' }, { branches: [], cursor: null }],
    recent_commits: [{ sha: A, message: 'Synthetic older description', repository_full_name: 'example/project', created_at: at }, { sha: B, message: 'Synthetic merge subject, not parent evidence', repository_full_name: 'example/project' }],
    pull_requests: [{ number: 1, title: 'Explore request timeouts', body: 'Author describes an experiment.', state: 'closed', merged: true, merged_at: at, head: 'experiment/timeout', head_sha: A, head_repo_full_name: 'example/project', base: 'stable/release' }, { number: 2, title: 'Different fork', state: 'open', head: 'experiment/timeout', head_sha: B, head_repo_full_name: 'other/fork' }] };
}
function resolution(ref, sha = B) { return { ref, captured_at: at, result: { repository_full_name: 'example/project', base: ref, head: ref, status: 'identical', total_commits: 0, files: [], base_commit: { sha }, merge_base_commit: { sha } } }; }
function commitInput() { return { repository: 'example/project', sha: A, captured_at: at, response: { commit: { sha: A, repository_full_name: 'example/project', message: 'Synthetic change', files: [{ filename: 'src/one.rs', patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'src/two.rs', patch: '+other' }] } } }; }

test('same schema preserves branch names without invented tips, parents, topology or Rust guarantees', () => {
  const value = core.normalizeChat(input()), s = value.snapshot;
  assert.equal(value.schema_version, 1); assert.equal(s.review_core.contract_version, '1.0.0');
  assert.equal(s.review_core.adapter, 'chat_github'); assert.equal(s.review_core.capabilities.pre_model_redaction, false);
  assert.equal(s.review_core.capabilities.commit_file_transfer_bounded, false);
  assert.ok(s.branch_overview.items.every((b) => b.tip_sha === null && b.history === null));
  assert.ok(s.dag.nodes.every((n) => n.parents === null)); assert.equal(s.dag.per_branch.length, 0);
  assert.equal(s.dag.edge_direction, 'child_to_parent'); assert.equal(s.dag.parent_fields_available, false);
  assert.equal(s.branch_overview.baseline.name, 'stable/release'); assert.equal(s.branch_overview.baseline.tip_sha, null);
  assert.equal(s.branch_overview.items[0].related_pull_requests.length, 1); assert.equal(s.branch_overview.items[0].related_pull_requests[0].head_matches_tip, null);
});

test('cursor exhaustion, retained card limit and default outside the first history-sized prefix are distinct', () => {
  const x = input(); x.branch_pages = [{ branches: Array.from({ length: 35 }, (_, i) => ({ branch: i === 32 ? 'stable/release' : 'candidate/' + i })), cursor: 'MzU' }];
  assert.equal(core.normalizeChat(x).snapshot.branches.coverage.fully_enumerated, false);
  x.branch_pages.push({ branches: [], cursor: null });
  let s = core.normalizeChat(x).snapshot; assert.equal(s.branches.coverage.fully_enumerated, true); assert.equal(s.branch_overview.items.length, 35);
  assert.ok(s.branch_overview.items.some((b) => b.name === 'stable/release'));
  x.branch_pages = [{ branches: Array.from({ length: 100 }, (_, i) => ({ branch: 'candidate/' + i })), cursor: 'a' }, { branches: [{ branch: 'stable/release' }], cursor: null }];
  s = core.normalizeChat(x).snapshot; assert.equal(s.branch_overview.items.length, 100); assert.ok(s.branch_overview.items.some((b) => b.name === 'stable/release')); assert.equal(s.branches.coverage.has_more, true);
  x.branch_pages[1].cursor = 'a'; assert.equal(core.normalizeChat(x).snapshot.branches.coverage.stopped_reason, 'repeated_cursor');
  x.branch_pages.push({ branches: [], cursor: null }); assert.throws(() => core.normalizeChat(x), /Invalid review observation/);
});

test('a named main is not default metadata and foreign repo or short SHA data is rejected', () => {
  const x = input(); delete x.repository_metadata; x.branch_pages = [{ branches: [{ branch: 'main' }], cursor: null }];
  assert.equal(core.normalizeChat(x).snapshot.branch_overview.baseline.name, null);
  x.repository_metadata = { repository_full_name: 'other/repo', default_branch: 'main' }; assert.throws(() => core.normalizeChat(x));
  const y = input(); y.recent_commits[0].sha = 'deadbee'; assert.throws(() => core.normalizeChat(y));
});

test('same-ref compare resolves a tip only after validating its returned basis; merge-base creates no edge', () => {
  const x = input(); x.tip_resolutions = [resolution('experiment/timeout')];
  const s = core.normalizeChat(x).snapshot;
  assert.equal(s.branch_overview.items[0].tip_sha, B); assert.equal(s.branch_overview.items[0].related_pull_requests[0].head_matches_tip, false);
  assert.equal(s.branch_overview.items[0].comparison.relation, 'unavailable_parent_fields');
  for (const change of [{ status: 'ahead' }, { head: 'different' }, { files: [{ filename: 'x' }] }, { repository_full_name: 'other/repo' }]) {
    const y = input(); y.tip_resolutions = [resolution('experiment/timeout')]; Object.assign(y.tip_resolutions[0].result, change); assert.throws(() => core.normalizeChat(y));
  }
});

test('Chat commit display binds exact SHA/path and keeps unknown status/parents and transfer limits', () => {
  const x = commitInput(); let d = core.normalizeChatCommit(x).commit_details;
  assert.equal(d.patch, null); assert.equal(d.commit.parents, null); assert.equal(d.files[0].file_id, null); assert.equal(d.files[0].status, null);
  assert.equal(d.coverage.provider_file_only_transfer, false);
  x.selected_path = 'src/two.rs'; d = core.normalizeChatCommit(x).commit_details;
  assert.equal(d.files.length, 1); assert.equal(d.patch.text, '+other'); assert.equal(d.patch.pre_model_redaction, false);
  assert.equal(d.files[0].selection.path, 'src/two.rs'); assert.equal(d.commit.comparison.parent_sha, null);
  x.selected_path = 'missing.rs'; assert.throws(() => core.normalizeChatCommit(x));
  x.selected_path = 'src/one.rs'; x.response.commit.sha = B; assert.throws(() => core.normalizeChatCommit(x));
});

test('secret-like patches are omitted from display, UTF-8/line limits are bounded, not pre-model filtering', () => {
  const x = commitInput(); x.selected_path = 'src/one.rs'; x.response.commit.files[0].patch = '+password=synthetic-only';
  let d = core.normalizeChatCommit(x).commit_details; assert.equal(d.patch.text, null); assert.equal(d.patch.omission_reason, 'sensitive_display_content'); assert.equal(d.patch.pre_model_redaction, false);
  x.response.commit.files[0].patch = ('+' + '日'.repeat(200) + '\n').repeat(150);
  d = core.normalizeChatCommit(x).commit_details; assert.ok(Buffer.byteLength(d.patch.text, 'utf8') <= 16384); assert.ok(d.patch.text.split('\n').length <= 120); assert.equal(d.patch.truncated, true);
});

test('Chat branch/path references are data, remain bound to the adapter and do not launch a call on selection', async () => {
  const v = { repository: 'example/project', captured_at: at, source_adapter: 'chat_github', targets: [{ kind: 'branch', branch_ref: 'experiment/timeout', sha: null }, { kind: 'file', sha: A, path: 'src/<script>.rs' }] };
  const calls = [], states = [], c = selection.create(v, () => ({ sendFollowUpMessage: (p) => calls.push(p), setWidgetState: (s) => states.push(s) }));
  c.select(c.targets[0].id); assert.equal(calls.length, 0); assert.equal(c.selected().sha, null);
  const branchData = JSON.parse(c.question().split('\n').at(-1)); assert.equal(branchData.selection.branch_ref, 'experiment/timeout'); assert.equal(branchData.source_adapter, 'chat_github');
  c.select(c.targets[1].id); assert.ok(!c.question().includes('<script>')); const data = JSON.parse(c.question().split('\n').at(-1)); assert.equal(data.selection.path, 'src/<script>.rs'); assert.equal(data.selection.file_id, undefined);
  assert.equal((await c.ask()).status, 'host_confirmation_requested'); assert.equal(calls.length, 1);
  assert.throws(() => selection.create({ ...v, source_adapter: 'rust_gh', targets: [v.targets[1]] }));
  assert.equal(selection.create({ ...v, captured_at: '2026-01-02T00:00:00Z' }, () => ({ widgetState: states.at(-1) })).selected(), null);
  for (const bad of ['/absolute', '../outside', 'a/../b', 'a\nb', 'a\\b']) assert.throws(() => selection.create({ ...v, targets: [{ kind: 'file', sha: A, path: bad }] }));
});

test('manual bridge fallback keeps immutable Chat path data without inventing successful delivery', async () => {
  const c = selection.create({ repository: 'example/project', captured_at: at, source_adapter: 'chat_github', targets: [{ kind: 'file', sha: A, path: 'src/one.rs' }] }, () => undefined);
  c.select(c.targets[0].id); const r = await c.ask(); assert.equal(r.status, 'manual'); assert.equal(JSON.parse(r.prompt.split('\n').at(-1)).selection.path, 'src/one.rs');
});

class Element {
  constructor() { this.dataset = {}; this.children = []; this.handlers = {}; this.attrs = {}; this.textContent = ''; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { this.handlers[k] = f; }
  async click() { if (!this.disabled) return this.handlers.click?.(); }
}
test('Chat overview renders unknown tips and allows explicit branch questions without a fake DAG or automatic GET', async () => {
  const s = core.normalizeChat(input()).snapshot, controls = {}, calls = [];
  for (const key of ['branch-cards','branch-baseline','branch-coverage','branch-source','review-selection','review-ask','review-fallback','review-status']) controls['[data-'+key+']'] = new Element();
  const panels = s.branch_overview.items.map((b) => { const p = new Element(); p.dataset.branchId = b.branch_id; return p; });
  const element = { ownerDocument: { createElement: () => new Element() }, querySelector: (q) => controls[q], querySelectorAll: (q) => q === '[data-branch-history]' ? panels : [] };
  const v = { repository: 'example/project', captured_at: at, source_adapter: 'chat_github', targets: s.branch_overview.items.map((b) => ({ kind: 'branch', branch_ref: b.name, sha: null })) };
  const selected = selection.bind(element, v, () => ({ sendFollowUpMessage: (p) => { calls.push(p); } }));
  selection.bindOverview(element, s.branch_overview, [{ branch_id: s.branch_overview.items[0].branch_id, tip_sha: null, purpose: { text: '待機処理の実験という著者の説明', kind: 'author_claim', evidence: ['pull/1'] } }], { source: 'chat_github', selection: selected, onSelect: ({ branch_id }) => selected.select(selected.targets.find((t) => 'ref/'+encodeURIComponent(t.branch_ref) === branch_id).id) });
  const texts = (p) => [p.textContent, ...p.children.flatMap(texts)].join('\n');
  assert.ok(texts(controls['[data-branch-cards]']).includes('待機処理'));
  assert.ok(texts(controls['[data-branch-cards]']).includes('枝名のみ')); assert.ok(controls['[data-branch-source]'].textContent.includes('Rust未実行'));
  assert.ok(controls['[data-branch-baseline]'].textContent.includes('stable/release'));
  await controls['[data-branch-cards]'].children[0].children.at(-1).click();
  assert.equal(calls.length, 0); assert.equal(panels[0].hidden, false); assert.equal(controls['[data-review-ask]'].disabled, false);
  await controls['[data-review-ask]'].click(); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].prompt.split('\n').at(-1)).selection.branch_ref, 'experiment/timeout');
});
