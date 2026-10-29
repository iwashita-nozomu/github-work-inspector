#!/usr/bin/env python3
"""Development-only packaging and offline smoke checks; not a CLI dependency."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tomllib
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--target", required=True, choices=[
    "aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"
])
parser.add_argument("--binary", required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
version = tomllib.loads((root / "Cargo.toml").read_text())["package"]["version"]
binary = args.binary.resolve()
for arguments in (["--help"], ["--version"], ["inspect", "--help"], ["install", "--help"]):
    result = subprocess.run([str(binary), *arguments], capture_output=True, timeout=10)
    if result.returncode or result.stderr:
        raise SystemExit("Offline CLI smoke failed")
result = subprocess.run([str(binary), "repo", "invalid", "--json"], capture_output=True, timeout=10)
assert result.returncode == 2 and json.loads(result.stdout)["error"]["code"] == "invalid_repository"
suffix = ".zip" if args.target.endswith("msvc") else ".tar.gz"
dist = root / "dist"
dist.mkdir(exist_ok=True)
archive = dist / f"github-work-inspector-v{version}-{args.target}{suffix}"
assert not archive.exists(), "Do not overwrite an existing release archive"
subprocess.run([sys.executable, str(root / "scripts/licenses.py"), "--check"], check=True)
entries = [(binary, binary.name), (root / "README.md", "README.md"),
           (root / "LICENSE", "LICENSE"), (root / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")]
entries += [(path, path.relative_to(root).as_posix()) for path in sorted((root / "third-party").rglob("*")) if path.is_file()]
skill = root / ".agents/skills/github-work-inspector"
entries += [(path, "skill/github-work-inspector/" + path.relative_to(skill).as_posix())
            for path in sorted(skill.rglob("*")) if path.is_file()]
if suffix == ".zip":
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as output:
        for source, name in entries:
            output.write(source, name)
else:
    with tarfile.open(archive, "x:gz") as output:
        for source, name in entries:
            info = output.gettarinfo(str(source), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with source.open("rb") as stream:
                output.addfile(info, stream)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")
print(json.dumps({"archive": archive.name, "size": archive.stat().st_size, "sha256": digest, "offline_smoke": "passed"}))
