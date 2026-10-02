import unittest
from unittest.mock import patch
from pathlib import Path

from hall_entry import recover_snapshot_entries, entry_manifest


class HallEntryRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.row = {'index': 1, 'audio': [30180502], 'clearTracks': [1, 2],
                    'baseIdle': 'idle1', 'effect': None, 'content': {}}
        self.live = {str(i): dict(self.row) for i in range(20)}
        self.saved = {**self.live, '3018005': dict(self.row)}

    def test_missing_entire_model_is_recovered(self):
        result = recover_snapshot_entries(self.live, self.saved, {'3018005'})
        self.assertEqual(result['3018005'], self.row)
        self.assertNotIn('3018005', self.live)

    def test_intact_source_removal_is_not_reintroduced(self):
        self.assertEqual(recover_snapshot_entries(self.live, self.saved, set()), self.live)

    def test_stale_snapshot_never_overrides_live_or_fills_gaps(self):
        self.saved['0'] = {**self.row, 'audio': [999]}
        self.assertEqual(recover_snapshot_entries(self.live, self.saved, {'3018005'}), self.live)

    def test_insufficient_evidence_or_malformed_row_is_ignored(self):
        self.assertEqual(recover_snapshot_entries({}, self.saved, {'3018005'}), {})
        self.saved['3018005'] = {**self.row, 'clearTracks': '1,2'}
        self.assertEqual(recover_snapshot_entries(self.live, self.saved, {'3018005'}), self.live)


class SelectedEntryTests(unittest.TestCase):
    def setUp(self):
        entry_manifest.cache_clear()
        self.rows = {str(i): {'index': i, 'audio': [i], 'clearTracks': [1],
                             'baseIdle': None, 'effect': None, 'content': {}} for i in range(30)}
        self.packs = {key: Path('source') / key for key in self.rows}

    def tearDown(self):
        entry_manifest.cache_clear()

    def test_selected_request_opens_only_one_bundle_and_reuses_result(self):
        with patch('hall_entry._entry_rows', return_value=(self.rows, self.packs, set())), \
             patch('hall_entry.interlude_default_of', return_value={'animation': 'idle3'}) as read:
            selected = entry_manifest(Path('source'), Path('cache'), '12')
            self.assertEqual(selected, {'12': {**self.rows['12'], 'baseIdle': 'idle3'}})
            self.assertEqual(read.call_args.args, (self.packs['12'],))
            self.assertEqual(entry_manifest(Path('source'), Path('cache'), '12'), selected)
            self.assertEqual(read.call_count, 1)
            self.assertIsNone(self.rows['12']['baseIdle'], 'shared config rows stay immutable')

    def test_absent_record_never_opens_a_bundle(self):
        with patch('hall_entry._entry_rows', return_value=(self.rows, self.packs, set())), \
             patch('hall_entry.interlude_default_of') as read:
            self.assertEqual(entry_manifest(Path('source'), Path('cache'), 'absent'), {})
            read.assert_not_called()

    def test_selected_record_matches_full_manifest(self):
        with patch('hall_entry._entry_rows', return_value=(self.rows, self.packs, set())), \
             patch('hall_entry.interlude_default_of', side_effect=lambda pack: {'animation': 'idle' + pack.name}):
            selected = entry_manifest(Path('source'), Path('cache'), '12')
            full = entry_manifest(Path('source'), Path('cache'))
            self.assertEqual(selected['12'], full['12'])
            self.assertEqual(len(full), 30)


if __name__ == '__main__':
    unittest.main()
