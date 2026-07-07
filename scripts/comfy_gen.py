#!/usr/bin/env python3
"""Generate card illustrations with ComfyUI and wire them into the decks.

Run once (whenever you add cards). It reads every backend/data/<lang>.json,
finds cards that have an `img_prompt` but no `image` yet, renders each one via
your ComfyUI server, saves the PNG to frontend/img/<lang>/<card_id>.png, and
sets the card's `image` field. The app then just serves the static file.

It is model-agnostic: point it at an **API-format** workflow exported from your
own ComfyUI (Settings → enable Dev mode → "Save (API format)"). The script finds
the positive-prompt node (traced from the sampler) and the seed automatically.

Usage:
    python scripts/comfy_gen.py                    # generate missing images
    python scripts/comfy_gen.py --force            # regenerate everything
    python scripts/comfy_gen.py --lang es          # one language only

Env:
    COMFY_URL   default http://127.0.0.1:8188
    WORKFLOW    default scripts/comfy_workflow.json  (your API-format export)
    STYLE       appended to every prompt for a consistent look
"""
from __future__ import annotations

import argparse
import json
import os
import random
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "backend" / "data"
IMG_DIR = ROOT / "frontend" / "img"

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKFLOW_PATH = Path(os.environ.get("WORKFLOW", ROOT / "scripts" / "comfy_workflow.json"))
STYLE = os.environ.get(
    "STYLE",
    "simple flat vector illustration, single clear subject, friendly, bright solid "
    "colors, soft pastel background, centered, minimal, no text, no words",
)

TEXT_KEYS = ("text", "prompt")               # inputs that hold a prompt string
SEED_KEYS = ("seed", "noise_seed")           # inputs that hold a random seed


def _get(path: str) -> bytes:
    with urllib.request.urlopen(f"{COMFY_URL}{path}", timeout=30) as r:
        return r.read()


def _post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{COMFY_URL}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def find_positive_node(wf: dict) -> str:
    """The prompt node feeding the sampler's positive input (else first text node)."""
    override = os.environ.get("POSITIVE_NODE")
    if override:
        return override
    for nid, node in wf.items():
        if "Sampler" in node.get("class_type", ""):
            pos = node.get("inputs", {}).get("positive")
            if isinstance(pos, list) and pos:
                return str(pos[0])
    for nid, node in wf.items():  # fallback: any text-encode node
        if "TextEncode" in node.get("class_type", "") and any(k in node.get("inputs", {}) for k in TEXT_KEYS):
            return nid
    raise SystemExit("Could not find a prompt node in the workflow — set POSITIVE_NODE.")


def prepare(wf: dict, prompt: str, pos_node: str) -> dict:
    wf = json.loads(json.dumps(wf))  # deep copy
    node_inputs = wf[pos_node]["inputs"]
    for k in TEXT_KEYS:
        if k in node_inputs:
            node_inputs[k] = prompt
            break
    for node in wf.values():         # randomize every seed we can find
        for k in SEED_KEYS:
            if k in node.get("inputs", {}):
                node["inputs"][k] = random.randint(0, 2**31 - 1)
    return wf


def render(wf: dict) -> bytes:
    pid = _post("/prompt", {"prompt": wf})["prompt_id"]
    while True:
        time.sleep(1.0)
        hist = json.loads(_get(f"/history/{pid}") or b"{}")
        if pid in hist:
            outputs = hist[pid]["outputs"]
            for out in outputs.values():
                if "images" in out and out["images"]:
                    im = out["images"][0]
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                    return _get(f"/view?{q}")
            raise RuntimeError("Workflow finished but produced no image.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="regenerate even if image exists")
    ap.add_argument("--lang", help="only this language code")
    args = ap.parse_args()

    if not WORKFLOW_PATH.exists():
        raise SystemExit(
            f"No workflow at {WORKFLOW_PATH}.\n"
            "In ComfyUI: build/load your Z-Image workflow, enable Dev mode in Settings,\n"
            'click "Save (API format)", and save it there.'
        )
    workflow = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
    pos_node = find_positive_node(workflow)
    print(f"ComfyUI: {COMFY_URL} | prompt node: {pos_node}")

    for path in sorted(DATA_DIR.glob("*.json")):
        lang = json.loads(path.read_text(encoding="utf-8"))
        if args.lang and lang["code"] != args.lang:
            continue
        changed = False
        for deck in lang["decks"]:
            for card in deck["cards"]:
                if not card.get("img_prompt"):
                    continue
                if card.get("image") and not args.force:
                    continue
                out = IMG_DIR / lang["code"] / f"{card['id']}.png"
                out.parent.mkdir(parents=True, exist_ok=True)
                prompt = f"{card['img_prompt']}. {STYLE}"
                print(f"  {card['id']:14} {card['img_prompt'][:48]}")
                try:
                    png = render(prepare(workflow, prompt, pos_node))
                except Exception as exc:
                    print(f"    ! failed: {exc}")
                    continue
                out.write_bytes(png)
                card["image"] = f"/img/{lang['code']}/{card['id']}.png"
                changed = True
        if changed:
            path.write_text(json.dumps(lang, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"updated {path.name}")


if __name__ == "__main__":
    main()
