"""Reviewed source corrections applied before coordinate/pose extraction.

Every correction has an exact original-row guard and a resource identity guard.
Changed upstream data must be reviewed again rather than silently patched.
"""
import copy
import json
from pathlib import Path


def apply_corrections(table: str, rows: list[dict], display: dict[int, dict]):
    document = json.loads(Path(__file__).with_name('interaction_corrections.json').read_text('utf-8'))
    if document['schema'] != 1:
        raise ValueError('Unsupported interaction correction schema')
    result = copy.deepcopy(rows)
    applied = []
    for correction in document['corrections']:
        if correction['table'] != table:
            continue
        model = next((row for row in result if row['id'] == correction['modelId']), None)
        if model is None or display.get(correction['modelId'], {}).get('l2dName') != correction['initialSpine']:
            raise ValueError(f"Correction resource identity changed: {correction['id']}")
        targets = [(i, row) for i, row in enumerate(model['item']) if row['index'] == correction['rowIndex']]
        if len(targets) != 1 or targets[0][1] != correction['expectedRow']:
            raise ValueError(f"Correction original row changed; review required: {correction['id']}")
        if correction['replacementRow'] != correction['source']['row']:
            raise ValueError(f"Replacement differs from recorded source evidence: {correction['id']}")
        model['item'][targets[0][0]] = copy.deepcopy(correction['replacementRow'])
        applied.append(copy.deepcopy(correction))
    return result, applied
