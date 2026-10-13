"""Android-sourced display text overlay; resource IDs and behavior stay untouched."""
import json
from functools import lru_cache
from pathlib import Path
from runtime_paths import PATHS

FILENAME = 'android_text_zh_cn.generated.json'
TEXT_KEYS = {'title', 'titleSimplified', 'label', 'labelSimplified', 'script', 'word',
             'name', 'roleName', 'character', 'description', 'cvName', 'obtain',
             'sName', 'desc', 'get_txt', 'text', 'hint', 'message'}
VOICE_GROUPS = ('entries', 'variantEntries', 'auxiliaryEntries', 'chineseEntries',
                'chineseVariantEntries', 'pictureEntries')


@lru_cache(maxsize=4)
def load_catalog(path):
    path = Path(path)
    return json.loads(path.read_text('utf8')) if path.is_file() else None


def translate(text, catalog):
    if not isinstance(text, str):
        return text
    return catalog['phrases'].get(text, ''.join(catalog['characters'].get(c, c) for c in text))


def localize(domain, value, cache=PATHS['cache'], catalog=None):
    catalog = catalog if catalog is not None else load_catalog(str(cache / FILENAME))
    if not catalog:
        return value

    def walk(node, field=''):
        if isinstance(node, list):
            return [walk(item, field) for item in node]
        if isinstance(node, dict):
            return {key: walk(item, key if field not in ('roleNames', 'entryNames', 'sTypeNames') else field)
                    for key, item in node.items()}
        if field in TEXT_KEYS or field in ('roleNames', 'entryNames', 'sTypeNames'):
            return translate(node, catalog)
        return node

    result = walk(value)
    if domain == 'voices':
        for group in VOICE_GROUPS:
            for bank in result.get(group, {}).values():
                prefix = {'picture': 'picture/', 'cv_skin': 'cv/cv_skin/',
                          'cv': 'cv/', 'cv_cn': 'cv/'}.get(bank.get('sourceGroup', 'cv'))
                if not prefix:
                    continue
                sheet = prefix + bank['sourceFile'].lower()
                for stream in bank.get('streams', []):
                    key = sheet + '|' + stream['name'].lower()
                    record = catalog['voices'].get(key)
                    semantic = stream.get('semantic')
                    resolved_sheet, resolved_cue = sheet, stream['name']
                    alias = (semantic or {}).get('textProvenance', {}).get('bankAlias')
                    if not record and alias:
                        resolved_sheet, resolved_cue = alias['canonicalSheet'], alias.get('canonicalCue', stream['name'])
                        record = catalog['voices'].get(resolved_sheet + '|' + resolved_cue.lower())
                    if not record or not semantic:
                        continue
                    if record['script']:
                        semantic['script'] = record['script']
                        semantic['textProvenance'] = {**semantic.get('textProvenance', {}), **catalog['source'], 'asset': record['asset'],
                                                      'audioId': record['audioId'], 'cueSheet': resolved_sheet, 'cueName': resolved_cue}
                    if record['label']:
                        semantic['label'] = semantic['labelSimplified'] = record['label']
    elif domain == 'asmr':
        for album in result.get('albums', []):
            matched = catalog['asmr'].get(str(album['voice']))
            if not matched or album['sheet'].lower() != matched['sheet'].lower():
                continue
            for field in ('title', 'description', 'cvName'):
                album[field] = matched[field]
            for line in album['lines']:
                text = matched['lines'].get(str(line['index']))
                if text and text['time'] == line['time']:
                    line['word'] = text['word']
    return result


def localized_bytes(domain, raw, cache=PATHS['cache']):
    if not raw or not load_catalog(str(cache / FILENAME)):
        return raw
    return json.dumps(localize(domain, json.loads(raw), cache), ensure_ascii=False).encode('utf8')
