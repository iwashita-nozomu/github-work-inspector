#!/usr/bin/env python3
"""Stage a verified local plugin source and personal marketplace; never edit Codex cache/config."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
NAME = 'github-work-inspector'

def require(condition, message):
    if not condition:
        raise ValueError(message)

def verify(root):
    manifest = json.loads((root / 'plugin-files.json').read_text(encoding="utf-8"))
    require(manifest['name'] == NAME and re.fullmatch('\\d+\\.\\d+\\.\\d+', manifest['version']), 'Plugin validation failed')
    expected = manifest['files']
    actual = set()
    for path in root.rglob('*'):
        require(not path.is_symlink(), 'Symlink in plugin source')
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            actual.add(relative)
            if relative != 'plugin-files.json':
                require(hashlib.sha256(path.read_bytes()).hexdigest() == expected.get(relative), 'Modified plugin file')
    require(actual == set(expected) | {'plugin-files.json'}, 'Unexpected or missing plugin file')
    for relative in expected:
        require(not Path(relative).is_absolute() and '..' not in Path(relative).parts, 'Plugin validation failed')
    require(json.loads((root / 'plugin.json').read_text(encoding="utf-8"))['version'] == manifest['version'], 'Plugin validation failed')
    return manifest

def safe_path(home, path):
    for part in [path, *path.parents]:
        if part == home:
            return
        require(not part.is_symlink(), 'Refuse symlinked installation path')
    raise AssertionError('Installation path outside selected home')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    manifest = verify(source)
    home = args.home.expanduser().resolve()
    target = home / 'plugins' / NAME
    market = home / '.agents/plugins/marketplace.json'
    safe_path(home, target)
    safe_path(home, market)
    before = market.read_bytes() if market.exists() else None
    payload = json.loads(before) if before is not None else {'name': 'personal-local', 'interface': {'displayName': 'Personal local plugins'}, 'plugins': []}
    require(re.fullmatch('[a-z0-9][a-z0-9._-]*', payload['name']), 'Review existing marketplace identity')
    require(isinstance(payload['plugins'], list), 'Plugin validation failed')
    entry = {'name': NAME, 'source': {'source': 'local', 'path': './plugins/' + NAME}, 'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Productivity'}
    existing = [x for x in payload['plugins'] if x.get('name') == NAME]
    require(not existing or existing == [entry], 'Unrelated existing marketplace entry')
    if not existing:
        payload['plugins'].append(entry)
    if target.exists():
        require(args.update, 'Existing source; use --update after review')
        verify(target)
    else:
        require(not args.update, 'No managed source to update')
    target.parent.mkdir(parents=True, exist_ok=True)
    market.parent.mkdir(parents=True, exist_ok=True)
    lock = target.parent / '.github-work-inspector-install.lock'
    # The exclusive file owns the lock, not an open handle (Windows unlink rules).
    with lock.open('x'):
        pass
    stage = temporary = backup = None
    promoted = committed = False
    new_market = (json.dumps(payload, indent=2) + '\n').encode()
    try:
        stage = Path(tempfile.mkdtemp(prefix='.gwi-plugin-new-', dir=target.parent))
        shutil.copytree(source, stage, dirs_exist_ok=True)
        verify(stage)
        require((market.read_bytes() if market.exists() else None) == before, 'Marketplace changed concurrently')
        if target.exists():
            verify(target)
            backup = target.with_name(NAME + '.backup-' + str(time.time_ns()))
            target.rename(backup)
        stage.rename(target)
        promoted = True
        if before is not None:
            backup_market = market.with_name('marketplace.json.backup-' + str(time.time_ns()))
            with backup_market.open('xb') as stream:
                stream.write(before)
        with tempfile.NamedTemporaryFile(dir=market.parent, prefix='.gwi-market-', delete=False) as out:
            temporary = Path(out.name)
            out.write(new_market)
        require((market.read_bytes() if market.exists() else None) == before, 'Marketplace changed concurrently')
        temporary.replace(market)
        committed = True
    except BaseException:
        if not committed:
            # Read back an uncertain replace before deciding whether to restore it.
            current = market.read_bytes() if market.exists() else None
            if current == new_market and current != before:
                if before is None:
                    market.unlink()
                else:
                    with tempfile.NamedTemporaryFile(dir=market.parent, prefix='.gwi-market-rollback-', delete=False) as out:
                        restore = Path(out.name)
                        out.write(before)
                    restore.replace(market)
            elif current != before:
                # Preserve concurrent edits; do not replace somebody else's marketplace.
                raise ValueError('Marketplace changed concurrently; inspect source and backups')
            if promoted and target.exists():
                # Retain even edits made after promotion, rather than deleting that tree.
                failed = target.with_name(NAME + '.failed-' + str(time.time_ns()))
                target.rename(failed)
            if backup and not target.exists():
                backup.rename(target)
        raise
    finally:
        try:
            if stage is not None and stage.exists():
                shutil.rmtree(stage)
            if temporary is not None and temporary.exists():
                temporary.unlink()
        finally:
            lock.unlink()
    print(json.dumps({'version': manifest['version'], 'source': str(target), 'marketplace': str(market), 'identity': NAME + '@' + payload['name'], 'backup': str(backup) if backup else None}))
    print('Next: codex plugin add ' + NAME + '@' + payload['name'] + ' --json')
if __name__ == '__main__':
    try:
        main()
    except (AssertionError, OSError, ValueError, KeyError):
        raise SystemExit('Plugin staging stopped; preserve existing files and inspect the source/marketplace. No Codex settings or cache were edited.')
