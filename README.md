# phone-call-gateway

A phone call gateway for LLM-driven conversations. It provisions Twilio numbers by
area code, places outbound calls, and exposes a WebSocket **control stream** per call:

- **Text in → speech out**: write text to the socket and it is synthesized with the OpenAI
  TTS API (`gpt-4o-mini-tts`, streaming, with style instructions) and played into the live call.
- **Speech in → annotated text out**: caller audio is transcribed live (OpenAI realtime
  transcription) and every transcript segment carries **paralinguistic metadata computed
  locally via DSP** — no API provides these:
  - `volume`: `whisper | normal | loud | yell` (RMS energy → dBFS bands)
  - `pace`: `calm | slow | normal | fast` (+ raw WPM; words over voiced time from energy VAD)
  - `stutter`: word repetitions, false starts (`wa- want`), and audio choppiness

An LLM **orchestrator harness** consumes that stream to conduct calls, adapting to *how*
the caller speaks (e.g. de-escalating when the caller yells, barging out when interrupted).

**Mock-first**: the entire system runs and tests offline. Fake Twilio and fake OpenAI
implementations speak the real wire protocols over localhost, so integration tests cover the
full pipeline (register → call → speak → transcribe → orchestrate → hang up) with no
credentials, faster than realtime. Real Twilio/OpenAI slot in with `MODE=live`.

## Quickstart (no credentials needed)

```bash
npm install
npm test                    # 154 tests, all offline
npm run orchestrate -- --fast   # watch an LLM-orchestrated demo call end to end
```

`orchestrate` starts an in-process gateway with a scripted fake caller. With
`OPENAI_API_KEY` set, the orchestration brain is a real LLM (TTS/STT stay fake in mock
mode); without it, a scripted fake LLM is used. Sample output:

```
Caller [volume: normal, pace: normal]: Hello, who is this?
Agent: Hi there! This is Alex...
Caller [volume: loud, pace: fast, stuttering]: I I wa- want to know why you keep calling me!
Agent: I understand, and I'm really sorry if it's been too much!
Caller [volume: whisper, pace: normal]: okay... fine. that sounds reasonable.
```

## Architecture

```
┌────────────────────────────── clients ───────────────────────────────┐
│  OpenClaw agents — one bearer token + one phone number + 90h/month   │
│  each · admin key mints tokens, sees accounting + the raw event log  │
└──────┬───────────────────────────────────────▲───────────────────────┘
       │ REST: /orchestrations /calls /sms     │ webhook push (per
       │ /numbers /inbound-config /accounting  │ client, isolated):
       │ /notify-config (+ /clients /events)   │  tool.requested
       │ control WS per call:                  │  followup.promised
       │  say / sendDigits / clear / hangup    │  call.inbound.started
       ▼                                       │  call.ended
┌─── Cloudflare tunnel: phone-gateway.fusenv.com → Server7:3052 ───────┐
│                                                                      │
│  auth · per-client scoping · 90h/month quotas · charge attribution   │
│                                                                      │
│  Orchestrator (one per call) — goal-locked LLM loop                  │
│    transcripts + prosody in → sentence-streamed says out             │
│    barge-in on recognized words · PRESS(digits) for IVR menus        │
│    mid-call tools: hold the line → broker to the client's agent →    │
│    speak the answer — or promise an immediate callback and hang up   │
│         │ control WS (loopback)                                      │
│         ▼                                                            │
│  CallSession (per-call state machine)                                │
│    out: say queue → TTS 24k PCM → FIR ↓8k → μ-law → 20ms frames      │
│         → 200ms prebuffer → marks (real playback acks) · DTMF tones  │
│    in:  μ-law decode → echo gate (Geigel double-talk detector)       │
│           ├→ prosody DSP: VAD · pace · volume · stutter              │
│           └→ FIR ↑24k → realtime STT (English-pinned)                │
│                                                                      │
│  Event store — CQRS+ES: append-only SQLite events.db (/data volume)  │
│    commands append client.* / orchestration.* events; projections    │
│    (clients, numbers, personas, call history) replay at boot         │
└──────┬───────────────────────────────────────┬───────────────────────┘
       │ Twilio REST + bidirectional media WS  │ OpenAI HTTPS + WSS
       ▼                                       ▼
   Twilio                                   OpenAI
     outbound calls · inbound webhook →       gpt-4o-mini-tts (voice out)
     <Connect><Stream> · SMS both ways        realtime transcription (ears)
     per-number routing · call/price log      chat + tool calling (brain)
       │
       ▼
   PSTN — the actual phones on both ends
```

- REST — numbers: `GET /numbers/available?areaCode=415` (preview candidates),
  `POST /numbers` with `{areaCode}` (buy first match) or `{phoneNumber}` (buy that exact one),
  `GET /numbers` (owned, straight from Twilio so it survives restarts),
  `DELETE /numbers/:sid` (release — stops monthly billing).
