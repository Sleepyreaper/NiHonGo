"""NiHonGo — a small web app for learning to read, write and speak languages.

FastAPI serves a JSON API for decks/cards and review scheduling, and also
serves the static frontend so the whole thing runs from one container.
"""
from __future__ import annotations

import json
import random
from datetime import date
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import database, stt

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

app = FastAPI(title="NiHonGo", description="Learn to read, write and speak languages.", version="1.0.0")

# Ensure the progress table exists as soon as the app is imported. Doing this at
# import time (rather than a startup event) means it works under uvicorn, the
# test client, and any other ASGI runner alike.
database.init_db()


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Serve the HTML/JS/CSS with revalidation so edits show up immediately.

    Without this the browser can hold onto a stale script for a long time, which
    is confusing while iterating on the app (and harmless in production — a
    conditional request just returns 304 when nothing changed).
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/js") or path.startswith("/css"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# --------------------------------------------------------------------------- #
# Content loading                                                             #
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def load_content() -> dict[str, dict]:
    """Load every <lang>.json file in data/ keyed by language code."""
    content: dict[str, dict] = {}
    for path in sorted(DATA_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            lang = json.load(fh)
        content[lang["code"]] = lang
    return content


def get_language(code: str) -> dict:
    content = load_content()
    if code not in content:
        raise HTTPException(status_code=404, detail=f"Unknown language '{code}'")
    return content[code]


def all_cards(code: str) -> list[dict]:
    lang = get_language(code)
    cards: list[dict] = []
    for deck in lang["decks"]:
        for card in deck["cards"]:
            cards.append({**card, "deck": deck["id"], "deck_name": deck["name"]})
    return cards


# --------------------------------------------------------------------------- #
# API models                                                                  #
# --------------------------------------------------------------------------- #
class ReviewResult(BaseModel):
    quality: int  # 0 = Again, 3 = Hard, 4 = Good, 5 = Easy


# --------------------------------------------------------------------------- #
# API routes                                                                  #
# --------------------------------------------------------------------------- #
@app.get("/api/languages")
def list_languages() -> list[dict]:
    out = []
    for code, lang in load_content().items():
        out.append({
            "code": code,
            "name": lang["name"],
            "native_name": lang.get("native_name", lang["name"]),
            "flag": lang.get("flag", ""),
            "speech_lang": lang.get("speech_lang", code),
            "has_reading": lang.get("has_reading", False),
            "reading_label": lang.get("reading_label", "Reading"),
            "deck_count": len(lang["decks"]),
            "card_count": sum(len(d["cards"]) for d in lang["decks"]),
        })
    return out


@app.get("/api/languages/{code}/decks")
def list_decks(code: str) -> list[dict]:
    lang = get_language(code)
    return [
        {"id": d["id"], "name": d["name"], "description": d.get("description", ""),
         "card_count": len(d["cards"])}
        for d in lang["decks"]
    ]


@app.get("/api/languages/{code}/cards")
def list_cards(code: str, deck: str | None = None) -> list[dict]:
    cards = all_cards(code)
    if deck:
        cards = [c for c in cards if c["deck"] == deck]
        if not cards:
            raise HTTPException(status_code=404, detail=f"Unknown deck '{deck}'")
    return cards


@app.get("/api/languages/{code}/review")
def review_queue(code: str, limit: int = 20) -> list[dict]:
    """Cards due for review, then unseen cards, up to `limit`."""
    today = date.today()
    cards = {c["id"]: c for c in all_cards(code)}
    due = database.due_card_ids(code, today)
    seen = database.seen_card_ids(code)

    queue = [cards[cid] for cid in due if cid in cards]
    fresh = [c for cid, c in cards.items() if cid not in seen]
    random.shuffle(fresh)
    queue.extend(fresh)
    return queue[:limit]


@app.post("/api/languages/{code}/review/{card_id}")
def submit_review(code: str, card_id: str, result: ReviewResult) -> dict:
    get_language(code)  # validates language exists
    if not any(c["id"] == card_id for c in all_cards(code)):
        raise HTTPException(status_code=404, detail=f"Unknown card '{card_id}'")

    from .srs import review as srs_review

    state, _ = database.get_state(code, card_id)
    new_state, due = srs_review(state, result.quality)
    database.save_state(code, card_id, new_state, due)
    return {"card_id": card_id, "due": due.isoformat(), "interval": new_state.interval,
            "reps": new_state.reps, "ease": round(new_state.ease, 2)}


@app.get("/api/languages/{code}/progress")
def progress(code: str) -> dict:
    get_language(code)
    total = len(all_cards(code))
    s = database.stats(code)
    return {**s, "total": total}


@app.post("/api/languages/{code}/speech-check/{card_id}")
async def speech_check(code: str, card_id: str, audio: UploadFile = File(...)) -> dict:
    """Score a spoken attempt: transcribe uploaded audio and compare to the card."""
    get_language(code)
    card = next((c for c in all_cards(code) if c["id"] == card_id), None)
    if card is None:
        raise HTTPException(status_code=404, detail=f"Unknown card '{card_id}'")
    if not stt.enabled():
        raise HTTPException(status_code=503, detail="Speech recognition is not configured on this server")

    data = await audio.read()
    try:
        transcript = await stt.transcribe(data, audio.filename, audio.content_type, code)
    except Exception as exc:  # network / service errors
        raise HTTPException(status_code=502, detail=f"Speech service error: {exc}")

    return {"ok": stt.matches(transcript, card["native"]), "transcript": transcript, "target": card["native"]}


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "languages": list(load_content().keys()), "stt": stt.enabled()}


# --------------------------------------------------------------------------- #
# Static frontend (mounted last so it doesn't shadow /api routes)             #
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
