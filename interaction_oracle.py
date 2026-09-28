"""Independent Lua-faithful oracle for the lobby interaction state machine.

This module is a direct translation of the game's own decision procedure and
is deliberately implemented WITHOUT looking at web/src/interactionMachine.ts.
It serves as the second, independent implementation in a differential test:
the TS reducer and this oracle must produce identical states and effects when
driven by the same event stream.

Authoritative sources (read-only extraction, local_viewer-asmr/.scratch/lua):
- CardTouchItem.lua      : touch item visibility + click dispatch
- RoleSpineItem2.lua     : TouchItemClickCB / SetContent / GetMulData / audio
- SpineTools.lua         : track semantics (IsIdle, CheckCanPlay, mulClick)

Every rule below cites the Lua file and line it came from.
"""
from __future__ import annotations

import json
from pathlib import Path

INTER_MS = 500  # RoleSpineItem2.lua L12 (inter = 0.5)


def _norm_random(value: float | None) -> float:
    if value is None:
        return 0.0
    return max(0.0, min(0.999999, value))


class Oracle:
    """Game-side interaction state for one modelId."""

    def __init__(self, rows: list[dict], spine: str | None, idle: str = "idle", role: int = 1):
        self.rows = rows
        self.row_by_index = {row["index"]: row for row in rows}
        self.spine = spine
        self.idle = idle
        self.cur_role = role  # CrearData() L1014-1023: curRoleNum = 1
        # CardTouchItem.Refresh L58-70: hidden when role mismatch or content.isHide
        self.active: dict[str, bool] = {}
        for row in rows:
            role_num = row.get("pose", 1)
            is_hide = "isHide" in row.get("content", {})
            self.active[str(row["index"])] = (role_num == self.cur_role) and not is_hide
        self.records: dict[str, int] = {}
        self.click_count: dict[str, int] = {}
        # track -> entry; entry keys: anim, percent, playing, finished
        self.tracks: dict[int, dict] = {}
        # track -> mulClick data (SpineTools L301-345)
        self.mul_click: dict[int, dict] = {}
        self.cooldown_until = 0.0
        self.interlude_until = 0.0
        self.change_idle: dict | None = None
        self.pending_chain: dict[int, int] = {}  # track -> next index
        self.dragging: int | None = None
        self.recover_anim: str | None = None
        self.role_switches = 0

    # ---- SpineTools semantics -------------------------------------------------

    def is_idle(self) -> bool:
        # SpineTools L495-497: IsIdle == not CheckIsExist(1)
        return 1 not in self.tracks

    def check_can_play(self, track: int) -> bool:
        # SpineTools L555-561: no entry, or TrackTime >= duration
        entry = self.tracks.get(track)
        if entry is None:
            return True
        return entry["finished"]

    def mul_click_playing(self, track: int) -> bool:
        # SpineTools L339-345: mulClickDic entry with TimeScale ~= 0
        data = self.mul_click.get(track)
        return data is not None and data["time_scale"] != 0

    # ---- helpers --------------------------------------------------------------

    def real_index(self, row: dict) -> int:
        # RoleSpineItem2 L958-963
        content = row.get("content", {}) or {}
        if content.get("trackIndex"):
            return int(content["trackIndex"])
        return int(row["index"])

    def audio_effect(self, row: dict, random: float = 0.0) -> dict | None:
        # RoleSpineItem2 L572-608 (sequential read happens AFTER SetContent updates)
        audio_ids = row.get("audio") or []
        if not audio_ids:
            return None
        if len(audio_ids) == 1:
            return {"type": "audio", "cue": audio_ids[0], "rowIndex": row["index"]}
        content = row.get("content", {}) or {}
        if any(content.get(k) for k in ("actions", "clicks", "randomActions", "orderActions")):
            index = self.records.get(str(self.real_index(row)), 1)
            index = max(1, min(len(audio_ids), int(index)))
            return {"type": "audio", "cue": audio_ids[index - 1], "rowIndex": row["index"]}
        # L597-601: random; the differential driver supplies the same sample to both sides
        pick = min(len(audio_ids) - 1, int(_norm_random(random) * len(audio_ids)))
        return {"type": "audio", "cue": audio_ids[pick], "rowIndex": row["index"]}

    # ---- SetContent (RoleSpineItem2 L852-926) ---------------------------------

    def set_content(self, row: dict, random: float, effects: list[dict]) -> tuple[str | None, bool, dict | None]:
        """Returns (sName, play_accepted, multiInfo). Applies records + activation."""
        content = row.get("content", {}) or {}
        s_name = row.get("anim")
        b = True  # role of Lua's `b` (whether the play call succeeded)
        multi: dict | None = None

        if content.get("randomActions"):
            # L861-874: weighted pick, records keyed by cfgChild.index
            cursor = 1
            total = 0.0
            for name, weight in content["randomActions"]:
                total += weight
                if _norm_random(random) <= total:
                    s_name = name
                    break
                cursor += 1
            else:
                s_name = content["randomActions"][-1][0]
                cursor = len(content["randomActions"])
            self.records[str(row["index"])] = cursor

        if content.get("orderActions"):
            # L876-881: cycle, records keyed by cfgChild.index
            index = self.records.get(str(row["index"]), 0)
            index = 1 if index + 1 > len(content["orderActions"]) else index + 1
            s_name = content["orderActions"][index - 1]
            self.records[str(row["index"])] = index

        if content.get("clicks"):
            # L883-895 (records advance runs regardless of track)
            if self.mul_click_playing(int(row["track"])):
                s_name = None
                b = False
            else:
                real = str(self.real_index(row))
                clicks = content["clicks"]
                num = 1
                prev = self.records.get(real)
                if prev is not None and prev < len(clicks):
                    num = prev + 1
                self.records[real] = num
                progress = clicks[num - 1]
                if int(row["track"]) != 1:
                    # L269: PlayByMulClick path is track ~= 1 only
                    multi = {
                        "animation": s_name, "track": row["track"], "progress": progress,
                        "timeScale": -1 if progress == 0 else 1,
                        "isLast": num >= len(clicks),
                    }

        if content.get("activation"):
            # L897-921: even record index flips the map
            is_f = False
            if content.get("clicks"):
                real = self.records.get(str(self.real_index(row)))
                if real is not None and real % 2 == 0:
                    is_f = True
            for index, raw in content["activation"].items():
                value = raw == 1
                if is_f:
                    value = not value
                self.active[str(index)] = value

        if content.get("isSpineUI"):
            effects.append({"type": "open-spine-ui"})

        return s_name, b, multi

    # ---- TouchItemClickCB (RoleSpineItem2 L165-330) ---------------------------

    def press(self, index: int, now_ms: float, random: float | None = None) -> tuple[bool, list[dict], list[str]]:
        effects: list[dict] = []
        trace: list[str] = []
        row = self.row_by_index.get(index)
        if row is None:
            return False, effects, ["row not found"]

        content = row.get("content", {}) or {}

        # CardTouchItem.Refresh L55-57: gesture ~= 0 disables the click Button,
        # so a touch press on these rows is unreachable in the game.
        if row.get("gesture"):
            return False, effects, ["unreachable: gesture row has no click button (L55-57)"]
        # Zero-area rects can never win a Unity UI raycast.
        if not row.get("hittable"):
            return False, effects, ["unreachable: zero-area rect (L50-53)"]
        # An inactive gameObject is not raycastable at all (SetGOActive L70/918).
        if not self.active.get(str(index)):
            return False, effects, ["unreachable: gameObject inactive"]

        # CardTouchItem.OnClick L94-98: asmr rows bypass TouchItemClickCB entirely.
        if content.get("asmr"):
            trace.append("asmr bypass (CardTouchItem L94-98)")
            if not self.active.get(str(index)):
                trace.append("ignored: gameObject inactive")
                return False, effects, trace
            effects.append({"type": "open-asmr", **content["asmr"]})
            return True, effects, trace

        # L170-171: interlude transition blocks clicks
        if now_ms < self.interlude_until:
            trace.append("blocked: interlude (L170)")
            return False, effects, trace

        # L173-176: 500 ms cooldown; rejected clicks do NOT extend it,
        # accepted-path clicks extend it before any gate check.
        if now_ms < self.cooldown_until:
            trace.append("blocked: cooldown (L173)")
            return False, effects, trace
        self.cooldown_until = now_ms + INTER_MS

        # L183-205: conditions on another row's track progress
        if content.get("conditions"):
            target = self.row_by_index.get(int(content["conditions"][0]))
            entry = self.tracks.get(target["track"]) if target else None
            cond = content["conditions"]
            if len(cond) == 2:
                if cond[1] == 0:
                    if entry is not None:
                        trace.append("rejected: conditions require track empty (L189-193)")
                        return False, effects, trace
                else:
                    if entry is None or entry["percent"] < cond[1]:
                        trace.append("rejected: conditions require playing >= perc (L194-197)")
                        return False, effects, trace
            else:
                top = cond[2] if len(cond) > 2 else 1
                if entry is None or entry["percent"] < cond[1] or entry["percent"] > top:
                    trace.append("rejected: conditions perc window (L199-204)")
                    return False, effects, trace

        track = int(row["track"])
        is_can = False
        if track == 1:
            # L211-225: track 1 requires idle (or an actions row); noClick gate here only
            if self.is_idle() or content.get("actions") is not None:
                is_can = True
            if content.get("noClick"):
                for v in content["noClick"]:
                    target = self.row_by_index.get(int(v))
                    if target is None:
                        continue
                    entry = self.tracks.get(target["track"])
                    # CheckTrackIsInStar L547-553: entry TrackTime == 0 counts as start
                    in_star = entry is None or entry["percent"] == 0
                    if not in_star:
                        is_can = False
                        trace.append(f"rejected: noClick row {v} in progress (L217-225)")
                        break
        elif content.get("guochange"):
            # L226-229
            if self.is_idle() and self.check_can_play(track):
                is_can = True
            else:
                trace.append("rejected: guochange needs idle + finished track (L226-229)")
        else:
            # L230-237
            if content.get("needIdle"):
                is_can = self.is_idle()
                if not is_can:
                    trace.append("rejected: needIdle (L232-233)")
            else:
                is_can = True

        # L239-245: needClicks
        if is_can and content.get("needClicks"):
            for v in content["needClicks"]:
                if not self.click_count.get(str(v)):
                    is_can = False
                    trace.append(f"rejected: needClicks row {v} not clicked yet (L239-245)")
                    break

        if not is_can:
            # L246-248: return without click count (cooldown was still burned)
            return False, effects, trace

        # L249-258: SetContent
        s_name, b, multi = self.set_content(row, _norm_random(random), effects)

        # L262-318: play dispatch
        pose_switch = row.get("poseSwitch")
        if content.get("reset7"):
            # ResetByIndex L1122-1133: clear the referenced tracks and records
            cleared: list[int] = []
            for v in content["reset7"]:
                target = self.row_by_index.get(int(v))
                if target is None:
                    continue
                cleared.append(target["track"])
                self.tracks.pop(target["track"], None)
                self.mul_click.pop(target["track"], None)
                self.records.pop(str(v), None)
            effects.append({"type": "clear-tracks", "tracks": sorted(set(cleared))})

        if content.get("changeIdle"):
            # L283-286
            self.change_idle = {
                "at": now_ms + content["changeIdle"][1],
                "idle": content["changeIdle"][0],
                "source_track": track,
                "keep": [self.row_by_index[int(k)]["track"] for k in content["changeIdle"][2:]
                         if int(k) in self.row_by_index],
            }

        if pose_switch is not None:
            # GetClickCB L336-372 + SetInterlude L424-435
            self.cur_role = pose_switch["targetRole"]
            self.interlude_until = now_ms + pose_switch["durationMs"]
            self.spine = pose_switch["targetSpine"]
            self.role_switches += 1
            if not pose_switch.get("inheritProgress"):
                self.records = {}
            effects.append({"type": "pose-interlude", "spine": pose_switch["interludeSpine"],
                            "durationMs": pose_switch["durationMs"]})
            effects.append({"type": "load-pose", "spine": pose_switch["targetSpine"],
                            "role": pose_switch["targetRole"],
                            "afterIndex": pose_switch.get("afterIndex"),
                            "inheritProgress": pose_switch.get("inheritProgress")})
            # re-evaluate visibility for the new role (SetImg -> SetTouch re-creation)
            for candidate in self.rows:
                role_num = candidate.get("pose", 1)
                is_hide = "isHide" in candidate.get("content", {})
                self.active[str(candidate["index"])] = (role_num == self.cur_role) and not is_hide

        play_emitted = any(e["type"] == "play" for e in effects)
        if multi is not None:
            # L269-271: PlayByMulClick (only reachable for track ~= 1 rows)
            effects.append({"type": "play", "animation": multi["animation"],
                            "track": multi["track"], "progress": multi["progress"],
                            "timeScale": multi["timeScale"], "mode": "multi"})
            play_emitted = True
            self.tracks[multi["track"]] = {"anim": multi["animation"], "percent": 0.0,
                                           "playing": True, "finished": False}
            self.mul_click[multi["track"]] = {
                "time_scale": multi["timeScale"],
                "progress": multi["progress"],
                "is_last": multi["isLast"],
            }
        elif s_name is not None and not play_emitted:
            mode = "click"
            if content.get("actions"):
                mode = "actions"
                current = self.tracks.get(track)
                if current is not None and current["anim"] == s_name:
                    # L274-277: re-click while playing -> ResetActionsClick, b stays false
                    b = False
                    play_emitted = False
                else:
                    play_emitted = True
                    b = True
                    effects.append({"type": "play", "animation": s_name, "track": track,
                                    "progress": None, "timeScale": None, "mode": "actions"})
            else:
                play_emitted = True
                effects.append({"type": "play", "animation": s_name, "track": track,
                                "progress": None, "timeScale": None, "mode": "click"})
            if play_emitted and b:
                entry = {"anim": s_name, "percent": 0.0, "playing": True, "finished": False}
                if track == 1:
                    entry["empty_fade"] = True  # PlayByClick1 L282: AddEmptyAnimation
                self.tracks[track] = entry
                if content.get("nextClick") is not None:
                    # GetClickCB L373-388: chain keyed by the clicked row's track
                    self.pending_chain[track] = int(content["nextClick"])
        elif s_name is None and not play_emitted:
            # L303-317: sName nil -> timer reset. GetClickCB L372: a changerole
            # row without sName delays the callback by duration/2, so the timer
            # reset lands at now + delay; nextClick chains fire immediately.
            if content.get("changerole") is not None:
                # changerole[3] in Lua (1-based) == duration; delay = duration/2
                duration = int(content["changerole"][2]) if len(content["changerole"]) > 2 else 0
                self.cooldown_until = now_ms + duration // 2
            else:
                self.cooldown_until = 0.0
                if content.get("nextClick") is not None:
                    # GetClickCB L374-388: cb() fires the chained press now
                    ok, chain_effects, chain_trace = self.press(int(content["nextClick"]), now_ms, random)
                    effects.extend(chain_effects)
                    trace.extend(chain_trace)
                    return ok, effects, trace

        # L319-323: audio only when the play call returned true (b starts false, L268)
        if play_emitted and b:
            audio = self.audio_effect(row, _norm_random(random))
            if audio is not None:
                effects.append(audio)

        # L326-327: click count for every gate-passing press
        self.click_count[str(index)] = self.click_count.get(str(index), 0) + 1
        return True, effects, trace

    # ---- SpineTools Complete (L237-247) + track lifecycle ----------------------

    def track_complete(self, track: int, now_ms: float) -> tuple[bool, list[dict], list[str]]:
        effects: list[dict] = []
        trace: list[str] = []
        entry = self.tracks.pop(track, None)
        if entry is None:
            return True, effects, trace
        if track == 1:
            # PlayByClick1 fade-out: the empty animation returns the track to idle
            trace.append("track 1 complete -> entry removed (empty fade)")
            next_index = self.pending_chain.pop(track, None)
            if next_index is not None:
                # GetClickCB L374-387: IsIdle now true -> immediate chain
                return self.press(next_index, now_ms)
            return True, effects, trace
        # non-1 tracks persist as finished entries (game never clears them here)
        entry["finished"] = True
        entry["playing"] = False
        entry["percent"] = 1.0
        self.tracks[track] = entry
        return True, effects, trace

    def track_progress(self, track: int, animation: str, progress: float, playing: bool):
        entry = self.tracks.get(track)
        if entry is None:
            entry = {"anim": animation, "percent": progress, "playing": playing, "finished": False}
            self.tracks[track] = entry
        else:
            entry["percent"] = progress
            entry["playing"] = playing
        if progress >= 1 and not playing:
            entry["finished"] = True
        # SpineTools Update L120-122: reaching the segment target pauses the entry
        data = self.mul_click.get(track)
        if data is not None and not playing:
            if (data["time_scale"] == 1 and progress >= data["progress"]) or \
               (data["time_scale"] == -1 and progress <= data["progress"]):
                data["time_scale"] = 0

    # ---- GetMulData.clickTimeCB (L939-954) + ClearMulClick (L348-359) ----------

    def multi_reset(self, index: int) -> tuple[bool, list[dict], list[str]]:
        row = self.row_by_index.get(index)
        effects: list[dict] = []
        if row is None:
            return False, effects, ["row not found"]
        real = str(self.real_index(row))
        self.records.pop(real, None)
        # timeout reverse finishes -> ClearTrack(k) + mulClickDic[k] = nil (L127-136)
        self.mul_click.pop(int(row["track"]), None)
        self.tracks.pop(int(row["track"]), None)
        effects.append({"type": "clear-tracks", "tracks": [int(row["track"])]})
        content = row.get("content", {}) or {}
        if content.get("activation"):
            for key, raw in content["activation"].items():
                self.active[str(key)] = raw != 1
        return True, effects, ["multi clickTime reset (L939-954)"]

    # ---- Update changeIdle (L766-790) ------------------------------------------

    def tick(self, now_ms: float) -> tuple[bool, list[dict], list[str]]:
        effects: list[dict] = []
        if self.change_idle and now_ms >= self.change_idle["at"]:
            source_track = self.change_idle["source_track"]
            keep = set(self.change_idle["keep"])
            clear = sorted(t for t in self.tracks if t != source_track and t not in keep)
            for t in clear:
                self.tracks.pop(t, None)
                self.mul_click.pop(t, None)
            effects.append({"type": "clear-tracks", "tracks": clear})
            self.idle = self.change_idle["idle"]
            effects.append({"type": "change-idle", "idle": self.idle})
            self.change_idle = None
            return True, effects, ["changeIdle fired (L766-790)"]
        return True, effects, []

    # ---- drag -------------------------------------------------------------------

    def drag_begin(self, index: int, now_ms: float) -> tuple[bool, list[dict], list[str]]:
        effects: list[dict] = []
        trace: list[str] = []
        row = self.row_by_index.get(index)
        if row is None or not row.get("gesture"):
            return False, effects, ["not a gesture row"]
        if not self.active.get(str(index)):
            return False, effects, ["gameObject inactive"]
        if now_ms < self.interlude_until:
            return False, effects, ["interlude"]
        # CardTouchItem.OnBeginDragXY L112-115 + ItemDragBeginCB L443-449
        if not self.is_idle():
            return False, effects, ["rejected: drag needs idle (CardTouchItem L113)"]
        self.dragging = index
        self.click_count[str(index)] = self.click_count.get(str(index), 0) + 1  # L475-476
        effects.append({"type": "drag-start", "rowIndex": index})
        audio = self.audio_effect(row, 0.0)
        if audio is not None:
            effects.append(audio)  # PlayAudio L472
        return True, effects, trace

    def drag_end(self, x: float = 0.0, y: float = 0.0) -> tuple[bool, list[dict], list[str]]:
        effects: list[dict] = []
        if self.dragging is None:
            return False, effects, []
        row = self.row_by_index[self.dragging]
        effects.append({"type": "drag-recover", "rowIndex": row["index"], "x": x, "y": y})
        self.dragging = None
        content = row.get("content", {}) or {}
        gesture = content.get("gestureDatas") or {}
        stop_time = gesture.get("stopTime")
        if stop_time is not None and stop_time >= 0:
            # L556-567: Recover; track 1 fades back via empty animation
            self.recover_anim = row.get("anim")
            track = int(row["track"])
            if track == 1:
                self.tracks.pop(track, None)
        return True, effects, []

    # ---- snapshot ---------------------------------------------------------------

    def snapshot(self, now_ms: float = 0.0) -> dict:
        return {
            "role": self.cur_role,
            "spine": self.spine,
            "idle": self.idle,
            "active": {k: v for k, v in sorted(self.active.items())},
            "records": {k: v for k, v in sorted(self.records.items())},
            "clickCounts": {k: v for k, v in sorted(self.click_count.items())},
            "trackAnims": {str(t): e["anim"] for t, e in sorted(self.tracks.items())},
            "trackFinished": {str(t): e["finished"] for t, e in sorted(self.tracks.items())},
            "cooldown": self.cooldown_until > now_ms,
            "interlude": self.interlude_until > now_ms,
            "dragging": self.dragging,
            "changeIdlePending": self.change_idle is not None,
        }


def load_model(manifest: dict, model_id: str) -> Oracle:
    rows = manifest["models"][model_id]
    contract = manifest["poses"][model_id]
    return Oracle(rows, contract["initialSpine"], role=contract.get("initialRole", 1))
