# 🗣️ NiHonGo

A small, self-hosted web app for learning to **read, write, and speak** languages.
Ships with **Spanish 🇪🇸**, **Chinese (Mandarin) 🇨🇳**, and **Japanese 🇯🇵** courses.

Speaking practice and pronunciation use your **browser's built-in speech engine**
(Web Speech API) — no paid cloud APIs, no keys, nothing to sign up for.

## Features

| Mode | What you practice |
|------|-------------------|
| 📖 **Learn** | Browse decks of words & phrases; tap 🔊 to hear native pronunciation. |
| 🃏 **Flashcards** | Spaced-repetition review (SM-2). Progress is saved and scheduled. |
| 🎤 **Speak** | Say the phrase; the browser transcribes it and checks you. |
| ✍️ **Write** | Type the phrase in the target language (native script or pinyin/romaji). |
| 📊 **Progress** | See how many cards you've studied and learned. |

## Quick start

### Option A — Docker (recommended)

```bash
docker compose up --build      # uses compose.yaml
```

Then open **http://localhost:8000**. Your review progress persists in a Docker
volume (`nihongo-data`), so it survives restarts.

To run without compose:

```bash
docker build -t nihongo .
docker run -p 8000:8000 -v nihongo-data:/data nihongo
```

### Option B — Local Python (no Docker)

```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Then open **http://localhost:8000**.

## Deploy on a server (Dockge)

The repo ships a production **`compose.yaml`** (Dockge's default filename) that
builds a hardened, non-root image and stores progress in a named volume. It's
tiny — idle RAM is well under 100 MB and no GPU is required.

1. **Get the code onto the server**, into your Dockge stacks directory
   (commonly `/opt/stacks/`). Either clone it:

   ```bash
   cd /opt/stacks
   git clone <your-repo-url> nihongo
   ```

   …or copy it up from this machine:

   ```bash
   rsync -av --exclude .venv --exclude data ./ user@server:/opt/stacks/nihongo/
   ```

2. **Deploy in Dockge.** The `nihongo` stack appears automatically — open it and
   click **Deploy** (Dockge builds the image and starts it). Or from a shell in
   that folder: `docker compose up -d --build`.

3. Browse to **http://\<server-ip\>:8000**, or point your reverse proxy at the
   container (Dockge users often front stacks with Nginx Proxy Manager or
   Traefik). Change the host port in `compose.yaml` if `8000` is taken.

Updating later: `git pull` (or re-`rsync`) then **Deploy** again — the
`nihongo-data` volume keeps your review history.

## Offline speech on the GPU (optional but recommended)

The production `compose.yaml` includes a **`whisper`** service that runs
[openai-whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice)
(faster-whisper backend) on an NVIDIA GPU. With it, 🎤 **Speak mode records your
mic and scores your pronunciation server-side — in *any* browser** (Firefox and
Safari included), instead of relying on Chrome/Edge's built-in recognition.

**How it fits together:** the browser records audio → posts it to the NiHonGo
backend → the backend forwards it to the `whisper` service → the transcript is
compared to the target phrase. The `whisper` service is internal (no published
port); only NiHonGo talks to it, via `STT_URL`.

**Host prerequisites (one-time):**

1. NVIDIA driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):
   ```bash
   sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi   # sanity check
   ```
2. Deploy the stack. On first start the `whisper` service downloads its model
   (cached in the `whisper-cache` volume), so give it a minute before the first
   Speak attempt.

**Tuning:** `ASR_MODEL` in `compose.yaml` defaults to `small` (fast, ~1–2 GB
VRAM — comfortable on a 6 GB 980 Ti). Bump to `medium` for stronger
Chinese/Japanese accuracy. If CTranslate2 complains about compute type on the
Maxwell GPU, set `ASR_COMPUTE_TYPE: float16` (or `float32`) on the service.

**Web-only fallback:** remove the `whisper` service and the `STT_URL` env, and
the app runs GPU-free — Speak mode then uses the browser's own recognition:

- **Pronunciation (🔊 / text-to-speech):** works in all modern browsers.
- **Speech recognition (🎤):** browser-based path works in **Chrome and Edge**;
  other browsers can still hear phrases and practice out loud.

## Project layout

```
NiHonGo/
├── backend/               FastAPI app + spaced-repetition engine
│   ├── main.py            API routes + serves the frontend
│   ├── srs.py             SM-2 scheduling
│   ├── database.py        SQLite progress store (stdlib only)
│   ├── stt.py             Forwards mic audio to the Whisper service
│   └── data/              Course content — one JSON file per language
│       ├── es_spanish.json
│       ├── zh_chinese.json
│       └── ja_japanese.json
├── frontend/              Vanilla HTML/CSS/JS single-page app
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── Dockerfile
├── compose.yaml           Production stack (Dockge) — app + GPU Whisper
├── docker-compose.dev.yml Local hot-reload stack
└── requirements.txt
```

## Adding your own content

Each language is a single JSON file in `backend/data/`. Copy an existing one and
edit — no code changes needed. The shape is:

```jsonc
{
  "code": "es",               // short language code (unique)
  "name": "Spanish",
  "native_name": "Español",
  "flag": "🇪🇸",
  "speech_lang": "es-ES",     // BCP-47 tag for Web Speech
  "has_reading": false,        // true = show a romanization line (pinyin/romaji)
  "reading_label": "Pinyin",
  "decks": [
    {
      "id": "greetings",
      "name": "Greetings & Basics",
      "description": "…",
      "cards": [
        { "id": "es-g-01", "native": "Hola", "reading": "OH-lah", "translation": "Hello" }
      ]
    }
  ]
}
```

Card `id`s must be unique within a language. Restart the server (or let
`--reload` pick it up) and the new course appears automatically.

## API reference

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/languages` | List available courses |
| `GET`  | `/api/languages/{code}/decks` | Decks in a course |
| `GET`  | `/api/languages/{code}/cards?deck=<id>` | Cards (optionally filtered) |
| `GET`  | `/api/languages/{code}/review?limit=20` | Cards due for review |
| `POST` | `/api/languages/{code}/review/{card_id}` | Submit a grade `{ "quality": 0..5 }` |
| `POST` | `/api/languages/{code}/speech-check/{card_id}` | Upload mic audio (`audio` file); returns `{ ok, transcript }` (requires the Whisper service) |
| `GET`  | `/api/languages/{code}/progress` | Study stats |
| `GET`  | `/api/health` | Health check (includes `stt`: whether server speech is on) |

Interactive API docs are available at **http://localhost:8000/docs**.
