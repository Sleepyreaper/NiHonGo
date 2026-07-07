/* NiHonGo — front-end logic (vanilla JS, no build step). */

const API = "/api";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  languages: [],
  current: null,        // current language object (from /api/languages)
  cards: [],            // all cards for current language
  deck: null,           // active deck filter in Learn view
  flashQueue: [],       // review queue
  flashIndex: 0,
  flashFlipped: false,
  speakCard: null,
  writeCard: null,
  recognition: null,
  sttEnabled: false,     // server-side Whisper available?
  recording: false,
  mediaRecorder: null,
  chunks: [],
  scenario: null,        // roleplay
  beatIndex: 0,
  rpRecording: false,
  rpRecorder: null,
  rpChunks: [],
  rpListening: false,    // roleplay: hide partner text, listen only
  course: null,          // {deckId, week, step} when a step is launched from the class
  shadowCards: [],
  shadowIndex: 0,
  ltCards: [],
  ltIndex: 0,
  ltScore: 0,
};

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */
async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Speech (Web Speech API)                                             */
/* ------------------------------------------------------------------ */
function speak(text, langCode) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langCode;
  u.rate = 0.9;
  const voice = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang && v.lang.toLowerCase().startsWith(langCode.slice(0, 2).toLowerCase()));
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);
}
// Voices load asynchronously in some browsers; nudge them.
if ("speechSynthesis" in window) window.speechSynthesis.getVoices();

function speechRecognitionSupported() {
  return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
}

/* Normalize text for lenient comparison (strip punctuation / spaces / case). */
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\s。、，,.!！?？'"·（）()｜|/／-]/g, "")
    .trim();
}

/* Strip pinyin/romaji tone marks so "ni hao" matches "ni hao". */
function stripTones(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/* ------------------------------------------------------------------ */
/* View routing                                                        */
/* ------------------------------------------------------------------ */
function showView(name) {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  const view = $(`#view-${name}`);
  if (view) view.classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));

  // Leaving a class step via the top nav abandons it (no completion).
  if (state.course && name !== "learn" && name !== "flashcards") {
    state.course = null;
    $("#course-banner").classList.add("hidden");
  }

  if (name === "course") renderCourse();
  if (name === "learn") renderLearn();
  if (name === "flashcards") startFlashcards();
  if (name === "speak") nextSpeak();
  if (name === "roleplay") renderRoleplayHome();
  if (name === "write") nextWrite();
  if (name === "progress") renderProgress();
}

/* ------------------------------------------------------------------ */
/* Home / language picker                                              */
/* ------------------------------------------------------------------ */
async function loadHome() {
  state.languages = await api("/languages");
  try {
    const h = await api("/health");
    state.sttEnabled = !!h.stt;
  } catch (e) {
    state.sttEnabled = false;
  }
  const grid = $("#langGrid");
  grid.innerHTML = "";
  for (const lang of state.languages) {
    const el = document.createElement("div");
    el.className = "lang-card";
    el.innerHTML = `
      <div class="flag">${lang.flag}</div>
      <div class="name">${lang.name}</div>
      <div class="native">${lang.native_name}</div>
      <div class="meta">${lang.card_count} phrases · ${lang.deck_count} decks</div>`;
    el.addEventListener("click", () => selectLanguage(lang.code));
    grid.appendChild(el);
  }
}

async function selectLanguage(code) {
  state.current = state.languages.find((l) => l.code === code);
  state.cards = await api(`/languages/${code}/cards`);
  state.deck = null;

  $("#nav").classList.remove("hidden");
  const badge = $("#langBadge");
  badge.classList.remove("hidden");
  badge.innerHTML = `${state.current.flag} <span class="small">${state.current.native_name}</span>`;
  showView("learn");
}

function goHome() {
  state.current = null;
  $("#nav").classList.add("hidden");
  $("#langBadge").classList.add("hidden");
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-home").classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.remove("active"));
}

