import unittest
from character_catalog import resolve_default_model


class DefaultModelOwnership(unittest.TestCase):
    def test_independent_role_reference_resolves_cross_character_model(self):
        wrong = {'id': 3018001, 'role_id': 30180}
        right = {'id': 3050001, 'role_id': 30500}
        row, issue = resolve_default_model(
            {'id': 30500, 'role_id': 30500, 'model': 3018001},
            {'3018001': wrong, '3050001': right}, {'30500': {'aModels': 3050001}})
        self.assertEqual(row, right)
        self.assertEqual(issue['resolvedModel'], 3050001)

    def test_conflict_without_matching_source_is_not_guessed(self):
        row, issue = resolve_default_model(
            {'id': 30500, 'role_id': 30500, 'model': 3018001},
            {'3018001': {'id': 3018001, 'role_id': 30180}}, {'30500': {'aModels': 3018001}})
        self.assertEqual(row['id'], 3018001)
        self.assertIsNone(issue['resolvedModel'])

    def test_valid_card_model_is_preserved(self):
        expected = {'id': 7101201, 'role_id': 71010}
        row, issue = resolve_default_model(
            {'id': 71012, 'role_id': 71010, 'model': 7101201},
            {'7101201': expected}, {'71010': {'aModels': 7101001}})
        self.assertEqual(row, expected)
        self.assertIsNone(issue)
