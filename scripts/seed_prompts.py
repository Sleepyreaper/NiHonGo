#!/usr/bin/env python3
"""Seed `img_prompt` on the concrete, picturable cards across all decks.

One curated place to say which cards get an illustration and what to draw.
Abstract grammar chunks are intentionally left out (no clean single picture).
Run this, then `python scripts/comfy_gen.py` to render the new ones.
Existing img_prompts are left untouched.
"""
from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "backend" / "data"

PROMPTS: dict[str, str] = {
    # --- Spanish ---
    "es-u2-06": "two people shaking hands in a friendly greeting",
    "es-u2-10": "a tired person yawning and stretching",
    "es-u3-04": "a tall glass of fresh orange juice",
    "es-u4-05": "a bold arrow pointing to the left",
    "es-u4-06": "a bold arrow pointing straight up",
    "es-u4-09": "a confused traveler looking at a folded map",
    "es-u5-05": "a single credit card",
    "es-u5-06": "a small stack of cash banknotes and coins",
    "es-u5-10": "a paper shopping bag",
    "es-u6-01": "a round wall clock",
    # --- Mandarin ---
    "zh-g-01": "a person smiling and waving hello",
    "zh-f-01": "a tall glass of clear water",
    "zh-f-04": "a bowl of steamed white rice",
    "zh-f-05": "a bowl of noodles with chopsticks",
    "zh-f-06": "a piece of cooked chicken on a plate",
    # --- Japanese ---
    "ja-g-01": "a person smiling and waving hello",
    "ja-f-01": "a tall glass of clear water",
    "ja-f-02": "a cup of green tea",
    "ja-f-03": "a bowl of steamed white rice",
    # --- Cantonese ---
    "yue-g-01": "a person smiling and waving hello",
    "yue-f-01": "a tall glass of clear water",
    "yue-f-02": "a cup of hot tea",
    "yue-f-03": "a cup of coffee",
    "yue-f-04": "a bowl of steamed white rice",
    "yue-f-05": "a bowl of noodles with chopsticks",
    "yue-f-06": "a piece of cooked chicken on a plate",
}


def main() -> None:
    seeded = 0
    for path in sorted(DATA_DIR.glob("*.json")):
        lang = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for deck in lang["decks"]:
            for card in deck["cards"]:
                if card["id"] in PROMPTS and not card.get("img_prompt"):
                    card["img_prompt"] = PROMPTS[card["id"]]
                    seeded += 1
                    changed = True
        if changed:
            path.write_text(json.dumps(lang, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"seeded {path.name}")
    print(f"added {seeded} new img_prompts")


if __name__ == "__main__":
    main()
