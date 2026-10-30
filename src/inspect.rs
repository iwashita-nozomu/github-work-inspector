use crate::client::Api;
use crate::{now, sha, text, Error, Repo, Result};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Coverage {
    pub requested_limit: usize,
    pub max_pages: usize,
    pub pages_fetched: usize,
    pub items_seen: usize,
    pub items_skipped: usize,
    pub has_more: Option<bool>,
    pub fully_enumerated: bool,
    pub stopped_reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Section {
    pub captured_at: String,
    pub items: Vec<Value>,
    pub coverage: Coverage,
    pub observed_summary: Option<Value>,
    pub error: Option<Error>,
}

impl Section {
    fn empty(limit: usize, pages: usize) -> Self {
        Self {
            captured_at: now(),
            items: vec![],
            observed_summary: None,
            error: None,
            coverage: Coverage {
                requested_limit: limit,
                max_pages: pages,
                pages_fetched: 0,
                items_seen: 0,
                items_skipped: 0,
                has_more: None,
                fully_enumerated: false,
                stopped_reason: "not_requested".into(),
            },
        }
    }
}

pub fn list<F>(
    api: &mut impl Api,
    endpoint: &str,
    key: Option<&str>,
    limit: usize,
    pages: usize,
    mut parse: F,
) -> Section
where
    F: FnMut(&Value) -> Result<Option<Value>>,
{
    let mut result = Section::empty(limit, pages);
    if limit == 0 {
        return result;
    }
    for page_number in 1..=pages {
        let separator = if endpoint.contains('?') { '&' } else { '?' };
        let path = format!("{endpoint}{separator}per_page=100&page={page_number}");
        let page = match api.get(&path) {
            Ok(page) => page,
            Err(error) => {
                result.error = Some(error);
                break;
            }
        };
        result.captured_at = page.observed_at;
        result.coverage.pages_fetched += 1;
        if page_number == 1 {
            if let Some(total) = page.data.get("total_count").and_then(Value::as_u64) {
                result.observed_summary = Some(json!({"total_count": total}));
            }
            if let Some(state) = page.data.get("state").and_then(Value::as_str) {
                result.observed_summary = Some(json!({"state": text(state)}));
            }
        }
        let array = key
            .map_or(Some(&page.data), |key| page.data.get(key))
            .and_then(Value::as_array);
        let Some(array) = array else {
            result.error = Some(Error::new("invalid_response"));
            break;
        };
        let mut overflow = false;
        for raw in array {
            result.coverage.items_seen += 1;
            match parse(raw) {
                Ok(Some(item)) if result.items.len() < limit => result.items.push(item),
                Ok(Some(_)) => overflow = true,
                Ok(None) => result.coverage.items_skipped += 1,
                Err(error) => {
                    result.error = Some(error);
                    break;
                }
            }
        }
        if result.error.is_some() {
            break;
        }
        result.coverage.has_more = Some(page.next || overflow);
        if overflow || (result.items.len() >= limit && page.next) {
            result.coverage.stopped_reason = "limit".into();
            break;
        }
        if !page.next {
            result.coverage.fully_enumerated = true;
            result.coverage.stopped_reason = "end".into();
            break;
        }
        result.coverage.stopped_reason = "page_limit".into();
    }
    if result.error.is_some() {
        result.coverage.has_more = None;
        result.coverage.fully_enumerated = false;
        result.coverage.stopped_reason = "error".into();
    }
    result
}

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("invalid_response"))
}
fn number(v: &Value, key: &str) -> Result<u64> {
    v.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::new("invalid_response"))
}
fn boolean(v: &Value, key: &str) -> Result<bool> {
    v.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| Error::new("invalid_response"))
}
fn nullable_text(v: &Value, key: &str) -> Result<Value> {
    match v.get(key) {
        Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(s)) => Ok(json!(text(s))),
        _ => Err(Error::new("invalid_response")),
    }
}
fn date(v: &Value, key: &str, nullable: bool) -> Result<Value> {
    if nullable && v.get(key).is_some_and(Value::is_null) {
        return Ok(Value::Null);
    }
    let s = string(v, key)?;
    DateTime::parse_from_rfc3339(s).map_err(|_| Error::new("invalid_response"))?;
    Ok(json!(s))
}

