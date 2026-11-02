# JSON contract v1

All commands with `--json` emit one object and no diagnostic stderr. Required root
keys are `schema_version: 1`, UTC `captured_at`, and boolean `ok`. Help/version are
plain text. Parse errors never echo supplied arguments.

Exactly one payload key is present:

- `repository`: metadata (same field names as the Python prototype).
- `repositories`: a repository-list section.
- `snapshot`: the bounded observation described below.
- `installation`: managed local installation result.
- `error`: fixed `{code,message}`; no raw exception, process stderr, or response.

Metadata keys: `name_with_owner`, `url`, `visibility`, `default_branch`, `archived`,
`disabled`, `is_template`, `language`, `stars`, `forks`, `open_issues`, `created_at`,
`updated_at`, `pushed_at`. Branch/language/pushed date may be null. `open_issues`
is GitHub's counter including PRs. URL is constructed from the validated canonical
name. Unknown API fields are dropped.

Every collection section contains:

```json
{"captured_at":"2026-01-01T00:00:00Z","items":[],"coverage":{"requested_limit":20,"max_pages":2,"pages_fetched":0,"items_seen":0,"items_skipped":0,"has_more":null,"fully_enumerated":false,"stopped_reason":"error"},"observed_summary":null,"error":{"code":"access_denied","message":"Existing authentication cannot read this resource."}}
```

`has_more` is boolean only when known from an observed Link header or omitted
accepted items. It becomes null on any section error. `stopped_reason` is `end`,
`limit`, `page_limit`, `error`, or `not_requested`. `fully_enumerated` means this
endpoint/filter was exhausted, not the entire repository. `items_seen` counts
processed API items, `items_skipped` counts intentionally filtered items. Successful
earlier pages survive a later error. `observed_summary` carries API `total_count`
or combined commit-status `state` when present, not a synthesized rollup.

Snapshot keys: requested/canonical repository, `repository_captured_at`,
`started_at`, `finished_at`, `atomic: false`, `partial`, `inferences: []`,
`text_handling`, `branches`, `dag`, `issues`, `pull_requests`, `workflow_runs`,
`pull_checks`, `branch_overview`. A root failure gives exit 1. Section/default-branch lookup errors give exit 3 and `ok:false`.
Expected scope limits alone give exit 0; they do not imply full coverage.

- branch: `name`, `branch_id` (SHA256 of original exact branch name), `sha`, `protected`.
  Display names are sanitized/truncated; identities are not derived from those labels.
- DAG node: `sha`, `parents`, sanitized first-line `subject`, `committed_at`.
  `dag.nodes` is deduplicated and SHA sorted. `outside_window_parents` enumerates
  observed parent SHAs absent from nodes. `per_branch` records branch/tip and its
  commit section. An empty parent list is an observed root commit. A missing
  parent node is not an assertion that the parent is absent from GitHub.
- Issue: `number`, `title`, `state`, nullable `state_reason`, `updated_at`, `url`.
- PR: `number`, `title`, `state`, `draft`, nullable `merged_at`, `updated_at`,
  `head_sha`, `head_branch`, `head_branch_id`, nullable `head_repository`, `base_branch`, `url`,
  nullable `body_excerpt` and its scope. The excerpt uses the existing text redaction,
  control removal and 240-character bound (plus ellipsis); it is untrusted author data,
  not the full body or verified intent. A closed PR with null merged date must not be reported as merged.
- workflow run: `id`, nullable `name`, `status`, nullable `conclusion`, `head_sha`,
  nullable `head_branch`, `event`, `created_at`, `updated_at`, `url`.
- `pull_checks.items`: `pull_number`, `head_sha`, `checks`, `statuses`.
  Check items: `id`, `name`, `status`, nullable `conclusion`/`started_at`/
  `completed_at`, `url`. Status items: `context`, `state`, `updated_at`.
  Sampling counts and scope are recorded alongside. No conclusion about required
  checks, mergeability, or issue completion is inferred.

