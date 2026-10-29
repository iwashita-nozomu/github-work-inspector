# Development instructions

Keep this project a Rust CLI for explicitly requested, read-only GitHub.com
repository inspection using existing `gh` authentication. Support bounded branch
and commit DAG snapshots, issues, pull requests, and CI observations.

- Validate `OWNER/REPO` before invoking `gh`. Use an argument array, no shell,
  a fixed host, a fixed GET endpoint, and a finite timeout.
- Return the versioned JSON envelope for results and errors. Do not expose raw
  subprocess output, exception details, tokens, or arbitrary API fields.
- Do not add a web server, listening port, browser credential storage, AI API
  call, or GUI. Mark pagination, missing data, observation times, and graph boundaries.
- Use synthetic fixtures. Do not commit personal information, conversation text,
  credentials, or captured private repository data.
- Keep the skill explicit-only. Installation may create managed user-level binary
  and skill files when requested; never overwrite unrelated files or auth settings.
- License is undecided. Do not add a LICENSE without an explicit choice.

Run cargo fmt --check, cargo clippy --locked --all-targets -- -D warnings,
cargo test --locked, and cargo build --locked --release. Tests must be offline;
explicit read-only smoke checks may use the existing GitHub account.
