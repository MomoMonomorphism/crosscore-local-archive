"""Run extracted game Lua in the game's own xLua runtime, with a small host.

This is an offline interaction oracle. It reads the installed game and the
extracted Lua files without changing either. The host supplies only the APIs
needed by the selected probe; unsupported Unity calls fail visibly in Lua.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_paths import PATHS


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_XLUA = PATHS['xlua']
LUA_DIR = ROOT / "local_viewer-asmr/.scratch/lua"
HOST_DIR = Path(__file__).resolve().parent


def config_entry(source: bytes, model_id: int) -> bytes:
    """Extract one intact Lua table from a dump damaged elsewhere."""
    match = re.search(rb"\[" + str(model_id).encode() + rb"\]\s*=\s*\{", source)
    if not match:
        raise ValueError(f"CfgSpineAction entry {model_id} not found")
    start = source.index(b"{", match.start())
    depth = 0
    quote = False
    escaped = False
    for cursor in range(start, len(source)):
        char = source[cursor]
        if quote:
            if escaped:
                escaped = False
            elif char == 92:
                escaped = True
            elif char == 34:
                quote = False
        elif char == 34:
            quote = True
        elif char == 123:
            depth += 1
        elif char == 125:
            depth -= 1
            if depth == 0:
                return b"CfgSpineAction = {[" + str(model_id).encode() + b"]=" + source[start:cursor + 1] + b"}"
    raise ValueError(f"CfgSpineAction entry {model_id} is incomplete")


def lua_literal(value: object) -> str:
    if value is None:
        return "nil"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "{" + ",".join(lua_literal(item) for item in value) + "}"
    if isinstance(value, dict):
        return "{" + ",".join(f"[{lua_literal(k)}]={lua_literal(v)}" for k, v in value.items()) + "}"
    raise TypeError(type(value))


class LuaState:
    def __init__(self, library: Path) -> None:
        self.lib = ctypes.CDLL(str(library))
        self.lib.luaL_newstate.restype = ctypes.c_void_p
        self.lib.luaL_openlibs.argtypes = [ctypes.c_void_p]
        self.lib.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.luaL_loadstring.restype = ctypes.c_int
        self.lib.lua_pcallk.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            ctypes.c_longlong, ctypes.c_void_p,
        ]
        self.lib.lua_pcallk.restype = ctypes.c_int
        self.lib.lua_tolstring.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_size_t),
        ]
        self.lib.lua_tolstring.restype = ctypes.c_void_p
        self.lib.lua_settop.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.lib.lua_close.argtypes = [ctypes.c_void_p]
        self.state = self.lib.luaL_newstate()
        if not self.state:
            raise RuntimeError("luaL_newstate failed")
        self.lib.luaL_openlibs(self.state)

    def close(self) -> None:
        if self.state:
            self.lib.lua_close(self.state)
            self.state = None

    def top_string(self) -> str:
        size = ctypes.c_size_t()
        pointer = self.lib.lua_tolstring(self.state, -1, ctypes.byref(size))
        return ctypes.string_at(pointer, size.value).decode("utf-8", "replace") if pointer else "<non-string Lua value>"

    def run(self, source: bytes, *, result: bool = False) -> str | None:
        self.lib.lua_settop(self.state, 0)
        if self.lib.luaL_loadstring(self.state, source):
            raise RuntimeError(f"Lua compile error: {self.top_string()}")
        if self.lib.lua_pcallk(self.state, 0, 1 if result else 0, 0, 0, None):
            raise RuntimeError(f"Lua runtime error: {self.top_string()}")
        return self.top_string() if result else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe", choices=["spine-tools", "poseidon-ui", "role-spine", "scan-configs", "scan-roles"])
    parser.add_argument("--xlua", type=Path, default=DEFAULT_XLUA)
    parser.add_argument("--scenario", type=Path, default=HOST_DIR / "role_smoke.json",
                        help="JSON scenario for the role-spine probe")
    args = parser.parse_args()
    state = LuaState(args.xlua)
    try:
        if args.probe in ("scan-configs", "scan-roles"):
            manifest = json.loads((ROOT / "local_viewer-interaction/cache/spine_action.generated.json").read_text(encoding="utf-8"))
            dump = (LUA_DIR / "cfgCfgSpineAction.lua").read_bytes()
            role_source = (ROOT / "local_viewer-interaction/.scratch/game_structure/RoleSpineItem2.lua").read_bytes()
            host_source = (HOST_DIR / "role_spine_probe.lua").read_bytes()
            failures = []
            checked = 0
            if args.probe == "scan-roles":
                state.run((LUA_DIR / "SpineTools.lua").read_bytes())
            for model in manifest["models"]:
                try:
                    state.run(config_entry(dump, int(model)))
                    if args.probe == "scan-roles":
                        row = next((item for item in manifest["models"][model]
                                    if item.get("anim") and item.get("sType") in (2, 6)
                                    and not item.get("content")), None)
                        if row is None:
                            continue
                        scenario = {"modelId": int(model), "steps": [{"op": "press", "index": row["index"], "at": 1}]}
                        state.run(role_source)
                        state.run(("ORACLE_SCENARIO = " + lua_literal(scenario)).encode("utf-8"))
                        output = state.run(host_source, result=True)
                        if f"track-event:{model}/{row['index']}" not in (output or ""):
                            raise RuntimeError("press did not reach the original game tracking callback")
                        checked += 1
                except (RuntimeError, ValueError) as error:
                    failures.append(f"{model}: {error}")
            if args.probe == "scan-configs":
                print(f"Original Lua config entries executable: {len(manifest['models']) - len(failures)}/{len(manifest['models'])}")
            else:
                print(f"Original RoleSpineItem2 plain-click paths executed: {checked} models; {len(failures)} failures")
            if failures:
                raise RuntimeError("\n".join(failures))
            return
        if args.probe == "spine-tools":
            state.run((LUA_DIR / "SpineTools.lua").read_bytes())
            host = HOST_DIR / "spine_tools_probe.lua"
        elif args.probe == "poseidon-ui":
            state.run((LUA_DIR / "70030_skin_Poseidon05_spine.lua").read_bytes())
            host = HOST_DIR / "poseidon_ui_probe.lua"
        else:
            scenario = json.loads(args.scenario.read_text(encoding="utf-8"))
            model_id = int(scenario["modelId"])
            state.run((LUA_DIR / "SpineTools.lua").read_bytes())
            state.run(config_entry((LUA_DIR / "cfgCfgSpineAction.lua").read_bytes(), model_id))
            state.run((ROOT / "local_viewer-interaction/.scratch/game_structure/RoleSpineItem2.lua").read_bytes())
            state.run(("ORACLE_SCENARIO = " + lua_literal(scenario)).encode("utf-8"))
            host = HOST_DIR / "role_spine_probe.lua"
        print(state.run(host.read_bytes(), result=True))
    finally:
        state.close()


if __name__ == "__main__":
    main()
