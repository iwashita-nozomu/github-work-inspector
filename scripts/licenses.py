#!/usr/bin/env python3
"""Preserve upstream notices from locked registry crates and the pinned Rust stdlib."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "third-party"
RUST_VERSION = "1.99.1"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def locked():
    return [p for p in tomllib.loads((ROOT / "Cargo.lock").read_text())["package"] if "source" in p]


def check():
    manifest = json.loads((DEST / "manifest.json").read_text())
    actual = {(p["name"], p["version"], p["checksum"]) for p in locked()}
    expected = {(p["name"], p["version"], p["checksum"]) for p in manifest["crates"]}
    assert actual == expected, "Cargo.lock changed; regenerate notices"
    compiler = subprocess.check_output(["rustc", "--version"], text=True).split()[1]
    assert compiler == manifest["rust_version"] == RUST_VERSION, "Rust notices must match compiler"
    assert tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]["license"] == "MIT"
    assert "Copyright (c) 2026 iwashita-nozomu" in (ROOT / "LICENSE").read_text()
    paths = set()
    for record in manifest["files"]:
        path = record["path"]
        assert not Path(path).is_absolute() and ".." not in Path(path).parts
        assert digest(DEST / path) == record["sha256"], "Notice content changed: " + path
        paths.add(path)
    actual_files = {p.relative_to(DEST).as_posix() for p in DEST.rglob("*") if p.is_file()}
    assert actual_files == paths | {"manifest.json"}, "Unexpected or missing notice file"
    assert digest(ROOT / "THIRD_PARTY_NOTICES.md") == manifest["index_sha256"]
    print(json.dumps({"locked_crates": len(actual), "notice_files": len(paths), "rust_version": RUST_VERSION, "licenses": "verified"}))


def generate():
    assert not DEST.exists(), "Preserve existing notices; review changes before regeneration"
    cache = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo"))) / "registry/src"
    DEST.mkdir()
    manifest = {"rust_version": RUST_VERSION, "crates": [], "files": []}
    lines = ["# Third-party notices", "", "Original project code is MIT (see LICENSE). Dependencies retain their upstream licenses.",
             "This conservative bundle covers every registry package in Cargo.lock, including build-time and",
             "other-target packages; it does not assert that every listed package is linked into every binary.",
             "Upstream copyright/license/notice files are preserved verbatim. Public upstream author names",
             "and contact details in those required notices are intentionally retained.", "",
             "Crate provenance: crates.io registry sources verified by Cargo.lock checksums.", "",
             "| Crate | Version | Upstream SPDX expression | Preserved notices |", "| --- | --- | --- | --- |"]
    for package in locked():
        name, version = package["name"], package["version"]
        matches = list(cache.glob("*/" + name + "-" + version))
        assert len(matches) == 1, "Run cargo fetch --locked first: " + name
        source = matches[0]
        metadata = tomllib.loads((source / "Cargo.toml").read_text())["package"]
        notices = [p for p in source.rglob("*") if p.is_file() and any(
            word in p.name.upper() for word in ["LICENSE", "COPYING", "NOTICE", "COPYRIGHT", "AUTHORS"])]
        if metadata.get("license-file"):
            notices.append(source / metadata["license-file"])
        assert notices, "Missing upstream notice: " + name
        for path in sorted(set(notices)):
            relative = Path("crates") / (name + "-" + version) / path.relative_to(source)
            target = DEST / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            manifest["files"].append({"path": relative.as_posix(), "sha256": digest(target)})
        expression = metadata.get("license", "See upstream license file")
        manifest["crates"].append({"name": name, "version": version, "checksum": package["checksum"], "license": expression})
        lines.append(f"| {name} | {version} | {expression} | [files](third-party/crates/{name}-{version}/) |")
    toolchain = Path(subprocess.check_output(["rustc", "--print", "sysroot"], text=True).strip()) / "share/doc/rust"
    rust_files = [toolchain / "COPYRIGHT-library.html", *sorted((toolchain / "licenses").glob("*.txt"))]
    assert len(rust_files) > 1
    for source in rust_files:
        relative = Path("rust-" + RUST_VERSION) / source.relative_to(toolchain)
        target = DEST / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        manifest["files"].append({"path": relative.as_posix(), "sha256": digest(target)})
    lines += ["", "## Rust standard library", "", f"Compiler pinned to Rust {RUST_VERSION}. The standard-library notice comes verbatim from the",
              "official rustup toolchain's share/doc/rust/COPYRIGHT-library.html, with its license texts.",
              "This includes the standard-library third-party notices; it is not a claim that the",
              "entire compiler, LLVM, or every component is shipped in the executable.",
              f"See [Rust notices](third-party/rust-{RUST_VERSION}/COPYRIGHT-library.html).", "",
              "Re-distribution must retain this notice bundle and the original project's LICENSE.", ""]
    (ROOT / "THIRD_PARTY_NOTICES.md").write_text("\n".join(lines))
    manifest["index_sha256"] = digest(ROOT / "THIRD_PARTY_NOTICES.md")
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    check()


parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
check() if args.check else generate()