- REST — calls: `POST /calls {to, from?}` → `{callId, controlUrl}` (`from` defaults to the last
  session purchase, then `TWILIO_FROM_NUMBER`, then any owned number), `GET/DELETE /calls/:id`,
  `GET /health`.
- REST — one-shot orchestrations (the agent-friendly surface): `POST /orchestrations
  {to, goal, openingLine?, voice?, from?}` places the call **and** runs the whole conversation
  server-side with the configured LLM; poll `GET /orchestrations/:id` for `status`
  (`running|ended|failed`), a live prosody-annotated transcript, and the final turn list. One
  HTTP call = one complete phone conversation — ideal for chat agents (OpenClaw etc.) that
  can't hold a low-latency WebSocket loop themselves:

  ```bash
  curl -X POST $GW/orchestrations -H 'content-type: application/json' \
    -d '{"to":"+15551234567","goal":"Book a table for 2 at 7pm Friday under Ana"}'
  # → {"orchestrationId":"...","statusUrl":"/orchestrations/..."}
  ```

  Calling a business line, three opt-in options change how the agent behaves (all off by
  default, so existing callers are unaffected):
  `awaitGreeting: true` holds the opening until whoever picks up (a receptionist, a phone
  menu) has spoken, answering their words when they come through and opening after a short
  pause when they do not; `silenceTimeoutMs` (0–120000, default 15000, 0 never) is how long
  the line may be silent after the agent speaks before it re-engages, so a hold or a transfer
  is not talked into; `promptOnUnclearSpeech: true` gives the agent a turn to say it did not
  catch that when a voice is heard but no words come through, instead of going quiet (at
  most four times a call, eight seconds apart).
- REST — webhook push + owed callbacks: `POST /notify-config {url, headers?}` registers a
  per-client endpoint the gateway pings (`tool.requested`, `followup.promised`,
  `call.inbound.started`, `call.ended`). Every delivery attempt is recorded on the
  orchestration (`notifications[]`: attempt, HTTP status or fetch error such as
  `ECONNREFUSED`), so a ping that reached nobody is visible in `GET /orchestrations/:id`.
  A promised callback whose ping was never accepted (`followUpRequired: true`,
  `followUpDelivered: false`) is re-pinged every 5 minutes for 72 hours until the endpoint
  answers 2xx — same `notificationId`, so receivers dedupe. `POST /orchestrations/:id/notify`
  re-sends it on demand and returns the outcome.
- REST — voices: `GET /voices` lists the voices an agent can speak with, each described by
  `gender` (female / male / neutral), `accent`, `age` and a few adjectives, with a
  `previewUrl` to listen to; filter with `?gender=female&accent=british&search=calm`.
  `GET /voices/:id/preview` returns a short spoken sample as it sounds on a phone line (WAV).
  Use a voice by passing its `id` as `voice` on `POST /orchestrations` or
  `POST /inbound-config`, or make it the default for all of a client's calls with
  `POST /voice-config {voice}` (`GET` shows it, `DELETE` clears it). Order of precedence:
  the call's own `voice`, the inbound persona's, the client default, the server default
  (`REALTIME_VOICE`). An unknown name never fails a call: it falls back to the default and
  the response says so in `warnings`.

  Two families of voices are listed. The ten built-in ones (`marin`, `cedar`, …) are the
  speech model's own. With `ELEVENLABS_API_KEY` set, ElevenLabs voices are listed too, with
  ids of the form `elevenlabs:<voice_id>` and far more accents: the account's own voices
  always, and on a paid ElevenLabs plan the public voice library, searched live with the
  same filters (`?accent=irish&gender=female`). ElevenLabs does not let free accounts use
  library voices over the API; the response's `notes` say so when that applies. For an
  ElevenLabs voice the model writes its reply as text and ElevenLabs speaks it as it is
  written; measured reply times are the same as for the built-in voices.

  ```bash
  curl "$GW/voices?gender=male"                       # browse
  curl "$GW/voices/cedar/preview" -o cedar.wav        # listen
  curl -X POST $GW/voice-config -H 'content-type: application/json' -d '{"voice":"cedar"}'
  ```
- Twilio reaches `/twilio/media/:callId` via bidirectional Media Streams
  (`<Connect><Stream>`); the orchestrator connects to `/control/:callId`.
- **Media clock**: all prosody timestamps are Twilio frame count × 20ms — never wall
  clock — so results are deterministic and mock runs can go faster than realtime.

## Voice engines

`VOICE_ENGINE` chooses how server-run conversations (`POST /orchestrations`, incoming calls)
hear and speak:

