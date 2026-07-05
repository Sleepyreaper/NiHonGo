"""Spaced-repetition scheduling (SM-2, lightly adapted).

Quality grades map from the UI buttons:
    Again = 0, Hard = 3, Good = 4, Easy = 5
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

MIN_EASE = 1.3
DEFAULT_EASE = 2.5


@dataclass
class CardState:
    reps: int = 0          # number of consecutive successful reviews
    lapses: int = 0        # number of times forgotten
    interval: int = 0      # days until next review
    ease: float = DEFAULT_EASE


def review(state: CardState, quality: int, today: date | None = None) -> tuple[CardState, date]:
    """Return the updated card state and its next due date."""
    today = today or date.today()
    quality = max(0, min(5, quality))

    if quality < 3:
        # Forgotten: reset the streak, see it again tomorrow.
        reps = 0
        interval = 1
        lapses = state.lapses + 1
    else:
        if state.reps == 0:
            interval = 1
        elif state.reps == 1:
            interval = 6
        else:
            interval = max(1, round(state.interval * state.ease))
        reps = state.reps + 1
        lapses = state.lapses

    # Update ease factor (SM-2 formula), clamped to a sane floor.
    ease = state.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    ease = max(MIN_EASE, ease)

    new_state = CardState(reps=reps, lapses=lapses, interval=interval, ease=ease)
    due = today + timedelta(days=interval)
    return new_state, due
