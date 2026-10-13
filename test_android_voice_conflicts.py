import unittest
from unittest.mock import patch
from tools.build_android_text import collect_voices, collect_verified_original_voices


class AndroidVoiceConflictTests(unittest.TestCase):
    def collect(self, tables):
        with patch('tools.build_android_text.rows', side_effect=lambda bundle, asset: tables.get(asset, [])):
            return collect_voices(object())

    def row(self, script, label='获得', audio_id=123, cue='A_01'):
        return {'cue_sheet': 'cv/A.acb', 'cue_name': cue, 'id': audio_id,
                'script1': script, 'name': label}

    def test_equivalent_newlines_restore_same_id_and_record_sources(self):
        voices, conflicts, equivalent = self.collect({
            'cfgSound.lua': [self.row('第一句\r\n第二句')],
            'cfgSound2.lua': [self.row('第一句\n第二句', audio_id='123')]})
        key = 'cv/a.acb|a_01'
        self.assertFalse(conflicts)
        self.assertEqual(voices[key]['script'], '第一句\n第二句')
        self.assertEqual(voices[key]['audioId'], 123)
        self.assertEqual([r['asset'] for r in equivalent[key]], ['cfgSound.lua', 'cfgSound2.lua'])

    def test_content_label_spacing_and_id_conflicts_remain_unresolved(self):
        first = [self.row('第一句\r\n第二句', cue=f'A_0{i}') for i in range(1, 5)]
        second = [self.row('第一句\n另一句', cue='A_01'),
                  self.row('第一句\n第二句', label='接触', cue='A_02'),
                  self.row('第一句\n第 二句', cue='A_03'),
                  self.row('第一句\n第二句', audio_id=999, cue='A_04')]
        voices, conflicts, equivalent = self.collect({'cfgSound.lua': first, 'cfgSound2.lua': second})
        self.assertFalse(voices)
        self.assertEqual(len(conflicts), 4)
        self.assertFalse(equivalent)

    def test_later_equal_record_cannot_hide_earlier_genuine_conflict(self):
        voices, conflicts, _ = self.collect({
            'cfgSound.lua': [self.row('原文本')],
            'cfgSound2.lua': [self.row('不同文本')],
            'cfgSound3.lua': [self.row('不同文本')]})
        self.assertFalse(voices)
        self.assertEqual(conflicts, {'cv/a.acb|a_01'})

    def originals(self, originals, active, voices=None, conflicts=None):
        tables = {'cfgSound1.lua': originals, 'cfgSound.lua': active}
        with patch('tools.build_android_text.rows', side_effect=lambda bundle, asset: tables.get(asset, [])):
            if voices is None:
                voices, _, _ = collect_voices(object())
            return collect_verified_original_voices(object(), voices, conflicts or set())

    def test_original_bank_reference_requires_active_text_and_retains_proof(self):
        original = {**self.row('一句\r\n二句'), 'cue_sheet': 'cv/Old.acb'}
        recovered = self.originals([original], [self.row('一句\n二句')])
        record = recovered['cv/old.acb|a_01']
        self.assertEqual(record['script'], '一句\r\n二句')
        self.assertEqual(record['asset'], 'cfgSound1.lua')
        self.assertEqual(record['originalConfig']['activeCueSheet'], 'cv/A.acb')

    def test_original_cannot_override_conflicts_or_unproven_content(self):
        old = {**self.row('原句'), 'cue_sheet': 'cv/Old.acb'}
        for active in ([], [self.row('不同句')], [self.row('原句', label='接触')],
                       [self.row('原句', audio_id=456)], [self.row('原句'), self.row('原句')]):
            with self.subTest(active=active):
                self.assertFalse(self.originals([old], active))
        self.assertFalse(self.originals([old], [self.row('原句')], conflicts={'cv/old.acb|a_01'}))
        self.assertFalse(self.originals([old, {**old, 'script1': '其他句'}], [self.row('原句')]))
        self.assertFalse(self.originals([old], [self.row('原句')], voices={}))
        # A different cue in the same bank needs PCM proof, even with equal text.
        self.assertFalse(self.originals([self.row('原句', cue='A_01b')], [self.row('原句')]))

    def test_original_preserves_existing_entry_and_handles_absent_table(self):
        old = {**self.row('原句'), 'cue_sheet': 'cv/Old.acb'}
        voices = {'cv/old.acb|a_01': {'label': '现有标签', 'script': '现有正文', 'audioId': 123}}
        self.assertFalse(self.originals([old], [self.row('原句')], voices=voices))
        self.assertEqual(voices['cv/old.acb|a_01']['script'], '现有正文')
        with patch('tools.build_android_text.rows', side_effect=KeyError('cfgSound1.lua')):
            self.assertFalse(collect_verified_original_voices(object(), {}, set()))


if __name__ == '__main__': unittest.main()
