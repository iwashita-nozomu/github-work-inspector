#!/usr/bin/env python3
"""Offline installer regression tests, including Python optimized mode."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


class SourceInstallation(unittest.TestCase):
    def test_preserves_marketplace_and_edits_even_with_optimized_python(self):
        with tempfile.TemporaryDirectory(prefix='gwi-plugin-test-') as temporary:
            root = Path(temporary)
            bundle, home = root/'bundle', root/'home'
            bundle.mkdir()
            home.mkdir()
            shutil.copyfile(Path(__file__).with_name('install-plugin.py'), bundle/'install-plugin.py')
            (bundle/'plugin.json').write_text(json.dumps({'name':'github-work-inspector','version':'1.0.0'}))
            files = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.iterdir()}
            (bundle/'plugin-files.json').write_text(json.dumps({'name':'github-work-inspector','version':'1.0.0','files':files}))
            market = home/'.agents/plugins/marketplace.json'
            market.parent.mkdir(parents=True)
            old = {'name':'existing-personal','interface':{'displayName':'Preserve'},'plugins':[{'name':'unrelated'}]}
            market.write_text(json.dumps(old))

            def run(*options):
                return subprocess.run([sys.executable, '-O', str(bundle/'install-plugin.py'), '--home', str(home), *options], capture_output=True, timeout=10)

            self.assertEqual(run().returncode, 0)
            lock = home/'plugins/.github-work-inspector-install.lock'
            self.assertFalse(lock.exists())
            actual = json.loads(market.read_text())
            self.assertEqual(actual['name'], old['name'])
            self.assertEqual(actual['interface'], old['interface'])
            self.assertEqual(actual['plugins'][0], old['plugins'][0])
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual(run('--update').returncode, 0)
            self.assertFalse(lock.exists())
            target = home/'plugins/github-work-inspector'
            (target/'user-edit').write_text('preserve')
            self.assertNotEqual(run('--update').returncode, 0)
            self.assertEqual((target/'user-edit').read_text(), 'preserve')
            (target/'user-edit').unlink()
            (target/'plugin.json').write_text('edited')
            self.assertNotEqual(run('--update').returncode, 0)
            self.assertEqual((target/'plugin.json').read_text(), 'edited')
            # Inject harmless filesystem failures after acquiring the exclusive lock.
            spec = importlib.util.spec_from_file_location('gwi_test_installer', bundle/'install-plugin.py')
            module = importlib.util.module_from_spec(spec)
            with patch.object(sys, 'dont_write_bytecode', True):
                spec.loader.exec_module(module)
            for operation in ['mkdtemp', 'copytree']:
                failure_home = root/('failed-' + operation)
                owner = module.tempfile if operation == 'mkdtemp' else module.shutil
                with patch.object(sys, 'argv', ['install-plugin.py', '--home', str(failure_home)]):
                    with patch.object(owner, operation, side_effect=OSError('fixture I/O failure')):
                        with self.assertRaises(OSError):
                            module.main()
                self.assertFalse((failure_home/'plugins/.github-work-inspector-install.lock').exists())
                self.assertFalse((failure_home/'plugins/github-work-inspector').exists())
                self.assertFalse(list((failure_home/'plugins').glob('.gwi-plugin-new-*')))
            # Fresh/update promotion followed by marketplace replace failure must roll back.
            for updating in [False, True]:
                failure_home = root/('market-failure-' + str(updating))
                arguments = ['install-plugin.py', '--home', str(failure_home)]
                with patch.object(sys, 'argv', arguments):
                    if updating:
                        module.main()
                    failure_market = failure_home/'.agents/plugins/marketplace.json'
                    previous_market = failure_market.read_bytes() if failure_market.exists() else None
                    failure_target = failure_home/'plugins/github-work-inspector'
                    previous_source = {p.relative_to(failure_target).as_posix():p.read_bytes() for p in failure_target.rglob('*') if p.is_file()} if updating else None
                    if updating:
                        arguments.append('--update')
                    with patch.object(Path, 'replace', side_effect=OSError('fixture marketplace write failure')):
                        with self.assertRaises(OSError):
                            module.main()
                    self.assertEqual(failure_market.read_bytes() if failure_market.exists() else None, previous_market)
                    if updating:
                        self.assertEqual({p.relative_to(failure_target).as_posix():p.read_bytes() for p in failure_target.rglob('*') if p.is_file()}, previous_source)
                    else:
                        self.assertFalse(failure_target.exists())
                    self.assertFalse((failure_home/'plugins/.github-work-inspector-install.lock').exists())
                    self.assertFalse(list((failure_home/'plugins').glob('.gwi-plugin-new-*')))
                    # Normal retry succeeds; quarantined candidates never block the target path.
                    module.main()
            # A bad input bundle must fail before creating anything in another home.
            (bundle/'plugin.json').write_text('edited')
            other = root/'other-home'
            r = subprocess.run([sys.executable, '-O', str(bundle/'install-plugin.py'), '--home', str(other)], capture_output=True, timeout=10)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse(other.exists())


if __name__ == '__main__':
    unittest.main()
