//! Derived evidence for a host-GPT branch overview. No requests or semantic inference.
use crate::{inspect::Section, Repo};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub fn default_branch_endpoint(repo: &Repo, name: &str) -> crate::Result<String> {
    if name.is_empty() || name.len() > 1024 || name.chars().any(char::is_control) {
        return Err(crate::Error::new("invalid_response"));
    }
    let encoded = name
        .as_bytes()
        .iter()
        .map(|b| format!("%{b:02X}"))
        .collect::<String>();
    Ok(format!("{}/branches/{encoded}", repo.endpoint()))
}

pub fn branch_id(name: &str) -> String {
    format!("{:x}", Sha256::digest(name.as_bytes()))
}

// A positive path is evidence. A missing path in a finite graph is never non-ancestry.
fn path(nodes: &BTreeMap<String, Value>, from: &str, to: &str) -> Option<Vec<String>> {
    let mut queue = VecDeque::from([from.to_string()]);
    let mut seen = BTreeSet::from([from.to_string()]);
    let mut previous = BTreeMap::<String, String>::new();
    while let Some(last) = queue.pop_front() {
        if last == to {
            let mut route = vec![last.clone()];
            let mut cursor = last;
            while let Some(parent) = previous.get(&cursor) {
                route.push(parent.clone());
                cursor.clone_from(parent);
            }
            route.reverse();
            return Some(route);
        }
        if let Some(parents) = nodes.get(&last).and_then(|v| v["parents"].as_array()) {
            for parent in parents.iter().filter_map(Value::as_str) {
                if seen.insert(parent.to_string()) {
                    previous.insert(parent.to_string(), last.clone());
                    queue.push_back(parent.to_string());
                }
            }
        }
    }
    None
}

pub fn build(
    repo: &Repo,
    default_branch: Option<&str>,
    baseline_observation: &Value,
    branches: &Section,
    histories: &[Value],
    nodes: &BTreeMap<String, Value>,
    pulls: &Section,
) -> Value {
    let default_id = default_branch.map(branch_id);
    let baseline = branches.items.iter().find(|b| {
        b["branch_id"]
            .as_str()
            .is_some_and(|id| Some(id) == default_id.as_deref())
    });
    let items = branches.items.iter().map(|branch| {
        let tip = branch["sha"].as_str().unwrap();
        let history = histories.iter().find(|h| h["branch_id"] == branch["branch_id"]);
        let history_ref = history.map(|h| json!({
            "commit_shas":h["commits"]["items"].as_array().unwrap().iter().map(|c| &c["sha"]).collect::<Vec<_>>(),
            "coverage":h["commits"]["coverage"],"captured_at":h["commits"]["captured_at"],"error":h["commits"]["error"],
        }));
        let (relation, route) = match baseline.and_then(|b| b["sha"].as_str()) {
            None => ("baseline_unobserved", None),
            Some(base) if base == tip => ("same_tip", Some(vec![tip.to_string()])),
            Some(base) => {
                if let Some(route) = path(nodes, base, tip) {
                    ("branch_tip_reachable_from_baseline", Some(route))
                } else if let Some(route) = path(nodes, tip, base) {
                    ("baseline_tip_reachable_from_branch", Some(route))
                } else {
                    ("unknown_in_bounded_graph", None)
                }
            }
        };
        let related = pulls.items.iter().filter(|pr| {
            pr["head_branch_id"] == branch["branch_id"]
                && pr["head_repository"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(&repo.0))
        }).map(|pr| json!({"pull":pr,"head_matches_tip":pr["head_sha"] == branch["sha"],
            "association":"same_repository_and_exact_head_ref"})).collect::<Vec<_>>();
        json!({"branch_id":branch["branch_id"],"name":branch["name"],"tip_sha":tip,
            "tip_commit":nodes.get(tip),"history":history_ref,
            "comparison":{"relation":relation,"child_to_parent_evidence_path":route,
                "unmerged_changes":"not_determined","ahead_behind":"not_queried"},
            "related_pull_requests":related,
            "pull_match_scope":"Sampled PRs with matching canonical head repository and exact branch identity only. Missing/deleted head repositories and forks are not associated. An empty list does not prove no PR exists. A merged PR does not prove the current tip was integrated."})
    }).collect::<Vec<_>>();
    json!({"items":items,
        "baseline":{"name":default_branch.map(crate::text),"branch_id":default_id,"tip_sha":baseline.map(|b| &b["sha"]),
            "observation":baseline_observation,
            "scope":"Observed default-branch tip only; no compare API, merge-base, content equivalence or squash/cherry-pick detection."},
        "branch_coverage":branches.coverage,"branch_error":branches.error,"branches_captured_at":branches.captured_at,
        "pull_coverage":pulls.coverage,"pull_error":pulls.error,"pulls_captured_at":pulls.captured_at,
        "history_branch_count":histories.len(),
        "inventory_scope":"At most 100 branch names/tips retained from already-fetched listing pages, plus the baseline within the same 100-item cap. This is not a complete repository claim; unretained/unfetched branches may exist. history:null means no dedicated history request for that branch.",
        "selection":"History sample: API order with default branch preferred; if absent from fetched pages, at most one fixed GET resolves it and replaces the last history-sampled branch. Requested history branch count is unchanged. Overview inventory does not cause extra history/diff requests; listing coverage does not cover the separate baseline GET.",
        "semantics":"Evidence only. Host GPT supplies purpose/differences separately with evidence and author_claim/inference/unknown labels. Names alone are not purpose or completion evidence.",
        "atomic":false,"inferences":[]})
}
