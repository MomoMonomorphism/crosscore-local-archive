"""Reject mixing frozen caches with another resource set or changed inputs."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from runtime_paths import PATHS
from startup_check import inspect


class BaselineBindingTests(unittest.TestCase):
    def test_valid_binding_and_source_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            source = cache / 'source.bin'
            source.write_bytes(b'original')
            binding = {'label': 'test-baseline', 'runtimePaths': {'cache': str(cache)},
                       'checks': [{'path': str(source), 'sha256': hashlib.sha256(b'original').hexdigest()}]}
            (cache / 'resource-baseline.json').write_text(json.dumps(binding))
            def check(paths):
                return next(c for c in inspect(paths)['checks'] if c['name'] == 'resource baseline')
            self.assertEqual(check({**PATHS, 'cache': cache})['status'], 'ok')
            source.write_bytes(b'updated')
            self.assertEqual(check({**PATHS, 'cache': cache})['status'], 'error')
            source.write_bytes(b'original')
            binding['runtimePaths']['source'] = str(cache / 'other-source')
            (cache / 'resource-baseline.json').write_text(json.dumps(binding))
            self.assertEqual(check({**PATHS, 'cache': cache})['status'], 'error')


if __name__ == '__main__':
    unittest.main()
