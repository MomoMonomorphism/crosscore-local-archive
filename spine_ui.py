"""Local, session-isolated execution of original SpineUI Lua in the game's xLua."""
import json
import math
import secrets
import sys
import threading
import time
from pathlib import Path
from spine_ui_assets import MODELS, extract
from lua_bundle import get_bundle

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
from run_game_lua import LuaState, DEFAULT_XLUA, lua_literal

LOCK = threading.Lock()
SESSIONS = {}


class Session:
    def __init__(self, model, source, cache, seed):
        self.last = time.monotonic()
        self.input_clock = 0.0
        self.timeline = 0.0
        self.sequence = 0
        path = cache / 'spine-ui' / model / 'scene.json'
        spec = json.loads(path.read_text(encoding='utf-8')) if path.exists() else extract(model, source, cache)
        if spec.get('version',0) < 6: spec = extract(model,source,cache)
        bundle = get_bundle()
        scripts = {n['lua']: bundle.read(n['lua'] + '.lua') for n in spec['nodes'].values() if n.get('lua')}
        # Keep the shipped pure function intact; the rest of StringUtil binds unrelated C# APIs.
        utility = bundle.read('StringUtil.lua')
        scripts['__split_number'] = 'local this={}\n' + utility[utility.index('function this:SplitNumber(num)'):]
        manifest = json.loads((cache / 'spine_action.generated.json').read_text(encoding='utf-8'))
        rows = {str(r['index']): {'track': r['track'], 'multi': bool(r['content'].get('clicks'))}
                for r in manifest['models'][model]}
        self.lua = LuaState(DEFAULT_XLUA)
        try:
            self.lua.run(('SPEC=' + lua_literal(spec) + '\nSOURCES=' + lua_literal(scripts)
                          + '\nMODEL=' + lua_literal(model) + '\nROWS=' + lua_literal(rows)
                          + '\nCALLBACK_PREFIX=' + lua_literal(secrets.token_hex(8) + ':')).encode())
            self.lua.run((ROOT / 'tools/spine_ui_host.lua').read_bytes())
            self.lua.run(f'boot({int(seed)})'.encode())
        except Exception:
            self.lua.close()
            raise

    def close(self):
        try:
            self.lua.run(b'shutdown()')
        finally:
            self.lua.close()

    def snapshot(self):
        result = json.loads(self.lua.run(b'return snapshot()', result=True))
        for k in ('nodes', 'commands'):
            if result[k] == {}: result[k] = []
        return result


def request(data, source, cache):
    with LOCK:
        now = time.monotonic()
        for key in list(SESSIONS):
            if now - SESSIONS[key].last > 300:
                SESSIONS.pop(key).close()
        op = data.get('op')
        if op == 'open':
            model = str(data.get('model'))
            if model not in MODELS: raise ValueError('Unsupported SpineUI model')
            if len(SESSIONS) >= 16: raise ValueError('Too many SpineUI sessions')
            key = secrets.token_hex(16)
            session = Session(model, source, cache, int(data.get('seed', secrets.randbelow(2**30))))
            SESSIONS[key] = session
            return {'session': key, **session.snapshot()}
        key = str(data.get('session', ''))
        if op == 'close':
            s = SESSIONS.pop(key, None)
            if s: s.close()
            return {'closed': True}
        if op != 'step' or key not in SESSIONS: raise ValueError('SpineUI session expired')
        s = SESSIONS[key];s.last = now
        if 'timedInputs' in data:
            # Validate the entire request before mutating Lua. No late replay, no retry scoring.
            sequence = int(data.get('sequence', 0))
            end = float(data['endTime'])
            if sequence != s.sequence + 1 or not math.isfinite(end) or end < s.timeline or end-s.timeline > .100001:
                raise ValueError('Invalid UI timeline sequence/frontier')
            events = data['timedInputs']
            if len(events) > 100: raise ValueError('Too many UI inputs')
            cursor, wall = s.timeline, s.input_clock
            for event in events:
                t, w = float(event['time']), float(event['wall'])
                if not math.isfinite(t) or not math.isfinite(w) or t < cursor-1e-9 or t > end+1e-9 or w < wall:
                    raise ValueError('Late or unordered UI input')
                cursor, wall = t, w
            idle = lua_literal(bool(data.get('idle')))
            tracks = {str(int(k)): {'progress': max(0, min(1, float(v.get('progress', 0)))), 'playing': bool(v.get('playing'))}
                      for k,v in data.get('multiTracks', {}).items() if str(k).isdigit()}
            s.lua.run(('setMultiTracks('+lua_literal(tracks)+')').encode())
            done = lua_literal([str(v) for v in data.get('done', [])][:100])
            s.lua.run(f'advance(0,{idle},{done},{{}})'.encode())
            cursor = s.timeline
            for event in events:
                t, w = float(event['time']), float(event['wall'])
                s.lua.run(f'advance({max(0,t-cursor)},nil,{{}},{{}})'.encode())
                s.lua.run(('setUnscaledTime('+str(w)+');advance(0,nil,{},'+lua_literal([str(event['node'])])+')').encode())
                cursor = t
            s.lua.run(f'advance({max(0,end-cursor)},nil,{{}},{{}})'.encode())
            s.timeline, s.sequence, s.input_clock = end, sequence, wall
            return s.snapshot()
        if 'unscaledTime' in data:
            value = float(data['unscaledTime'])
            if not math.isfinite(value) or value < s.input_clock:
                raise ValueError('Invalid unscaled UI time')
            s.input_clock = value
            s.lua.run(f'setUnscaledTime({value})'.encode())
        dt = max(0, min(0.1, float(data.get('dt', 0))))
        done = [str(v) for v in data.get('done', [])][:100]
        inputs = [str(v) for v in data.get('inputs', [])][:100]
        tracks = {str(int(k)): {'progress': max(0, min(1, float(v.get('progress', 0)))),
                               'playing': bool(v.get('playing'))}
                  for k, v in data.get('multiTracks', {}).items() if str(k).isdigit()}
        s.lua.run(('setMultiTracks(' + lua_literal(tracks) + ')').encode())
        code = f'advance({dt},{lua_literal(bool(data.get("idle")))},{lua_literal(done)},{lua_literal(inputs)})'
        s.lua.run(code.encode())
        return s.snapshot()
