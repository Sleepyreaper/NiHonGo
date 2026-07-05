"""SQLite persistence for per-card review progress.

We keep dependencies to the standard library only: the deck/card *content*
lives in JSON files under backend/data, while a card's learning *state*
(ease, interval, due date) lives here so progress survives restarts.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import date
from pathlib import Path

from .srs import CardState

# Store the DB outside the source tree so a Docker volume can persist it.
DB_PATH = Path(os.environ.get("NIHONGO_DB", Path(__file__).resolve().parent.parent / "data" / "progress.db"))


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS progress (
                language   TEXT NOT NULL,
                card_id    TEXT NOT NULL,
                reps       INTEGER NOT NULL DEFAULT 0,
                lapses     INTEGER NOT NULL DEFAULT 0,
                interval   INTEGER NOT NULL DEFAULT 0,
                ease       REAL    NOT NULL DEFAULT 2.5,
                due        TEXT,
                last_seen  TEXT,
                PRIMARY KEY (language, card_id)
            )
            """
        )


def get_state(language: str, card_id: str) -> tuple[CardState, str | None]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT reps, lapses, interval, ease, due FROM progress WHERE language=? AND card_id=?",
            (language, card_id),
        ).fetchone()
    if row is None:
        return CardState(), None
    return CardState(reps=row["reps"], lapses=row["lapses"], interval=row["interval"], ease=row["ease"]), row["due"]


def save_state(language: str, card_id: str, state: CardState, due: date) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO progress (language, card_id, reps, lapses, interval, ease, due, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(language, card_id) DO UPDATE SET
                reps=excluded.reps,
                lapses=excluded.lapses,
                interval=excluded.interval,
                ease=excluded.ease,
                due=excluded.due,
                last_seen=excluded.last_seen
            """,
            (language, card_id, state.reps, state.lapses, state.interval, state.ease,
             due.isoformat(), date.today().isoformat()),
        )


def due_card_ids(language: str, today: date) -> set[str]:
    """Card ids that are due for review today or earlier."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT card_id FROM progress WHERE language=? AND due IS NOT NULL AND due <= ?",
            (language, today.isoformat()),
        ).fetchall()
    return {r["card_id"] for r in rows}


def seen_card_ids(language: str) -> set[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT card_id FROM progress WHERE language=?", (language,)
        ).fetchall()
    return {r["card_id"] for r in rows}


def stats(language: str) -> dict:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS studied,
                COALESCE(SUM(CASE WHEN reps >= 3 THEN 1 ELSE 0 END), 0) AS learned,
                COALESCE(SUM(lapses), 0) AS lapses
            FROM progress WHERE language=?
            """,
            (language,),
        ).fetchone()
    return {"studied": row["studied"], "learned": row["learned"], "lapses": row["lapses"]}
