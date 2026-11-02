#!/usr/bin/env python3
"""Negative account-package guards; no fake dependency is packaged or uploaded."""
import importlib.util
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('chat_package', Path(__file__).with_name('package-chat.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Guards(unittest.TestCase):
    def test_app_owned_presentation_and_config_survive_both_manifests(self):
        candidate = json.loads((module.ROOT/'plugins'/module.NAME/'plugin.json').read_text())
        previous = copy.deepcopy(candidate)
        previous['version'] = '0.3.0'
        previous['description'] = 'Existing App-owned description'
        ui = previous['extensions']['com.openai']['interface']
        ui.update(longDescription='Existing App-owned presentation', iconSmall='./assets/existing.svg', defaultPrompt=['First prompt', 'Second prompt'])
        previous['extensions']['com.openai']['appOwnedSetting'] = {'keep': True}
        original = copy.deepcopy(previous)
        candidate['description'] = 'Candidate description must not replace App data'
        candidate['extensions']['com.openai']['interface'].update(displayName='Candidate title', defaultPrompt=['First prompt', 'Second prompt'])
        effective = module.account_manifest(candidate, previous)
        overlay = module.codex_overlay(effective)
        self.assertEqual(effective['extensions']['com.openai']['interface'], ui)
        self.assertEqual(overlay['interface'], ui)
        self.assertEqual(effective['description'], original['description'])
        self.assertEqual(effective['extensions'], original['extensions'])
        self.assertEqual(effective['version'], '0.4.0')
        self.assertEqual(overlay['version'], '0.4.0')
        self.assertEqual(previous, original)
        candidate['extensions']['com.openai']['interface']['defaultPrompt'].reverse()
        with self.assertRaises(ValueError):
            module.account_manifest(candidate, previous)

    def test_missing_or_unverified_shape_cannot_create_an_archive(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d)/'package.zip'
            for app_id in [None, '', 'GitHub', 'https://example.invalid', 'plugin_connector_not_an_app']:
                with self.assertRaises(ValueError):
                    module.build(output, app_id, 'a'*40)
                self.assertFalse(output.exists())

    def test_unknown_source_and_existing_output_are_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d)/'package.zip'
            # Syntax-only fixture reaches the source/output guards, never archive construction.
            with self.assertRaises(ValueError):
                module.build(output, 'connector_syntax_fixture_only', 'deadbee')
            output.write_bytes(b'user-existing-file')
            with self.assertRaises(ValueError):
                module.build(output, 'connector_syntax_fixture_only', 'a'*40)
            self.assertEqual(output.read_bytes(), b'user-existing-file')


if __name__ == '__main__':
    unittest.main()
