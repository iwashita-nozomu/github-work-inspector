# Development instructions

Keep this project a small Python standard-library CLI for explicitly requested,
read-only GitHub repository inspection. The initial scope is one repository
metadata GET through an existing `gh` authentication on GitHub.com.

- Validate `OWNER/REPO` before invoking `gh`. Use an argument array, no shell,
  a fixed host, a fixed GET endpoint, and a finite timeout.
- Return the versioned JSON envelope for results and errors. Do not expose raw
  subprocess output, exception details, tokens, or arbitrary API fields.
- Do not add a web server, listening port, browser credential storage, or AI API
  call. Branches, DAGs, issues, pull requests, CI, and GUI are outside this version.
- Use synthetic fixtures. Do not commit personal information, conversation text,
  credentials, or captured private repository data.
- Keep the repo skill explicit-only. Do not change global skills or auth settings.
- License is undecided. Do not add a LICENSE without an explicit choice.

Run `python3 -m github_work_inspector --help` and
`python3 -m unittest discover -s tests -v` after code changes. Tests must be offline.
