"""Server-side speech-to-text via an external Whisper service.

We talk to `openai-whisper-asr-webservice` (faster-whisper backend) over HTTP.
When STT_URL is unset the feature is simply disabled and the frontend falls back
to the browser's own speech recognition, so nothing breaks without it.

Scoring note: Whisper transcribes speech into whatever script it likes — a
spoken Japanese "san" (三) can come back as 三, 3, さん or サン; a Mandarin number
likewise. So we don't just string-compare against the card's characters: we
canonicalize numerals and kana, and for Japanese we recover romaji from kana and
compare against the card's reading. See `matches`.
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


# CJK / full-width numerals → ASCII digits (covers the 0–10 number decks and a
# few common extras) so a spoken number matches whichever form Whisper returns.
_NUM_MAP = {
    "〇": "0", "零": "0", "一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
    "六": "6", "七": "7", "八": "8", "九": "9", "十": "10", "两": "2", "兩": "2",
}

# Hiragana → romaji (Hepburn-ish), used to recover a reading when Whisper writes
# Japanese as kana instead of the kanji shown on the card.
_YOON = {
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo", "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho", "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo", "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo", "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo", "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
}
_KANA = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n", "ー": "",
}


def _kata_to_hira(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        out.append(chr(o - 0x60) if 0x30A1 <= o <= 0x30F6 else ch)
    return "".join(out)


def _kana_to_romaji(s: str) -> str:
    s = _kata_to_hira(s)
    out: list[str] = []
    i = 0
    while i < len(s):
        pair = s[i:i + 2]
        if pair in _YOON:
            out.append(_YOON[pair])
            i += 2
            continue
        ch = s[i]
        if ch == "っ":  # sokuon: double the next consonant
            nxt = _kana_to_romaji(s[i + 1:i + 2])
            if nxt:
                out.append(nxt[0])
            i += 1
            continue
        out.append(_KANA.get(ch, ch))
        i += 1
    return "".join(out)


def _strip_marks(s: str) -> str:
    """Lowercase and drop accents / tone marks / macrons (ū→u, ǎ→a…)."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def normalize(text: str) -> str:
    """Canonical form for comparison: unify width/kana/numerals, drop marks & punctuation."""
    text = unicodedata.normalize("NFKC", (text or "")).lower()  # full-width → half, etc.
    text = _kata_to_hira(text)                                  # サン → さん
    text = "".join(_NUM_MAP.get(ch, ch) for ch in text)         # 三 → 3
    text = _strip_marks(text)
    return re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)


def _letters(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _strip_marks(s))


def matches(transcript: str, target: str, reading: str = "", language: str = "") -> bool:
    """True if the transcript sounds like the target card.

    First a canonical character comparison (handles 3↔三, サン↔さん). Then, for
    Japanese, a phonetic fallback: romanize kana in the transcript and compare to
    the card's reading, so さん / サン also match a 三 card whose reading is "san".
    """
    a, b = normalize(transcript), normalize(target)
    if b and (a == b or b in a or a in b):
        return True

    if language == "ja" and reading:
        spoken = _letters(_kana_to_romaji(transcript))
        for token in re.split(r"[\s/,]+", reading):
            r = _letters(token)
            if len(r) >= 2 and spoken and (spoken == r or r in spoken or spoken in r):
                return True
    return False


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
