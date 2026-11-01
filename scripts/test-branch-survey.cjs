// Synthetic receipts only; exercises orchestration requests and the shipped fragment's actual DOM handlers.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), prefix = path.join(root, 'plugins/github-work-inspector-chat/skills/github-repo-review-chat/references');
const bundle = fs.readFileSync(path.join(prefix, 'review-selection.js'), 'utf8');
const ctx = { TextEncoder }; vm.runInNewContext(bundle, ctx);
const core = ctx.GitHubReviewCore, survey = ctx.GitHubReviewSurvey, ui = ctx.GitHubReviewOverview;
const at = '2026-01-01T00:00:00Z', repo = 'example/project', A = 'a'.repeat(40), B = 'b'.repeat(40);
function fixture(n = 42) {
  const names = Array.from({ length: n }, (_, i) => i === 37 ? 'main' : 'feature/' + i);
  const pages = []; for (let i = 0; i < n; i += 100) pages.push({ branches: names.slice(i, i + 100).map((branch) => ({ branch })), cursor: String(i + 100) });
  pages.push({ branches: [], cursor: null });
  return { repository: repo, captured_at: at, repository_metadata: { repository_full_name: repo, default_branch: 'main' }, branch_pages: pages };
}
function populate(x) {
  const names = x.branch_pages.flatMap((p) => p.branches.map((b) => b.branch));
  x.tip_resolutions = names.map((ref) => ({ ref, captured_at: at, result: { repository_full_name: repo, base: ref, head: ref, status: 'identical', total_commits: 0, files: [], base_commit: { sha: ref === 'main' ? A : B } } }));
  x.branch_reads = names.map((ref) => { const sha = ref === 'main' ? A : B; return { ref, sha, captured_at: at,
    comparison: { repository_full_name: repo, base: A, head: sha, status: sha === A ? 'identical' : 'ahead', ahead_by: sha === A ? 0 : 1, behind_by: 0, files: sha === A ? [] : [{ filename: 'src/worker.rs', status: 'modified' }] },
    baseline_files: sha === A ? [] : [{sha:A,path:'src/worker.rs',start_line:1,end_line:60,captured_at:at,content:'pub fn process() { /* synthetic baseline */ }'}],
    files: ['README.md', sha === A ? 'CMakeLists.txt' : 'src/worker.rs'].map((path) => ({ path, start_line: 1, end_line: 60, captured_at: at, content: path === 'README.md' ? '# Synthetic queue\nHandles bounded jobs.' : 'pub fn process() { /* synthetic bounded worker */ }' })) }; });
  return x;
}
function model(x) { return core.normalizeChat(x); }

test('42 branches including default #38 survive acquisition/normalization/display target and full tip planning', () => {
  const s = model(fixture()).snapshot, c = s.branches.coverage;
  assert.equal(c.items_seen, 42); assert.equal(c.normalized_count, 42); assert.equal(c.display_target_count, 42); assert.equal(c.fully_enumerated, true);
  assert.equal(s.branch_overview.items[37].name, 'main'); assert.equal(s.branch_overview.baseline.name, 'main');
  const p = survey.plan(s); assert.equal(p.phase, 'inspect_default_branch_first'); assert.equal(p.requests.length, 1); assert.equal(p.requests[0].args.base, 'main'); assert.equal(p.progress.counts.remaining, 42); assert.equal(p.max_parallel, 4);
  assert.ok(p.requests.every((q) => q.method === 'compare_commits' && q.args.base === q.args.head));
  assert.equal(s.branch_overview.content_coverage.with_file_evidence, 0); assert.equal(s.dag.per_branch.length, 0);
});

test('all fetched names survive more than 100 and the limit is explicit rather than silently clipping', () => {
  const x = fixture(205), s = model(x).snapshot;
  assert.equal(s.branch_overview.items.length, 205); assert.equal(s.branches.coverage.fully_enumerated, true);
  x.branch_pages = Array.from({ length: 11 }, () => ({ branches: [], cursor: 'next' })); assert.throws(() => model(x));
  const partial = fixture(); partial.branch_pages.pop(); assert.equal(model(partial).snapshot.branches.coverage.fully_enumerated, false);
});

