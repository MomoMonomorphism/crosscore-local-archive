import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

from voice_annotations import verified_annotations


class VoiceAnnotationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'A.acb').write_bytes(b'audio')
        self.lua = self.root / 'lua'
        self.lua.write_bytes(b'lua')
        self.entry = {'sourceGroup': 'cv', 'sourceFile': 'A.acb', 'index': 1,
                      'cue': 'A_01', 'sourceSha256': hashlib.sha256(b'audio').hexdigest(),
                      'platform': 'android', 'luaSha256': hashlib.sha256(b'lua').hexdigest(),
                      'kind': 'original-text', 'audioId': 10}
        self.tables = {'cfgSound1.lua': [{'id': 10, 'cue_sheet': 'cv/A.acb',
                         'cue_name': 'A_01', 'name': '受击', 'script1': '原配置正文'}],
                       'cfgSound.lua': []}
        self.bundle = Mock()

    def verify(self, entry=None):
        with patch('voice_annotations.get_bundle', return_value=self.bundle), \
                patch('voice_annotations.rows', side_effect=lambda bundle, asset: self.tables[asset]):
            return verified_annotations({'entries': [entry or self.entry]},
                                        {'cv': self.root}, {'android': self.lua})

    def test_original_text_requires_exact_key_id_and_no_active_conflict(self):
        result = self.verify()[('cv', 'A.acb', 1, 'A_01')]
        self.assertEqual(result['script'], '原配置正文')
        self.assertTrue(result['annotationOnly'])
        self.assertFalse(result['originalConfig']['activeRecordPresent'])
        self.assertEqual(self.verify({**self.entry, 'audioId': 11}), {})
        self.assertEqual(self.verify({**self.entry, 'cue': 'A_02'}), {})
        self.tables['cfgSound.lua'] = [{'id': 10, 'cue_sheet': 'cv/B.acb', 'cue_name': 'B_01'}]
        self.assertEqual(self.verify(), {})
        self.tables['cfgSound.lua'][0].update(id=11, cue_sheet='cv/A.acb', cue_name='A_01')
        self.assertEqual(self.verify(), {})

    def test_changed_original_files_invalidate_proof(self):
        self.lua.write_bytes(b'changed lua')
        self.assertEqual(self.verify(), {})
        self.lua.write_bytes(b'lua')
        (self.root / 'A.acb').write_bytes(b'changed audio')
        self.assertEqual(self.verify(), {})
        with self.assertRaises(ValueError):
            self.verify({**self.entry, 'sourceFile': '../A.acb'})

    def test_usage_has_no_subtitle_and_requires_exact_game_call(self):
        self.tables['cfgcharacter.lua'] = [{'id': 1, 's_hit': ['A_01']}]
        usage = {**self.entry, 'kind': 'usage', 'proofs': [
            {'asset': 'cfgcharacter.lua', 'modelId': 1, 'field': 's_hit'}]}
        result = self.verify(usage)[('cv', 'A.acb', 1, 'A_01')]
        self.assertEqual(set(result), {'usage'})
        self.assertEqual(result['usage']['label'], '受击')
        self.assertEqual(result['usage']['provenance'][0]['bundleSha256'], self.entry['luaSha256'])
        with self.assertRaises(ValueError):
            self.verify({**usage, 'cue': 'A_02'})
        with self.assertRaises(ValueError):
            self.verify({**usage, 'proofs': []})
        event = 'cue_sheet="cv/A.acb", cue_name="A_01"'
        self.bundle.read.return_value = event
        fbd = {**usage, 'proofs': [{'asset': 'FBD_test.lua', 'event': event}]}
        self.assertEqual(self.verify(fbd)[('cv', 'A.acb', 1, 'A_01')]['usage']['label'], '战斗技能语音')
        self.bundle.read.return_value = 'cue_sheet="cv/B.acb", cue_name="A_01"'
        with self.assertRaises(ValueError):
            self.verify(fbd)


if __name__ == '__main__':
    unittest.main()
