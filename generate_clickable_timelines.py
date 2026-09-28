"""A4: clickable-set timelines for every interaction model.

Breadth-first from the initial lobby state: every reachable state (via presses
on clickable rows) records which rows are actually clickable and what each
click does. This is the data that tells a human "this circle can / cannot be
clicked right now, and clicking it plays X" without any visual inspection.

Output: cache/oracle_diff/clickable_timelines.json
"""
from __future__ import annotations

import json
from pathlib import Path

from interaction_oracle import Oracle

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "cache" / "oracle_diff" / "clickable_timelines.json"


def state_key(oracle: Oracle) -> tuple:
    return (
        oracle.cur_role,
        tuple(sorted(k for k, v in oracle.active.items() if v)),
        tuple(sorted(oracle.records.items())),
    )


def clickable_rows(oracle: Oracle) -> list[int]:
    """Rows that would accept a press right now (probed on a cloned oracle)."""
    result = []
    for row in oracle.rows:
        clone = clone_oracle(oracle)
        accepted, _effects, _trace = clone.press(row["index"], 10_000_000.0, 0.5)
        if accepted:
            result.append(row["index"])
    return result


def clone_oracle(oracle: Oracle) -> Oracle:
    import copy
    return copy.deepcopy(oracle)


def describe(oracle: Oracle, index: int) -> dict:
    clone = clone_oracle(oracle)
    accepted, effects, _trace = clone.press(index, 10_000_000.0, 0.5)
    if not accepted:
        return {"index": index, "clickable": False}
    plays = [e for e in effects if e["type"] == "play"]
    audio = [e for e in effects if e["type"] == "audio"]
    entry = {
        "index": index,
        "clickable": True,
        "anim": plays[0]["animation"] if plays else None,
        "track": plays[0]["track"] if plays else None,
        "mode": plays[0]["mode"] if plays else None,
        "audio": audio[0]["cue"] if audio else None,
        "poseSwitch": plays == [] and clone.cur_role != oracle.cur_role,
        "newRole": clone.cur_role if clone.cur_role != oracle.cur_role else None,
        "activationDelta": {
            k: [oracle.active.get(k), clone.active.get(k)]
            for k in oracle.active
            if oracle.active.get(k) != clone.active.get(k)
        } or None,
    }
    return entry


def main() -> None:
    manifest = json.loads((ROOT / "cache" / "spine_action.generated.json").read_text(encoding="utf-8"))
    timelines = {}
    for model_id, _rows in manifest["models"].items():
        oracle = Oracle(
            manifest["models"][model_id],
            manifest["poses"][model_id]["initialSpine"],
            role=manifest["poses"][model_id].get("initialRole", 1),
        )
        steps = []
        seen = {state_key(oracle)}
        queue = [(oracle, 0)]
        while queue:
            current, depth = queue.pop(0)
            rows_info = []
            next_states = []
            for row in current.rows:
                entry = describe(current, row["index"])
                if entry["clickable"]:
                    clone = clone_oracle(current)
                    clone.press(row["index"], 10_000_000.0, 0.5)
                    key = state_key(clone)
                    if key not in seen and depth < 2:
                        seen.add(key)
                        next_states.append((clone, depth + 1))
                if entry["clickable"] or current.active.get(str(row["index"])):
                    rows_info.append(entry)
            steps.append({
                "role": current.cur_role,
                "spine": current.spine,
                "activeRows": sorted(int(k) for k, v in current.active.items() if v),
                "rows": rows_info,
            })
            queue.extend(next_states)
        timelines[model_id] = steps
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(timelines, ensure_ascii=False, indent=1), encoding="utf-8")
    total_states = sum(len(v) for v in timelines.values())
    print(f"timelines: {len(timelines)} models, {total_states} reachable states -> {OUT.name}")


if __name__ == "__main__":
    main()
