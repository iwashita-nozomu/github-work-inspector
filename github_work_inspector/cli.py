"""Fetch a fixed set of repository metadata without persisting the response."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import re
import subprocess
from typing import Any

SCHEMA_VERSION = 1
TIMEOUT_SECONDS = 20
_OWNER = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", re.ASCII)
_REPO = re.compile(r"[A-Za-z0-9_.-]{1,100}", re.ASCII)
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", re.ASCII)


class InspectionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def envelope(ok: bool, **payload: Any) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "ok": ok,
        **payload,
    }


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True, allow_nan=False))


def fail(code: str, message: str, exit_code: int = 1) -> int:
    emit(envelope(False, error={"code": code, "message": message}))
    return exit_code


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse messages may contain user-supplied values; never echo them.
        fail("invalid_arguments", "Invalid command or arguments. Use --help.", 2)
        raise SystemExit(2)


def validate_repository(value: str) -> str:
    parts = value.split("/") if isinstance(value, str) else []
    if len(parts) == 2:
        owner, repo = parts
        if (
            _OWNER.fullmatch(owner)
            and "--" not in owner
            and _REPO.fullmatch(repo)
            and repo not in {".", ".."}
        ):
            return value
    raise InspectionError("invalid_repository", "Expected a GitHub.com OWNER/REPO identifier.")


def _text(value: Any, *, nullable: bool = False, limit: int = 255) -> bool:
    return (nullable and value is None) or (
        isinstance(value, str)
        and 0 < len(value) <= limit
        and all(ord(c) >= 32 and ord(c) != 127 for c in value)
    )


def _timestamp(value: Any, *, nullable: bool = False) -> bool:
    if nullable and value is None:
        return True
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def metadata(data: Any) -> dict[str, Any]:
    invalid = InspectionError("invalid_response", "GitHub returned an invalid metadata response.")
    if not isinstance(data, dict):
        raise invalid
    try:
        name = validate_repository(data["full_name"])
        private = data["private"]
        visibility = data.get("visibility", "private" if private else "public")
        if type(private) is not bool or visibility not in {"public", "private", "internal"}:
            raise invalid
        if (visibility == "public") == private:
            raise invalid
        for key in ("archived", "disabled", "is_template"):
            if type(data[key]) is not bool:
                raise invalid
        for key in ("stargazers_count", "forks_count", "open_issues_count"):
            if type(data[key]) is not int or data[key] < 0:
                raise invalid
        if not _text(data["default_branch"], nullable=True) or not _text(data["language"], nullable=True):
            raise invalid
        if not _timestamp(data["created_at"]) or not _timestamp(data["updated_at"]):
            raise invalid
        if not _timestamp(data["pushed_at"], nullable=True):
            raise invalid
    except (KeyError, TypeError, InspectionError):
        raise invalid from None
    # Explicit allowlist: no owner profile, descriptions, contacts, or raw URLs.
    return {
        "name_with_owner": name,
        "url": "https://github.com/" + name,
        "visibility": visibility,
        "default_branch": data["default_branch"],
        "archived": data["archived"],
        "disabled": data["disabled"],
        "is_template": data["is_template"],
        "language": data["language"],
        "stars": data["stargazers_count"],
        "forks": data["forks_count"],
        "open_issues": data["open_issues_count"],
        "created_at": data["created_at"],
        "updated_at": data["updated_at"],
        "pushed_at": data["pushed_at"],
    }


def inspect_repository(repository: str) -> dict[str, Any]:
    repository = validate_repository(repository)
    command = [
        "gh", "api", "--hostname", "github.com", "--method", "GET",
        "--header", "Accept: application/vnd.github+json",
        "--header", "X-GitHub-Api-Version: 2022-11-28",
        "repos/" + repository,
    ]
    env = os.environ.copy()
    env.pop("GH_DEBUG", None)
    env["GH_PROMPT_DISABLED"] = "1"
    try:
        response = subprocess.run(
            command, shell=False, stdin=subprocess.DEVNULL, capture_output=True,
            encoding="utf-8", timeout=TIMEOUT_SECONDS, check=False, env=env,
        )
    except subprocess.TimeoutExpired:
        raise InspectionError("timeout", "GitHub metadata request timed out.") from None
    except OSError:
        raise InspectionError("gh_unavailable", "Unable to run gh. Check the existing CLI installation.") from None
    except UnicodeError:
        raise InspectionError("invalid_response", "GitHub returned an invalid metadata response.") from None
    if response.returncode:
        raise InspectionError(
            "gh_failed", "GitHub metadata request failed. Check access, existing gh authentication, and network."
        )
    try:
        data = json.loads(response.stdout)
    except (ValueError, TypeError):
        raise InspectionError("invalid_response", "GitHub returned an invalid metadata response.") from None
    return envelope(True, repository=metadata(data))


def main(argv: list[str] | None = None) -> int:
    parser = Parser(description="Read GitHub.com repository metadata through an existing gh login.")
    commands = parser.add_subparsers(dest="command", required=True)
    repo = commands.add_parser("repo", help="Fetch one repository's metadata using GET.")
    repo.add_argument("repository", metavar="OWNER/REPO")
    repo.add_argument("--json", action="store_true", help="Use versioned JSON output (currently always enabled).")
    args = parser.parse_args(argv)
    try:
        result = inspect_repository(args.repository)
    except InspectionError as error:
        return fail(error.code, error.message, 2 if error.code == "invalid_repository" else 1)
    emit(result)
    return 0
