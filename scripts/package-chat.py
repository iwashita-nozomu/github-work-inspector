#!/usr/bin/env python3
"""Build one private account package with a caller-verified existing GitHub app ID.

No account registration, network, release upload, local install or auth mutation.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'github-work-inspector-chat'


def build(output, github_app_id, source_sha):
    if not re.fullmatch(r'connector_[A-Za-z0-9][A-Za-z0-9_-]*', github_app_id or ''):
        raise ValueError('A verified existing GitHub connector app ID is required')
    if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', source_sha or ''):
        raise ValueError('An exact source commit is required')
    if output.exists():
        raise ValueError('Refuse to overwrite an existing account package')
    actual_head = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    if source_sha != actual_head:
        raise ValueError('Account package must identify the current exact source commit')
    if subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'], text=True).strip():
        raise ValueError('Commit the intended source and preserve edits before packaging')
    subprocess.run(['python3', str(ROOT/'scripts/sync-review-core.py'), '--check'], check=True, capture_output=True)
    plugin = ROOT/'plugins'/NAME
    entries = {p.relative_to(plugin).as_posix(): p.read_bytes() for p in plugin.rglob('*') if p.is_file()}
    if any(p.is_symlink() for p in plugin.rglob('*')):
        raise ValueError('Symlinks are not package inputs')
    manifest = json.loads(entries['plugin.json'])
    assert manifest['name'] == NAME and manifest['extensions']['com.openai']['apps'] == './.app.json'
    assert len(manifest['extensions']['com.openai']['interface']['shortDescription']) <= 30
    assert not any(name in entries for name in ['mcp.json', '.mcp.json'])
    entries['.app.json'] = (json.dumps({'apps': {'github': {'id': github_app_id}}}, indent=2)+'\n').encode()
    for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        entries[name] = (ROOT/name).read_bytes()
    for path in (ROOT/'third-party').rglob('*'):
        if path.is_file():
            entries[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    lock = json.loads((ROOT/'docs/CORE-LOCK.json').read_text())
    entries['BUILD-INFO.json'] = (json.dumps({
        'package': NAME, 'version': manifest['version'], 'source_sha': source_sha,
        'shared_core_digest': lock['core_digest'], 'contract_version': lock['contract_version'],
        'intended_scope': 'private_personal_account', 'account_registration_performed': False,
        'dependency': 'Existing connected GitHub app; no new OAuth or scope requested',
        'rust_in_chat_runtime': False, 'native_ui_verified': False,
        'entry_hashes': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(entries.items())},
    }, indent=2)+'\n').encode()
    # Reject task-local paths and obvious credentials before producing an uploadable ZIP.
    for name, data in entries.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or name.startswith(('.git/', 'bin/')):
            raise ValueError('Unexpected account package entry')
        text = data.decode('utf-8')
        if re.search(r'/(?:Users/|home/agent/|private/var/folders/)|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----', text):
            raise ValueError('Local path or credential-like package content')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(NAME+'/'+name, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert json.loads(archive.read(NAME+'/.app.json'))['apps']['github']['id'] == github_app_id
        assert archive.read(NAME+'/skills/github-repo-review-chat/references/review-selection.js') == (ROOT/'.agents/skills/github-work-inspector/references/review-selection.js').read_bytes()
    return {'archive': str(output), 'size': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'entries': len(entries), 'source_sha': source_sha, 'shared_core_digest': lock['core_digest'],
            'account_registered': False, 'public_release': False, 'native_ui_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--github-app-id', required=True, help='Copy only an app ID verified by backend discovery; syntax checking does not verify authorization.')
    parser.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.out, args.github_app_id, args.source_sha)))
