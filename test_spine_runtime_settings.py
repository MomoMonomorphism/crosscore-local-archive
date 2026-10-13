import unittest
from types import SimpleNamespace
from spine_runtime_settings import settings_from_environment


class Object:
    def __init__(self, path_id, kind, data):
        self.path_id, self.type, self.data = path_id, SimpleNamespace(name=kind), data

    def read_typetree(self):
        return self.data

    def read(self):
        return SimpleNamespace(**self.data)


def ptr(number, file=0):
    return {'m_FileID': file, 'm_PathID': number}


class SettingsTests(unittest.TestCase):
    def fixture(self):
        return [Object(1, 'MonoBehaviour', {'startingAnimation': 'idle3', 'startingLoop': True,
                    'skeletonDataAsset': ptr(3)}),
                Object(2, 'MonoBehaviour', {'defaultMix': .9, 'skeletonJSON': ptr(5)}),
                Object(3, 'MonoBehaviour', {'defaultMix': .2, 'skeletonJSON': ptr(4),
                    'fromAnimation': ['idle1', ''], 'toAnimation': ['idle3', 'ignored'], 'duration': [.4, .8]}),
                Object(4, 'TextAsset', {'m_Name': 'correct'}), Object(5, 'TextAsset', {'m_Name': 'wrong'})]

    def test_follows_refs_and_preserves_mix_overrides(self):
        result = settings_from_environment(SimpleNamespace(objects=self.fixture()))
        self.assertEqual(list(result['models']), ['correct'])
        settings = result['models']['correct']
        self.assertEqual(settings['defaultMix'], .2)
        self.assertEqual(settings['startingAnimation'], 'idle3')
        self.assertEqual(settings['mixes'], [{'from': 'idle1', 'to': 'idle3', 'duration': .4}])

    def test_external_ref_not_matched_to_local_id(self):
        objects = self.fixture()
        objects[0].data['skeletonDataAsset'] = ptr(3, 1)
        result = settings_from_environment(SimpleNamespace(objects=objects))
        self.assertFalse(result['models'])
        self.assertTrue(result['warnings'])

    def test_profile_identity_matches_trimmed_asset_names(self):
        objects = self.fixture()
        objects[3].data['m_Name'] = ' correct '
        result = settings_from_environment(SimpleNamespace(objects=objects))
        self.assertEqual(list(result['models']), ['correct'])

    def test_conflicting_starts_not_guessed(self):
        objects = self.fixture()
        objects.append(Object(6, 'MonoBehaviour', {**objects[0].data, 'startingAnimation': 'idle2'}))
        result = settings_from_environment(SimpleNamespace(objects=objects))
        self.assertFalse(result['models'])
        self.assertIn('conflicting', result['warnings'][0])


if __name__ == '__main__':
    unittest.main()
