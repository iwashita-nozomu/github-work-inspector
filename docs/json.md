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
`pull_checks`. A root failure gives exit 1. Section errors give exit 3 and `ok:false`.
Expected scope limits alone give exit 0; they do not imply full coverage.

- branch: `name`, `sha`, `protected`.
- DAG node: `sha`, `parents`, sanitized first-line `subject`, `committed_at`.
  `dag.nodes` is deduplicated and SHA sorted. `outside_window_parents` enumerates
  observed parent SHAs absent from nodes. `per_branch` records branch/tip and its
  commit section. An empty parent list is an observed root commit. A missing
  parent node is not an assertion that the parent is absent from GitHub.
- Issue: `number`, `title`, `state`, nullable `state_reason`, `updated_at`, `url`.
- PR: `number`, `title`, `state`, `draft`, nullable `merged_at`, `updated_at`,
  `head_sha`, `head_branch`, `base_branch`, `url`. A closed PR with null merged date
  must not be reported as merged.
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
