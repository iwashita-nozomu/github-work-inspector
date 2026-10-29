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


def verify(root):
    manifest = json.loads((root / 'plugin-files.json').read_text())
    assert manifest['name'] == NAME and re.fullmatch(r'\d+\.\d+\.\d+', manifest['version'])
    expected = manifest['files']
    actual = set()
    for path in root.rglob('*'):
        assert not path.is_symlink(), 'Symlink in plugin source'
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            actual.add(relative)
            if relative != 'plugin-files.json':
                assert hashlib.sha256(path.read_bytes()).hexdigest() == expected.get(relative), 'Modified plugin file'
    assert actual == set(expected) | {'plugin-files.json'}, 'Unexpected or missing plugin file'
    for relative in expected:
        assert not Path(relative).is_absolute() and '..' not in Path(relative).parts
    assert json.loads((root/'plugin.json').read_text())['version'] == manifest['version']
    return manifest


def safe_path(home, path):
    for part in [path, *path.parents]:
        if part == home:
            return
        assert not part.is_symlink(), 'Refuse symlinked installation path'
    raise AssertionError('Installation path outside selected home')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    manifest = verify(source)
    home = args.home.expanduser().resolve()
    target = home/'plugins'/NAME
    market = home/'.agents/plugins/marketplace.json'
    safe_path(home, target)
    safe_path(home, market)
    before = market.read_bytes() if market.exists() else None
    payload = json.loads(before) if before is not None else {
        'name':'personal-local', 'interface':{'displayName':'Personal local plugins'}, 'plugins':[]}
    assert re.fullmatch(r'[a-z0-9][a-z0-9._-]*', payload['name']), 'Review existing marketplace identity'
    assert isinstance(payload['plugins'], list)
    entry = {'name':NAME,'source':{'source':'local','path':'./plugins/'+NAME},
             'policy':{'installation':'AVAILABLE','authentication':'ON_INSTALL'},'category':'Productivity'}
    existing = [x for x in payload['plugins'] if x.get('name') == NAME]
    assert not existing or existing == [entry], 'Unrelated existing marketplace entry'
    if not existing:
        payload['plugins'].append(entry)
    if target.exists():
        assert args.update, 'Existing source; use --update after review'
        verify(target)  # preserves user modifications and extra files by refusing the update
    else:
        assert not args.update, 'No managed source to update'
    target.parent.mkdir(parents=True, exist_ok=True)
    market.parent.mkdir(parents=True, exist_ok=True)
    lock = target.parent/'.github-work-inspector-install.lock'
    with lock.open('x'):
        stage = Path(tempfile.mkdtemp(prefix='.gwi-plugin-new-', dir=target.parent))
        backup = None
        try:
            shutil.copytree(source, stage, dirs_exist_ok=True)
            verify(stage)
            assert (market.read_bytes() if market.exists() else None) == before, 'Marketplace changed concurrently'
            if target.exists():
                backup = target.with_name(NAME+'.backup-'+str(time.time_ns()))
                target.rename(backup)
            stage.rename(target)
            if before is not None:
                backup_market = market.with_name('marketplace.json.backup-'+str(time.time_ns()))
                backup_market.write_bytes(before)
            with tempfile.NamedTemporaryFile(dir=market.parent, prefix='.gwi-market-', delete=False) as out:
                out.write((json.dumps(payload, indent=2)+'\n').encode())
                temporary = Path(out.name)
            temporary.replace(market)
        except BaseException:
            if backup and not target.exists():
                backup.rename(target)
            raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)
            lock.unlink()
    print(json.dumps({'version':manifest['version'],'source':str(target),'marketplace':str(market),
                      'identity':NAME+'@'+payload['name'],'backup':str(backup) if backup else None}))
    print('Next: codex plugin add '+NAME+'@'+payload['name']+' --json')


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, OSError, ValueError, KeyError):
        raise SystemExit('Plugin staging stopped; preserve existing files and inspect the source/marketplace. No Codex settings or cache were edited.')