- **`realtime`** — the caller's audio goes straight into a speech-to-speech model
  (`REALTIME_MODEL`, default `gpt-realtime-1.5`) and the model's voice comes straight back,
  as 8kHz μ-law in both directions with no resampling. The gateway itself decides
  turn-taking (`src/realtime/realtimeAgent.ts`), because the model's built-in detectors wait
  about 0.8s before answering:
  - **Speculative replies.** 140ms after the caller goes quiet the model is asked for its
    answer; if the caller carries on, the answer is dropped unheard and the whole turn so far
    is given to the model again as one piece of audio.
  - **Patience.** A prepared answer is spoken only after the caller has been silent for
    700ms, more for callers who are seen to pause longer mid-sentence (up to 1s) and after a
    one- or two-word utterance ("okay", "hi"), which usually has more coming.
  - **Mid-thought holds.** The model can call `keep_listening` instead of speaking when the
    caller has clearly not finished ("my number is…"); a trailing "um" or "and" in the
    transcript is a backstop. After 2.5s of nothing more it answers anyway.
  - **Interruptions.** 140ms of caller sound over the agent pauses it at once, and a
    streaming transcriber (`gpt-live-transcribe`, fed only while the agent talks) reports
    the caller's first word about half a second in. A listening noise ("mm-hmm", "uh-huh",
    "yeah") and the agent carries straight on from the last gap between words; a real word
    (even a lone "Wait.") or 0.7s of continued talking and it stops for good, and the model
    is told how much of its reply was actually heard. A "yeah" or "okay" said over the
    agent is kept and answered once the agent has finished its sentence.
  - **Echo.** Some lines (speakerphones) send the agent's own voice back. The agent
    measures how much comes back during its first seconds of speech and ignores inbound
    sound below that level; on a line with no echo nothing the caller says is filtered.
  - **Greetings** and other exact lines are generated before the line connects and cached
    per voice, so from the second call on a persona's hello starts the moment the call is
    answered.
  - The model ends calls with an `end_call` tool, presses keys with `press_keys`, and uses
    the client's tools exactly as before (hold line, `/respond`, callback promise).
  - `VOICE_TUNING` overrides any timing as JSON, e.g. `{"patienceMinMs":800}` (see
    `TurnTuning`). `REALTIME_REASONING` sets reasoning effort for models that reason.
- **`classic`** (default until switched) — transcribe → chat model → text-to-speech, one
  sentence at a time, driven over the control WebSocket. Still what `POST /calls` clients
  use when they run their own conversation loop.

### Measuring how a call feels (`rig/`)

`rig/` is a test rig that grades the caller's experience, not the code:

- `rig/run.ts` places **real phone calls** between two Twilio numbers. One is answered by a
  local gateway (through a temporary tunnel), the other is a scripted robot caller that plays
  human-paced speech, records both sides on one clock, and measures what a caller would
  hear: the gap before each reply, whether the agent talks over a mid-sentence pause, how
  fast it stops when interrupted, whether "mm-hmm" derails it, stalls, and whether the task
  got done. `rig/judge.ts` then has an audio model listen to the recordings and rate them.
- `rig/sim.ts` runs the same agent and the same caller scripts in-process with a simulated
  phone path (no Twilio), several calls at once: about a minute for the whole suite. Use it
  to iterate; confirm on the phone.
- `rig/floor.ts` measures the phone path alone (beep-to-beep, no gateway): about 620ms round
  trip in this setup, which is part of every reply gap a caller hears and which the gateway
  cannot remove.

```bash
rig/session.sh up                                   # tunnels + local gateway + test numbers
VOICE_ENGINE=realtime rig/session.sh gateway        # (re)start the gateway under test
node --import tsx rig/run.ts --label mychange --n 3 # 18 real calls, graded scorecard
node --import tsx rig/judge.ts --dir rig/out/<run>  # listener ratings
node --import tsx rig/sim.ts --label try --n 2      # the fast loop, no phone
node --import tsx rig/rescore.ts rig/out/<run>      # re-grade saved recordings with the current analysis
rig/session.sh down
```

Reading a scorecard: the timings are "as heard" by the caller, so they include the phone
path. A call whose line added over half a second more than usual (a network fault between
gateway and caller, visible as the gap between what the gateway logged and what the caller
heard) is counted in a "left out" row rather than mixed into the timings. Pass
`--voice elevenlabs:<voice_id>` to `rig/run.ts`, or set `REALTIME_VOICE` for `rig/sim.ts`,
to grade a particular voice.

## Control WebSocket protocol

Client → server:

```jsonc
{ "type": "say", "id": "s1", "text": "Hello!", "voice": "ash", "instructions": "warm, calm" }
{ "type": "clear" }    // barge-in: abort in-flight + queued says, flush Twilio's buffer
{ "type": "hangup" }
```

Server → client:

