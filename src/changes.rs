//! Selected immutable commit/file observations. Never request a whole-commit diff.
use crate::{client::Api, sha, text, Error, Repo, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const FILE_CAP: usize = 3000;
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Mode {
    Files,
    Patch,
}
#[derive(Clone, Debug)]
pub struct Options {
    pub mode: Mode,
    pub file_id: Option<String>,
    pub file_index: usize,
    pub limit: usize,
    pub patch_lines: usize,
    pub patch_bytes: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            mode: Mode::Files,
            file_id: None,
            file_index: 0,
            limit: 10,
            patch_lines: 120,
            patch_bytes: 16384,
        }
    }
}
impl Options {
    pub fn validate(&self) -> Result<()> {
        if self.file_index >= FILE_CAP
            || !(1..=20).contains(&self.limit)
            || !(1..=400).contains(&self.patch_lines)
            || !(1..=65536).contains(&self.patch_bytes)
        {
            return Err(Error::new("invalid_arguments"));
        }
        match (&self.mode, &self.file_id) {
            (Mode::Files, None) => {}
            (Mode::Patch, Some(id))
                if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return Err(Error::new("invalid_arguments")),
        }
        Ok(())
    }
}
pub fn file_id(reference: &str, filename: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(reference.to_ascii_lowercase().as_bytes());
    digest.update([0]);
    digest.update(filename.as_bytes());
    format!("{:x}", digest.finalize())
}
pub fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| Error::new("invalid_response"))
}
fn file_url(repo: &Repo, reference: &str, raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.starts_with('/')
        || raw.contains('\\')
        || raw
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
        || text(raw) != raw
    {
        return None;
    }
    let mut encoded = String::new();
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    Some(format!("{}/blob/{reference}/{encoded}", repo.url()))
}
fn sensitive_path(value: &str) -> bool {
    value.split('/').any(|part| {
        let p = part.to_ascii_lowercase();
        p == ".env"
            || p.starts_with(".env.")
            || matches!(
                p.as_str(),
                ".ssh"
                    | ".aws"
                    | ".npmrc"
                    | ".pypirc"
                    | "credentials"
                    | "secrets"
                    | "id_rsa"
                    | "id_ed25519"
            )
            || p.ends_with(".pem")
            || p.ends_with(".key")
    })
}
fn patch(file: &Value, options: &Options, merge: bool) -> Value {
    let unavailable = |reason: &str| json!({"text":null,"html_escaped":null,"omission_reason":reason,"truncated":false,"binary":null,"api_completeness":"not_guaranteed"});
    let raw = match file.get("patch").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s,
        _ => return unavailable("api_patch_unavailable_binary_large_or_not_provided"),
    };
    if raw.len() > 512 * 1024 {
        return unavailable("patch_exceeds_safe_scan_limit");
    }
    if sensitive_path(file["filename"].as_str().unwrap_or(""))
        || file
            .get("previous_filename")
            .and_then(Value::as_str)
            .is_some_and(sensitive_path)
        || crate::has_sensitive_text(raw)
    {
        return unavailable("sensitive_content_or_path");
    }
    // Controls and bidi markers are display transformations; they are never commands.
    let clean: String = raw
        .chars()
        .filter(|c| (*c == '\n' || *c == '\t' || !c.is_control()) && !crate::is_bidi(*c))
        .collect();
    if crate::has_sensitive_text(&clean) {
        return unavailable("sensitive_content_or_path");
    }
    let mut shown = String::new();
    let mut lines = 1;
    for c in clean.chars() {
        if shown.len() + c.len_utf8() > options.patch_bytes
            || (c == '\n' && lines >= options.patch_lines)
        {
            break;
        }
        shown.push(c);
        if c == '\n' {
            lines += 1;
        }
    }
    let truncated = shown.len() < clean.len();
    json!({"text":shown,"html_escaped":html_escape(&shown),"omission_reason":null,"truncated":truncated,
        "local_limit_reason":if truncated {Some("line_or_byte_limit")}else{None},"controls_removed":clean!=raw,
        "binary":null,"api_completeness":"not_guaranteed","merge_parent_basis_unverified":merge})
}
fn metadata(value: &Value, repo: &Repo, expected: &str) -> Result<Value> {
    let actual = sha(value["sha"]
        .as_str()
        .ok_or_else(|| Error::new("invalid_response"))?)?;
    if actual != expected {
        return Err(Error::new("invalid_response"));
    }
    let raw = value["parents"]
        .as_array()
        .ok_or_else(|| Error::new("invalid_response"))?;
    let parents = raw
        .iter()
        .take(32)
        .map(|p| {
            sha(p["sha"]
                .as_str()
                .ok_or_else(|| Error::new("invalid_response"))?)
        })
        .collect::<Result<Vec<_>>>()?;
    let basis = match raw.len() {
        0 => "initial_commit_empty_tree",
        1 => "single_parent",
        _ => "github_commit_api_merge_parent_unspecified",
    };
    Ok(
        json!({"sha":actual,"url":format!("{}/commit/{actual}",repo.url()),"subject":text(value["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or("")),
        "parents":parents,"parent_count":raw.len(),"parents_truncated":raw.len()>32,
        "comparison":{"kind":basis,"parent_sha":if raw.len()==1 {parents.first()}else{None},"source":"GitHub commit JSON API","per_parent_comparison_performed":false},
        "stats":{"additions":number(&value["stats"],"additions")?,"deletions":number(&value["stats"],"deletions")?,"total":number(&value["stats"],"total")?}}),
    )
}
fn file(value: &Value, repo: &Repo, commit: &Value, index: usize, at: &str) -> Result<Value> {
    let raw = value["filename"]
        .as_str()
        .ok_or_else(|| Error::new("invalid_response"))?;
    let status = value["status"]
        .as_str()
        .ok_or_else(|| Error::new("invalid_response"))?;
    if !matches!(
        status,
        "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
    ) {
        return Err(Error::new("invalid_response"));
    }
    let previous = value.get("previous_filename").and_then(Value::as_str);
    let parent = commit["comparison"]["parent_sha"].as_str();
    let new_url = if status == "removed" {
        None
    } else {
        file_url(repo, commit["sha"].as_str().unwrap(), raw)
    };
    let old_path = if status == "renamed" {
        previous
    } else {
        Some(raw)
    };
    let old_url = if status == "added" {
        None
    } else {
        parent.and_then(|p| old_path.and_then(|n| file_url(repo, p, n)))
    };
    Ok(
        json!({"index":index,"file_id":file_id(commit["sha"].as_str().unwrap(),raw),"filename":text(raw),"filename_html":html_escape(&text(raw)),"status":status,"previous_filename":previous.map(text),
        "additions":number(value,"additions")?,"deletions":number(value,"deletions")?,"changes":number(value,"changes")?,
        "new_blob_url":new_url,"old_blob_url":old_url,"captured_at":at,"patch_available":value.get("patch").and_then(Value::as_str).is_some_and(|s| !s.is_empty())}),
    )
}
/// Each fixed GET requests at most one file's JSON patch; unselected patches are discarded.
pub fn inspect(
    api: &mut impl Api,
    repo: &Repo,
    reference: &str,
    options: &Options,
) -> Result<(Value, bool)> {
    options.validate()?;
    let reference = sha(reference).map_err(|_| Error::new("invalid_commit"))?;
    let limit = if options.mode == Mode::Patch {
        1
    } else {
        options.limit
    };
    let mut attempts = 0usize;
    let mut files = Vec::new();
    let mut commit = None;
    let mut selected_patch = Value::Null;
    let mut more = None;
    let mut error = None;
    let mut observed = Vec::new();
    let mut stopped = "requested_limit";
    for index in options.file_index..(options.file_index + limit).min(FILE_CAP) {
        let endpoint = format!(
            "{}/commits/{reference}?per_page=1&page={}",
            repo.endpoint(),
            index + 1
        );
        attempts += 1;
        let page = match api.get(&endpoint) {
            Ok(p) => p,
            Err(e) => {
                if commit.is_none() {
                    return Err(e);
                }
                error = Some(e);
                stopped = "request_failed";
                more = None;
                break;
            }
        };
        let current = metadata(&page.data, repo, &reference)?;
        if commit.as_ref().is_some_and(|c| c != &current) {
            return Err(Error::new("invalid_response"));
        }
        commit = Some(current.clone());
        observed.push(page.observed_at.clone());
        let values = page.data["files"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_response"))?;
        if values.len() > 1 {
            return Err(Error::new("invalid_response"));
        }
        more = Some(page.next);
        if let Some(raw) = values.first() {
            if options.mode == Mode::Patch {
                let name = raw["filename"]
                    .as_str()
                    .ok_or_else(|| Error::new("invalid_response"))?;
                if options.file_id.as_ref().map(|s| s.to_ascii_lowercase())
                    != Some(file_id(&reference, name))
                {
                    return Err(Error::new("invalid_response"));
                }
            }
            files.push(file(raw, repo, &current, index, &page.observed_at)?);
            if options.mode == Mode::Patch {
                selected_patch = patch(raw, options, current["parent_count"].as_u64().unwrap() > 1);
            }
        } else {
            stopped = "file_not_observed";
            break;
        }
        if !page.next {
            stopped = "api_page_end";
            break;
        }
    }
    let at_cap = options.file_index + files.len() >= FILE_CAP;
    if at_cap {
        stopped = "api_3000_file_cap";
        more = None;
    }
    let partial = error.is_some() || (options.mode == Mode::Patch && files.is_empty());
    Ok((
        json!({"review_core":crate::review::rust_provenance(),"repository":repo.0,"commit":commit,"files":files,"patch":selected_patch,
        "mode":if options.mode==Mode::Patch {"patch"}else{"files"},"coverage":{"start_index":options.file_index,"returned":files.len(),"requests":attempts,"successful_requests":observed.len(),"request_observed_at":observed,
        "has_more":more,"next_file_index":if more==Some(true){Some(options.file_index+files.len())}else{None},"complete_file_listing":options.file_index==0 && more==Some(false) && !partial && !at_cap,
        "stopped_reason":stopped,"api_file_cap":FILE_CAP,"total_files":null},"error":error,"partial":partial,"inferences":[],
        "text_handling":"Untrusted display data; controls removed, sensitive-looking patches omitted. html_escaped is display text, not executable HTML. JSON API may include one patch per requested file page; unselected patch text is discarded."}),
        partial,
    ))
}
