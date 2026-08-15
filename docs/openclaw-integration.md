# Using the phone gateway from OpenClaw

The gateway lets an agent place a real phone call with one HTTP request: you
state a goal, a server-side voice loop (OpenAI TTS/STT + LLM) conducts the
conversation, and you read back a transcript annotated with how the person
spoke. Live deployment: `https://phone-gateway.fusenv.com`.

## Setup

1. Set the tenant env var:
   `PHONE_GATEWAY_URL=https://phone-gateway.fusenv.com`
2. Enable the capability for the tenant (in openclaw-8examples):
   `npm run cli -- enable <tenant> phone`

That injects the phone workspace doc; the agent drives everything with curl.

## Authentication

**There is currently no API key.** Twilio and OpenAI credentials live
server-side; the caller of this API needs nothing but the URL. That also means
anyone who discovers the hostname can place calls on the Twilio account — put
a bearer token in front before handing the URL to anything semi-trusted.

## Make a call (the one-shot orchestration surface)

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/orchestrations" \
  -H 'content-type: application/json' \
  -d '{
    "to": "+15551234567",
    "goal": "Book a table for 2 at 7pm Friday under Ana. Get a confirmation.",
    "openingLine": "Hi! I am calling to book a table."
  }'
```

Fields: `to` (E.164, required), `goal` (what the voice agent should achieve),
`openingLine` (optional fixed first sentence; omit to let the LLM open),
`voice` (optional OpenAI TTS voice), `from` (optional; defaults to the
gateway's configured number, currently +15877417105).

Immediate `202` response:

```json
{
  "orchestrationId": "d5bd…",
  "callId": "d5bd…",
  "to": "+15551234567",
  "from": "+15877417105",
  "goal": "…",
  "status": "running",
  "statusUrl": "/orchestrations/d5bd…"
}
```

## Poll for the result

```bash
curl -s "$PHONE_GATEWAY_URL/orchestrations/<orchestrationId>"
```

Poll every few seconds until `status` is `ended` or `failed`:

```json
{
  "id": "d5bd…",
  "status": "ended",
  "reason": "remote_hangup",
  "turns": [
    { "role": "agent",  "text": "Hi! I am calling to book a table." },
    { "role": "caller", "text": "Sure, what name?",
      "annotation": "[volume: normal, pace: normal]" }
  ],
  "liveTranscript": ["[normal, normal] Sure, what name?"],
  "errors": [],
  "events": ["7ms call.state dialing", "18220ms call.state active", "…"]
}
```

- `liveTranscript` fills while the call runs; `turns` is the full conversation
  once it ends. Caller turns carry prosody annotations
  (`volume: whisper|normal|loud|yell`, `pace: calm|slow|normal|fast`,
  `stuttering`) — use them when judging how the call went.
- **IVR menus / keypad (DTMF)**: the voice agent can both press keys and hear
  them. Write goals like "navigate the menu: press 2 for billing, then ask
  about the invoice" — the agent dials keys itself (they appear as
  `[pressed 2]` agent turns). Keys the other side presses appear as
  `[pressed 42]` caller turns and as `[key] 4` lines in `liveTranscript`.
- `reason`: `hangup` = our agent ended it, `remote_hangup` = they did.
- `errors` lists in-call failures (e.g. `stt_failed`); `events` is a full
  timeline for debugging.

Error responses: `400` invalid body or no from-number configured, `424` the
upstream Twilio call couldn't be created (body has the reason).

## Driving the conversation yourself (advanced)

If the agent wants to decide each line instead of delegating to the built-in
brain, use the raw call + control WebSocket:

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/calls" -H 'content-type: application/json' \
  -d '{"to": "+15551234567"}'
# → { "callId": "…", "controlUrl": "/control/<callId>" }
```

Connect one WebSocket client to `wss://…/control/<callId>` and speak JSON:

Client → server: `{"type":"say","id":"s1","text":"…","voice?":"…","instructions?":"…"}`
(FIFO queue), `{"type":"sendDigits","id":"d1","digits":"1w2#"}` (DTMF keys
0-9 A-D * #, `w` = half-second pause; queued in order with says and played as
in-band tones), `{"type":"clear"}` (barge-in: abort current+queued audio),
`{"type":"hangup"}`.

Server → client: `call.state` (dialing/active/ending/ended/failed),
`say.started|say.completed|say.aborted` (completed = actually finished playing
on the phone; sendDigits shares these events by id),
`speech.started|speech.stopped` (voice activity), `transcript.delta`
(partials), `transcript` (final text + prosody), `dtmf`
(`{"type":"dtmf","digit":"4","atMs":12340}` — the remote party pressed a key),
`error`.

