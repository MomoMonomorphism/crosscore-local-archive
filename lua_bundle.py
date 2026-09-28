"""Read TextAssets out of the game's `Custom/luascripts` bundle.

The bundle is an `ABCustom` BinaryFormatter wrapper around a UnityFS archive
whose payload is one continuous Lua source stream: every TextAsset is stored as

    [u32 tag][u32 name_len][name][zero pad to 4][u32 body_len][body...]

and each body starts with a UTF-8 BOM.  The layout is 4-byte aligned, which is
why a fixed `+1` padding guess only works for names whose length happens to make
`8 + len(name)` land at 31 mod 4.

Some blocks carry altered bytes in their LZ4 stream. Known repairs belong to an
older client build, so decoding always tries the shipped bytes first and accepts
a repair only when decompression reaches the declared size. Damaged blocks are
reported explicitly; `read_segments()` exposes only the intact portions of a
table. The current client has gaps in both `cfgSound` and `CfgCardRoleVoice`.
"""

from __future__ import annotations

import codecs
import re
import struct
from functools import lru_cache
from pathlib import Path
from typing import Iterator

import lz4.block
from runtime_paths import PATHS

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LUA_BUNDLE = PATHS['lua_bundle']

BLOCK_SIZE = 131072
NAME_RE = re.compile(rb"[A-Za-z0-9_]{3,64}\.lua")

# block index -> {compressed-stream offset: replacement byte}
# Older client byte repairs, used only when the original block fails to decode
# to its declared size. No patch is applied to a valid current block.
BLOCK_REPAIRS: dict[int, dict[int, int]] = {
    # cfgCfgCardRoleVoice.lua spans blocks 129-130; block 130 carries 4 altered bytes.
    130: {8885: 0x33, 8886: 0xEF, 8887: 0xBC, 8888: 0x8C},
    # cfgSound.lua spans blocks 563-600 and is damaged at 570, 578 and 595.
    # Block 595 in the current client is valid without this older patch.
    595: {4348: 0x11},
}


def _unwrap_abcustom(raw: bytes) -> bytearray:
    """Return the UnityFS payload from the BinaryFormatter ABCustom wrapper."""
    marker = raw.find(b"UnityFS\0")
    if marker >= 0:
        return bytearray(raw[marker:])
    # The ABCustom wrapper's first payload byte is overwritten in some client
    # revisions (0x15 in the earlier bundle, 0x1e in the current one). Recover
    # only that byte; the BinaryFormatter byte-array length and the UnityFS
    # version immediately after the signature must still validate.
    tail = raw.find(b"nityFS\0")
    marker = tail - 1
    if tail < 1 or marker < 5 or b"ABCustom" not in raw[:marker]:
        raise ValueError("UnityFS payload not found in luascripts")
    payload_size = int.from_bytes(raw[marker - 5 : marker - 1], "little")
    if payload_size < 64 or marker + payload_size > len(raw):
        raise ValueError("invalid ABCustom payload size")
    payload = bytearray(raw[marker : marker + payload_size])
    if payload[1:8] != b"nityFS\0" or payload[8:12] != b"\0\0\0\x08":
        raise ValueError("invalid UnityFS header in ABCustom payload")
    payload[0] = ord("U")
    return payload


