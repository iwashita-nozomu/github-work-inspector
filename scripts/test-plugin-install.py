#!/usr/bin/env python3
"""Offline installer regression tests, including Python optimized mode."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


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
            actual = json.loads(market.read_text())
            self.assertEqual(actual['name'], old['name'])
            self.assertEqual(actual['interface'], old['interface'])
            self.assertEqual(actual['plugins'][0], old['plugins'][0])
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual(run('--update').returncode, 0)
            target = home/'plugins/github-work-inspector'
            (target/'user-edit').write_text('preserve')
            self.assertNotEqual(run('--update').returncode, 0)
            self.assertEqual((target/'user-edit').read_text(), 'preserve')
            (target/'user-edit').unlink()
            (target/'plugin.json').write_text('edited')
            self.assertNotEqual(run('--update').returncode, 0)
            self.assertEqual((target/'plugin.json').read_text(), 'edited')
            # A bad input bundle must fail before creating anything in another home.
            (bundle/'plugin.json').write_text('edited')
            other = root/'other-home'
            r = subprocess.run([sys.executable, '-O', str(bundle/'install-plugin.py'), '--home', str(other)], capture_output=True, timeout=10)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse(other.exists())


if __name__ == '__main__':
    unittest.main()