pub fn repository(v: &Value) -> Result<Value> {
    let canonical =
        Repo::parse(string(v, "full_name")?).map_err(|_| Error::new("invalid_response"))?;
    let private = boolean(v, "private")?;
    let visibility = v
        .get("visibility")
        .and_then(Value::as_str)
        .unwrap_or(if private { "private" } else { "public" });
    if !matches!(visibility, "public" | "private" | "internal")
        || (visibility == "public") == private
    {
        return Err(Error::new("invalid_response"));
    }
    Ok(json!({
        "name_with_owner": canonical.0, "url": canonical.url(), "visibility": visibility,
        "default_branch": nullable_text(v, "default_branch")?,
        "archived": boolean(v,"archived")?, "disabled": boolean(v,"disabled")?, "is_template": boolean(v,"is_template")?,
        "language": nullable_text(v,"language")?, "stars": number(v,"stargazers_count")?,
        "forks": number(v,"forks_count")?, "open_issues": number(v,"open_issues_count")?,
        "created_at": date(v,"created_at",false)?, "updated_at": date(v,"updated_at",false)?, "pushed_at": date(v,"pushed_at",true)?,
    }))
}

pub fn branch(v: &Value) -> Result<Option<Value>> {
    Ok(Some(
        json!({"name": text(string(v,"name")?), "branch_id": crate::overview::branch_id(string(v,"name")?), "sha": sha(string(&v["commit"],"sha")?)?, "protected": boolean(v,"protected")?}),
    ))
}
pub fn commit(v: &Value) -> Result<Option<Value>> {
    let parents = v
        .get("parents")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::new("invalid_response"))?
        .iter()
        .map(|p| sha(string(p, "sha")?))
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(
        json!({"sha": sha(string(v,"sha")?)?, "parents": parents,
            "subject": text(string(&v["commit"],"message")?.lines().next().unwrap_or("")),
            "committed_at": date(&v["commit"]["committer"],"date",false)?,
        }),
    ))
}
pub fn issue(v: &Value, repo: &Repo) -> Result<Option<Value>> {
    if v.get("pull_request").is_some() {
        return Ok(None);
    }
    let n = number(v, "number")?;
    Ok(Some(
        json!({"number": n, "title": text(string(v,"title")?), "state": text(string(v,"state")?),
            "state_reason": nullable_text(v,"state_reason")?, "updated_at": date(v,"updated_at",false)?,
            "url": format!("{}/issues/{n}",repo.url()),
        }),
    ))
}
pub fn pull(v: &Value, repo: &Repo) -> Result<Option<Value>> {
    let n = number(v, "number")?;
    let head_repository = v["head"]["repo"]["full_name"]
        .as_str()
        .and_then(|name| Repo::parse(name).ok())
        .map(|repo| repo.0);
    let body_excerpt = v.get("body").and_then(Value::as_str).map(text);
    Ok(Some(
        json!({"number": n, "title": text(string(v,"title")?), "state": text(string(v,"state")?),
            "draft": boolean(v,"draft")?, "merged_at": date(v,"merged_at",true)?, "updated_at": date(v,"updated_at",false)?,
            "head_sha": sha(string(&v["head"],"sha")?)?, "head_branch": text(string(&v["head"],"ref")?),
            "head_branch_id": crate::overview::branch_id(string(&v["head"],"ref")?),
            "head_repository": head_repository, "body_excerpt": body_excerpt,
            "body_excerpt_scope": "Sanitized/redacted excerpt, at most 240 characters plus ellipsis; may be missing. Author claims, not verified intent.",
            "base_branch": text(string(&v["base"],"ref")?), "url": format!("{}/pull/{n}",repo.url()),
        }),
    ))
}
pub fn check(v: &Value, repo: &Repo) -> Result<Option<Value>> {
    let id = number(v, "id")?;
    Ok(Some(
        json!({"id": id, "name": text(string(v,"name")?), "status": text(string(v,"status")?),
            "conclusion": nullable_text(v,"conclusion")?, "started_at": date(v,"started_at",true)?,
            "completed_at": date(v,"completed_at",true)?, "url": format!("{}/runs/{id}",repo.url()),
        }),
    ))
}
pub fn status(v: &Value) -> Result<Option<Value>> {
    Ok(Some(
        json!({"context": text(string(v,"context")?), "state": text(string(v,"state")?),
            "updated_at": date(v,"updated_at",false)?,
        }),
    ))
}
pub fn run(v: &Value, repo: &Repo) -> Result<Option<Value>> {
    let id = number(v, "id")?;
    Ok(Some(
        json!({"id": id, "name": nullable_text(v,"name")?, "status": text(string(v,"status")?),
            "conclusion": nullable_text(v,"conclusion")?, "head_sha": sha(string(v,"head_sha")?)?,
            "head_branch": nullable_text(v,"head_branch")?, "event": text(string(v,"event")?),
            "created_at": date(v,"created_at",false)?, "updated_at": date(v,"updated_at",false)?,
            "url": format!("{}/actions/runs/{id}",repo.url()),
        }),
    ))
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub branches: usize,
    pub commits: usize,
    pub issues: usize,
    pub pulls: usize,
    pub runs: usize,
    pub checked_pulls: usize,
    pub pages: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            branches: 6,
            commits: 12,
            issues: 20,
            pulls: 20,
            runs: 20,
            checked_pulls: 5,
            pages: 2,
        }
    }
}

