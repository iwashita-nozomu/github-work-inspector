#!/usr/bin/env python3
"""Negative account-package guards; no fake dependency is packaged or uploaded."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('chat_package', Path(__file__).with_name('package-chat.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Guards(unittest.TestCase):
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
