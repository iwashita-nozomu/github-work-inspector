use std::process::Command;

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_github-work-inspector"))
}

#[test]
fn help_version_and_static_argument_errors() {
    for args in [
        vec!["--help"],
        vec!["inspect", "--help"],
        vec!["install", "--help"],
        vec!["commit", "--help"],
        vec!["--version"],
    ] {
        let out = cli().args(args).output().unwrap();
        assert!(out.status.success());
        assert!(out.stderr.is_empty());
    }
    for args in [
        vec!["--json", "--unknown=synthetic-secret"],
        vec!["commit", "example/project", "deadbee", "--json"],
        vec![
            "commit",
            "example/project",
            "deadbee",
            "--file-index",
            "3000",
            "--json",
        ],
        vec!["repo", "https://github.com/example/project", "--json"],
        vec!["inspect", "example/project", "--pages", "999", "--json"],
    ] {
        let out = cli().args(args).env("PATH", "").output().unwrap();
        assert_eq!(out.status.code(), Some(2));
        let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["ok"], false);
        assert!(!String::from_utf8_lossy(&out.stdout).contains("synthetic-secret"));
        assert!(out.stderr.is_empty());
    }
}

#[test]
fn missing_gh_is_a_json_error() {
    let out = cli()
        .args(["repo", "example/project", "--json"])
        .env("PATH", "")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["error"]["code"], "gh_unavailable");
    assert!(out.stderr.is_empty());
}

#[cfg(unix)]
#[test]
fn fake_gh_process_metadata_redaction_timeout_and_response_limit() {
    use std::os::unix::fs::PermissionsExt;
    use std::{
        fs,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "gwi-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let gh = root.join("gh");
    let response = root.join("response");
    fs::write(
        &response,
        format!(
            "HTTP/2.0 200 OK\n\n{}",
            include_str!("fixtures/metadata.json")
        ),
    )
    .unwrap();
    fs::write(&gh,"#!/bin/sh\nif [ \"$GWI_FAKE_MODE\" = timeout ]; then exec /bin/sleep 5; fi\nif [ \"$GWI_FAKE_MODE\" = failure ]; then echo 'synthetic-secret (HTTP 403)' >&2; exit 1; fi\n/bin/cat \"$GWI_FAKE_RESPONSE\"\necho 'synthetic-secret' >&2\n").unwrap();
    fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
    let invoke = |mode: &str| {
        cli()
            .args([
                "repo",
                "example/project",
                "--json",
                "--timeout-seconds",
                "1",
            ])
            .env("PATH", &root)
            .env("GWI_FAKE_RESPONSE", &response)
            .env("GWI_FAKE_MODE", mode)
            .output()
            .unwrap()
    };
    let out = invoke("success");
    assert!(out.status.success());
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["repository"]["name_with_owner"], "example/project");
    assert!(!String::from_utf8_lossy(&out.stdout).contains("synthetic"));
    assert!(out.stderr.is_empty());
    let out = invoke("failure");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("access_denied"));
    assert!(out.stderr.is_empty());
    let started = Instant::now();
    let out = invoke("timeout");
    assert!(started.elapsed().as_secs_f64() < 2.5);
    assert!(String::from_utf8_lossy(&out.stdout).contains("timeout"));
    fs::write(
        &response,
        vec![b'x'; (github_work_inspector::client::MAX_RESPONSE + 2) as usize],
    )
    .unwrap();
    let out = invoke("success");
    assert!(String::from_utf8_lossy(&out.stdout).contains("response_too_large"));
    fs::remove_dir_all(root).unwrap();
}
