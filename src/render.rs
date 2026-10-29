use crate::text;
use serde_json::Value;
use std::fmt::Write;

fn s(v: &Value) -> String {
    v.as_str().map(text).unwrap_or_else(|| v.to_string())
}
fn short(v: &Value) -> String {
    s(v).chars().take(8).collect()
}
fn section(out: &mut String, name: &str, value: &Value) {
    let count = value["items"].as_array().map_or(0, Vec::len);
    let _ = writeln!(
        out,
        "{name}: {count}  [{}; observed {}]",
        s(&value["coverage"]["stopped_reason"]),
        s(&value["captured_at"])
    );
    if !value["error"].is_null() {
        let _ = writeln!(out, "  unavailable: {}", s(&value["error"]["code"]));
    }
    if let Some(items) = value["items"].as_array() {
        for item in items {
            if item.get("number").is_some() {
                let merged = if !item["merged_at"].is_null() && item.get("merged_at").is_some() {
                    " merged"
                } else {
                    ""
                };
                let _ = writeln!(
                    out,
                    "  #{} {}{} {}",
                    item["number"],
                    s(&item["state"]),
                    merged,
                    s(&item["title"])
                );
            } else if item.get("name_with_owner").is_some() {
                let _ = writeln!(
                    out,
                    "  {} ({})",
                    s(&item["name_with_owner"]),
                    s(&item["visibility"])
                );
            } else {
                let _ = writeln!(
                    out,
                    "  {} {} {} {}",
                    s(&item["id"]),
                    s(&item["name"]),
                    s(&item["status"]),
                    s(&item["conclusion"])
                );
            }
        }
    }
}

pub fn human(value: &Value) -> String {
    let mut out = String::new();
    if let Some(error) = value.get("error") {
        let _ = writeln!(out, "{}: {}", s(&error["code"]), s(&error["message"]));
        return out;
    }
    if let Some(repo) = value.get("repository") {
        let _=writeln!(out,"{} ({})\n{}\ndefault branch: {}  stars: {}  forks: {}  open issues incl PRs: {}\nobserved {}",
            s(&repo["name_with_owner"]),s(&repo["visibility"]),s(&repo["url"]),s(&repo["default_branch"]),repo["stars"],repo["forks"],repo["open_issues"],s(&value["captured_at"]));
    } else if let Some(snapshot) = value.get("snapshot") {
        let _ = writeln!(
            out,
            "{} ({})\nobserved {} .. {}; partial={} (non-atomic)",
            s(&snapshot["repository"]["name_with_owner"]),
            s(&snapshot["repository"]["visibility"]),
            s(&snapshot["started_at"]),
            s(&snapshot["finished_at"]),
            snapshot["partial"]
        );
        let _ = writeln!(
            out,
            "Branches [{}; observed {}]",
            s(&snapshot["branches"]["coverage"]["stopped_reason"]),
            s(&snapshot["branches"]["captured_at"])
        );
        if let Some(branches) = snapshot["branches"]["items"].as_array() {
            for branch in branches {
                let _ = writeln!(out, "  {} -> {}", s(&branch["name"]), short(&branch["sha"]));
            }
        }
        if !snapshot["branches"]["error"].is_null() {
            let _ = writeln!(
                out,
                "  unavailable: {}",
                s(&snapshot["branches"]["error"]["code"])
            );
        }
        let _ = writeln!(
            out,
            "DAG (observed child -> parent; SHA order; ? = outside window)"
        );
        let boundaries = snapshot["dag"]["outside_window_parents"].as_array();
        if let Some(nodes) = snapshot["dag"]["nodes"].as_array() {
            for node in nodes {
                let parents = node["parents"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| {
                        format!(
                            "{}{}",
                            short(p),
                            if boundaries.is_some_and(|b| b.contains(p)) {
                                "?"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let _ = writeln!(
                    out,
                    "  {} -> [{}] {}",
                    short(&node["sha"]),
                    parents,
                    s(&node["subject"])
                );
            }
        }
        if let Some(branches) = snapshot["dag"]["per_branch"].as_array() {
            for branch in branches {
                let _ = writeln!(
                    out,
                    "  {} commits: {}{}",
                    s(&branch["branch"]),
                    s(&branch["commits"]["coverage"]["stopped_reason"]),
                    if branch["commits"]["error"].is_null() {
                        String::new()
                    } else {
                        format!("; unavailable {}", s(&branch["commits"]["error"]["code"]))
                    }
                );
            }
        }
        section(&mut out, "Issues", &snapshot["issues"]);
        section(&mut out, "Pull requests", &snapshot["pull_requests"]);
        section(&mut out, "Workflow runs", &snapshot["workflow_runs"]);
        let _ = writeln!(
            out,
            "Checks (sampled open PRs; not a mergeability decision)"
        );
        if let Some(checks) = snapshot["pull_checks"]["items"].as_array() {
            for pr in checks {
                let _ = writeln!(
                    out,
                    "  PR #{} head {}",
                    pr["pull_number"],
                    short(&pr["head_sha"])
                );
                section(&mut out, "    Check runs", &pr["checks"]);
                let statuses = &pr["statuses"];
                let _ = writeln!(
                    out,
                    "    Commit statuses: {} [{}]",
                    s(&statuses["observed_summary"]["state"]),
                    s(&statuses["coverage"]["stopped_reason"])
                );
                if !statuses["error"].is_null() {
                    let _ = writeln!(out, "      unavailable: {}", s(&statuses["error"]["code"]));
                }
                if let Some(items) = statuses["items"].as_array() {
                    for item in items {
                        let _ =
                            writeln!(out, "      {} {}", s(&item["context"]), s(&item["state"]));
                    }
                }
            }
        }
        let _ = writeln!(
            out,
            "  unchecked open PRs in sample: {}",
            snapshot["pull_checks"]["unchecked_open_pulls_in_snapshot"]
        );
    } else if let Some(repos) = value.get("repositories") {
        section(&mut out, "Repositories", repos);
    } else if let Some(installation) = value.get("installation") {
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(installation).unwrap()
        );
    }
    out
}
