"""Server-side speech-to-text via an external Whisper service.

We talk to `openai-whisper-asr-webservice` (faster-whisper backend, GPU) over
HTTP. When STT_URL is unset the feature is simply disabled and the frontend
falls back to the browser's own speech recognition, so nothing breaks without a
GPU/server.
"""
from __future__ import annotations

import os
import re
import unicodedata

import httpx

STT_URL = os.environ.get("STT_URL", "").strip().rstrip("/")
STT_TIMEOUT = float(os.environ.get("STT_TIMEOUT", "60"))


def enabled() -> bool:
    return bool(STT_URL)


def normalize(text: str) -> str:
    """Lowercase, drop accents/tone marks and punctuation; keep letters (incl. CJK)."""
    text = unicodedata.normalize("NFD", (text or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)


def matches(transcript: str, target: str) -> bool:
    a, b = normalize(transcript), normalize(target)
    return bool(b) and (a == b or b in a or a in b)


async def transcribe(audio: bytes, filename: str, content_type: str, language: str) -> str:
    """Send audio to the Whisper service and return the recognized text."""
    if not enabled():
        raise RuntimeError("STT is not configured")
    params = {"task": "transcribe", "language": language, "output": "json", "encode": "true"}
    files = {"audio_file": (filename or "speech.webm", audio, content_type or "application/octet-stream")}
    async with httpx.AsyncClient(timeout=STT_TIMEOUT) as client:
        resp = await client.post(f"{STT_URL}/asr", params=params, files=files)
        resp.raise_for_status()
        data = resp.json()
    return (data.get("text") or "").strip()
