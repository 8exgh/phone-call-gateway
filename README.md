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
- Twilio reaches `/twilio/media/:callId` via bidirectional Media Streams
  (`<Connect><Stream>`); the orchestrator connects to `/control/:callId`.
- **Media clock**: all prosody timestamps are Twilio frame count × 20ms — never wall
  clock — so results are deterministic and mock runs can go faster than realtime.

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