def _bundle_blocks(payload: bytearray) -> tuple[list[tuple[int, int, int]], int]:
    pos = 0

    def read_cstring() -> bytes:
        nonlocal pos
        end = payload.index(0, pos)
        value = bytes(payload[pos:end])
        pos = end + 1
        return value

    if read_cstring() != b"UnityFS":
        raise ValueError("invalid UnityFS signature")
    version = struct.unpack_from(">I", payload, pos)[0]
    pos += 4
    read_cstring()  # player version
    read_cstring()  # engine version
    if version < 6:
        raise ValueError(f"unsupported UnityFS version {version}")
    bundle_size, compressed_size, uncompressed_size, flags = struct.unpack_from(">QIII", payload, pos)
    pos += 20
    if bundle_size != len(payload):
        raise ValueError("UnityFS size does not match ABCustom payload")
    pos = (pos + 15) & ~15
    compressed_info = bytearray(payload[pos : pos + compressed_size])

    try:
        info = lz4.block.decompress(bytes(compressed_info), uncompressed_size=uncompressed_size)
    except lz4.block.LZ4BlockError:
        # The first token in this client build was complemented (c2 -> 1d).
        compressed_info[0] ^= 0xFF
        info = lz4.block.decompress(bytes(compressed_info), uncompressed_size=uncompressed_size)
    if len(info) != uncompressed_size:
        raise ValueError("unexpected UnityFS block-info length")

    info_pos = 16
    block_count = struct.unpack_from(">i", info, info_pos)[0]
    info_pos += 4
    blocks: list[tuple[int, int, int]] = []
    for _ in range(block_count):
        blocks.append(struct.unpack_from(">IIH", info, info_pos))
        info_pos += 10

    data_offset = pos + compressed_size
    if flags & 0x200:
        data_offset = (data_offset + 15) & ~15
    return blocks, data_offset


def _decompress_block(payload: bytearray, block_index: int, offset: int, block: tuple[int, int, int]) -> bytes:
    uncompressed_size, compressed_size, flags = block
    compressed = bytes(payload[offset : offset + compressed_size])
    compression = flags & 0x3F

    def decode(data: bytes) -> bytes:
        if compression == 0:
            result = data
        elif compression in (2, 3):
            result = lz4.block.decompress(data, uncompressed_size=uncompressed_size)
        else:
            raise ValueError(f"unsupported UnityFS block compression {compression}")
        if len(result) != uncompressed_size:
            raise ValueError(f"unexpected length for Lua block {block_index}")
        return result

    # These repairs describe an older client build. The current block 595 is
    # valid as shipped; applying its old patch would break it.
    try:
        return decode(compressed)
    except (ValueError, lz4.block.LZ4BlockError):
        repairs = BLOCK_REPAIRS.get(block_index)
        if not repairs:
            raise
        patched = bytearray(compressed)
        for byte_offset, replacement in repairs.items():
            patched[byte_offset] = replacement
        return decode(bytes(patched))


