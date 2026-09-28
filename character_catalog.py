"""Character portraits and reviewed ownership supplements from local game tables."""
from collections import defaultdict
from asset_cache import DEFAULT_SOURCE
from config_records import records
from character_identity import key
from display_names import simplify_display
from lua_bundle import get_bundle
from spine_action import _text
from luatable import parse_config

# Cross-build verification is recorded in ANDROID_IDENTITY_FINDINGS_2026-09-26.md.
# Other conflicts are reported, not automatically resolved by trusting role_id.
VERIFIED_DEFAULT_MODELS = {30500: 3050001}

def resolve_default_model(card, chars, roles):
    """Trust a card's model only when its explicit character role agrees.

    CfgCardRole.aModels supplies an independent source reference, not a guessed
    model-ID suffix. Only cross-build verified corrections are applied; other
    conflicts retain their existing source model and remain explicitly reported.
    """
    model = str(card['model'])
    row = chars.get(model, {})
    role = card['role_id']
    if not row.get('role_id') or row['role_id'] == role:
        return row, None
    alternate = roles.get(str(role), {}).get('aModels')
    replacement = chars.get(str(alternate), {})
    resolved = bool(replacement and replacement.get('role_id') == role
                    and VERIFIED_DEFAULT_MODELS.get(card['id']) == alternate)
    issue = {'cardId': card['id'], 'roleId': role, 'originalModel': card['model'],
             'originalModelRole': row['role_id'], 'resolvedModel': alternate if resolved else None,
             'source': 'CfgCardRole.aModels + character.role_id' if resolved else 'unresolved role conflict'}
    return (replacement if resolved else row), issue


