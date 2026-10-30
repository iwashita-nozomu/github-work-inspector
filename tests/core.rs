use github_work_inspector::{
    client::{self, Api, Page},
    inspect::{self, Limits},
    install, render, text, Error, Repo,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn metadata() -> Value {
    serde_json::from_str(include_str!("fixtures/metadata.json")).unwrap()
}
fn page(data: Value, next: bool) -> Page {
    Page {
        data,
        next,
        observed_at: "2026-01-01T00:00:00Z".into(),
    }
}
fn hash(c: char) -> String {
    std::iter::repeat_n(c, 40).collect()
}
struct Fake {
    pages: VecDeque<github_work_inspector::Result<Page>>,
    paths: Vec<String>,
}
impl Fake {
    fn new(pages: Vec<Page>) -> Self {
        Self {
            pages: pages.into_iter().map(Ok).collect(),
            paths: vec![],
        }
    }
}
impl Api for Fake {
    fn get(&mut self, path: &str) -> github_work_inspector::Result<Page> {
        self.paths.push(path.into());
        self.pages.pop_front().expect("unexpected request")
    }
}
fn node(id: char, parents: &[char]) -> Value {
    json!({"sha":hash(id),"parents":parents.iter().map(|p|json!({"sha":hash(*p)})).collect::<Vec<_>>(),"commit":{"message":"fixture subject\nignored body","committer":{"date":"2026-01-01T00:00:00Z"}}})
}

#[test]
fn strict_identifiers() {
    for valid in [
        "a/b".to_string(),
        "Mixed-Owner/.github".into(),
        format!("{}/{}", "a".repeat(39), "b".repeat(100)),
    ] {
        assert!(Repo::parse(&valid).is_ok());
    }
    for invalid in [
        "example",
        "/repo",
        "a/..",
        "a/.",
        "a/a/b",
        "https://github.com/a/b",
        "a/a?x=1",
        "a/%2e%2e",
        "a/a#fragment",
        "a/a b",
        "a/a\nb",
        "a/a\\b",
        "a/$(id)",
        "a/`id`",
        "a/a;id",
        "a--b/c",
        "-a/b",
        "a-/b",
        "日本/a",
    ] {
        assert!(Repo::parse(invalid).is_err(), "{invalid}");
    }
    assert!(Repo::parse(&format!("{}/b", "a".repeat(40))).is_err());
    assert!(Repo::parse(&format!("a/{}", "b".repeat(101))).is_err());
}

#[test]
fn subprocess_is_fixed_get() {
    let command = client::command("repos/example/project");
    assert_eq!(command.get_program(), "gh");
    let args = command
        .get_args()
        .map(|s| s.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        args,
        vec![
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "--include",
            "--header",
            "Accept: application/vnd.github+json",
            "--header",
            "X-GitHub-Api-Version: 2022-11-28",
            "repos/example/project"
        ]
    );
    assert!(command
        .get_envs()
        .any(|(k, v)| k == "GH_DEBUG" && v.is_none()));
}

#[test]
fn headers_redirects_pagination_and_static_errors() {
    let p=client::parse_response(b"HTTP/2.0 301 Moved\r\nLocation: ignored\r\n\r\nHTTP/2.0 200 OK\r\nLink: <https://invalid.example>; rel=\"next\"\r\n\r\n[]").unwrap();
    assert!(p.next);
    assert_eq!(p.data, json!([]));
    assert!(client::parse_response(b"synthetic-secret").is_err());
    for (message, code) in [
        ("gh: synthetic-secret (HTTP 404)", "not_found"),
        ("synthetic-secret (HTTP 403)", "access_denied"),
        ("API rate limit synthetic-secret", "rate_limited"),
    ] {
        let e = client::classify_failure(message);
        assert_eq!(e.code, code);
        assert!(!e.message.contains("synthetic-secret"));
    }
}

#[test]
fn whitelist_and_display_sanitization() {
    let result = inspect::repository(&metadata()).unwrap();
    assert!(!result.to_string().contains("synthetic-never-output"));
    assert_eq!(result["url"], "https://github.com/example/project");
    let redacted=text("\u{1b}[31m API_KEY=fixturesecret Bearer fixture-token ghp_abcdefghijklmnopqrstuvwxyz \u{202e}");
    assert!(!redacted.contains("fixturesecret"));
    assert!(!redacted.contains("fixture-token"));
    assert!(!redacted.contains("ghp_"));
    assert!(!redacted.contains('\u{1b}'));
    assert!(!redacted.contains('\u{202e}'));
    assert!(text(&"a".repeat(1000)).chars().count() <= 241);
    for bad in [json!({}), json!([]), {
        let mut m = metadata();
        m["private"] = json!("false");
        m
    }] {
        assert!(inspect::repository(&bad).is_err());
    }
}

#[test]
fn pagination_filtering_limits_and_missing_data() {
    let mut api = Fake::new(vec![
        page(json!([{"pr":true}]), true),
        page(json!([1, 2, 3]), false),
    ]);
    let section = inspect::list(
        &mut api,
        "repos/example/project/issues?state=all",
        None,
        2,
        3,
        |v| Ok(if v.is_number() { Some(v.clone()) } else { None }),
    );
    assert_eq!(section.items, vec![json!(1), json!(2)]);
    assert_eq!(section.coverage.pages_fetched, 2);
    assert_eq!(section.coverage.items_skipped, 1);
    assert_eq!(section.coverage.has_more, Some(true));
    assert_eq!(section.coverage.stopped_reason, "limit");
    assert!(!section.coverage.fully_enumerated);
    assert!(api.paths[1].ends_with("&per_page=100&page=2"));
    let mut api = Fake {
        pages: VecDeque::from([Ok(page(json!([1]), true)), Err(Error::new("access_denied"))]),
        paths: vec![],
    };
    let section = inspect::list(&mut api, "repos/example/project/issues", None, 10, 2, |v| {
        Ok(Some(v.clone()))
    });
    assert_eq!(section.items.len(), 1);
    assert_eq!(section.coverage.has_more, None);
    assert!(section.error.is_some());
    let mut api = Fake::new(vec![page(json!([1]), true)]);
    let section = inspect::list(&mut api, "repos/example/project/issues", None, 10, 1, |v| {
        Ok(Some(v.clone()))
    });
    assert_eq!(section.coverage.stopped_reason, "page_limit");
    assert_eq!(section.coverage.has_more, Some(true));
}

#[test]
fn finite_dag_merge_dedup_and_ci_observations() {
    let mut api = Fake::new(vec![
        page(metadata(), false),
        page(
            json!([{"name":"main","commit":{"sha":hash('a')},"protected":true},{"name":"feature","commit":{"sha":hash('b')},"protected":false}]),
            false,
        ),
        page(json!([node('a', &['b', 'c']), node('b', &['d'])]), false),
        page(json!([node('b', &['d'])]), false),
        page(
            json!([{"pull_request":{}},{"number":1,"title":"Fixture issue","state":"open","state_reason":null,"updated_at":"2026-01-01T00:00:00Z"}]),
            false,
        ),
        page(
            json!([{"number":2,"title":"Fixture PR","state":"open","draft":false,"merged_at":null,"updated_at":"2026-01-01T00:00:00Z","head":{"sha":hash('b'),"ref":"feature"},"base":{"ref":"main"}}]),
            false,
        ),
        page(
            json!({"total_count":1,"workflow_runs":[{"id":3,"name":"CI","status":"completed","conclusion":"success","head_sha":hash('b'),"head_branch":"feature","event":"push","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}),
            false,
        ),
        page(
            json!({"total_count":1,"check_runs":[{"id":4,"name":"test","status":"completed","conclusion":"success","started_at":null,"completed_at":"2026-01-01T00:00:00Z"}]}),
            false,
        ),
        page(
            json!({"state":"pending","statuses":[{"context":"external CI","state":"pending","updated_at":"2026-01-01T00:00:00Z"}]}),
            false,
        ),
    ]);
    let (snapshot, partial) = inspect::snapshot(
        &mut api,
        &Repo::parse("example/project").unwrap(),
        &Limits::default(),
    )
    .unwrap();
    assert!(!partial);
    assert_eq!(snapshot["dag"]["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(
        snapshot["dag"]["outside_window_parents"],
        json!([hash('c'), hash('d')])
    );
    assert_eq!(snapshot["issues"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        snapshot["pull_checks"]["items"][0]["statuses"]["observed_summary"]["state"],
        "pending"
    );
    assert_eq!(snapshot["inferences"], json!([]));
    assert_eq!(snapshot["atomic"], false);
    assert!(api
        .paths
        .iter()
        .all(|p| !p.contains("merge") && !p.contains("logs")));
    let human = render::human(&github_work_inspector::envelope("snapshot", snapshot, true));
    assert!(human.contains("cccccccc?"));
    assert!(human.contains("pending"));
    assert!(!human.contains("ignored body"));
}

#[test]
fn partial_snapshot_preserves_other_sections() {
    let mut api = Fake::new(vec![page(metadata(), false)]);
    for code in [
        "access_denied",
        "access_denied", // separate bounded default-branch observation
        "timeout",
        "budget_exhausted",
        "rate_limited",
    ] {
        api.pages.push_back(Err(Error::new(code)));
    }
    let (snapshot, partial) = inspect::snapshot(
        &mut api,
        &Repo::parse("example/project").unwrap(),
        &Limits::default(),
    )
    .unwrap();
    assert!(partial);
    assert_eq!(snapshot["branches"]["error"]["code"], "access_denied");
    assert_eq!(
        snapshot["workflow_runs"]["coverage"]["has_more"],
        Value::Null
    );
    assert_eq!(snapshot["repository"]["name_with_owner"], "example/project");
}

fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "gwi-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&path).unwrap();
    path
}

#[test]
fn install_update_uninstall_and_preserve_user_edits() {
    let root = temp();
    let binary = root.join("bin/tool");
    let skill = root.join("skills/github-work-inspector");
    install::install_bytes(&binary, &skill, false, b"fixture-one").unwrap();
    assert_eq!(fs::read(&binary).unwrap(), b"fixture-one");
    assert!(install::install_bytes(&binary, &skill, false, b"fixture-two").is_err());
    install::install_bytes(&binary, &skill, true, b"fixture-two").unwrap();
    assert_eq!(fs::read(&binary).unwrap(), b"fixture-two");
    fs::write(skill.join("SKILL.md"), "user-edited").unwrap();
    assert!(
        fs::read_to_string(skill.join("references/review-selection.js"))
            .unwrap()
            .contains("sendFollowUpMessage")
    );
    assert!(install::install_bytes(&binary, &skill, true, b"fixture-three").is_err());
    assert!(install::uninstall(&binary, &skill).is_err());
    assert_eq!(
        fs::read_to_string(skill.join("SKILL.md")).unwrap(),
        "user-edited"
    );
    fs::remove_dir_all(&root).unwrap();
    let root = temp();
    let binary = root.join("bin/tool");
    let skill = root.join("skills/github-work-inspector");
    install::install_bytes(&binary, &skill, false, b"fixture").unwrap();
    install::uninstall(&binary, &skill).unwrap();
    assert!(!binary.exists());
    assert!(!skill.exists());
    fs::remove_dir_all(root).unwrap();
}

fn legacy_install(root: &std::path::Path, version: &str) -> (PathBuf, PathBuf) {
    let binary = root.join("bin/tool");
    let skill = root.join("skills/github-work-inspector");
    install::install_bytes(&binary, &skill, false, b"legacy-fixture").unwrap();
    fs::remove_file(skill.join("references/review-selection.js")).unwrap();
    fs::remove_dir(skill.join("references")).unwrap();
    let path = skill.join(".install.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["version"] = json!(version);
    manifest["files"]
        .as_object_mut()
        .unwrap()
        .remove("references/review-selection.js");
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    (binary, skill)
}

#[test]
fn released_two_file_skills_upgrade_without_bypassing_hash_checks() {
    for version in ["0.3.4", "0.4.0"] {
        let root = temp();
        let (binary, skill) = legacy_install(&root, version);
        install::install_bytes(&binary, &skill, true, b"upgraded-fixture").unwrap();
        assert_eq!(fs::read(&binary).unwrap(), b"upgraded-fixture");
        assert!(skill.join("references/review-selection.js").is_file());
        let manifest: Value =
            serde_json::from_slice(&fs::read(skill.join(".install.json")).unwrap()).unwrap();
        assert_eq!(manifest["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(manifest["files"].as_object().unwrap().len(), 3);
        install::uninstall(&binary, &skill).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn legacy_upgrade_still_preserves_edits_extra_files_and_unknown_versions() {
    for damage in [
        "edited_skill",
        "extra_file",
        "edited_binary",
        "unknown_version",
    ] {
        let root = temp();
        let (binary, skill) = legacy_install(&root, "0.4.0");
        match damage {
            "edited_skill" => fs::write(skill.join("SKILL.md"), b"user-edit").unwrap(),
            "extra_file" => fs::write(skill.join("user-note"), b"user-note").unwrap(),
            "edited_binary" => fs::write(&binary, b"user-binary").unwrap(),
            _ => {
                let path = skill.join(".install.json");
                let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                value["version"] = json!("9.9.9");
                fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
            }
        }
        let before_bin = fs::read(&binary).unwrap();
        let before_skill = fs::read(skill.join("SKILL.md")).unwrap();
        assert_eq!(
            install::install_bytes(&binary, &skill, true, b"new")
                .unwrap_err()
                .code,
            "install_conflict"
        );
        assert_eq!(fs::read(&binary).unwrap(), before_bin);
        assert_eq!(fs::read(skill.join("SKILL.md")).unwrap(), before_skill);
        assert!(!skill.join("references/review-selection.js").exists());
        if damage == "extra_file" {
            assert_eq!(fs::read(skill.join("user-note")).unwrap(), b"user-note");
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn unrelated_files_and_symlinks_are_preserved() {
    let root = temp();
    let binary = root.join("tool");
    let skill = root.join("skill");
    fs::write(&binary, b"unrelated").unwrap();
    assert!(install::install_bytes(&binary, &skill, false, b"fixture").is_err());
    assert_eq!(fs::read(&binary).unwrap(), b"unrelated");
    fs::remove_file(&binary).unwrap();
    install::install_bytes(&binary, &skill, false, b"fixture").unwrap();
    fs::write(skill.join("user-note"), "preserve").unwrap();
    assert!(install::uninstall(&binary, &skill).is_err());
    assert!(skill.join("user-note").exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinked_managed_file_is_not_updated_or_removed() {
    use std::os::unix::fs::symlink;
    let root = temp();
    let binary = root.join("bin/tool");
    let skill = root.join("skills/github-work-inspector");
    install::install_bytes(&binary, &skill, false, b"fixture").unwrap();
    let outside = root.join("outside-note");
    fs::write(&outside, "preserve").unwrap();
    fs::remove_file(skill.join("SKILL.md")).unwrap();
    symlink(&outside, skill.join("SKILL.md")).unwrap();
    assert!(install::uninstall(&binary, &skill).is_err());
    assert!(install::install_bytes(&binary, &skill, true, b"updated").is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "preserve");
    fs::remove_dir_all(root).unwrap();
}
