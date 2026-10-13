import unittest
import hashlib
from pathlib import Path
import tempfile
from voice_index_refresh import refresh_missing, verified_sound_aliases


class VoiceIndexRefreshTests(unittest.TestCase):
    def test_usage_and_verified_text_preserve_playback_and_are_idempotent(self):
        bank = {'id': 'a', 'sourceGroup': 'cv', 'sourceFile': 'A.acb', 'streams': [
            {'index': 1, 'name': 'A_01', 'interactionAudioId': 99},
            {'index': 2, 'name': 'A_02', 'interactionAudioId': 20}]}
        annotation = {('cv', 'A.acb', 1, 'A_01'): {'platform': 'android', 'asset': 'cfgSound1.lua',
            'label': '原标签', 'script': '原文', 'audioId': 10, 'annotationOnly': True},
            ('cv', 'A.acb', 2, 'A_02'): {'usage': {'label': '受击', 'category': 'battle'}}}
        updated, report = refresh_missing({'entries': {'a': bank}, 'variantEntries': {'skin': bank}},
                                          {}, {'source': {}}, annotations=annotation)
        self.assertEqual((report['addedCount'], report['usageAddedCount']), (1, 1))
        streams = updated['entries']['a']['streams']
        self.assertEqual(streams[0]['interactionAudioId'], 99)
        self.assertTrue(streams[0]['semantic']['annotationOnly'])
        self.assertNotIn('semantic', streams[1])
        self.assertEqual(streams[1]['usage']['label'], '受击')
        again, repeated = refresh_missing(updated, {}, {'source': {}}, annotations=annotation)
        self.assertEqual((repeated['addedCount'], repeated['usageAddedCount']), (0, 0))
        self.assertEqual(again, updated)

    def test_cross_group_alias_keeps_original_bank_and_composite_cue(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'cv'
            (root / 'cv_skin').mkdir(parents=True)
            picture = root.parent / 'picture'
            picture.mkdir()
            (root / 'cv_skin/A.acb').write_bytes(b'source')
            (picture / 'B.acb').write_bytes(b'canonical')
            alias = {'sourceGroup': 'cv_skin', 'canonicalGroup': 'picture',
                     'sourceFile': 'A.acb', 'canonicalFile': 'B.acb',
                     'sourceSha256': hashlib.sha256(b'source').hexdigest(),
                     'canonicalSha256': hashlib.sha256(b'canonical').hexdigest(),
                     'cues': [{'sourceCue': 'A_01; A_02', 'canonicalCue': 'B_01'}]}
            sound = {('picture/b.acb', 'B_01'): {'audioId': 10, 'label': '台词', 'script': '全文'}}
            expanded, active = verified_sound_aliases(sound, root, [alias])
            self.assertEqual(active, ['A.acb'])
            self.assertEqual(expanded[('cv/cv_skin/a.acb', 'A_01; A_02')]['bankAlias']['canonicalSheet'], 'picture/b.acb')
            self.assertNotIn(('cv/cv_skin/a.acb', 'A_01'), expanded)

    def test_alias_requires_original_hashes_and_explicit_cue_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'old.acb').write_bytes(b'old verified bank')
            (root / 'new.acb').write_bytes(b'new verified bank')
            alias = {'sourceGroup': 'cv', 'sourceFile': 'old.acb', 'canonicalFile': 'new.acb',
                     'sourceSha256': hashlib.sha256(b'old verified bank').hexdigest(),
                     'canonicalSha256': hashlib.sha256(b'new verified bank').hexdigest(),
                     'cues': [{'sourceCue': 'Old_01', 'canonicalCue': 'New_02'}]}
            sound = {('cv/new.acb', 'New_02'): {'audioId': 2, 'label': '接触', 'script': '有证明的台词'},
                     ('cv/new.acb', 'Old_03'): {'audioId': 3}}
            expanded, active = verified_sound_aliases(sound, root, [alias])
            self.assertEqual(active, ['old.acb'])
            record = expanded[('cv/old.acb', 'Old_01')]
            self.assertEqual(record['audioId'], 2)
            self.assertEqual(record['bankAlias']['canonicalCue'], 'New_02')
            self.assertNotIn(('cv/old.acb', 'Old_03'), expanded)
            bank = {'id': 'old', 'sourceFile': 'old.acb', 'streams': [{'index': 1, 'name': 'Old_01'}]}
            updated, report = refresh_missing({'entries': {'old': bank}}, expanded, {})
            self.assertEqual(report['addedCount'], 1)
            self.assertTrue(updated['entries']['old']['streams'][0]['semantic']['annotationOnly'])
            self.assertEqual(updated['entries']['old']['streams'][0]['semantic']['textProvenance']['bankAlias'], record['bankAlias'])
            # A changed original invalidates the registered proof.
            (root / 'old.acb').write_bytes(b'updated bank')
            self.assertEqual(verified_sound_aliases(sound, root, [alias]), (sound, []))
            with self.assertRaises(ValueError):
                verified_sound_aliases(sound, root, [{**alias, 'sourceFile': '../old.acb'}])

    def test_exact_key_duplicates_identity_and_id_conflicts(self):
        existing = {'audioId': 7, 'label': '原标识', 'script': '原文', 'source': 'roleVoice'}
        bank = {'id': 'a', 'sourceGroup': 'cv', 'sourceFile': 'A.acb', 'streams': [
            {'index': 1, 'name': 'A_01', 'duration': 1.2, 'interactionAudioId': 10},
            {'index': 2, 'name': 'A_02', 'semantic': existing},
            {'index': 3, 'name': 'A_03', 'interactionAudioId': 99},
            {'index': 4, 'name': 'A_04'}]}
        source = {('cv/a.acb', 'A_01'): {'audioId': 10, 'label': '登录', 'script': '正确原文'},
                  ('cv/a.acb', 'A_03'): {'audioId': 30, 'label': '失败', 'script': '不应错配'}}
        android = {'source': {'platform': 'android', 'bundleSha256': 'fixed'}, 'voices': {
            'cv/a.acb|a_04': {'audioId': 40, 'label': '接触', 'script': '安卓原文', 'asset': 'cfgSound2.lua'},
            'cv/b.acb|a_03': {'audioId': 99, 'label': '错误音库', 'script': '不能猜'}}}
        original = {'entries': {'a': bank}, 'variantEntries': {'variant': bank}, 'skinLabelledBankCount': 99}
        updated, report = refresh_missing(original, source, android)
        self.assertEqual(report['addedCount'], 2)
        self.assertEqual(len(report['rejected']), 1)
        streams = updated['entries']['a']['streams']
        self.assertEqual(streams[0]['semantic']['audioId'], 10)
        self.assertEqual(streams[0]['duration'], 1.2)
        self.assertEqual(streams[1]['semantic'], existing)
        self.assertNotIn('semantic', streams[2])
        self.assertEqual(streams[3]['semantic']['textProvenance']['asset'], 'cfgSound2.lua')
        self.assertEqual(updated['variantEntries']['variant']['streams'], streams)
        self.assertNotIn('semantic', bank['streams'][0])
        self.assertEqual(updated['semanticStreamCount'], 3)
        self.assertEqual(updated['skinLabelledBankCount'], 0)
        again, repeat = refresh_missing(updated, source, android)
        self.assertEqual(repeat['addedCount'], 0)
        self.assertEqual(again, updated)

    def test_composite_cue_is_not_guessed(self):
        bank = {'id': 'm', 'sourceFile': 'M.acb', 'streams': [{'index': 1, 'name': 'M_01; M_02'}]}
        updated, report = refresh_missing({'entries': {'m': bank}}, {
            ('cv/m.acb', 'M_01'): {'audioId': 1, 'label': '技能', 'script': '第一句'}}, {})
        self.assertEqual(report['addedCount'], 0)
        self.assertNotIn('semantic', updated['entries']['m']['streams'][0])

    def test_original_config_proof_survives_annotation_without_redirecting_audio(self):
        stream = {'index': 1, 'name': 'Old_01', 'duration': 2.0}
        bank = {'id': 'old', 'sourceFile': 'Old.acb', 'streams': [stream]}
        proof = {'activeAsset': 'cfgSound.lua', 'activeCueSheet': 'cv/New.acb',
                 'activeCueName': 'New_01', 'verification': 'original-key-and-active-text-agreement'}
        catalog = {'source': {'platform': 'android', 'bundleSha256': 'fixed'}, 'voices': {
            'cv/old.acb|old_01': {'audioId': 123, 'label': '获得', 'script': '原文',
                                'asset': 'cfgSound1.lua', 'originalConfig': proof}}}
        updated, report = refresh_missing({'entries': {'old': bank}}, {}, catalog)
        result = updated['entries']['old']['streams'][0]
        self.assertEqual(report['addedCount'], 1)
        self.assertEqual(result['semantic']['textProvenance']['originalConfig'], proof)
        self.assertEqual(result['semantic']['textProvenance']['cueSheet'], 'cv/old.acb')
        self.assertEqual({k: v for k, v in result.items() if k != 'semantic'}, stream)


if __name__ == '__main__': unittest.main()
