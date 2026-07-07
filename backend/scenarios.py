"""Roleplay scenarios: guided, branching-feel dialogues for speaking practice.

Each scenario is a JSON file in data/scenarios/. The frontend drives the state
machine (plays the partner's line, records the learner, matches their words
against the beat's `expect` keywords), so this module only needs to load and
serve them.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

SCENARIO_DIR = Path(__file__).resolve().parent / "data" / "scenarios"


@lru_cache(maxsize=1)
def load_scenarios() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if SCENARIO_DIR.is_dir():
        for path in sorted(SCENARIO_DIR.glob("*.json")):
            with path.open(encoding="utf-8") as fh:
                scenario = json.load(fh)
            out[scenario["id"]] = scenario
    return out


def summaries() -> list[dict]:
    return [
        {
            "id": s["id"],
            "language": s["language"],
            "title": s["title"],
            "level": s.get("level", ""),
            "type": s.get("type", "transactional"),
            "intro": s.get("intro", ""),
            "beats": len(s.get("beats", [])),
        }
        for s in load_scenarios().values()
    ]