/* ------------------------------------------------------------------ */
/* Learn / browse                                                      */
/* ------------------------------------------------------------------ */
async function renderLearn() {
  const decks = await api(`/languages/${state.current.code}/decks`);
  const bar = $("#deckBar");
  bar.innerHTML = "";

  const mkChip = (id, label) => {
    const c = document.createElement("button");
    c.className = "deck-chip" + ((state.deck === id || (id === null && !state.deck)) ? " active" : "");
    c.textContent = label;
    c.addEventListener("click", () => { state.deck = id; renderLearn(); });
    return c;
  };
  bar.appendChild(mkChip(null, "All"));
  decks.forEach((d) => bar.appendChild(mkChip(d.id, d.name)));

  const cards = state.deck ? state.cards.filter((c) => c.deck === state.deck) : state.cards;
  const list = $("#cardList");
  list.innerHTML = "";
  for (const card of cards) {
    const el = document.createElement("div");
    el.className = "vocab";
    el.innerHTML = `
      <div>
        <div class="native">${card.native}</div>
        ${state.current.has_reading ? `<div class="reading">${card.reading}</div>` : ""}
        <div class="translation">${card.translation}</div>
      </div>
      <button class="speak-btn" title="Hear it">🔊</button>`;
    el.querySelector(".speak-btn").addEventListener("click", () => speak(card.native, state.current.speech_lang));
    list.appendChild(el);
  }
}

/* ------------------------------------------------------------------ */
/* Flashcards (SRS)                                                    */
/* ------------------------------------------------------------------ */
async function startFlashcards() {
  state.flashQueue = await api(`/languages/${state.current.code}/review?limit=20`);
  state.flashIndex = 0;
  if (state.flashQueue.length === 0) {
    $("#flashcard").classList.add("hidden");
    $("#flashEmpty").classList.remove("hidden");
    return;
  }
  $("#flashEmpty").classList.add("hidden");
  $("#flashcard").classList.remove("hidden");
  renderFlashcard();
}

function renderFlashcard() {
  const card = state.flashQueue[state.flashIndex];
  state.flashFlipped = false;
  $("#flashProgress").textContent = `Card ${state.flashIndex + 1} of ${state.flashQueue.length}`;
  $("#flashPrompt").innerHTML = `<div class="en-cue">${card.translation}</div>`;
  $("#flashFace").querySelector(".flash-hint").textContent = "Tap the card to flip";
  $("#flashControls").classList.add("hidden");
}

function flipFlashcard() {
  const card = state.flashQueue[state.flashIndex];
  if (state.flashFlipped) return;
  state.flashFlipped = true;
  $("#flashPrompt").innerHTML = `
    <div class="big-native">${card.native}</div>
    ${state.current.has_reading ? `<div class="reading">${card.reading}</div>` : ""}
    <div class="translation">${card.translation}</div>`;
  $("#flashFace").querySelector(".flash-hint").textContent = "How well did you know it?";
  $("#flashControls").classList.remove("hidden");
  speak(card.native, state.current.speech_lang);
}