test('full SHA comparison then bounded representative reads; same revision requests deduplicate', () => {
  const x = populate(fixture()), first = x.branch_reads[0]; x.branch_reads = [first, x.branch_reads[37]];
  const s = model(x).snapshot;
  assert.equal(s.branch_overview.content_coverage.with_file_evidence, 42); assert.equal(s.branch_overview.content_coverage.unique_file_reads, 5);
  assert.ok(s.branch_overview.items[1].content_review.reused_revision);
  delete x.branch_reads[0].files[1]; x.branch_reads[0].files = x.branch_reads[0].files.filter(Boolean);
  let p = survey.plan(model(x).snapshot); assert.equal(p.requests.filter((r) => r.method === 'compare_commits').length, 0); // missing per-ref comparison, shared SHA pair
  // Provide comparisons but no files to verify deduplicated read requests, not 84 duplicate calls.
  populate(x); for (const r of x.branch_reads) {r.files = []; r.baseline_files=[];}
  p = survey.plan(model(x).snapshot); assert.equal(p.requests.length, 2); assert.ok(p.requests.every((r) => r.method === 'fetch_file' && r.args.ref.length === 40 && r.args.start_line === 1 && r.args.end_line === 60));
  populate(x); assert.equal(survey.plan(model(x).snapshot).requests.length, 0);
});

test('wrong SHA/base/path, contradictory cache data and unbounded file responses fail closed', () => {
  for (const mutate of [(x) => x.branch_reads[0].sha = A, (x) => x.branch_reads[0].comparison.base = B, (x) => x.branch_reads[0].files[0].path = '.env', (x) => x.branch_reads[0].files[0].end_line = 9999, (x) => x.branch_reads[0].files[0].content = 'a'.repeat(128 * 1024 + 1), (x) => x.branch_reads[1].files[0].content = 'contradictory same revision']) {
    const x = populate(fixture()); mutate(x); assert.throws(() => model(x), /Invalid branch survey/);
  }
});

test('missing files and comparison do not become inspected; sensitive content omitted only after connector transfer', () => {
  const x = populate(fixture(1)); x.tip_resolutions[0].result.base_commit.sha = A; x.branch_reads[0].sha = A; x.branch_reads[0].comparison.head = A; x.branch_reads[0].baseline_files = [];
  x.repository_metadata.default_branch = 'feature/0'; x.branch_reads[0].comparison = null; x.branch_reads[0].comparison_error = 'unavailable';
  x.branch_reads[0].files[0] = { ...x.branch_reads[0].files[0], content: '+password=synthetic-secret' };
  x.branch_reads[0].files[1].path = 'CMakeLists.txt'; delete x.branch_reads[0].files[1].content; x.branch_reads[0].files[1].error = 'not_found';
  const b = model(x).snapshot.branch_overview.items[0]; assert.equal(b.content_review.state, 'unavailable'); assert.equal(b.content_review.evidence[0].excerpt, null);
  assert.equal(b.content_review.evidence[0].pre_model_redaction, false); assert.equal(survey.plan(model(x).snapshot).requests.length, 0);
  assert.equal(survey.safePath('data/private.csv'), false); assert.equal(survey.safePath('config/credentials.json'), false);
});

