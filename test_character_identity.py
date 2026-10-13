import copy
import unittest

from character_identity import identity_records, regroup_characters


class CharacterIdentityTests(unittest.TestCase):
    def test_damaged_record_cannot_borrow_next_identity(self):
        text = ('_G["character"]={[1]={["id"]=1,["role_id"]=10,["englishName"]="A",'
                '--[[DAMAGED]]--\n,[2]={["id"]=2,["role_id"]=20,["englishName"]="B",'
                '["l2dName"]="B_spine"}}')
        rows = identity_records(text)
        self.assertIsNone(rows['1']['l2dName'])
        self.assertEqual(rows['2']['role_id'], 20)

    def test_source_identity_overrides_name_but_retains_unreferenced_assets(self):
        def entry(name, variants):
            return {'id': 'character:' + name, 'category': 'character', 'characterIds': ['10'],
                    'variants': [{'id': folder, 'label': '默认', 'main': {
                        'folder': folder, 'sourceName': folder, 'characterId': '10'}, 'effects': []}
                        for folder in variants]}
        entries = [entry('a', ['A', 'wrongly-grouped']), entry('b', ['B']), entry('newa', ['10_newA'])]
        rows = {'101': {'role_id': 10, 'englishName': 'A', 'l2dName': 'A'},
                '201': {'role_id': 20, 'englishName': 'B', 'l2dName': 'B'},
                '202': {'role_id': 20, 'englishName': 'B', 'l2dName': 'wrongly-grouped'}}
        aliases, defaults = {}, {}
        report = regroup_characters(entries, aliases, defaults, rows, {})
        self.assertEqual(len(report['moves']), 1)
        self.assertEqual([v['id'] for v in entries[1]['variants']], ['B', 'wrongly-grouped'])
        self.assertEqual(entries[2]['id'], 'character:newa')
        stable = copy.deepcopy(entries)
        self.assertEqual(regroup_characters(entries, aliases, defaults, rows, {})['moves'], [])
        self.assertEqual(stable, entries)

    def test_shared_english_name_does_not_merge_distinct_roles(self):
        entries = [{'id': 'character:a', 'category': 'character', 'characterIds': [], 'variants': [
            {'id': 'A', 'main': {'folder': 'A', 'sourceName': 'A'}, 'label': '默认'}]},
            {'id': 'character:other', 'category': 'character', 'characterIds': [], 'variants': [
                {'id': 'B', 'main': {'folder': 'B', 'sourceName': 'B'}, 'label': '默认'}]}]
        rows = {'1': {'role_id': 10, 'englishName': 'A', 'l2dName': 'A'},
                '2': {'role_id': 20, 'englishName': 'A', 'l2dName': 'B'}}
        self.assertEqual(regroup_characters(entries, {}, {}, rows, {})['moves'], [])


if __name__ == '__main__':
    unittest.main()
