"""Gallery ownership from game character records, independent of asset spelling.

Only complete scalar fields inside a bounded source record are used. This also
recovers identity fields in records whose unrelated nested tables cannot parse.
Unreferenced resources are retained, never inferred from a name or number alone.
"""
from __future__ import annotations

import re
from collections import defaultdict

from lua_bundle import get_bundle
from spine_action import _text, parse_config_entries
from voice_semantics import _field


def key(value: str) -> str:
    return re.sub(r"spine$", "", re.sub(r"[^a-z0-9]", "", value.lower()))


def identity_records(text: str) -> dict:
    marks = list(re.finditer(r'(?:^|[\r\n])\s*,?\[(\d+)\]=\{', text))
    # The first record immediately follows the table assignment.
    first = re.search(r'=\{\[(\d+)\]=\{', text)
    starts = ([(first.group(1), first.end())] if first else [])
    starts += [(m.group(1), m.end()) for m in marks]
    rows = {}
    for index, (model, start) in enumerate(starts):
        end = starts[index + 1][1] if index + 1 < len(starts) else len(text)
        body = text[start:end].split('--[[DAMAGED]]--')[0]
        row = {field: _field(body, field) for field in
               ('id', 'role_id', 'key', 'englishName', 'l2dName', 'skinType', 'desc')}
        if row['id'] == int(model) and row['role_id'] and row['englishName']:
            rows[model] = row
    return rows


def load_identity_sources() -> tuple[dict, dict]:
    bundle = get_bundle()
    rows = identity_records(_text(bundle, 'cfgcharacter.lua'))
    actions, _ = parse_config_entries(_text(bundle, 'cfgCfgSpineAction.lua'))
    return rows, actions


def regroup_characters(entries: list, aliases: dict, defaults: dict,
                       rows: dict | None = None, actions: dict | None = None) -> dict:
    if rows is None:
        rows, actions = load_identity_sources()
    actions = actions or {}
    from display_names import simplify_display
    references = defaultdict(list)
    for model, row in rows.items():
        if row.get('l2dName'):
            references[key(row['l2dName'])].append((model, row, 'cfgcharacter.l2dName'))
    # The same character config owns every pose explicitly named by its actions.
    def strings(value):
        if isinstance(value, dict):
            for child in value.values():
                yield from strings(child)
        elif isinstance(value, list):
            for child in value:
                yield from strings(child)
        elif isinstance(value, str):
            yield value
    for model, action in actions.items():
        if model not in rows:
            continue
        items = action.get('item', {})
        items = items.values() if isinstance(items, dict) else items
        pose_resources = [item.get('content', {}).get('changerole', []) for item in items]
        for value in strings(pose_resources):
            if 'spine' in value.lower():
                references[key(value)].append((model, rows[model], 'CfgSpineAction.resource'))

    characters = [e for e in entries if e['category'] == 'character']
    by_id = {e['id']: e for e in characters}
    targets = {}
    for row in rows.values():
        candidate = 'character:' + key(row['englishName'])
        if candidate in by_id:
            targets.setdefault(str(row['role_id']), set()).add(candidate)
    target_roles = defaultdict(set)
    for role, candidates in targets.items():
        for candidate in candidates:
            target_roles[candidate].add(role)
    moved, unresolved, resolved = [], [], {}
    old_defaults = {e['id']: e['variants'][0]['id'] for e in characters if e['variants']}
    for entry in characters:
        for variant in list(entry['variants']):
            main = variant['main']
            folder = re.sub(r'_(kr|jp)$', '', main['folder'], flags=re.I)
            matches = references.get(key(folder), []) or references.get(key(main['sourceName']), [])
            roles = {str(row['role_id']) for _, row, _ in matches}
            if len(roles) != 1:
                unresolved.append({'variant': variant['id'], 'reason': 'ambiguous' if roles else 'no-source-reference'})
                continue
            role = next(iter(roles))
            candidates = targets.get(role, set())
            if len(candidates) != 1:
                continue
            target_id = next(iter(candidates))
            if len(target_roles[target_id]) != 1:
                continue  # Shared English names do not prove one game identity.
            resolved[variant['id']] = role
            variant['identity'] = {'roleId': role, 'modelIds': sorted({m for m, _, _ in matches}),
                                   'sources': sorted({s for _, _, s in matches})}
            variant['label'] = simplify_display(variant['label'])
            if target_id == entry['id']:
                continue
            target = by_id[target_id]
            entry['variants'].remove(variant)
            target['variants'].append(variant)
            # Display-only label; original asset ID and animation data survive.
            if variant['label'] == '默认':
                row = matches[0][1]
                variant['label'] = {2: '突破', 3: '同调形态', 4: '切换形态'}.get(row.get('skinType'), '形态')
                if row.get('desc'):
                    variant['label'] += ' · ' + simplify_display(str(row['desc']))
            moved.append({'variant': variant['id'], 'from': entry['id'], 'to': target_id, 'roleId': role})
    owner = {v['id']: e['id'] for e in characters for v in e['variants']}
    for entry in characters:
        if not entry['variants']:
            original = old_defaults[entry['id']]
            aliases[entry['id']] = owner[original]
            defaults[entry['id']] = original
        elif any(m['from'] == entry['id'] or m['to'] == entry['id'] for m in moved):
            # Drop folder-derived IDs belonging solely to variants moved away.
            entry['characterIds'] = sorted({
                resolved.get(v['id']) or str(v['main'].get('characterId', '—'))
                for v in entry['variants']
            } - {'—', '', 'None'}, key=lambda s: (len(s), s))
    entries[:] = [e for e in entries if e['variants']]
    for old in list(aliases):
        seen = {old}
        while aliases.get(aliases[old]) and aliases[old] not in seen:
            seen.add(aliases[old])
            aliases[old] = aliases[aliases[old]]
    return {'moves': moved, 'unresolved': unresolved}
