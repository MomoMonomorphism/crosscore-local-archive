import unittest
from archive_supplement import select_additions


class ArchiveSupplementTests(unittest.TestCase):
    def test_colliding_platform_ids_remain_separate(self):
        existing = {'95': {'id': 95, 'img': 'Private_Consultation'}}
        row = {'id': 95, 'img': 'Awaited_Delicacy', 'sName': '待享美味', 'show': False, 'l2dName': 'kuizhou'}
        result = select_additions([row], existing, {'awaited_delicacy': 'awaited_delicacy'}, 'hash', {95})
        self.assertEqual(list(result), ['android:95'])
        self.assertEqual(existing['95']['img'], 'Private_Consultation')
        self.assertEqual(result['android:95']['source']['archiveId'], 95)
        self.assertFalse(result['android:95']['show'])
        self.assertFalse(result['android:95']['hasDynamicTouch'])
        self.assertEqual(result['android:95']['entryMatches'], [])

    def test_duplicate_image_is_not_reimported_under_another_id(self):
        result = select_additions([{'id': 98, 'img': 'Same'}], {'94': {'img': 'same'}}, {}, 'hash', {98})
        self.assertEqual(result, {})

    def test_missing_local_image_fails_before_import(self):
        with self.assertRaisesRegex(ValueError, 'Missing local image'):
            select_additions([{'id': 95, 'img': 'unknown'}], {}, {}, 'hash', {95})


if __name__ == '__main__':
    unittest.main()
