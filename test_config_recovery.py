import unittest
from luatable import parse_config
from spine_action import parse_config_entries


class ConfigRecoveryTest(unittest.TestCase):
    def test_mixed_implicit_and_keyed_entries_are_all_read(self):
        text = '_G["X"]={{["id"]=1},{["id"]=2},[48]={["id"]=48}}'
        rows, failed = parse_config_entries(text)
        self.assertEqual(set(rows), {'1', '2', '48'})
        self.assertEqual(failed, [])
        self.assertEqual(set(parse_config_entries(text, {2, 48})[0]), {'2', '48'})

    def test_duplicate_declared_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            parse_config_entries('{{["id"]=1},{["id"]=1}}')

    def test_broken_middle_does_not_hide_tail(self):
        text = '_G["X"]={[1]={["id"]=1},\n[2]={["id"]=2,["bad\n[3]={["name"]="ok",["id"]=3}}'
        rows, damaged = parse_config_entries(text)
        self.assertEqual(set(rows), {'1', '3'})
        self.assertEqual(damaged, [2])

    def test_literal_fake_header_is_not_a_record(self):
        text = '_G["X"]={[1]={["id"]=1,["text"]=[=[\n[99]={["id"]=99}\n]=]},\n[2]={["id"]=2}}'
        rows, damaged = parse_config_entries(text)
        self.assertEqual(set(rows), {'1', '2'})
        self.assertEqual(damaged, [])

    def test_quote_styles_and_long_strings(self):
        self.assertEqual(parse_config("{['name']='hello', ['other']=[=[world]=]}"),
                         {'name':'hello', 'other':'world'})


if __name__ == '__main__':
    unittest.main()