def enrich_characters(entries, aliases, defaults):
    bundle = get_bundle()
    chars = records(_text(bundle, 'cfgcharacter.lua'), ['id', 'role_id', 'key', 'englishName', 'img', 'l2dName', 'imgPos', 'face', 'faceID', 'desc'])
    cards = records(_text(bundle, 'cfgCardData.lua'), ['id', 'base_card', 'role_id', 'model', 'breakModels', 'skin'])
    roles = records(_text(bundle, 'cfgCfgCardRole.lua'), ['id', 'aModels'])
    actions = parse_config(_text(bundle, 'cfgCfgImageAction.lua'))
    by_id = {e['id']: e for e in entries}
    moves = []
    # Explicitly reviewed resource alias; it remains a separate idle-only asset.
    supplements = {'character:newcapriccio': 'character:capriccio', 'character:jiguang': 'character:aurora'}
    for source, destination in supplements.items():
        target = by_id.get(destination)
        token = 'newcapriccio' if source.endswith('newcapriccio') else 'jiguang'
        existing = next((v for v in (target or {}).get('variants', []) if token in v['main']['folder'].lower()), None)
        if existing:
            defaults.setdefault(source, existing['id'])
    def move(old, target, variant, evidence):
        if old is target:
            return
        old['variants'].remove(variant)
        target['variants'].append(variant)
        moves.append({'from': old['id'], 'to': target['id'], 'variant': variant['id'], 'evidence': evidence})
    for source, destination in supplements.items():
        if source not in by_id or destination not in by_id:
            continue
        old, target = by_id[source], by_id[destination]
        if old['variants']:
            defaults.setdefault(source, old['variants'][0]['id'])
        for variant in list(old['variants']):
            if source.endswith('jiguang'):
                variant['archiveId'] = 1026
                variant['label'] = '半身档案 · 美味侍奉'
                evidence = 'CfgArchiveMultiPicture[1026]: 极光'
            else:
                variant['label'] = '皮肤04A · 仅待机版本'
                evidence = 'user-reviewed alias: newcapriccio; no interaction inferred'
            move(old, target, variant, evidence)
        aliases[source] = destination
    by_resource = {key(v['main']['folder']): (e, v) for e in entries for v in e['variants']}
    for row in chars.values():
        family = str(row.get('face', '')).split('/')[0]
        if family not in ('71010', '71020') or not row.get('l2dName'):
            continue
        found = by_resource.get(key(row['l2dName']))
        target = by_id.get('character:captainm' if family == '71010' else 'character:captainf')
        if found and target:
            move(found[0], target, found[1], 'cfgcharacter.face protagonist family + l2dName')
    for identity, title in [('character:captainm', '总队长（男）'), ('character:captainf', '总队长（女）')]:
        if identity in by_id:
            by_id[identity]['displayName'] = title
    owners = {v['id']: e['id'] for e in entries for v in e['variants']}
    for e in list(entries):
        if not e['variants'] and not e.get('portraits') and e['id'] in {m['from'] for m in moves}:
            preferred = defaults.get(e['id'])
            aliases[e['id']] = owners.get(preferred) or next(m['to'] for m in moves if m['from'] == e['id'])
            entries.remove(e)
    # Resolve role owners by exact game resource references, never localized names.
    role_owners = defaultdict(set)
    by_resource = {key(v['main']['folder']): e['id'] for e in entries for v in e['variants']}
    for row in chars.values():
        owner = by_resource.get(key(row.get('l2dName', '')))
        if owner and row.get('role_id'):
            role_owners[str(row['role_id'])].add(owner)
    for entry in entries:
        if entry['category'] == 'character' and entry['variants']:
            for role in entry.get('characterIds', []):
                if not role_owners[str(role)]:
                    role_owners[str(role)].add(entry['id'])
    for e in entries:
        e['portraits'] = []
    added = 0
    model_conflicts = []
    for card in cards.values():
        if card.get('base_card') is not True or not card.get('role_id') or not card.get('model'):
            continue
        row, conflict = resolve_default_model(card, chars, roles)
        if conflict:
            model_conflicts.append(conflict)
        image = row.get('img')
        if not image or not (DEFAULT_SOURCE / ('textures_bigs_character_' + image.lower())).is_file():
            continue
        role = str(row.get('role_id', card.get('role_id')))
        candidates = role_owners[role]
        family = str(row.get('face', '')).split('/')[0]
        owner = ('character:captainm' if family == '71010' else 'character:captainf') if family in ('71010', '71020') else (next(iter(candidates)) if len(candidates) == 1 else None)
        if not owner:
            owner = 'character:role' + role
        entry = next((e for e in entries if e['id'] == owner), None)
        if entry is None:
            entry = {'id': owner, 'title': row.get('englishName') or role, 'displayName': simplify_display(row.get('key') or role), 'category': 'character', 'characterIds': [role], 'variants': [], 'portraits': []}
            entries.append(entry)
            added += 1
        if row.get('key'):
            entry.setdefault('displayName', simplify_display(row['key']))
        if role not in entry['characterIds']:
            entry['characterIds'].append(role)
        model = str(row['id'])
        if any(p['modelId'] == model for p in entry['portraits']):
            continue
        entry['portraits'].append({'modelId': model, 'roleId': role, 'label': '默认立绘' if not entry['portraits'] else '默认立绘 · ' + simplify_display(row.get('key') or str(card['id'])) + ' · ' + str(card['id']), 'image': image.lower(), 'url': '/assets/portrait/' + image.lower() + '.png', 'imgPos': row.get('imgPos'), 'faceID': row.get('faceID'), 'touches': actions.get(int(model), {}).get('item', [])})
    for alias, target in list(aliases.items()):
        seen = {alias}
        while target in aliases and target not in seen:
            seen.add(target)
            target = aliases[target]
        aliases[alias] = target
    # A previous migration may have made an unbound role entry before a source
    # owner became available. Remove only our now-empty synthetic entries.
    for entry in list(entries):
        if entry['id'].startswith('character:role') and not entry['variants'] and not entry['portraits']:
            role = entry['id'].removeprefix('character:role')
            targets = role_owners.get(role, set())
            if len(targets) == 1:
                aliases[entry['id']] = next(iter(targets))
            entries.remove(entry)
    return {'moves': moves, 'staticOnlyEntriesAdded': added, 'portraits': sum(len(e.get('portraits', [])) for e in entries), 'defaultModelConflicts': model_conflicts}
