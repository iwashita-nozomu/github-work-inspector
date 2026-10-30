use github_work_inspector::{
    changes,
    client::{Api, Page},
    mcp, Error,
};
use serde_json::{json, Value};

struct Observations {
    calls: Vec<String>,
}
impl Api for Observations {
    fn get(&mut self, path: &str) -> Result<Page, Error> {
        self.calls.push(path.into());
        Ok(Page {
            data: serde_json::from_str(include_str!("../docs/examples/semantic-commit.json"))
                .unwrap(),
            next: false,
            observed_at: "2026-01-01T00:00:00Z".into(),
        })
    }
}

#[test]
fn short_input_fixture_keeps_initial_history_separate_from_selected_patch() {
    // This validates reference/evidence flow, not GPT understanding of the Japanese request.
    let fixture: Value =
        serde_json::from_str(include_str!("../docs/examples/review-scenarios.json")).unwrap();
    assert_eq!(fixture["synthetic_only"], true);
    let case = &fixture["cases"][0];
    assert_eq!(case["expected_initial"]["patch_calls"], 0);
    let selection = &case["after_ask_file"];
    let reference = selection["sha"].as_str().unwrap();
    let mut api = Observations { calls: vec![] };
    let initial = mcp::parse(
        "repository_commit",
        json!({"repository":"example/project","sha":reference,"limit":5})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    let observed = mcp::execute(initial, &mut api).unwrap();
    assert!(observed["commit_details"]["patch"].is_null());
    assert!(!observed
        .to_string()
        .contains("pub const REQUEST_TIMEOUT_SECONDS"));
    assert_eq!(
        observed["commit_details"]["files"][0]["file_id"],
        selection["file_id"]
    );
    assert_eq!(
        selection["file_id"],
        changes::file_id(reference, "src/settings.rs")
    );
    assert_eq!(api.calls.len(), 1); // No automatic representative patch was fetched.
    let selected = mcp::parse("repository_commit", json!({"repository":"example/project","sha":reference,"mode":"patch","file_index":selection["file_index"],"file_id":selection["file_id"]}).as_object().unwrap().clone()).unwrap();
    let details = mcp::execute(selected, &mut api).unwrap();
    assert_eq!(api.calls.len(), 2);
    assert_eq!(details["commit_details"]["inferences"], json!([]));
    assert!(details["commit_details"]["patch"]["text"]
        .as_str()
        .unwrap()
        .contains("+pub const REQUEST_TIMEOUT_SECONDS: u64 = 20;"));
    assert!(api.calls.iter().all(
        |path| path == &format!("repos/example/project/commits/{reference}?per_page=1&page=1")
    ));
}
