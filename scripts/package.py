#!/usr/bin/env python3
"""Development-only packaging and offline smoke checks; not a CLI dependency."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import shutil
import tempfile
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
for arguments in (["--help"], ["--version"], ["inspect", "--help"], ["install", "--help"], ["mcp", "--help"]):
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
def write_archive(archive, entries):
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
    print(json.dumps({"archive":archive.name,"size":archive.stat().st_size,"sha256":digest,"files":len(entries),"offline_smoke":"passed"}))


write_archive(archive, entries)
subprocess.run([sys.executable, str(root / "scripts/check-plugin.py")], check=True)
plugin_archive = dist / f"github-work-inspector-plugin-v{version}-{args.target}{suffix}"
with tempfile.TemporaryDirectory(prefix="gwi-plugin-package-") as directory:
    plugin = Path(directory) / "github-work-inspector"
    shutil.copytree(root / "plugins/github-work-inspector", plugin)
    for name in ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]:
        shutil.copyfile(root / name, plugin / name)
    shutil.copytree(root / "docs", plugin / "docs")
    shutil.copytree(root / "third-party", plugin / "third-party")
    shutil.copyfile(root / "scripts/install-plugin.py", plugin / "install-plugin.py")
    (plugin / "bin").mkdir()
    executable = "github-work-inspector.exe" if args.target.endswith("msvc") else "github-work-inspector"
    shutil.copy2(binary, plugin / "bin" / executable)
    for filename in ["mcp.json", ".mcp.json"]:
        document = json.loads((plugin / filename).read_text())
        document["mcpServers"]["github-work-inspector"]["command"] = "./bin/" + executable
        (plugin / filename).write_text(json.dumps(document, indent=2) + "\n")
    files = {path.relative_to(plugin).as_posix():hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(plugin.rglob("*")) if path.is_file()}
    (plugin / "plugin-files.json").write_text(json.dumps({"name":"github-work-inspector","version":version,"target":args.target,"files":files},indent=2)+"\n")
    plugin_entries = [(path, "github-work-inspector/" + path.relative_to(plugin).as_posix())
                      for path in sorted(plugin.rglob("*")) if path.is_file()]
    write_archive(plugin_archive, plugin_entries)
