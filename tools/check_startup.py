"""Configuration/diagnostic regression checks; live cache and port 8798 stay untouched."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_paths import load_paths, PATHS
from startup_check import inspect, MANIFESTS


class StartupChecks(unittest.TestCase):
    def test_relative_paths_and_environment_override(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'viewer.json'
            config.write_text(json.dumps({'game_data': 'game', 'cache': 'cached files'}))
            paths = load_paths(config, {'CROSSCORE_CACHE': 'preferred cache'})
            self.assertEqual(paths['source'], Path(directory) / 'game/GameHotRes/Custom')
            self.assertEqual(paths['lua_bundle'], paths['source'] / 'luascripts')
            self.assertEqual(paths['cache'], Path(directory) / 'preferred cache')
            self.assertEqual(paths['chinese_source'], Path(directory) / 'game/GameHotRes/sounds_cn/cv')

    def test_configuration_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'viewer.json'
            with self.assertRaises(FileNotFoundError):
                load_paths(config, {})
            for value in ({'cahce': 'typo'}, {'cache': ''}, []):
                config.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    load_paths(config, {})

    def test_production_imports_share_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'viewer.json'
            config.write_text(json.dumps({'game_data': 'relocated game', 'cache': 'relocated cache'}))
            code = '''
from runtime_paths import PATHS as p
import asset_cache as a, lua_bundle as l, voice_cache as v, thumbnail_cache as t
import spine_action as s, multi_picture_action as m
from tools.run_game_lua import DEFAULT_XLUA
assert a.DEFAULT_SOURCE == t.DEFAULT_SOURCE == p['source']
assert a.DEFAULT_CACHE == v.DEFAULT_CACHE == t.DEFAULT_CACHE == p['cache']
assert l.DEFAULT_LUA_BUNDLE == p['lua_bundle']
assert v.DEFAULT_SOURCE == p['voice_source'] and v.DEFAULT_CHINESE_SOURCE == p['chinese_source']
assert s.DEFAULT_OUT.parent == m.DEFAULT_OUT.parent == p['cache']
assert DEFAULT_XLUA == p['xlua']
'''
            env = {k: v for k, v in os.environ.items() if not k.startswith('CROSSCORE_')}
            env['CROSSCORE_CONFIG'] = str(config)
            subprocess.run([sys.executable, '-X', 'utf8', '-c', code], cwd=ROOT, env=env, check=True)

    def test_missing_and_malformed_manifests_are_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            report = inspect({**PATHS, 'cache': cache})
            errors = {c['name'] for c in report['checks'] if c['status'] == 'error'}
            self.assertTrue(set(MANIFESTS).issubset(errors))
            self.assertEqual(list(cache.iterdir()), [])
            bad = cache / 'asmr.generated.json'
            bad.write_text('{}')
            report = inspect({**PATHS, 'cache': cache})
            self.assertTrue(any(c['name'] == bad.name and c['status'] == 'error' for c in report['checks']))
            self.assertEqual(bad.read_text(), '{}')

    def test_new_server_identity_on_private_test_port(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / 'cache'
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            env = {**os.environ, 'CROSSCORE_CACHE': str(cache)}
            with (Path(directory) / 'server.log').open('w', encoding='utf8') as log:
                # Self-closing test server avoids killing a Windows venv redirector
                # while its actual interpreter still owns the socket/log file.
                code = '''
import threading, server
class TestServer(server.AssetServer):
    def serve_forever(self, *args, **kwargs):
        timer = threading.Timer(3, self.shutdown)
        timer.start()
        try: return super().serve_forever(*args, **kwargs)
        finally: timer.cancel()
server.AssetServer = TestServer
server.main()
'''
                process = subprocess.Popen([sys.executable, '-X', 'utf8', '-c', code, '--port', str(port)],
                                           cwd=ROOT, env=env, stdout=log, stderr=log)
                try:
                    health = None
                    for _ in range(60):
                        if process.poll() is not None:
                            self.fail('Test server exited; ' + (Path(directory) / 'server.log').read_text(encoding='utf8'))
                        try:
                            with urlopen(f'http://127.0.0.1:{port}/api/health', timeout=.5) as response:
                                health = json.load(response)
                            break
                        except OSError:
                            time.sleep(.1)
                    self.assertIsNotNone(health)
                    self.assertIn(process.pid, (health['pid'], health['parentPid']))
                    self.assertEqual(health['service'], 'crosscore-local-viewer')
                    self.assertEqual(Path(health['workspace']), ROOT)
                    self.assertEqual(Path(health['cache']), cache)
                    self.assertEqual(Path(health['runtimePaths']['cache']), cache)
                    self.assertEqual(Path(health['runtimePaths']['xlua']), PATHS['xlua'])
                    self.assertEqual(health['buildIndexSha256'], hashlib.sha256((ROOT / 'dist/index.html').read_bytes()).hexdigest())
                finally:
                    process.wait(timeout=15)

    def test_voice_freshness_detects_missing_or_changed_bound_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lua = root / 'lua'
            lua.write_bytes(b'lua')
            catalog = root / 'android_text_zh_cn.generated.json'
            catalog.write_bytes(b'catalog')
            aliases = root / 'voice_bank_aliases.json'
            aliases.write_bytes(b'aliases')
            manifest = {'entries': {}, 'pictureEntries': {}, 'semanticIndexSource': {
                'luaSha256': hashlib.sha256(b'lua').hexdigest(),
                'androidTextSha256': hashlib.sha256(b'catalog').hexdigest(),
                'bankAliasesSha256': hashlib.sha256(b'aliases').hexdigest()}}
            (root / 'voices.generated.json').write_text(json.dumps(manifest))
            def status():
                report = inspect({**PATHS, 'cache': root, 'lua_bundle': lua}, root=root)
                return next(c['status'] for c in report['checks'] if c['name'] == 'voice semantic index freshness')
            self.assertEqual(status(), 'ok')
            catalog.unlink()
            self.assertEqual(status(), 'warning')
            catalog.write_bytes(b'catalog')
            aliases.unlink()
            self.assertEqual(status(), 'warning')
            aliases.write_bytes(b'changed aliases')
            self.assertEqual(status(), 'warning')
            aliases.write_bytes(b'aliases')
            android_lua = root / 'android-lua'
            android_lua.write_bytes(b'android')
            annotations = root / 'voice_annotations.json'
            annotations.write_text(json.dumps({'luaSources': {'android': {
                'path': 'android-lua', 'sha256': hashlib.sha256(b'android').hexdigest()}}}))
            manifest['semanticIndexSource']['annotationsSha256'] = hashlib.sha256(annotations.read_bytes()).hexdigest()
            (root / 'voices.generated.json').write_text(json.dumps(manifest))
            self.assertEqual(status(), 'ok')
            android_lua.write_bytes(b'changed android')
            self.assertEqual(status(), 'warning')
            android_lua.unlink()
            self.assertEqual(status(), 'warning')
            android_lua.write_bytes(b'android')
            annotations.unlink()
            self.assertEqual(status(), 'warning')


if __name__ == '__main__':
    unittest.main(verbosity=2)
