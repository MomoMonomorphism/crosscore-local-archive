import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import spine_source as source


class SourceTests(unittest.TestCase):
    def test_pinned_reference_and_explicit_source(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'pc'
            base.mkdir()
            package = 'prefabs_spine_test'
            (base / package).write_bytes(b'pc')
            target = root / 'android'
            target.write_bytes(b'android')
            ref = {'source': str(target), 'baseSha256': hashlib.sha256(b'pc').hexdigest(),
                   'sha256': hashlib.sha256(b'android').hexdigest()}
            with patch.object(source, 'DEFAULT_SOURCE', base), patch.object(source, 'REFERENCES', {package: ref}):
                self.assertEqual(source.resolve_spine_source(package, base), target)
                self.assertEqual(source.resolve_spine_source('other', base), base / 'other')
                alternative = root / 'explicit'
                self.assertEqual(source.resolve_spine_source(package, alternative), alternative / package)
                ref['baseSource'] = str(root / 'another-frozen-pc')
                self.assertEqual(source.resolve_spine_source(package, base), base / package)
                ref['baseSource'] = str(base)
                self.assertEqual(source.resolve_spine_source(package, base), target)
                target.write_bytes(b'changed android')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    source.resolve_spine_source(package, base)
                target.write_bytes(b'android')
                (base / package).write_bytes(b'changed pc')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    source.resolve_spine_source(package, base)


if __name__ == '__main__':
    unittest.main()