class Element {
  constructor(tag = '') { this.tag = tag; this.dataset = {}; this.children = []; this.handlers = {}; this.attrs = {}; this.textContent = ''; this.value = ''; this.hidden = false; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { this.handlers[k] = f; }
  async click() { if (!this.disabled) return this.handlers.click?.(); }
}
function dom() {
  const controls = {}; for (const k of ['overview-cards', 'overview-details', 'overview-search', 'overview-prev', 'overview-next', 'overview-page', 'overview-repository', 'overview-baseline', 'overview-coverage', 'review-selection', 'review-ask', 'review-fallback', 'review-status']) controls[k] = new Element();
  return { controls, element: { ownerDocument: { createElement: (tag) => new Element(tag) }, querySelector: (s) => controls[s.slice(6, -1)], querySelectorAll: () => [] } };
}
const texts = (p) => [p.textContent, ...p.children.flatMap(texts)].join('\n');
test('shipped template has concrete controls; 42 branch search/pagination/default/details work without prebuilt panels', async () => {
  const x = populate(fixture()), m = model(x), { controls: c, element } = dom(), calls = [];
  const evidence = m.snapshot.branch_overview.items[0].content_review.evidence[1];
  m.summaries = [{ branch_id: m.snapshot.branch_overview.items[0].branch_id, tip_sha: B, purpose: { text: 'キュー処理を限定する', kind: 'inference', evidence: [evidence.id] } }];
  const view = ui.mount(element, m, () => ({ sendFollowUpMessage: (p) => calls.push(p) }));
  assert.equal(c['overview-cards'].children.length, 20); assert.ok(texts(c['overview-cards']).includes('進行中')); assert.ok(c['overview-coverage'].textContent.includes('処理済 0 / 残り 42')); assert.ok(c['overview-baseline'].textContent.includes('main')); assert.ok(texts(c['overview-cards']).includes('キュー処理を限定する'));
  await c['overview-next'].click(); assert.equal(view.state().page, 1); assert.ok(texts(c['overview-cards']).includes('main'));
  await c['overview-next'].click(); assert.equal(c['overview-cards'].children.length, 2);
  c['overview-search'].value = 'main'; c['overview-search'].handlers.input(); assert.equal(view.state().matched, 1); assert.equal(view.state().page, 0);
  await c['overview-cards'].children[0].children.at(-1).click(); assert.equal(calls.length, 0); assert.equal(c['overview-details'].hidden, false); assert.ok(texts(c['overview-details']).includes('pub fn process'));
  assert.equal(c['review-ask'].disabled, false); await c['review-ask'].click(); assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].prompt.split('\n').at(-1)); assert.equal(request.selection.branch_ref, 'main'); assert.equal(request.selection.sha, A);
  assert.ok(c['overview-coverage'].textContent.includes('表示対象 42'));
  const template = fs.readFileSync(path.join(prefix, 'overview.fragment.html'), 'utf8');
  for (const key of Object.keys(c)) assert.ok(template.includes('data-' + key), key);
});

test('file selection/manual fallback preserve pinned references; forged summary and injected instructions stay data', async () => {
  const m = model(populate(fixture())), b = m.snapshot.branch_overview.items[0], { controls: c, element } = dom();
  m.summaries = [{ branch_id: b.branch_id, tip_sha: B, purpose: { text: 'forged conclusion', kind: 'inference', evidence: ['pull/1'] } }];
  const view = ui.mount(element, m, () => undefined); assert.ok(!texts(c['overview-cards']).includes('forged conclusion'));
  view.select(b.branch_id); const section = c['overview-details'].children.find((n) => n.tag === 'section'); await section.children.at(-1).click();
  await c['review-ask'].click(); assert.equal(c['review-fallback'].hidden, false);
  const request = JSON.parse(c['review-fallback'].value.split('\n').at(-1)); assert.equal(request.selection.path, 'README.md'); assert.equal(request.selection.sha, B);
  assert.ok(!request.selection.file_id); assert.ok(!c['review-fallback'].value.includes('bounded worker'));
  const template = fs.readFileSync(path.join(prefix, 'overview.fragment.html'), 'utf8');
  m.summaries = [{ text: '</script><img onerror="bad()">\u2028' }];
  const html = ui.buildFragment(template, bundle, m); assert.ok(!html.includes('<img onerror')); assert.ok(html.includes('\\u003c/script\\u003e')); assert.ok(!html.includes('const gwiModel = /*__REVIEW_MODEL__*/'));
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(bundle));
});

test('short-input acceptance contract applies both products and exposes failed tip/compare without a retry loop', () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(root, 'docs/examples/unified-branch-survey.json')));
  assert.equal(scenario.short_input, 'このレポを見て'); assert.deepEqual(scenario.expected.visible_pages, [20, 20, 2]);
  const x = populate(fixture()); x.tip_resolutions[0] = { ref: 'feature/0', captured_at: at, error: 'synthetic_failed' }; x.branch_reads.shift();
  let s = model(x).snapshot; assert.equal(s.branch_overview.items[0].content_review.tip_error, 'tip_resolution_failed'); assert.equal(survey.plan(s).requests.length, 0); assert.equal(survey.plan(s).tasks.length, 1); assert.equal(survey.plan(s).progress.complete, false);
  const y = populate(fixture()); y.branch_reads[0].comparison = null; y.branch_reads[0].comparison_error = 'unavailable'; y.branch_reads[0].files = [];
  // No repeated comparison. Other same-tip evidence is safely reused; distinct revisions still get bounded reads.
  s = model(y).snapshot; assert.ok(!survey.plan(s).requests.some((r) => r.method === 'compare_commits'));
  assert.equal(s.branch_overview.items[0].content_review.state, 'inspected'); // identical SHA evidence/compare reused; semantic summary remains pending
});