## Phone numbers

The gateway already owns +15877417105; nothing to do for normal use.

```bash
curl -s "$PHONE_GATEWAY_URL/numbers/available?areaCode=587"   # preview
curl -s -X POST "$PHONE_GATEWAY_URL/numbers" -H 'content-type: application/json' \
  -d '{"areaCode": "587"}'                                    # buy first match
curl -s -X POST "$PHONE_GATEWAY_URL/numbers" -H 'content-type: application/json' \
  -d '{"phoneNumber": "+15877417105"}'                        # buy exact
curl -s "$PHONE_GATEWAY_URL/numbers"                          # list owned
curl -s -X DELETE "$PHONE_GATEWAY_URL/numbers/<sid>"          # release
```

Area codes are searched US-first with Canadian fallback (587 is Alberta).

## SMS

The gateway's number (+15877417105) is SMS+MMS capable.

Send:

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/sms" -H 'content-type: application/json' \
  -d '{"to": "+15551234567", "body": "Your table for 2 at 7pm Friday is booked."}'
# → { "sid": "SM…", "status": "queued", "to": "…", "from": "+15877417105", "body": "…" }
```

`from` is optional and defaults to the gateway's number. Errors: `400` invalid
body or no from-number, `424` provider rejected the send.

Read history / receive (last 30 days by default, newest first; inbound
messages appear here with no webhook needed — poll this to "receive"):

```bash
curl -s "$PHONE_GATEWAY_URL/sms"            # last 30 days, up to 100 messages
curl -s "$PHONE_GATEWAY_URL/sms?days=7&limit=20"
```

```json
{
  "days": 30,
  "count": 2,
  "messages": [
    { "sid": "SM…", "direction": "inbound",  "from": "+15878998081",
      "to": "+15877417105", "body": "a reply!", "status": "received",
      "sentAt": "2026-08-14T21:04:11.000Z" },
    { "sid": "SM…", "direction": "outbound", "from": "+15877417105",
      "to": "+15878998081", "body": "hello", "status": "delivered",
      "sentAt": "2026-08-14T21:03:02.000Z" }
  ]
}
```

`days` accepts 1–90, `limit` 1–500. There is no push notification for inbound
SMS yet — poll `GET /sms` when expecting a reply.

## Receiving calls (pickup)

The gateway answers incoming calls **on your behalf**: you register a standing
answering persona once, the built-in voice agent handles each call live toward
that goal, and you discover the answered calls (with full transcripts) by
polling. You never need to react to a ring in real time.

Set (or update) the answering persona:

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/inbound-config" -H 'content-type: application/json' \
  -d '{
    "goal": "You are Sean'\''s assistant answering his number. Find out who is calling and why, take a message with callback details, keep it brief and friendly.",
    "openingLine": "Hi! You have reached Sean'\''s assistant. Who am I speaking with?"
  }'
curl -s "$PHONE_GATEWAY_URL/inbound-config"      # read current policy
curl -s -X DELETE "$PHONE_GATEWAY_URL/inbound-config"  # stop answering (reject calls)
```

The runtime config survives until the gateway restarts; the `INBOUND_GOAL` /
`INBOUND_OPENING_LINE` env vars provide the boot-time default. With neither
set, incoming calls are rejected.

Discover answered calls by polling the list (same shape as your own calls,
tagged `direction: "inbound"`, `from` = the caller's number):

```bash
curl -s "$PHONE_GATEWAY_URL/orchestrations?direction=inbound"
# → { "count": 1, "orchestrations": [ { "id": "…", "direction": "inbound",
#      "startedAt": "…", "from": "+1587…", "to": "+15877417105",
#      "status": "ended", "turnCount": 5, "statusUrl": "/orchestrations/…" } ] }
```

Then `GET /orchestrations/<id>` for the full transcript, exactly like an
outbound call. Poll on your heartbeat and follow up on anything new (records
are in-memory: history resets when the gateway restarts, so treat the list as
"recent calls", not an archive).

Plumbing notes: purchased numbers get their Voice URL pointed at
`POST /twilio/voice` automatically; Twilio webhook signatures are validated
when the gateway has `TWILIO_AUTH_TOKEN` configured.

Rules for agents:

- Agree the goal, who to call, and any personal info you may share BEFORE dialing.
- Never call emergency or premium-rate numbers. One call at a time.
- If a transcript shows the callee was upset or asked not to be called, do not
  call again without explicit permission.
- After the call, report the outcome in two sentences: what happened, what's next.