This is a sequential observation, not a transaction. A section timestamp is the
latest successful page observation, or an attempt timestamp when none succeeded.
Text may be redacted/truncated; it is not suitable for reconstructing original
content. New additive fields may appear within v1. Breaking field/type/semantic
changes require a new schema version.

## Shared Work/Chat review core (development)

Snapshots and selected-commit observations add `review_core` with `contract_version`,
`adapter` and the capability profile authored in `core/contract.json`. The shared
[observation/selection schema](core-observation.schema.json) is additive to v1;
it does not replace repository-list, metadata, installation or error envelopes.
Work uses `rust_gh`. Chat's reference normalizer uses `chat_github`, with nullable
tips/parents and explicit lack of file-transfer bounds/pre-model redaction.
`parents:null` is unknown; `parents:[]` is an observed zero-parent commit.
Chat file identity is immutable SHA plus observed exact path, not an invented
Rust file_id. The shared selection code distinguishes adapters and rejects stale
view references or cross-adapter locators. See `CORE-LOCK.json` for generated
source consistency; this is not a signature or an execution guarantee.

## Branch overview evidence (additive v1)

`branch_overview` contains `items`, `baseline`, independent branch/PR coverage,
errors and observation timestamps, selection scope, `atomic:false`, `inferences:[]`.
Each item has exact `branch_id` and `tip_sha`, sampled `tip_commit`/`history`,
`comparison`, and sampled `related_pull_requests`. Host GPT supplies purpose and
differences separately; Rust does not generate semantic claims or infer branch families.
The overview inventory retains at most 100 names/tips already seen on fetched list pages,
independently of the smaller `branches` history-sample limit. `history_branch_count`
states how many bounded histories were requested; `history:null` means tip/list data
only. The overview does not fetch histories or patches for every listed branch.
`history.commit_shas` references the existing `dag.nodes`/`dag.per_branch` observations
without duplicating the full DAG; coverage/error/time remain attached to that history.

The repository's observed `default_branch` is preferred within already-fetched
branch pages. If missing and branches were requested, one fixed GET of the encoded
default branch is attempted, replacing the last sampled branch when the cap is full.
This never raises the requested branch count or per-branch commit/page limits.
`baseline.observation` gives its source/time/error. No request is made for a null
default branch or `branches=0`. Listing coverage remains coverage of the list endpoint;
the extra GET does not mean intervening pages or omitted branches were fetched.
The baseline is shown even when its tip is unavailable.

Comparison relations are `same_tip`, `branch_tip_reachable_from_baseline`,
`baseline_tip_reachable_from_branch`, `baseline_unobserved`, or
`unknown_in_bounded_graph`. Only positive paths use actual observed parent edges,
returned as `child_to_parent_evidence_path`; missing paths prove nothing outside
the finite DAG. `unmerged_changes:not_determined` and `ahead_behind:not_queried`
are intentional: no compare API, merge-base or content/squash/cherry-pick test occurs.
Related PRs require both exact branch identity and a matching canonical head repo;
forks/deleted or missing head repos are excluded. `head_matches_tip` distinguishes
stale PR heads. A merged PR alone never certifies current-tip integration.

API contracts: [branches](https://docs.github.com/en/rest/branches/branches),
[pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests).

## Selected commit/file (0.4.0)

`commit_details` contains repository, immutable commit metadata, observed file entries,
coverage, error, partial and inferences. File `index` is zero-based in the API's file order;
Patch mode also requires the observed `file_id` (SHA256 identity binding of commit/path);
a mismatched file is rejected without displaying its patch.
`coverage.next_file_index` is a bounded continuation, not proof of a complete repository.
`patch` is null in files mode. Patch mode returns a single selected file and bounded
`patch.text` / `html_escaped`, or an `omission_reason`. Local truncation is separate
from API completeness, which is always `not_guaranteed`. Missing patches do not prove
binary data. Merge parent basis is `github_commit_api_merge_parent_unspecified`, with
no claimed first-parent comparison. Only single-parent old blob URLs are generated.
No whole-commit diff is requested and API fields/raw logs are not forwarded wholesale.
