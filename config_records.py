"""Bounded recovery of scalar and flat-table config fields."""
import re
from luatable import parse_config

def records(text, fields):
    starts = [(m.group(1), m.end()) for m in re.finditer(r'(?:^|[\r\n])\s*,?\[(\d+)\]=\{', text)]
    first = re.search(r'=\{\[(\d+)\]=\{', text)
    if first:
        starts.insert(0, (first.group(1), first.end()))
    result = {}
    for index, (record_id, start) in enumerate(starts):
        end = starts[index + 1][1] if index + 1 < len(starts) else len(text)
        body = text[start:end].split('--[[DAMAGED]]--')[0]
        row = {}
        for field in fields:
            match = re.search(r'\["' + re.escape(field) + r'"\]=(\{[^{}]*\}|"(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)', body)
            if match:
                try:
                    row[field] = parse_config('{' + match.group(0) + '}')[field]
                except Exception:
                    pass
        if row.get('id') == int(record_id):
            result[record_id] = row
    return result