async function gradeFlashcard(quality) {
  const card = state.flashQueue[state.flashIndex];
  try {
    await api(`/languages/${state.current.code}/review/${card.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quality }),
    });
  } catch (e) { /* keep going even if save fails */ }

  state.flashIndex++;
  if (state.flashIndex >= state.flashQueue.length) {
    if (state.course && state.course.step === "drill") { completeCourseStep(); return; }
    $("#flashcard").classList.add("hidden");
    $("#flashEmpty").classList.remove("hidden");
    $("#flashEmpty").textContent = "🎉 Session complete! Great work — check Progress to see your stats.";
    return;
  }
  renderFlashcard();
}

/* ------------------------------------------------------------------ */
/* Speak practice                                                      */
/* ------------------------------------------------------------------ */
function randomCard() {
  return state.cards[Math.floor(Math.random() * state.cards.length)];
}

function canSpeak() {
  return state.sttEnabled || speechRecognitionSupported();
}

function nextSpeak() {
  const note = $("#speakNote");
  if (state.sttEnabled) {
    note.textContent = "Tap “Speak now”, say the phrase, then tap again to check — works in any browser (server-scored).";
  } else if (speechRecognitionSupported()) {
    note.textContent = "Tap “Speak now”, say the phrase, and we'll check what we heard.";
  } else {
    note.textContent = "🎙️ Live speech scoring needs Chrome or Edge here. You can still tap 🔊 to hear the phrase and practice out loud.";
  }
  state.speakCard = randomCard();
  const c = state.speakCard;
  $("#speakTarget").innerHTML = `
    <div class="native">${c.native}</div>
    ${state.current.has_reading ? `<div class="reading">${c.reading}</div>` : ""}
    <div class="translation">${c.translation}</div>`;
  const fb = $("#speakFeedback");
  fb.className = "practice-feedback";
  fb.textContent = "";
  const btn = $("#speakStart");
  btn.disabled = !canSpeak();
  btn.classList.remove("listening");
  btn.textContent = "🎤 Speak now";
}

/* Dispatch the Speak button to server recording (preferred) or browser STT. */
function speakAction() {
  if (state.sttEnabled) toggleServerRecord();
  else startSpeaking();
}

/* Record the mic with MediaRecorder, then upload to the server for scoring. */
async function toggleServerRecord() {
  const btn = $("#speakStart");
  if (state.recording && state.mediaRecorder) {
    state.mediaRecorder.stop();  // fires onstop → submitSpeech
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const fb = $("#speakFeedback");
    fb.className = "practice-feedback bad";
    fb.textContent = "🎤 Microphone access was blocked. Allow it in your browser to practice speaking.";
    return;
  }
  const rec = new MediaRecorder(stream);
  state.mediaRecorder = rec;
  state.chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    state.recording = false;
    btn.classList.remove("listening");
    btn.textContent = "🎤 Speak now";
    await submitSpeech(new Blob(state.chunks, { type: rec.mimeType || "audio/webm" }));
  };
  rec.start();
  state.recording = true;
  btn.classList.add("listening");
  btn.textContent = "⏹ Stop & check";
  const fb = $("#speakFeedback");
  fb.className = "practice-feedback";
  fb.textContent = "🎙️ Recording… tap again when you're done.";
}

async function submitSpeech(blob) {
  const fb = $("#speakFeedback");
  fb.className = "practice-feedback";
  fb.textContent = "⏳ Checking your pronunciation…";
  const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("audio", blob, `speech.${ext}`);
  try {
    const res = await fetch(`${API}/languages/${state.current.code}/speech-check/${state.speakCard.id}`,
      { method: "POST", body: form });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    if (data.ok) {
      fb.className = "practice-feedback ok";
      fb.innerHTML = `✅ Nailed it! <span class="heard">(heard: “${data.transcript || "…"}”)</span>`;
    } else {
      fb.className = "practice-feedback bad";
      fb.innerHTML = `❌ Not quite — try again. <span class="heard">(heard: “${data.transcript || "…"}”)</span>`;
    }
  } catch (e) {
    fb.className = "practice-feedback bad";
    fb.textContent = "Couldn't reach the speech service. Try again in a moment.";
  }
}

function startSpeaking() {
  if (!speechRecognitionSupported()) return;
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Rec();
  rec.lang = state.current.speech_lang;
  rec.interimResults = false;
  rec.maxAlternatives = 3;

  const btn = $("#speakStart");
  btn.classList.add("listening");
  btn.textContent = "🎙️ Listening…";

  rec.onresult = (ev) => {
    const alts = Array.from(ev.results[0]).map((r) => normalize(r.transcript));
    const target = normalize(state.speakCard.native);
    const heard = ev.results[0][0].transcript;
    const fb = $("#speakFeedback");
    if (alts.some((a) => a === target || a.includes(target) || target.includes(a))) {
      fb.className = "practice-feedback ok";
      fb.innerHTML = `✅ Nailed it! <span class="heard">(heard: “${heard}”)</span>`;
    } else {
      fb.className = "practice-feedback bad";
      fb.innerHTML = `❌ Not quite — try again. <span class="heard">(heard: “${heard}”)</span>`;
    }
  };
  rec.onerror = (ev) => {
    const fb = $("#speakFeedback");
    fb.className = "practice-feedback bad";
    fb.textContent = ev.error === "not-allowed"
      ? "🎤 Microphone access was blocked. Allow it in your browser to practice speaking."
      : `Speech error: ${ev.error}`;
  };
  rec.onend = () => {
    btn.classList.remove("listening");
    btn.textContent = "🎤 Speak now";
  };
  rec.start();
  state.recognition = rec;
}

/* ------------------------------------------------------------------ */
/* Write practice                                                      */
/* ------------------------------------------------------------------ */
function nextWrite() {
  state.writeCard = randomCard();
  const c = state.writeCard;
  const hint = state.current.has_reading ? ` <span style="color:var(--muted)">(${state.current.reading_label} accepted)</span>` : "";
  $("#writePrompt").innerHTML = `Write this in ${state.current.name}:${hint}<span class="cue">${c.translation}</span>`;
  const input = $("#writeInput");
  input.value = "";
  input.focus();
  const fb = $("#writeFeedback");
  fb.className = "practice-feedback";
  fb.textContent = "";
}

function checkWrite() {
  const c = state.writeCard;
  // Compare with tones stripped so "ni hao" also matches "nǐ hǎo".
  const answer = stripTones(normalize($("#writeInput").value));
  if (!answer) return;
  const accepts = [stripTones(normalize(c.native))];
  if (state.current.has_reading) accepts.push(stripTones(normalize(c.reading)));
  const fb = $("#writeFeedback");
  if (accepts.some((a) => a && (a === answer || a.includes(answer) || answer.includes(a)))) {
    fb.className = "practice-feedback ok";
    fb.textContent = "✅ Correct!";
    speak(c.native, state.current.speech_lang);
  } else {
    fb.className = "practice-feedback bad";
    fb.innerHTML = `❌ Not quite. <span class="heard">Answer: ${c.native}${state.current.has_reading ? " · " + c.reading : ""}</span>`;
  }
}

function revealWrite() {
  const c = state.writeCard;
  const fb = $("#writeFeedback");
  fb.className = "practice-feedback";
  fb.innerHTML = `💡 ${c.native}${state.current.has_reading ? ` · <span style="color:var(--accent-2)">${c.reading}</span>` : ""}`;
  speak(c.native, state.current.speech_lang);
}

/* ------------------------------------------------------------------ */
/* Roleplay (guided scenarios)                                         */
/* ------------------------------------------------------------------ */
function canon(s) { return stripTones(normalize(s)); }

async function renderRoleplayHome() {
  $("#rp-run").classList.add("hidden");
  $("#rp-home").classList.remove("hidden");
  const list = $("#rp-list");
  list.innerHTML = "<p class='rp-hint'>Loading…</p>";
  let scenarios = [];
  try { scenarios = await api(`/scenarios?language=${state.current.code}`); } catch (e) { /* */ }
  if (!scenarios.length) {
    list.innerHTML = `<p class="empty">No roleplay scenarios for ${state.current.name} yet.</p>`;
    return;
  }
  list.innerHTML = "";
  for (const s of scenarios) {
    const el = document.createElement("div");
    el.className = "vocab rp-card";
    el.style.display = "block";
    el.innerHTML = `
      <div class="native" style="font-size:18px">${s.title}</div>
      <div class="rp-intro">${s.intro}</div>
      <span class="rp-badge">${s.level} · ${s.beats} turns</span>`;
    el.addEventListener("click", () => startScenario(s.id));
    list.appendChild(el);
  }
}

async function startScenario(id) {
  try { state.scenario = await api(`/scenarios/${id}`); } catch (e) { return; }
  state.beatIndex = 0;
  $("#rp-home").classList.add("hidden");
  $("#rp-run").classList.remove("hidden");
  $("#rp-title").textContent = state.scenario.title;
  $("#rp-chat").innerHTML = "";
  $("#rp-input").innerHTML = "";
  addBubble("system", `<em>${state.scenario.intro}</em>`);
  playBeat();
}

function rpSpeechLang() { return state.scenario.speech_lang || state.current.speech_lang; }

function addBubble(kind, html) {
  const b = document.createElement("div");
  b.className = `bubble ${kind}`;
  b.innerHTML = html;
  $("#rp-chat").appendChild(b);
  b.scrollIntoView({ behavior: "smooth", block: "end" });
  return b;
}

function playBeat() {
  const beat = state.scenario.beats[state.beatIndex];
  const line = beat.say[Math.floor(Math.random() * beat.say.length)];
  $("#rp-progress").textContent = `Turn ${state.beatIndex + 1} of ${state.scenario.beats.length}`;
  const masked = state.rpListening;
  const b = addBubble("partner", `
    <div class="who">${state.scenario.partner}</div>
    <div class="say${masked ? " masked" : ""}">${line} <button class="replay" title="Replay">🔊</button></div>
    ${masked ? '<div class="reveal-hint">🎧 Listen — tap to reveal the text</div>' : (beat.say_en ? `<div class="say-en">${beat.say_en}</div>` : "")}`);
  const sayEl = b.querySelector(".say");
  b.querySelector(".replay").addEventListener("click", (e) => { e.stopPropagation(); speak(line, rpSpeechLang()); });
  if (masked) sayEl.addEventListener("click", () => {
    sayEl.classList.remove("masked");
    const hint = b.querySelector(".reveal-hint");
    if (hint && beat.say_en) hint.outerHTML = `<div class="say-en">${beat.say_en}</div>`;
    else if (hint) hint.remove();
  });
  speak(line, rpSpeechLang());
  renderRpInput(beat);
}

function renderRpInput(beat) {
  const box = $("#rp-input");
  box.innerHTML = `
    <div class="rp-hint">💬 ${beat.hint || "Respond in " + state.current.name + "."}</div>
    <div class="rp-row">
      <input type="text" id="rp-text" class="write-input" placeholder="Type your reply…" autocomplete="off" spellcheck="false" />
      <button class="btn primary" id="rp-send">Send</button>
    </div>
    <div class="rp-actions">
      ${state.sttEnabled ? '<button class="btn" id="rp-mic">🎤 Speak your reply</button>' : ""}
      <button class="btn ghost" id="rp-skip">Show answer &amp; continue →</button>
    </div>`;
  const input = $("#rp-text");
  input.focus();
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") handleResponse(input.value); });
  $("#rp-send").addEventListener("click", () => handleResponse(input.value));
  $("#rp-skip").addEventListener("click", () => revealAndAdvance(beat));
  if (state.sttEnabled) $("#rp-mic").addEventListener("click", rpToggleRecord);
}

function beatPass(beat, text) {
  const t = canon(text);
  if (!beat.expect || beat.expect.length === 0) return t.length >= 2;  // open-ended reply
  return beat.expect.some((k) => { const kk = canon(k); return kk && t.includes(kk); });
}

function handleResponse(text) {
  text = (text || "").trim();
  if (!text) return;
  const beat = state.scenario.beats[state.beatIndex];
  const pass = beatPass(beat, text);
  addBubble("you" + (pass ? "" : " miss"), `<div class="who">You</div><div class="say">${text}</div>`);
  if (pass) {
    advanceBeat();
  } else {
    const fb = document.createElement("div");
    fb.className = "rp-feedback";
    fb.innerHTML = `Close! Try again, or use — <span class="model">“${beat.model}”</span> <span class="model-en">${beat.model_en || ""}</span>`;
    $("#rp-chat").appendChild(fb);
    fb.scrollIntoView({ behavior: "smooth", block: "end" });
    const input = $("#rp-text"); if (input) { input.value = ""; input.focus(); }
  }
}

function revealAndAdvance(beat) {
  addBubble("system", `Model answer — <span style="color:var(--text)">“${beat.model}”</span>${beat.model_en ? `<br><span class="say-en">${beat.model_en}</span>` : ""}`);
  advanceBeat();
}

function advanceBeat() {
  // Lock the input during the transition so a fast second submit can't be scored
  // against the next (not-yet-shown) beat, then advance when the line plays.
  $("#rp-input").innerHTML = "";
  setTimeout(() => {
    state.beatIndex++;
    if (state.beatIndex >= state.scenario.beats.length) finishScenario();
    else playBeat();
  }, 450);
}

function finishScenario() {
  addBubble("system", `✅ <strong>${state.scenario.outro || "Scenario complete!"}</strong>`);
  $("#rp-input").innerHTML = `<div class="rp-actions">
    <button class="btn primary" id="rp-again">Try again</button>
    <button class="btn ghost" id="rp-done">← Back to scenarios</button>
  </div>`;
  $("#rp-again").addEventListener("click", () => startScenario(state.scenario.id));
  $("#rp-done").addEventListener("click", renderRoleplayHome);
}

/* Record a spoken reply and transcribe via the generic /api/stt endpoint. */
async function rpToggleRecord() {
  const btn = $("#rp-mic");
  if (state.rpRecording && state.rpRecorder) { state.rpRecorder.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { addBubble("system", "🎤 Microphone access was blocked."); return; }
  const rec = new MediaRecorder(stream);
  state.rpRecorder = rec;
  state.rpChunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) state.rpChunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    state.rpRecording = false;
    btn.classList.remove("listening");
    btn.textContent = "🎤 Speak your reply";
    const blob = new Blob(state.rpChunks, { type: rec.mimeType || "audio/webm" });
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
    const form = new FormData();
    form.append("audio", blob, `reply.${ext}`);
    form.append("language", state.scenario.language);
    try {
      const res = await fetch(`${API}/stt`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (data.transcript) handleResponse(data.transcript);
      else addBubble("system", "Didn't catch that — try again.");
    } catch (e) {
      addBubble("system", "Couldn't reach the speech service — you can type your reply instead.");
    }
  };
  rec.start();
  state.rpRecording = true;
  btn.classList.add("listening");
  btn.textContent = "⏹ Stop";
}

/* ------------------------------------------------------------------ */
/* Class — weekly guided loop (learn → tape → drill → test)            */
/* ------------------------------------------------------------------ */
const COURSE_STEPS = [
  { key: "learn", label: "Learn", icon: "📖" },
  { key: "tape", label: "Tape", icon: "📼" },
  { key: "drill", label: "Drill", icon: "🃏" },
  { key: "test", label: "Test", icon: "🎧" },
];

const doneKey = (deckId, step) => `nihongo:done:${state.current.code}:${deckId}:${step}`;
const isStepDone = (deckId, step) => localStorage.getItem(doneKey(deckId, step)) === "1";
const markStepDone = (deckId, step) => localStorage.setItem(doneKey(deckId, step), "1");

function showOnly(name) {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  const el = $(`#view-${name}`);
  if (el) el.classList.remove("hidden");
}

async function renderCourse() {
  $("#course-banner").classList.add("hidden");
  $("#course-title").textContent = `Your ${state.current.name} class`;
  const decks = await api(`/languages/${state.current.code}/decks`);
  const wrap = $("#course-weeks");
  wrap.innerHTML = "";
  let nextClaimed = false;
  decks.forEach((d, wi) => {
    const done = COURSE_STEPS.filter((s) => isStepDone(d.id, s.key)).length;
    const week = document.createElement("div");
    week.className = "week" + (done === COURSE_STEPS.length ? " done" : "");
    let steps = "";
    COURSE_STEPS.forEach((s) => {
      const sd = isStepDone(d.id, s.key);
      let cls = "step-btn" + (sd ? " done" : "");
      if (!sd && !nextClaimed) { cls += " next"; nextClaimed = true; }
      steps += `<button class="${cls}" data-deck="${d.id}" data-week="${wi + 1}" data-step="${s.key}">
        <span>${s.icon}</span><span>${s.label}</span><span class="step-check">${sd ? "✓" : ""}</span></button>`;
    });
    week.innerHTML = `
      <div class="week-head">
        <span class="week-num">Week ${wi + 1}</span>
        <span class="week-name">${d.name}</span>
        <span class="week-desc">${d.description || ""}</span>
      </div>
      <div class="week-steps">${steps}</div>`;
    week.querySelectorAll(".step-btn").forEach((b) =>
      b.addEventListener("click", () => startCourseStep(b.dataset.deck, +b.dataset.week, b.dataset.step)));
    wrap.appendChild(week);
  });
}

function startCourseStep(deckId, week, step) {
  state.course = { deckId, week, step };
  if (step === "learn") { state.deck = deckId; showOnly("learn"); renderLearn(); }
  else if (step === "tape") startShadow(deckId);
  else if (step === "drill") startDrill(deckId);
  else if (step === "test") startListeningTest(deckId);
  showCourseBanner();
}

function showCourseBanner() {
  if (!state.course) { $("#course-banner").classList.add("hidden"); return; }
  const meta = COURSE_STEPS.find((s) => s.key === state.course.step);
  const b = $("#course-banner");
  b.classList.remove("hidden");
  b.innerHTML = `
    <span class="cb-label">🎓 Week ${state.course.week} · ${meta.icon} ${meta.label}</span>
    <span class="cb-sub">part of your class</span>
    <span class="cb-actions">
      <button class="btn primary" id="cb-done">✓ Mark done &amp; continue</button>
      <button class="btn ghost" id="cb-exit">Exit</button>
    </span>`;
  $("#cb-done").addEventListener("click", completeCourseStep);
  $("#cb-exit").addEventListener("click", exitCourseStep);
}

function completeCourseStep() {
  if (state.course) markStepDone(state.course.deckId, state.course.step);
  exitCourseStep();
}

function exitCourseStep() {
  state.course = null;
  $("#course-banner").classList.add("hidden");
  $$(".nav-btn").forEach((x) => x.classList.remove("active"));
  showOnly("course");
  renderCourse();
}

/* --- Generic one-shot recorder → /api/stt (used by Tape) --- */
let _rec = null, _recChunks = [], _recStream = null;
async function toggleRecorder(btn, language, activeLabel, idleLabel, onResult) {
  if (_rec) { _rec.stop(); return; }
  try { _recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { onResult(null, "blocked"); return; }
  _rec = new MediaRecorder(_recStream);
  _recChunks = [];
  _rec.ondataavailable = (e) => { if (e.data && e.data.size) _recChunks.push(e.data); };
  _rec.onstop = async () => {
    _recStream.getTracks().forEach((t) => t.stop());
    btn.classList.remove("listening");
    btn.textContent = idleLabel;
    const blob = new Blob(_recChunks, { type: _rec.mimeType || "audio/webm" });
    _rec = null;
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
    const form = new FormData();
    form.append("audio", blob, `a.${ext}`);
    form.append("language", language);
    try {
      const res = await fetch(`${API}/stt`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`${res.status}`);
      onResult((await res.json()).transcript || "", null);
    } catch (e) { onResult(null, "error"); }
  };
  _rec.start();
  btn.classList.add("listening");
  btn.textContent = activeLabel;
}

/* --- Tape (shadowing): hear it, say it back --- */
function startShadow(deckId) {
  state.shadowCards = state.cards.filter((c) => c.deck === deckId);
  state.shadowIndex = 0;
  showOnly("shadow");
  renderShadowCard();
}

function renderShadowCard() {
  const c = state.shadowCards[state.shadowIndex];
  $("#shadow-count").textContent = `Phrase ${state.shadowIndex + 1} of ${state.shadowCards.length}`;
  $("#shadow-en").textContent = c.translation;
  const nat = $("#shadow-native");
  nat.textContent = c.native;
  nat.classList.add("blur");
  const fb = $("#shadow-feedback");
  fb.className = "practice-feedback";
  fb.textContent = "";
  $("#shadow-say").textContent = "🎤 Say it back";
  $("#shadow-say").disabled = false;
  speak(c.native, state.current.speech_lang);  // the "tape" plays
}

function shadowSay() {
  const fb = $("#shadow-feedback");
  const c = state.shadowCards[state.shadowIndex];
  if (!state.sttEnabled) {  // no server STT — self-paced, just reveal
    $("#shadow-native").classList.remove("blur");
    fb.className = "practice-feedback";
    fb.textContent = "Say it out loud, then move on. 👍";
    return;
  }
  toggleRecorder($("#shadow-say"), state.current.code, "⏹ Stop", "🎤 Say it back", (text, err) => {
    if (err) { fb.className = "practice-feedback bad"; fb.textContent = err === "blocked" ? "🎤 Mic blocked." : "Speech service error."; return; }
    $("#shadow-native").classList.remove("blur");
    const ok = canon(text) && (canon(text).includes(canon(c.native)) || canon(c.native).includes(canon(text)));
    fb.className = "practice-feedback " + (ok ? "ok" : "bad");
    fb.innerHTML = (ok ? "✅ Nice!" : "❌ Close —") + ` <span class="heard">(heard: “${text || "…"}”)</span>`;
  });
}

function shadowNext() {
  state.shadowIndex++;
  if (state.shadowIndex >= state.shadowCards.length) {
    if (state.course) completeCourseStep();
    else exitCourseStep();
    return;
  }
  renderShadowCard();
}

/* --- Drill: deck-scoped flashcards (reuses the flashcard UI) --- */
function startDrill(deckId) {
  const cards = state.cards.filter((c) => c.deck === deckId).slice();
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  state.flashQueue = cards;
  state.flashIndex = 0;
  showOnly("flashcards");
  $("#flashEmpty").classList.add("hidden");
  $("#flashcard").classList.remove("hidden");
  renderFlashcard();
}

/* --- Listening test: audio only, self-checked --- */
function startListeningTest(deckId) {
  const cards = state.cards.filter((c) => c.deck === deckId).slice();
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  state.ltCards = cards;
  state.ltIndex = 0;
  state.ltScore = 0;
  showOnly("listentest");
  renderLtCard();
}

function renderLtCard() {
  const c = state.ltCards[state.ltIndex];
  $("#lt-count").textContent = `Item ${state.ltIndex + 1} of ${state.ltCards.length}`;
  $("#lt-prompt").textContent = "What does it mean? Say it out loud, then reveal.";
  $("#lt-play").textContent = "🔊 Listen";
  const rev = $("#lt-reveal");
  rev.classList.add("hidden");
  rev.innerHTML = "";
  $("#lt-grade-row").innerHTML = `<button class="btn ghost" id="lt-show">Reveal</button>`;
  $("#lt-show").addEventListener("click", ltReveal);
  speak(c.native, state.current.speech_lang);
}

function ltReveal() {
  const c = state.ltCards[state.ltIndex];
  const rev = $("#lt-reveal");
  rev.classList.remove("hidden");
  rev.innerHTML = `<div class="lt-native">${c.native}</div>${state.current.has_reading ? `<div class="reading">${c.reading}</div>` : ""}<div class="lt-en">${c.translation}</div>`;
  $("#lt-grade-row").innerHTML = `
    <button class="btn" id="lt-miss">✗ Missed</button>
    <button class="btn primary" id="lt-got">✓ Understood</button>`;
  $("#lt-got").addEventListener("click", () => ltGrade(true));
  $("#lt-miss").addEventListener("click", () => ltGrade(false));
}

function ltGrade(ok) {
  if (ok) state.ltScore++;
  state.ltIndex++;
  if (state.ltIndex >= state.ltCards.length) ltFinish();
  else renderLtCard();
}

function ltFinish() {
  const pct = Math.round((100 * state.ltScore) / state.ltCards.length);
  $("#lt-count").textContent = "Test complete";
  $("#lt-play").style.display = "none";
  $("#lt-prompt").innerHTML = `🎧 You understood <strong>${state.ltScore} of ${state.ltCards.length}</strong> by ear (${pct}%).`;
  $("#lt-reveal").classList.add("hidden");
  $("#lt-grade-row").innerHTML = `<button class="btn primary" id="lt-done">Finish → back to class</button>`;
  $("#lt-done").addEventListener("click", () => {
    $("#lt-play").style.display = "";
    if (state.course) completeCourseStep(); else exitCourseStep();
  });
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */
async function renderProgress() {
  const p = await api(`/languages/${state.current.code}/progress`);
  const pct = p.total ? Math.round((p.learned / p.total) * 100) : 0;
  $("#progressStats").innerHTML = `
    <div class="stat"><div class="num">${p.studied}</div><div class="label">Cards studied</div></div>
    <div class="stat"><div class="num">${p.learned}</div><div class="label">Cards learned</div></div>
    <div class="stat"><div class="num">${p.total}</div><div class="label">Total in course</div></div>
    <div class="stat"><div class="num">${p.lapses}</div><div class="label">Times forgotten</div></div>`;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="progress-bar"><div style="width:${pct}%"></div></div>
    <div class="progress-caption">${pct}% of ${state.current.name} learned</div>`;
  $("#progressStats").appendChild(wrap);
}

/* ------------------------------------------------------------------ */
/* Wire up events                                                      */
/* ------------------------------------------------------------------ */
function init() {
  $("#brand").addEventListener("click", goHome);
  $("#langBadge").addEventListener("click", goHome);
  $$(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  $("#flashFace").addEventListener("click", flipFlashcard);
  $$("#flashControls .grade").forEach((b) =>
    b.addEventListener("click", () => gradeFlashcard(parseInt(b.dataset.q, 10))));

  $("#speakHear").addEventListener("click", () => speak(state.speakCard.native, state.current.speech_lang));
  $("#speakStart").addEventListener("click", speakAction);
  $("#speakSkip").addEventListener("click", nextSpeak);

  $("#rp-back").addEventListener("click", renderRoleplayHome);
  $("#rp-listen").addEventListener("change", (e) => { state.rpListening = e.target.checked; });

  // Tape (shadowing)
  $("#shadow-hear").addEventListener("click", () => speak(state.shadowCards[state.shadowIndex].native, state.current.speech_lang));
  $("#shadow-say").addEventListener("click", shadowSay);
  $("#shadow-reveal").addEventListener("click", () => $("#shadow-native").classList.remove("blur"));
  $("#shadow-next").addEventListener("click", shadowNext);

  // Listening test
  $("#lt-play").addEventListener("click", () => speak(state.ltCards[state.ltIndex].native, state.current.speech_lang));

  $("#writeCheck").addEventListener("click", checkWrite);
  $("#writeReveal").addEventListener("click", revealWrite);
  $("#writeNext").addEventListener("click", nextWrite);
  $("#writeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") checkWrite(); });

  loadHome().catch((e) => {
    $("#langGrid").innerHTML = `<p class="empty">Couldn't reach the server. Is the backend running?</p>`;
  });
}

document.addEventListener("DOMContentLoaded", init);