```jsonc
{ "type": "call.state", "callId": "c1", "state": "dialing|active|ending|ended|failed", "reason": "..." }
{ "type": "say.started",   "id": "s1" }
{ "type": "say.completed", "id": "s1" }   // Twilio mark ack: playback actually finished
{ "type": "say.aborted",   "id": "s1", "reason": "clear|hangup|error" }
{ "type": "speech.started", "atMs": 12340 }   // VAD onset  → barge-in trigger
{ "type": "speech.stopped", "atMs": 15100 }   // VAD offset → turn-taking trigger
{ "type": "transcript.delta", "text": "I I wa-" }
{ "type": "transcript",
  "text": "I I wa- want to cancel my order",
  "startMs": 12340, "endMs": 15100,
  "pace":    { "class": "fast", "wpm": 182 },
  "volume":  { "class": "loud", "dbfs": -14.2 },
  "stutter": { "detected": true, "repetitions": 1, "falseStarts": 1, "choppiness": 0.4 },
  "confidence": 0.93 }
{ "type": "error", "code": "invalid_message|call_failed|tts_failed|stt_failed|control_busy|unknown_call", "message": "..." }
```

On `tts_failed` the say is not dropped: the gateway plays a pre-rendered
"Out of OpenAI tokens." clip (`src/speech/ttsFallbackClip.ts`, regenerate with
`scripts/render-tts-fallback.sh`) under the same say id, so the callee hears
why the line went quiet and the usual `say.completed` follows.

Schemas live in `src/protocol/messages.ts` (zod; single source of truth for server,
orchestrator, and tests). One control client per call; connecting early replays buffered
lifecycle events.

## Live mode

1. Copy `.env.example` → `.env`; set `MODE=live`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `OPENAI_API_KEY`.
2. Expose the gateway publicly (Twilio must reach the media WebSocket):
   `ngrok http 3300`, then set `PUBLIC_WSS_URL=wss://<your-id>.ngrok.app`.
3. `npm run dev` (or `npm run build && npm start`), then either use the REST API directly or
   `npm run orchestrate -- --to +1XXXXXXXXXX --goal "confirm the appointment"`.
4. Optional: set `TWILIO_FROM_NUMBER` to reuse a number you own instead of purchasing
   (`POST /numbers` buys a real number and bills your account).

**Twilio trial account caveats**: trials can only call **verified** numbers, play a spoken
preamble before connecting (which delays `active` and pollutes the first seconds of
transcription), and include one number. These artifacts don't exist in mock mode.

**Latency**: a live turn is roughly VAD endpointing (~300ms) + STT completion (200–500ms) +
LLM (0.5–1.5s) + TTS first byte (200–500ms) ≈ **1.3–2.8s**. `transcript.delta` and
`speech.stopped` exist so orchestrators can start thinking before the full transcript lands.

**Audio quality**: PSTN is 8kHz mu-law — TTS will sound like a phone call no matter the
source quality. Resampling is 1:3 linear/mean (`src/audio/resample.ts`); a proper FIR filter
is a drop-in upgrade there.

## Prosody tuning

Thresholds are exported constants with unit tests around them:

- `src/prosody/volume.ts` — dBFS class bands + hysteresis window
- `src/prosody/vad.ts` — onset (60ms) / offset (300ms) / burst gap (60ms)
- `src/prosody/pace.ts` — WPM class bands, minimum voiced time
- `src/prosody/stutter.ts` — repetition/false-start heuristics, choppiness (short-burst ratio)

Pace WPM uses local VAD voiced-time (the realtime STT API provides no word timestamps), so
treat it as a coarse signal — which is all an orchestrator needs.

## Project layout

```
src/
  server.ts             buildServer(deps, config) — DI seam: mock vs live is a config switch
  config.ts             zod env schema; the only module reading process.env
  protocol/messages.ts  control WS protocol (zod)
  call/                 CallSession state machine, media (Twilio) + control WS handlers
  audio/                mu-law codec, 8k↔24k resampling, 20ms framing, tone generator
  prosody/              rms, vad, volume, pace, stutter + ProsodyAnalyzer facade
  speech/               SpeechSynthesizer/Transcriber seams + OpenAI implementations
  telephony/            TwilioApi seam, live SDK adapter, TwiML builder
  orchestrator/         LLM conversation loop + chat client seam
  fakes/                FakeTwilio{Api,MediaClient}, caller scripts, fake TTS/STT/LLM
  bin/orchestrate.ts    CLI: run an orchestrated call (mock or live)
test/unit/              DSP + protocol tests (synthetic audio vectors)
test/integration/       full-pipeline tests over real localhost WebSockets
```

## Commands

| Command | What |
|---|---|
| `npm test` | full offline suite |
| `npm run typecheck` | strict TypeScript, no emit |
| `npm run dev` | gateway with live reload (mock unless `MODE=live`) |
| `npm run orchestrate -- [--to N] [--goal "..."] [--fast] [--server URL]` | run an orchestrated call |
