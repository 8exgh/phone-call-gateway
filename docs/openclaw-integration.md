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

Every endpoint (except `/health` and Twilio's webhook) requires a bearer
token:

```bash
curl -s "$PHONE_GATEWAY_URL/orchestrations" -H "Authorization: Bearer $PHONE_GATEWAY_API_KEY"
```

There are two kinds of token:

- **Admin key** (`ADMIN_API_KEY` on the server) — the operator's password. It
  can do everything, sees all accounts, and is the only key that can mint
  client tokens:

  ```bash
  curl -s -X POST "$PHONE_GATEWAY_URL/clients" -H "Authorization: Bearer $ADMIN_KEY" \
    -H 'content-type: application/json' -d '{"name": "jason"}'
  # → 201 { "id": "jason-3f2a", "apiKey": "pgw_…", "limits": { "maxNumbers": 1, "maxCallHoursPerMonth": 90 } }
  ```

  `GET /clients` lists accounts; `DELETE /clients/:id` removes one (release
  its number separately). Pass `"phoneNumber": "+1…"` on creation to pre-bind
  an already-owned number.

- **Client key** (`pgw_…`) — what each OpenClaw gets. It is scoped: one
  registered number (calls and texts always send from it), its own inbound
  answering persona, and visibility only into its own calls, SMS, and
  charges. Limits per client: **1 phone number** and **90 call-hours per
  month** (measured from the provider's call log, inbound + outbound; over
  quota means outbound returns 429 and incoming calls are rejected).

Every claw should set both env vars: `PHONE_GATEWAY_URL` and
`PHONE_GATEWAY_API_KEY`, and send the Authorization header on every request
shown in this document.

## Registering a number (per client)

A client registers its one number itself; area codes fall back to same-city
overlays when dry (e.g. Winnipeg's 204 is usually out of stock, so the
overlay 431 supplies the number — the response tells you which was used):

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/numbers" \
  -H "Authorization: Bearer $PHONE_GATEWAY_API_KEY" -H 'content-type: application/json' \
  -d '{"areaCode": "204"}'
# → { "sid": "PN…", "phoneNumber": "+1431…", "areaCode": "431" }
```

The number is remembered server-side: omit `from` everywhere after this.

## Accounting

Charges come from the provider's own records, attributed to whichever
account's number was involved:

```bash
curl -s "$PHONE_GATEWAY_URL/accounting?days=30" -H "Authorization: Bearer $KEY"
```

With a client key you get your own account:
`{ "days": 30, "currency": "USD", "account": { "clientId": …, "calls": { "count", "minutes", "costUsd" }, "sms": { … }, "numberMonthlyEstimateUsd": 1.15, "totalUsd": … } }`.
With the admin key you get `clients: […]` (every account), plus
`unattributed` traffic (calls/SMS involving no bound number) and a grand
`totalUsd`. Note: number rental is a flat estimate (Twilio doesn't expose it
per number), and very recent traffic can be briefly unrated (`costUsd`
counts it as 0 until Twilio rates it).

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
- **Mid-call tools**: the voice agent can invoke tools during the call — see
  the "Mid-call tools" section below. While one runs it holds the line
  naturally; if the result can't arrive in time it promises an immediate
  callback and hangs up.
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

## Mid-call tools (the agent asks, YOU fulfill)

The gateway never executes tools itself — it brokers them to whoever placed
the call. The voice model decides *implicitly* when it needs one (caller asks
"is he busy Thursday?" → it invokes `check_calendar`), says a natural hold
line, and the request appears on the orchestration record.

**Your fulfillment loop — run this while every call you place is running:**
poll the record's `statusUrl` every 2–3 seconds. When `pendingRequests`
contains an entry with `status: "open"`, execute it with whatever capability
you actually have (the tool names are hints, not a rigid API: `run_bash` =
your shell, `check_calendar` = however you read the calendar, `ask_assistant`
= you, answering with your full toolbox), then post the result:

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/orchestrations/<id>/respond" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"requestId": "<request id>", "result": "Calendar says: free after 3pm."}'
```

The result is injected into the live conversation and the agent answers the
caller. Be fast: the agent holds the line ~25 seconds, reassuring once.

**Default toolset** (used when you don't pass your own): `check_calendar`,
`search_email`, `web_search`, `fetch_webpage`, `run_bash`, `write_code`,
`read_file`, `lookup_contact`, `save_note`, and the catch-all
`ask_assistant`. Override per call with `"tools": [{name, description,
parameters?}, …]` in the POST /orchestrations body to declare exactly what
you can fulfill.

**Push instead of poll (optional).** Register a webhook and the gateway pings
you the moment your calls need attention — no polling latency:

```bash
curl -s -X POST "$PHONE_GATEWAY_URL/notify-config" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"url": "https://your-endpoint.example.com/hooks/phone"}'
```

Events posted as JSON: `tool.requested` (agent is holding the line — act
NOW; includes `requestId` and `respondUrl`), `followup.promised` (callback
owed), `call.inbound.started`, and `call.ended` (inbound or follow-up calls).
Delivery is per-client and isolated — your endpoint being down never affects
anyone else's calls (and polling still works as the fallback). The URL must
be public http(s). `GET`/`DELETE /notify-config` read/clear it.

Every ping carries a stable `notificationId` (also sent as the
`idempotency-key` header); retries and re-sends reuse it, so dedupe on it.
Each delivery attempt is recorded on the orchestration record as
`notifications[]` (`event`, `attempt`, `ok`, HTTP `status` or the fetch
`error`, e.g. `ECONNREFUSED`) — check it when you suspect a ping never
arrived. A `followup.promised` ping nobody accepted (record shows
`followUpRequired: true, followUpDelivered: false`) is re-sent every 5
minutes for 72 hours, flagged `redelivery: true`, until your endpoint
answers 2xx; `POST /orchestrations/<id>/notify` re-sends it immediately and
returns the attempt's outcome.

**The callback contract.** If no result arrives in time, the agent tells the
caller "I'm going to hang up, take care of it right now, and call you back
immediately" and ends the call. The record then has `followUpRequired: true`
(also visible in the GET /orchestrations list). Your duty on seeing it:

1. Execute the tool(s) in `pendingRequests` with status `callback_promised`.
2. POST each result to `/respond` (this records the answer, clears
   `followUpRequired`, and stops the re-sends).
3. Immediately place a new call to the same person with the answer, e.g.
   goal: "You promised to call back with X — deliver it: <the answer>".

Inbound-call caveat: tool brokering assumes someone is polling; for calls the
gateway answers on its own, the persona should take messages rather than
attempt live lookups, and you handle them on your next heartbeat.

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

Client personas are persisted (event-sourced) and survive restarts. The
`INBOUND_GOAL` / `INBOUND_OPENING_LINE` env vars provide the fallback policy
for numbers not bound to any client. With no applicable policy, incoming
calls are rejected.

Discover answered calls by polling the list (same shape as your own calls,
tagged `direction: "inbound"`, `from` = the caller's number):

```bash
curl -s "$PHONE_GATEWAY_URL/orchestrations?direction=inbound"
# → { "count": 1, "orchestrations": [ { "id": "…", "direction": "inbound",
#      "startedAt": "…", "from": "+1587…", "to": "+15877417105",
#      "status": "ended", "turnCount": 5, "statusUrl": "/orchestrations/…" } ] }
```

Then `GET /orchestrations/<id>` for the full transcript, exactly like an
outbound call. Poll on your heartbeat and follow up on anything new. Call
history is event-sourced in SQLite and survives restarts; the polling list
serves the most recent 500 calls (the full log is kept on disk — admins can
audit it raw via `GET /events?limit=100&stream=orchestration:<id>`).

Plumbing notes: purchased numbers get their Voice URL pointed at
`POST /twilio/voice` automatically; Twilio webhook signatures are validated
when the gateway has `TWILIO_AUTH_TOKEN` configured.

Rules for agents:

- Agree the goal, who to call, and any personal info you may share BEFORE dialing.
- Never call emergency or premium-rate numbers. One call at a time.
- If a transcript shows the callee was upset or asked not to be called, do not
  call again without explicit permission.
- After the call, report the outcome in two sentences: what happened, what's next.
