import contextlib
from datetime import datetime, timezone
import io
import json
import subprocess
import unittest
from unittest.mock import patch

from github_work_inspector import cli


def fixture():
    return {
        "full_name": "example/project", "private": False, "visibility": "public",
        "default_branch": "main", "archived": False, "disabled": False,
        "is_template": False, "language": "Python", "stargazers_count": 3,
        "forks_count": 2, "open_issues_count": 1,
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
        "pushed_at": None,
    }


class CliTests(unittest.TestCase):
    def invoke(self, args, *, response=None, exception=None):
        if response is None:
            response = subprocess.CompletedProcess([], 0, json.dumps(fixture()), "")
        out, err = io.StringIO(), io.StringIO()
        with patch.object(cli.subprocess, "run", return_value=response, side_effect=exception) as run:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = cli.main(args)
                except SystemExit as stop:
                    code = stop.code
        return code, out.getvalue(), err.getvalue(), run

    def test_fixed_get_and_success_envelope(self):
        before = datetime.now(timezone.utc)
        code, out, err, run = self.invoke(["repo", "example/project", "--json"])
        payload = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(payload["schema_version"], 1)
        self.assertTrue(payload["ok"])
        captured = datetime.fromisoformat(payload["captured_at"].replace("Z", "+00:00"))
        self.assertLess(abs((captured - before).total_seconds()), 2)
        self.assertEqual(payload["repository"]["name_with_owner"], "example/project")
        self.assertEqual(payload["repository"]["stars"], 3)
        command = run.call_args.args[0]
        self.assertEqual(command, [
            "gh", "api", "--hostname", "github.com", "--method", "GET",
            "--header", "Accept: application/vnd.github+json",
            "--header", "X-GitHub-Api-Version: 2022-11-28", "repos/example/project",
        ])
        options = run.call_args.kwargs
        self.assertIs(options["shell"], False)
        self.assertEqual(options["timeout"], 20)
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertTrue(options["capture_output"])
        self.assertEqual(options["env"]["GH_PROMPT_DISABLED"], "1")

    def test_invalid_identifiers_do_not_launch_subprocess(self):
        invalid = [
            "example", "example/", "/project", "example/a/b", "example/..", "example/.",
            "https://github.com/example/project", "example/a?x=1", "example/a#fragment",
            "example/%2e%2e", "example/a\\b", "example/a b", "example/a\nb",
            "example/a;id", "example/$(id)", "example/`id`", "-owner/project",
            "owner-/project", "two--names/project", "a" * 40 + "/project",
            "example/" + "a" * 101, "日本語/project",
        ]
        for value in invalid:
            with self.subTest(value=value):
                code, out, err, run = self.invoke(["repo", value, "--json"])
                self.assertEqual(code, 2)
                self.assertFalse(json.loads(out)["ok"])
                self.assertEqual(err, "")
                run.assert_not_called()

    def test_valid_boundary_identifiers(self):
        for value in ["a/b", "Mixed-Owner/.github", "a" * 39 + "/" + "b" * 100, "a/a_b.c-d"]:
            with self.subTest(value=value):
                self.assertEqual(cli.validate_repository(value), value)

    def test_argument_errors_are_static_json(self):
        for args in [[], ["other"], ["repo"], ["repo", "example/project", "--unknown-secret-value"]]:
            with self.subTest(args=args):
                code, out, err, run = self.invoke(args)
                self.assertEqual(code, 2)
                self.assertEqual(json.loads(out)["error"]["code"], "invalid_arguments")
                self.assertNotIn("unknown-secret-value", out + err)
                self.assertEqual(err, "")
                run.assert_not_called()

    def test_help_is_offline(self):
        for args in [["--help"], ["repo", "--help"]]:
            code, out, err, run = self.invoke(args)
            self.assertEqual(code, 0)
            self.assertIn("usage:", out)
            self.assertEqual(err, "")
            run.assert_not_called()

    def test_failures_never_forward_raw_output_or_exceptions(self):
        secret = "synthetic-secret-never-print"
        cases = [
            (subprocess.CompletedProcess([], 1, secret, secret), None, "gh_failed"),
            (None, subprocess.TimeoutExpired(["gh"], 20, output=secret, stderr=secret), "timeout"),
            (None, FileNotFoundError(secret), "gh_unavailable"),
            (None, PermissionError(secret), "gh_unavailable"),
            (None, UnicodeError(secret), "invalid_response"),
            (subprocess.CompletedProcess([], 0, secret, secret), None, "invalid_response"),
        ]
        for response, exception, expected in cases:
            with self.subTest(expected=expected, exception=type(exception).__name__):
                code, out, err, _ = self.invoke(
                    ["repo", "example/project", "--json"], response=response, exception=exception
                )
                payload = json.loads(out)
                self.assertEqual(code, 1)
                self.assertEqual(payload["schema_version"], 1)
                self.assertIn("captured_at", payload)
                self.assertEqual(payload["error"]["code"], expected)
                self.assertNotIn(secret, out + err)
                self.assertEqual(err, "")

    def test_unknown_api_fields_are_dropped(self):
        data = fixture()
        data.update({
            "description": "synthetic-secret-never-print", "owner": {"email": "synthetic-secret-never-print"},
            "temp_clone_token": "synthetic-secret-never-print",
            "html_url": "https://invalid.example/synthetic-secret-never-print",
        })
        response = subprocess.CompletedProcess([], 0, json.dumps(data), "synthetic-secret-never-print")
        code, out, err, _ = self.invoke(["repo", "example/project", "--json"], response=response)
        self.assertEqual(code, 0)
        self.assertNotIn("synthetic-secret-never-print", out + err)
        self.assertEqual(json.loads(out)["repository"]["url"], "https://github.com/example/project")

    def test_malformed_metadata_is_rejected(self):
        bad = [[], None, {}, {**fixture(), "full_name": None}, {**fixture(), "full_name": "a/.."}]
        for key, value in [
            ("visibility", []), ("visibility", "private"), ("private", "false"),
            ("archived", 0), ("stargazers_count", True), ("forks_count", -1),
            ("default_branch", "main\n"), ("language", 7),
            ("created_at", "2026-02-30T00:00:00Z"), ("pushed_at", "unexpected"),
        ]:
            bad.append({**fixture(), key: value})
        for data in bad:
            with self.subTest(data=data):
                response = subprocess.CompletedProcess([], 0, json.dumps(data), "")
                code, out, err, _ = self.invoke(["repo", "example/project", "--json"], response=response)
                self.assertEqual(code, 1)
                self.assertEqual(json.loads(out)["error"]["code"], "invalid_response")
                self.assertEqual(err, "")

    def test_private_and_internal_visibility(self):
        for visibility in ["private", "internal"]:
            data = {**fixture(), "private": True, "visibility": visibility}
            self.assertEqual(cli.metadata(data)["visibility"], visibility)

    def test_visibility_fallback(self):
        data = fixture()
        del data["visibility"]
        self.assertEqual(cli.metadata(data)["visibility"], "public")
        data["private"] = True
        self.assertEqual(cli.metadata(data)["visibility"], "private")

    def test_debug_logging_is_disabled_without_mutating_process_environment(self):
        with patch.dict(cli.os.environ, {"GH_DEBUG": "api"}):
            _, _, _, run = self.invoke(["repo", "example/project", "--json"])
            self.assertNotIn("GH_DEBUG", run.call_args.kwargs["env"])
            self.assertEqual(cli.os.environ["GH_DEBUG"], "api")


if __name__ == "__main__":
    unittest.main()