pub fn snapshot(api: &mut impl Api, requested: &Repo, limits: &Limits) -> Result<(Value, bool)> {
    let started_at = now();
    let meta_page = api.get(&requested.endpoint())?;
    let meta = repository(&meta_page.data)?;
    let repo = Repo::parse(
        meta["name_with_owner"]
            .as_str()
            .ok_or_else(|| Error::new("invalid_response"))?,
    )?;
    let base = repo.endpoint();
    let mut default_tip = None;
    let mut overview_inventory = Vec::new();
    let branches_default = meta_page.data["default_branch"].as_str();
    let mut branches = list(
        api,
        &format!("{base}/branches"),
        None,
        limits.branches,
        limits.pages,
        |v| {
            let parsed = branch(v)?;
            if let Some(item) = &parsed {
                if overview_inventory.len() < 100
                    && !overview_inventory
                        .iter()
                        .any(|b: &Value| b["branch_id"] == item["branch_id"])
                {
                    overview_inventory.push(item.clone());
                }
            }
            if v["name"].as_str() == branches_default && branches_default.is_some() {
                default_tip = parsed.clone();
            }
            Ok(parsed)
        },
    );
    // Prefer the default branch only if seen on an already-fetched page. No extra GET.
    if let Some(tip) = default_tip {
        if !branches
            .items
            .iter()
            .any(|b| b["branch_id"] == tip["branch_id"])
        {
            if let Some(last) = branches.items.last_mut() {
                *last = tip;
            }
        }
    }
    let mut baseline_observation =
        json!({"source":"branch_list","captured_at":branches.captured_at,"error":null});
    if let Some(name) = branches_default.filter(|_| limits.branches > 0) {
        let default_id = crate::overview::branch_id(name);
        if !branches.items.iter().any(|b| b["branch_id"] == default_id) {
            // One bounded fixed GET when alphabetic listing/pagination omitted the baseline.
            let observed = crate::overview::default_branch_endpoint(&repo, name)
                .and_then(|endpoint| api.get(&endpoint))
                .and_then(|page| {
                    let parsed =
                        branch(&page.data)?.ok_or_else(|| Error::new("invalid_response"))?;
                    if parsed["branch_id"] != default_id {
                        return Err(Error::new("invalid_response"));
                    }
                    Ok((parsed, page.observed_at))
                });
            match observed {
                Ok((tip, captured_at)) => {
                    if branches.items.len() == limits.branches {
                        branches.items.pop();
                    }
                    branches.items.push(tip);
                    baseline_observation = json!({"source":"direct_branch_get","captured_at":captured_at,"error":null});
                }
                Err(error) => {
                    baseline_observation =
                        json!({"source":"direct_branch_get","captured_at":now(),"error":error});
                }
            }
        }
    }
    let mut branch_commits = Vec::new();
    let mut nodes = BTreeMap::new();
    let mut partial = branches.error.is_some() || !baseline_observation["error"].is_null();
    for tip in &branches.items {
        let commits = list(
            api,
            &format!("{base}/commits?sha={}", tip["sha"].as_str().unwrap()),
            None,
            limits.commits,
            limits.pages,
            commit,
        );
        partial |= commits.error.is_some();
        for node in &commits.items {
            nodes.insert(node["sha"].as_str().unwrap().to_string(), node.clone());
        }
        branch_commits.push(json!({"branch": tip["name"], "branch_id": tip["branch_id"], "tip": tip["sha"], "commits": commits}));
    }
    let boundary: BTreeSet<String> = nodes
        .values()
        .flat_map(|v| v["parents"].as_array().unwrap().iter())
        .filter_map(Value::as_str)
        .filter(|parent| !nodes.contains_key(*parent))
        .map(String::from)
        .collect();
    let issues = list(
        api,
        &format!("{base}/issues?state=all&sort=updated&direction=desc"),
        None,
        limits.issues,
        limits.pages,
        |v| issue(v, &repo),
    );
    let pulls = list(
        api,
        &format!("{base}/pulls?state=all&sort=updated&direction=desc"),
        None,
        limits.pulls,
        limits.pages,
        |v| pull(v, &repo),
    );
    let runs = list(
        api,
        &format!("{base}/actions/runs"),
        Some("workflow_runs"),
        limits.runs,
        limits.pages,
        |v| run(v, &repo),
    );
    partial |= issues.error.is_some() || pulls.error.is_some() || runs.error.is_some();
    let mut pull_checks = Vec::new();
    let open_count = pulls.items.iter().filter(|p| p["state"] == "open").count();
    for pr in pulls
        .items
        .iter()
        .filter(|p| p["state"] == "open")
        .take(limits.checked_pulls)
    {
        let head = pr["head_sha"].as_str().unwrap();
        let checks = list(
            api,
            &format!("{base}/commits/{head}/check-runs?filter=latest"),
            Some("check_runs"),
            100,
            limits.pages,
            |v| check(v, &repo),
        );
        let statuses = list(
            api,
            &format!("{base}/commits/{head}/status"),
            Some("statuses"),
            100,
            limits.pages,
            status,
        );
        partial |= checks.error.is_some() || statuses.error.is_some();
        pull_checks.push(json!({"pull_number": pr["number"], "head_sha": head, "checks": checks, "statuses": statuses}));
    }
    // Listing responses already contain up to 100 names/tips. Keep their overview
    // without multiplying history/diff requests by the inventory size.
    for item in &branches.items {
        if !overview_inventory
            .iter()
            .any(|b| b["branch_id"] == item["branch_id"])
        {
            if overview_inventory.len() == 100 {
                overview_inventory.pop();
            }
            overview_inventory.push(item.clone());
        }
    }
    let overview_branches = Section {
        items: overview_inventory,
        ..branches.clone()
    };
    let branch_overview = crate::overview::build(
        &repo,
        branches_default,
        &baseline_observation,
        &overview_branches,
        &branch_commits,
        &nodes,
        &pulls,
    );
    Ok((
        json!({
            "requested_repository": requested.0, "repository": meta, "repository_captured_at": meta_page.observed_at,
            "review_core": crate::review::rust_provenance(),
            "started_at": started_at, "finished_at": now(), "atomic": false,
            "partial": partial, "inferences": [], "text_handling": "Untrusted text; controls removed, common credentials redacted, limited to 240 characters. PR body excerpts only; no full bodies or logs.",
            "branches": branches,
            "branch_overview": branch_overview,
            "dag": {"nodes": nodes.into_values().collect::<Vec<_>>(), "outside_window_parents": boundary,
                "per_branch": branch_commits, "edge_direction": "child_to_parent", "ordering": "sha", "bounded": true},
            "issues": issues, "pull_requests": pulls, "workflow_runs": runs,
            "pull_checks": {"items": pull_checks, "requested_limit": limits.checked_pulls,
                "open_pulls_in_snapshot": open_count, "unchecked_open_pulls_in_snapshot": open_count.saturating_sub(limits.checked_pulls),
                "scope": "Only sampled open pull requests, using their observed head SHA. Required branch-protection rules and mergeability are not queried."},
        }),
        partial,
    ))
}

pub fn repositories(
    api: &mut impl Api,
    owner: Option<&str>,
    limit: usize,
    pages: usize,
) -> Result<Section> {
    let endpoint = if let Some(owner) = owner {
        Repo::parse(&format!("{owner}/placeholder"))?;
        format!("users/{owner}/repos?sort=pushed&type=all")
    } else {
        "user/repos?sort=pushed&affiliation=owner,collaborator,organization_member".into()
    };
    Ok(list(api, &endpoint, None, limit, pages, |v| {
        repository(v).map(Some)
    }))
}
