import copy
import unittest
from text_localization import localize


class TextLocalizationTests(unittest.TestCase):
    def catalog(self):
        return {'phrases': {'獲得': '获得'}, 'characters': {'獲':'获', '國':'国', '語':'语'},
                'source': {'platform':'android','bundleSha256':'fixed'},
                'voices': {'cv/a.acb|a_01': {'label':'安卓标签','script':'安卓原文', 'audioId':99,'asset':'cfgSound.lua'}},
                'asmr': {'1': {'sheet':'asmr/a.acb','title':'标题','description':'说明','cvName':'姓名',
                               'lines': {'1':{'time':3,'word':'匹配台词'}, '2':{'time':9,'word':'错误时点'}}}}}

    def test_exact_bank_and_cue_only_and_input_unchanged(self):
        value={'entries': {'a':{'id':'a','sourceFile':'a.acb','sourceGroup':'cv','streams':[
            {'name':'A_01','index':1,'duration':2.5,'semantic':{'audioId':10,'script':'PC原文','category':'home'}},
            {'name':'A_02','index':2,'semantic':{'script':'國語'}}]},
            'b':{'id':'b','sourceFile':'b.acb','streams':[{'name':'A_01','semantic':{'script':'國語'}}]}}}
        original=copy.deepcopy(value)
        result=localize('voices',value,catalog=self.catalog())
        self.assertEqual(value,original)
        streams=result['entries']['a']['streams']
        self.assertEqual(streams[0]['semantic']['script'],'安卓原文')
        self.assertEqual(streams[0]['semantic']['audioId'],10)
        self.assertEqual(streams[0]['duration'],2.5)
        self.assertEqual(streams[1]['semantic']['script'],'国语')
        self.assertEqual(result['entries']['b']['streams'][0]['semantic']['script'],'国语')

    def test_asmr_requires_sheet_index_and_timestamp(self):
        album={'voice':1,'sheet':'asmr/a.acb','lines':[{'index':1,'time':3,'word':'國語'}, {'index':2,'time':8,'word':'國語'}]}
        result=localize('asmr',{'albums':[album]},catalog=self.catalog())['albums'][0]
        self.assertEqual(result['lines'][0]['word'],'匹配台词')
        self.assertEqual(result['lines'][1],{'index':2,'time':8,'word':'国语'})
        self.assertEqual(album['lines'][0]['word'],'國語')

    def test_verified_alias_text_uses_canonical_cue_without_changing_playback(self):
        alias = {'canonicalSheet': 'cv/a.acb', 'canonicalCue': 'A_01',
                 'verification': 'decoded-pcm-equality', 'sourceSha256': 'original'}
        stream = {'index': 17, 'name': 'Legacy_03', 'duration': 7.5,
                  'semantic': {'audioId': 10, 'script': 'PC原文', 'category': 'touch',
                               'textProvenance': {'platform': 'pc', 'bankAlias': alias}}}
        original = {'entries': {'legacy': {'id': 'legacy', 'sourceFile': 'legacy.acb',
                                           'sourceGroup': 'cv', 'streams': [stream]}}}
        result = localize('voices', original, catalog=self.catalog())['entries']['legacy']['streams'][0]
        self.assertEqual(result['semantic']['script'], '安卓原文')
        self.assertEqual(result['semantic']['audioId'], 10)
        self.assertEqual(result['semantic']['textProvenance']['audioId'], 99)
        self.assertEqual(result['semantic']['textProvenance']['bankAlias'], alias)
        self.assertEqual(result['semantic']['textProvenance']['cueName'], 'A_01')
        for field in ('index', 'name', 'duration'):
            self.assertEqual(result[field], stream[field])
        self.assertEqual(stream['semantic']['script'], 'PC原文')

    def test_ids_paths_and_animations_are_not_translated(self):
        original={'id':'國語','key':'國語','sourceFile':'國語.acb','animation':'國語','title':'獲得',
                  'roleNames':{'123':'國語'},'index':3,'loop':True}
        result=localize('manifest',original,catalog=self.catalog())
        for field in ('id','key','sourceFile','animation','index','loop'):
            self.assertEqual(result[field],original[field])
        self.assertEqual(result['title'],'获得')
        self.assertEqual(result['roleNames']['123'],'国语')


if __name__=='__main__':unittest.main()
