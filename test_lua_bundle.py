"""Synthetic fixtures: no game data required to exercise complete decoding."""
import struct
import tempfile
import unittest
from pathlib import Path

import lz4.block

from lua_bundle import BLOCK_SIZE, LuaBundle, _decode_abcustom, _unwrap_abcustom


def wrap(payload):
    return b'fixture-ABCustom\x0f' + struct.pack('<I', len(payload)) + b'\x02' + payload + b'\x0b'


def bundle_fixture():
    name = b'cfgFixture.lua'
    body = ('\ufeff' + '-- Unicode across block boundaries: 入场台词\n' * 9000).encode('utf8')
    stream = struct.pack('<II', 0, len(name)) + name
    stream += bytes((-len(stream)) % 4)
    stream += struct.pack('<I', len(body)) + body
    chunks = [stream[i:i + BLOCK_SIZE] for i in range(0, len(stream), BLOCK_SIZE)]
    compressed = [lz4.block.compress(c, store_size=False) for c in chunks]
    info = bytes(16) + struct.pack('>i', len(chunks))
    info += b''.join(struct.pack('>IIH', len(c), len(z), 3) for c, z in zip(chunks, compressed))
    info += struct.pack('>i', 0)
    packed_info = lz4.block.compress(info, store_size=False)
    header = b'UnityFS\0' + struct.pack('>I', 8) + b'5.x.x\0fixture\0'
    aligned = (len(header) + 20 + 15) & ~15
    size = aligned + len(packed_info) + sum(map(len, compressed))
    header += struct.pack('>QIII', size, len(packed_info), len(info), 3)
    return header + bytes(aligned - len(header)) + packed_info + b''.join(compressed), body.decode('utf-8-sig')


class LuaBundleTests(unittest.TestCase):
    def test_length_dependent_transform_known_positions_and_roundtrip(self):
        # For length 1000: key=239, stride=10; after 0 XOR 239, next key=239.
        plain = bytearray(i % 256 for i in range(1000))
        encoded = plain.copy()
        _decode_abcustom(encoded)
        self.assertEqual(encoded[0], 239)
        self.assertEqual(encoded[10], 10 ^ 239)
        self.assertEqual(encoded[20], 20 ^ ((10 + (10 ^ 239)) & 255))
        self.assertEqual(encoded[1:10], plain[1:10])
        _decode_abcustom(encoded)
        self.assertEqual(encoded, plain)

    def test_real_reader_restores_all_blocks_and_exact_text(self):
        payload, expected = bundle_fixture()
        encoded = bytearray(payload)
        _decode_abcustom(encoded)
        for label, raw in [('raw', payload), ('wrapped', wrap(payload)), ('scrambled', wrap(encoded))]:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'luascripts'
                path.write_bytes(raw)
                bundle = LuaBundle(path)
                self.assertTrue(all(bundle.readable))
                self.assertGreater(len(bundle.readable), 1)
                self.assertEqual(bundle.read('cfgFixture.lua'), expected)
                self.assertEqual(''.join(x[1] for x in bundle.read_segments('cfgFixture.lua')).lstrip('\ufeff'), expected)
                self.assertEqual(path.read_bytes(), raw)

    def test_invalid_encrypted_signature_is_not_silently_repaired(self):
        payload, _ = bundle_fixture()
        encoded = bytearray(payload)
        _decode_abcustom(encoded)
        encoded[0] ^= 1
        with self.assertRaisesRegex(ValueError, 'transform'):
            _unwrap_abcustom(wrap(encoded))

    def test_truncated_wrapper_is_rejected(self):
        payload, _ = bundle_fixture()
        encoded = bytearray(payload)
        _decode_abcustom(encoded)
        with self.assertRaisesRegex(ValueError, 'size'):
            _unwrap_abcustom(wrap(encoded)[:-20])


if __name__ == '__main__':
    unittest.main()
