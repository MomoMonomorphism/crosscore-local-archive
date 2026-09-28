"""Parse the client's Lua-literal config tables (`_G["Name"]={...}`) into Python.

The shipped configs are plain Lua table constructors::

    _G["CfgASMR"]={{["id"]=1,["l2d"]="70030_skin_Poseidon03_ASMR_spine",...}}

Only tables, numbers, strings and booleans occur, so a small recursive-descent
parser covers them and avoids pulling a Lua VM into the environment.  The
Lua stream has localised splices (see `lua_bundle.read_segments`), so callers
should parse **entry by entry** and account for what fails — `parse_config`
deliberately raises rather than guessing.
"""

from __future__ import annotations

import re
from typing import Any

_NUM = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")
_INT_KEY = re.compile(r"\[(\d+)\]")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}
_WS = " \t\r\n"
_LONG = re.compile(r'\[(=*)\[')


class LuaParseError(ValueError):
    """Raised when the text is not the table constructor we expect."""


class _Parser:
    def __init__(self, text: str, start: int = 0) -> None:
        self.s = text
        self.i = start

    def ws(self) -> None:
        while self.i < len(self.s) and self.s[self.i] in _WS:
            self.i += 1

    def value(self) -> Any:
        self.ws()
        if self.i >= len(self.s):
            raise LuaParseError("unexpected end of input")
        c = self.s[self.i]
        if c == "{":
            return self.table()
        long = _LONG.match(self.s, self.i)
        if long:
            end_marker = ']' + long.group(1) + ']'
            end = self.s.find(end_marker, long.end())
            if end < 0:
                raise LuaParseError('unterminated long string')
            self.i = end + len(end_marker)
            return self.s[long.end():end].removeprefix('\r\n').removeprefix('\n')
        if c in ('"', "'"):
            return self.string()
        for word, out in (("true", True), ("false", False), ("nil", None)):
            if self.s.startswith(word, self.i):
                self.i += len(word)
                return out
        m = _NUM.match(self.s, self.i)
        if m:
            self.i = m.end()
            raw = m.group()
            return float(raw) if any(ch in raw for ch in ".eE") else int(raw)
        raise LuaParseError(f"unexpected {c!r} at offset {self.i}")

    def string(self) -> str:
        quote = self.s[self.i]
        if quote not in ('"', "'"):
            raise LuaParseError(f'expected quoted string at offset {self.i}')
        self.i += 1
        out: list[str] = []
        while True:
            if self.i >= len(self.s):
                raise LuaParseError("unterminated string")
            c = self.s[self.i]
            if c == "\\":
                if self.i + 1 >= len(self.s):
                    raise LuaParseError('unterminated escape')
                out.append(_ESCAPES.get(self.s[self.i + 1], self.s[self.i + 1]))
                self.i += 2
                continue
            if c == quote:
                self.i += 1
                return "".join(out)
            out.append(c)
            self.i += 1

    def table(self) -> Any:
        self.i += 1
        arr: list[Any] = []
        obj: dict[Any, Any] = {}
        while True:
            self.ws()
            if self.i >= len(self.s):
                raise LuaParseError("unterminated table")
            if self.s[self.i] == "}":
                self.i += 1
                break
            m = _INT_KEY.match(self.s, self.i)
            if m:
                self.i = m.end()
            elif self.s[self.i] == "[":
                self.i += 1
                key = self.string()
                self.ws()
                if self.i >= len(self.s) or self.s[self.i] != "]":
                    raise LuaParseError(f"expected ] at offset {self.i}")
                self.i += 1
                m = None
            else:
                key = None
                m = None
            if m is not None or key is not None:
                self.ws()
                if self.i >= len(self.s) or self.s[self.i] != "=":
                    raise LuaParseError(f"expected = at offset {self.i}")
                self.i += 1
                k = int(m.group(1)) if m else key
                obj[k] = self.value()
            else:
                arr.append(self.value())
            self.ws()
            if self.i < len(self.s) and self.s[self.i] == ",":
                self.i += 1
        if obj and not arr:
            return obj
        if obj:
            return {"__array": arr, **obj}
        return arr


def parse_config(text: str) -> Any:
    """Return the table body of a `_G["X"]={...}` (or bare `{...}`) config."""
    at = text.find("{")
    if at < 0:
        raise LuaParseError("no table constructor found")
    out = _Parser(text, at).table()
    if isinstance(out, dict) and "__array" in out:
        arr = out.pop("__array")
        arr.extend(out.values())
        return arr
    return out


def top_level_entries(text: str) -> list[tuple[int, int]]:
    """`(numeric key, offset)` for every `[<digits>]={...}` at table depth 1.

    Lets a caller slice a big keyed table into entries and parse them one at a
    time, so a single spliced entry costs that entry instead of the whole table.
    """
    i = text.find("{") + 1
    depth = 1
    n = len(text)
    out: list[tuple[int, int]] = []
    while i < n:
        c = text[i]
        comment = text.startswith('--', i)
        long = _LONG.match(text, i + 2 if comment else i)
        if long:
            close = ']' + long.group(1) + ']'
            end = text.find(close, long.end())
            i = n if end < 0 else end + len(close)
            continue
        if comment:
            end = text.find('\n', i)
            i = n if end < 0 else end + 1
            continue
        if c in ('"', "'"):
            quote = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif depth == 1 and c == "[":
            m = _INT_KEY.match(text, i)
            if m:
                # `_INT_KEY` consumes the closing `]`, so `=` must come next.
                k = m.end()
                while k < n and text[k] in _WS:
                    k += 1
                if k < n and text[k] == "=":
                    out.append((int(m.group(1)), i))
                    i = k
        i += 1
    return out


def config_record_entries(text: str) -> list[tuple[int, int]]:
    """Recover newline-delimited generated records despite damaged nesting.

    Successfully parsed records protect all their strings and nested tables
    from being treated as new records. Failed records end at the next explicit
    record header; callers must report the failed record, never salvage its body.
    Intact rows must have an id matching their outer key. This recovery is for
    the client's generated tables, not arbitrary hand-written Lua programs.
    Other table layouts continue to use the normal depth scanner.
    """
    recovered = []
    protected_until = -1
    headers = re.compile(r'(?:^|[\r\n])\s*,?\[(\d+)\]\s*=\s*\{')
    candidates = [(m.group(1), text.index('[', m.start(), m.end()), m.end()-1)
                  for m in headers.finditer(text)]
    first = re.search(r'=\s*\{\s*\[(\d+)\]\s*=\s*\{', text)
    if first:
        candidates.insert(0, (first.group(1), text.index('[', first.start(), first.end()), first.end()-1))
    for identity, start, body in candidates:
        if start < protected_until:
            continue
        parser = _Parser(text, body)
        try:
            row = parser.value()
            protected_until = parser.i
            if not isinstance(row, dict) or row.get('id') != int(identity):
                continue
        except (LuaParseError, IndexError):
            pass
        recovered.append((int(identity), start))
    return recovered or top_level_entries(text)
