use github_work_inspector::{
    changes::{self, Mode, Options},
    client::{Api, Page},
    envelope, mcp, render, Error, Repo,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
fn hash(c: char) -> String {
    c.to_string().repeat(40)
}
fn file(status: &str, name: &str) -> Value {
    json!({"filename":name,"status":status,"additions":2,"deletions":1,"changes":3,"patch":"@@ -1 +1 @@\n-old\n+<demo>&\"quoted\""})
}
fn page(files: Vec<Value>, next: bool, parents: usize) -> Page {
    Page {
        data: json!({"sha":hash('a'),"commit":{"message":"Synthetic subject\nbody is not returned"},"parents":(0..parents).map(|_|json!({"sha":hash('b')})).collect::<Vec<_>>(),"stats":{"additions":2,"deletions":1,"total":3},"files":files}),
        next,
        observed_at: "2026-01-01T00:00:00Z".into(),
    }
}
struct Fake {
    pages: VecDeque<Result<Page, Error>>,
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
    fn get(&mut self, path: &str) -> Result<Page, Error> {
        self.paths.push(path.into());
        self.pages.pop_front().expect("Unexpected GET")
    }
}
fn repo() -> Repo {
    Repo::parse("example/project").unwrap()
}
#[test]
fn selected_commit_metadata_pages_and_one_file_patch() {
    let mut api = Fake::new(vec![
        page(vec![file("added", "src/new.rs")], true, 1),
        page(vec![file("modified", "src/main.rs")], true, 1),
    ]);
    let opts = Options {
        limit: 2,
        ..Default::default()
    };
    let (v, partial) = changes::inspect(&mut api, &repo(), &hash('a'), &opts).unwrap();
    assert!(!partial);
    assert_eq!(v["files"].as_array().unwrap().len(), 2);
    assert!(v["patch"].is_null());
    assert!(!v.to_string().contains("<demo>"));
    assert!(!v.to_string().contains("body is not returned"));
    assert_eq!(v["coverage"]["next_file_index"], 2);
    assert_eq!(v["coverage"]["complete_file_listing"], false);
    assert_eq!(
        api.paths,
        vec![
            format!(
                "repos/example/project/commits/{}?per_page=1&page=1",
                hash('a')
            ),
            format!(
                "repos/example/project/commits/{}?per_page=1&page=2",
                hash('a')
            )
        ]
    );
    let mut api = Fake::new(vec![page(vec![file("modified", "src/main.rs")], false, 1)]);
    let (v, _) = changes::inspect(
        &mut api,
        &repo(),
        &hash('a'),
        &Options {
            mode: Mode::Patch,
            file_id: Some(changes::file_id(&hash('a'), "src/main.rs")),
            file_index: 7,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(api.paths.len(), 1);
    assert!(api.paths[0].ends_with("per_page=1&page=8"));
    assert!(v["patch"]["text"].as_str().unwrap().contains("<demo>"));
    assert!(v["patch"]["html_escaped"]
        .as_str()
        .unwrap()
        .contains("&lt;demo&gt;&amp;&quot;"));
    assert_eq!(v["patch"]["api_completeness"], "not_guaranteed");
    let mut wrong = Fake::new(vec![page(vec![file("modified", "different.rs")], false, 1)]);
    assert!(changes::inspect(
        &mut wrong,
        &repo(),
        &hash('a'),
        &Options {
            mode: Mode::Patch,
            file_id: Some(changes::file_id(&hash('a'), "src/main.rs")),
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(wrong.paths.len(), 1);
    let human = render::human(&envelope("commit_details", v, true));
    assert!(human.contains("Selected API patch"));
    assert!(human.contains("+<demo>"));
}
#[test]
fn rename_removed_root_and_merge_provenance() {
    for (parents, status) in [
        (1, "renamed"),
        (1, "removed"),
        (0, "added"),
        (2, "modified"),
    ] {
        let mut f = file(status, "dir/new name.rs");
        if status == "renamed" {
            f["previous_filename"] = json!("dir/old name.rs");
        }
        let mut api = Fake::new(vec![page(vec![f], false, parents)]);
        let (v, _) = changes::inspect(
            &mut api,
            &repo(),
            &hash('a'),
            &Options {
                mode: Mode::Patch,
                file_id: Some(changes::file_id(&hash('a'), "dir/new name.rs")),
                ..Default::default()
            },
        )
        .unwrap();
        let f = &v["files"][0];
        assert_eq!(f["new_blob_url"].is_null(), status == "removed");
        assert_eq!(
            f["old_blob_url"].is_null(),
            parents != 1 || status == "added"
        );
        if status == "renamed" {
            assert!(f["old_blob_url"]
                .as_str()
                .unwrap()
                .ends_with("/dir/old%20name.rs"));
        }
        if parents == 2 {
            assert_eq!(
                v["commit"]["comparison"]["kind"],
                "github_commit_api_merge_parent_unspecified"
            );
            assert_eq!(v["patch"]["merge_parent_basis_unverified"], true);
        }
        assert!(v["commit"]["url"].as_str().unwrap().contains(&hash('a')));
    }
}
#[test]
fn unavailable_sensitive_and_bounded_patch_are_explicit() {
    let mut cases = vec![
        file("modified", "image.bin"),
        file("modified", ".env"),
        file("modified", "src/main.rs"),
        file("modified", "src/main.rs"),
    ];
    cases[0].as_object_mut().unwrap().remove("patch");
    cases[2]["patch"] = json!(format!("+{}{}", ["gh", "p_"].concat(), "X".repeat(30)));
    cases[3]["patch"] = json!(format!("+gh\u{2066}p_{}", "X".repeat(30)));
    for f in cases {
        let id = changes::file_id(&hash('a'), f["filename"].as_str().unwrap());
        let mut api = Fake::new(vec![page(vec![f], false, 1)]);
        let (v, _) = changes::inspect(
            &mut api,
            &repo(),
            &hash('a'),
            &Options {
                mode: Mode::Patch,
                file_id: Some(id),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(v["patch"]["text"].is_null());
        assert!(v["patch"]["omission_reason"].is_string());
        assert!(!v.to_string().contains(&"X".repeat(30)));
        assert!(v["patch"]["binary"].is_null());
    }
    let mut f = file("modified", "main.rs");
    f["patch"] = json!("+日\u{1b}\u{2066}\n+日\n+日");
    let mut api = Fake::new(vec![page(vec![f], false, 1)]);
    let (v, _) = changes::inspect(
        &mut api,
        &repo(),
        &hash('a'),
        &Options {
            mode: Mode::Patch,
            file_id: Some(changes::file_id(&hash('a'), "main.rs")),
            patch_bytes: 6,
            patch_lines: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(v["patch"]["truncated"], true);
    assert_eq!(v["patch"]["controls_removed"], true);
    assert!(v["patch"]["text"].as_str().unwrap().len() <= 6);
    let mut f = file("modified", "main.rs");
    f["patch"] = json!("x".repeat(512 * 1024 + 1));
    let mut api = Fake::new(vec![page(vec![f], false, 1)]);
    let (v, _) = changes::inspect(
        &mut api,
        &repo(),
        &hash('a'),
        &Options {
            mode: Mode::Patch,
            file_id: Some(changes::file_id(&hash('a'), "main.rs")),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        v["patch"]["omission_reason"],
        "patch_exceeds_safe_scan_limit"
    );
}
#[test]
fn partial_limits_and_unknown_tool_arguments_never_expand_access() {
    let mut api = Fake::new(vec![page(vec![file("modified", "main.rs")], true, 1)]);
    api.pages.push_back(Err(Error::new("timeout")));
    let (v, p) = changes::inspect(&mut api, &repo(), &hash('a'), &Options::default()).unwrap();
    assert!(p);
    assert_eq!(v["coverage"]["requests"], 2);
    assert!(v["coverage"]["has_more"].is_null());
    assert_eq!(v["error"]["code"], "timeout");
    let mut api = Fake::new(vec![]);
    assert!(changes::inspect(&mut api, &repo(), "deadbee", &Options::default()).is_err());
    assert!(changes::inspect(
        &mut api,
        &repo(),
        &hash('a'),
        &Options {
            file_index: 3000,
            ..Default::default()
        }
    )
    .is_err());
    assert!(api.paths.is_empty());
    for args in [
        json!({"repository":"example/project","sha":"deadbee"}),
        json!({"repository":"example/project","sha":hash('a'),"file":"../../private"}),
        json!({"repository":"example/project","sha":hash('a'),"file_index":3000}),
        json!({"repository":"example/project","sha":hash('a'),"mode":"execute"}),
    ] {
        assert!(mcp::parse("repository_commit", args.as_object().unwrap().clone()).is_err());
    }
    let mut api = Fake::new(vec![page(vec![file("modified", "last.rs")], false, 1)]);
    let (v, _) = changes::inspect(
        &mut api,
        &repo(),
        &hash('a'),
        &Options {
            file_index: 2999,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(v["coverage"]["has_more"].is_null());
    assert_eq!(v["coverage"]["stopped_reason"], "api_3000_file_cap");
}

#[test]
fn semantic_review_fixture_preserves_evidence_without_inventing_intent() {
    let source: Value =
        serde_json::from_str(include_str!("../docs/examples/semantic-commit.json")).unwrap();
    let reference = source["sha"].as_str().unwrap();
    let mut api = Fake::new(vec![Page {
        data: source.clone(),
        next: false,
        observed_at: "2026-01-01T00:00:00Z".into(),
    }]);
    let (value, partial) = changes::inspect(
        &mut api,
        &repo(),
        reference,
        &Options {
            mode: Mode::Patch,
            file_id: Some(changes::file_id(reference, "src/settings.rs")),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!partial);
    assert_eq!(value["commit"]["sha"], reference);
    assert_eq!(value["files"][0]["filename"], "src/settings.rs");
    assert_eq!(value["files"][0]["index"], 0);
    assert_eq!(value["patch"]["text"], source["files"][0]["patch"]);
    assert_eq!(value["patch"]["truncated"], false);
    assert_eq!(value["inferences"], json!([]));
    assert!(value["commit"].get("verified_intent").is_none());
}