class LuaBundle:
    """Flat view of the concatenated Lua source stream."""

    def __init__(self, path: Path = DEFAULT_LUA_BUNDLE) -> None:
        self.path = path
        payload = _unwrap_abcustom(path.read_bytes())
        self._blocks, data_offset = _bundle_blocks(payload)
        self._stream = bytearray()
        self.readable: list[bool] = []
        cursor = data_offset
        for index, block in enumerate(self._blocks):
            try:
                data = _decompress_block(payload, index, cursor, block)
                self._stream += data
                self.readable.append(True)
            except (ValueError, lz4.block.LZ4BlockError):
                # Keep offsets stable even for unreadable blocks: pad with zeros so
                # `block_offset()` stays valid for every index.
                self._stream += bytes(block[0])
                self.readable.append(False)
            cursor += block[1]  # block == (uncompressed_size, compressed_size, flags)
        self._assets: dict[str, tuple[int, int]] | None = None

    # -- geometry ---------------------------------------------------------
    def block_offset(self, index: int) -> int:
        return index * BLOCK_SIZE

    def block_of(self, position: int) -> int:
        return position // BLOCK_SIZE

    def stream_ok(self, position: int, length: int) -> bool:
        """True when [position, position+length) lies inside readable blocks only."""
        first = self.block_of(position)
        last = self.block_of(position + max(0, length - 1))
        return all(self.readable[i] for i in range(first, last + 1))

    # -- assets -----------------------------------------------------------
    @property
    def assets(self) -> dict[str, tuple[int, int]]:
        """name -> (body_start, body_len) in the flat stream."""
        if self._assets is None:
            found: dict[str, tuple[int, int]] = {}
            for match in NAME_RE.finditer(self._stream):
                name = match.group()
                name_at = match.start()
                if name_at < 8:
                    continue
                if int.from_bytes(self._stream[name_at - 4 : name_at], "little") != len(name):
                    continue
                size_at = (name_at + len(name) + 3) & ~3
                if size_at + 4 > len(self._stream):
                    continue
                body_len = int.from_bytes(self._stream[size_at : size_at + 4], "little")
                body_at = size_at + 4
                if not (0 < body_len <= 8_000_000):
                    continue
                if self._stream[body_at : body_at + 3] != b"\xef\xbb\xbf":
                    continue
                found[name.decode()] = (body_at, body_len)
            self._assets = found
        return self._assets

    def names(self) -> list[str]:
        return sorted(self.assets)

    def read(self, name: str) -> str:
        """Return one TextAsset as text (BOM stripped). Raises if unavailable."""
        if name not in self.assets:
            # Distinguish "absent" from "unreadable" so callers can report honestly.
            for match in NAME_RE.finditer(self._stream):
                if match.group() == name.encode():
                    raise ValueError(f"{name} is present but its block is unreadable")
            raise KeyError(f"{name} not found in luascripts")
        body_at, body_len = self.assets[name]
        if not self.stream_ok(body_at, body_len):
            raise ValueError(f"{name} spans a damaged block and could not be decoded")
        return self._stream[body_at : body_at + body_len].decode("utf-8-sig", errors="replace")

    def search(self, needle: str) -> Iterator[str]:
        pattern = re.compile(needle)
        for name in self.names():
            if pattern.search(name):
                yield name

    # -- partial reads ----------------------------------------------------
    def damaged_blocks(self, name: str) -> list[int]:
        """Block indexes this asset spans that cannot be decompressed."""
        if name not in self.assets:
            raise KeyError(f"{name} not found in luascripts")
        body_at, body_len = self.assets[name]
        first = self.block_of(body_at)
        last = self.block_of(body_at + body_len - 1)
        return [index for index in range(first, last + 1) if not self.readable[index]]

    def read_segments(self, name: str) -> list[tuple[int, str]]:
        """Read an asset that may span damaged blocks, one readable block at a time.

        `read()` refuses such an asset outright. Row-based tables can use the
        intact segments if their caller discards records cut by a block edge.

        Decoding runs through one incremental UTF-8 decoder across the blocks so a
        multi-byte character straddling a block boundary is not corrupted into
        U+FFFD on both sides.

        Returns `[(block_index, text), ...]` in stream order.
        """
        if name not in self.assets:
            raise KeyError(f"{name} not found in luascripts")
        body_at, body_len = self.assets[name]
        end = body_at + body_len
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        segments: list[tuple[int, str]] = []
        for index in range(self.block_of(body_at), self.block_of(end - 1) + 1):
            if not self.readable[index]:
                # A character split across the damaged block is unrecoverable; drop
                # the held-back bytes rather than gluing them onto the next block.
                decoder.reset()
                continue
            lo = max(self.block_offset(index), body_at)
            hi = min(self.block_offset(index) + BLOCK_SIZE, end)
            if hi <= lo:
                continue
            text = decoder.decode(bytes(self._stream[lo:hi]), final=hi >= end)
            segments.append((index, text))
        return segments


@lru_cache(maxsize=1)
def get_bundle(path: Path = DEFAULT_LUA_BUNDLE) -> LuaBundle:
    return LuaBundle(path)


if __name__ == "__main__":
    import sys

    bundle = get_bundle()
    readable = sum(bundle.readable)
    print(f"blocks: {readable}/{len(bundle._blocks)} readable")
    print(f"assets: {len(bundle.assets)}")
    if len(sys.argv) > 1:
        for wanted in sys.argv[1:]:
            try:
                text = bundle.read(wanted)
            except (KeyError, ValueError) as exc:
                print(f"-- {wanted}: {exc}")
                continue
            print(f"-- {wanted}: {len(text)} chars")
            print(text[:600])
