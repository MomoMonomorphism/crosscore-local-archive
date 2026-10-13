"""Build a reproducible simplified Chinese text overlay from fixed Android Lua."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lua_bundle import get_bundle
from luatable import parse_config
from runtime_paths import PATHS
from text_localization import FILENAME


def rows(bundle, asset):
    value = parse_config(bundle.read(asset))
    if isinstance(value, dict) and 'names' in value and 'data' in value:
        return [dict(zip(value['names'], row)) for row in value['data']]
    return list(value.values()) if isinstance(value, dict) else value


def sound_key(row):
    return row.get('cue_sheet', '').lower() + '|' + row.get('cue_name', '').lower()


def normalized_line_endings(text):
    # Only equivalent newline encodings; do not discard words, punctuation or spaces.
    return text.replace('\r\n', '\n').replace('\r', '\n')


def collect_voices(bundle):
    records = defaultdict(list)
    for asset in ['cfgSound.lua', 'cfgSound2.lua', 'cfgSound3.lua']:
        for row in rows(bundle, asset):
            records[sound_key(row)].append({
                'script': row.get('script1') or row.get('script2') or '',
                'label': row.get('name') or '', 'asset': asset, 'audioId': int(row['id'])})
    voices = {}; conflicts = set(); equivalent_formatting = {}
    for key, candidates in records.items():
        signatures = {(normalized_line_endings(r['script']), normalized_line_endings(r['label'])) for r in candidates}
        raw = {(r['script'], r['label']) for r in candidates}
        if len(signatures) != 1:
            conflicts.add(key)
            continue
        if len(raw) > 1:
            # Newline equivalence alone must not select between different playback IDs.
            if len({r['audioId'] for r in candidates}) != 1:
                conflicts.add(key)
                continue
            equivalent_formatting[key] = candidates
        # Preserve the existing table precedence and each chosen original text.
        voices[key] = candidates[-1]
    return voices, conflicts, equivalent_formatting


def collect_verified_original_voices(bundle, voices, conflicts):
    """Recover original bank references only when the active text corroborates them.

    cfgSound1 is a historical source table, not an active playback table. It
    cannot override current records or resolve current table conflicts. Cue
    renumbering within one bank still requires separate decoded-audio proof.
    """
    try:
        originals = rows(bundle, 'cfgSound1.lua')
    except KeyError:
        return {}
    active_by_id = defaultdict(list)
    for row in rows(bundle, 'cfgSound.lua'):
        active_by_id[int(row['id'])].append(row)
    original_by_key = defaultdict(list)
    for row in originals:
        original_by_key[sound_key(row)].append(row)
    recovered = {}
    for key, candidates in original_by_key.items():
        if key in voices or key in conflicts:
            continue
        signatures = {(int(r['id']), normalized_line_endings(r.get('name') or ''),
                       normalized_line_endings(r.get('script1') or r.get('script2') or ''))
                      for r in candidates}
        if len(signatures) != 1:
            continue
        audio_id, label, script = next(iter(signatures))
        active = active_by_id.get(audio_id, [])
        if len(active) != 1 or not label or not script:
            continue
        current = active[0]
        corroboration = voices.get(sound_key(current))
        if (not corroboration or corroboration['audioId'] != audio_id
                or current.get('cue_sheet', '').lower() == candidates[0].get('cue_sheet', '').lower()
                or normalized_line_endings(corroboration['label']) != label
                or normalized_line_endings(corroboration['script']) != script):
            continue
        original = candidates[-1]
        recovered[key] = {
            'script': original.get('script1') or original.get('script2'),
            'label': original['name'], 'asset': 'cfgSound1.lua', 'audioId': audio_id,
            'originalConfig': {'activeAsset': 'cfgSound.lua',
                               'activeCueSheet': current['cue_sheet'],
                               'activeCueName': current['cue_name'],
                               'verification': 'original-key-and-active-text-agreement'}}
    return recovered


def build(pc, android):
    candidates = defaultdict(set)
    pairs = []
    characters = {**json.loads((ROOT/'voice_fold_map.json').read_text('utf8')),
                  **json.loads((ROOT/'display_simplified_map.json').read_text('utf8'))}
    def pair(old, new):
        if isinstance(old, str) and isinstance(new, str) and old and new:
            candidates[old].add(new)
            folded = ''.join(characters.get(c, c) for c in old)
            candidates[folded].add(new)
            pairs.append((old, new))
    voices, voice_conflicts, equivalent_formatting = collect_voices(android)
    original_voices = collect_verified_original_voices(android, voices, voice_conflicts)
    voices.update(original_voices)
    for asset in ['cfgSound.lua', 'cfgSound2.lua', 'cfgSound3.lua']:
        try:
            before = {sound_key(r): r for r in rows(pc, asset)}
        except KeyError:
            before = {}  # PC folds some Android split sound sheets into cfgSound.
        for row in rows(android, asset):
            key = sound_key(row)
            if key in before:
                for field in ['name', 'script1', 'script2']:
                    pair(before[key].get(field), row.get(field))
    tables = [
        ('cfgcharacter.lua', 'id', ['englishName', 'l2dName'], ['key', 'desc', 'get_txt']),
        ('cfgCfgCardRole.lua', 'id', ['eName'], ['sName', 'sAliasName']),
        ('cfgCfgArchiveMultiPicture.lua', 'img', [], ['sName', 'get_txt']),
        ('cfgCfgArchiveIllustration.lua', 'id', ['small'], ['name', 'sName']),
        ('cfgCfgASMR.lua', 'cue_sheet2', [], ['name', 'des', 'cvName']),
    ]
    for asset, identity, guards, fields in tables:
        def key(r):return str(r.get(identity, '')).lower()
        before = {key(r): r for r in rows(pc, asset)}
        for row in rows(android, asset):
            old = before.get(key(row))
            if not old or any(str(old.get(g,'')).lower() != str(row.get(g,'')).lower() for g in guards):
                continue
            for field in fields:pair(old.get(field), row.get(field))
    asmr = {}
    old_lines = {str(r['id']): r['arr'] for r in rows(pc,'cfgCfgAsmrVoice.lua')}
    new_lines = {str(r['id']): r['arr'] for r in rows(android,'cfgCfgAsmrVoice.lua')}
    for row in rows(android,'cfgCfgASMR.lua'):
        voice = str(row['voice'])
        lines = {str(r['index']): {'word':r['word'],'time':r['time']} for r in new_lines.get(voice,[])}
        asmr[voice] = {'sheet':row['cue_sheet2'],'title':row['name'],'description':row.get('des',''),
                       'cvName':row.get('cvName',''),'lines':lines}
        for old in old_lines.get(voice,[]):
            new = lines.get(str(old['index']))
            if new and new['time'] == old['time']:pair(old['word'], new['word'])
    # Extend fallback conversions only for repeated, unambiguous characters not
    # present in Android text. Exact source phrases always take priority.
    android_chars = set(''.join(new for _,new in pairs))
    votes = defaultdict(Counter)
    for old,new in pairs:
        if len(old)==len(new):
            for a,b in zip(old,new):
                if a != b and '\u4e00' <= a <= '\u9fff' and '\u4e00' <= b <= '\u9fff' and a not in android_chars:
                    votes[a][b]+=1
    added = {}
    for a, counts in votes.items():
        if a not in characters and len(counts)==1 and sum(counts.values())>=3:
            added[a]=next(iter(counts))
    characters.update(added)
    return {'schema':1, 'locale':'zh-CN', 'phrases':{old:next(iter(v)) for old,v in candidates.items() if len(v)==1 and old!=next(iter(v))},
            'characters':characters,'voices':voices,'asmr':asmr,
            'audit':{'phraseConflicts':{k:sorted(v) for k,v in candidates.items() if len(v)>1},
                     'voiceConflicts':sorted(voice_conflicts),
                     'voiceEquivalentFormatting':equivalent_formatting,
                     'voiceVerifiedOriginals':original_voices,'addedFallbackCharacters':added}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--android',type=Path,required=True)
    parser.add_argument('--pc',type=Path,default=PATHS['lua_bundle'])
    parser.add_argument('--output',type=Path,default=PATHS['cache']/FILENAME)
    args=parser.parse_args()
    data=build(get_bundle(args.pc),get_bundle(args.android))
    data['source']={'platform':'android','locale':'zh-CN','bundleSha256':hashlib.sha256(args.android.read_bytes()).hexdigest()}
    data['pcBundleSha256']=hashlib.sha256(args.pc.read_bytes()).hexdigest()
    temporary=args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
    temporary.replace(args.output)
    print(json.dumps({'phrases':len(data['phrases']),'voices':len(data['voices']),'asmr':len(data['asmr']),
                      'phraseConflicts':len(data['audit']['phraseConflicts']),'voiceConflicts':len(data['audit']['voiceConflicts']),
                      'fallbackCharacters':len(data['characters']),'output':str(args.output)},ensure_ascii=False))


if __name__=='__main__':main()
