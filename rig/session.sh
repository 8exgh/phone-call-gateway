#!/usr/bin/env bash
# Test-rig session: two temporary public tunnels (one to the local gateway under
# test, one to the robot caller), the local gateway process, and the Twilio
# test numbers pointed at them.
#
#   rig/session.sh up        start tunnels, point the agent test number at the gateway tunnel
#   rig/session.sh gateway   (re)start the local gateway with the current working tree
#   rig/session.sh caller    robot caller's tunnel only (to grade a deployed gateway)
#   rig/session.sh down      stop everything and clear the test numbers' webhooks
set -euo pipefail
RIG="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$RIG")"; STATE="$RIG/.state"; mkdir -p "$STATE"
set -a; . "$ROOT/.env"; set +a
GW_PORT=3310; CALLER_PORT=3311
AGENT_NUMBER="+15878165146"; AGENT_SID="PN3f3017f9a931e21c59da630095fcd977"
CALLER_NUMBER="+15878175749"; CALLER_SID="PN01f97ad19e361fb48fb26744f90b7cce"
TW="https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID"

voice_url() { curl -s -m 20 -u "$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET" -X POST "$TW/IncomingPhoneNumbers/$1.json" --data-urlencode "VoiceUrl=$2" --data-urlencode "VoiceMethod=POST" -o /dev/null -w "%{http_code}"; }

tunnel() { # name port -> prints https url
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" --network host cloudflare/cloudflared:latest tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$2" >/dev/null
  for _ in $(seq 1 40); do
    url=$(docker logs "$1" 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1 || true)
    [ -n "$url" ] && { echo "$url"; return 0; }
    sleep 1
  done
  echo "tunnel $1 did not come up" >&2; return 1
}

# The gateway is whatever process is listening on our port (setsid hides the real pid).
stop_gateway() {
  local pid
  pid=$(ss -ltnpH "sport = :$GW_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  for _ in $(seq 1 20); do ss -ltnH "sport = :$GW_PORT" 2>/dev/null | grep -q . || return 0; sleep 0.25; done
  echo "gateway on :$GW_PORT would not stop" >&2; return 1
}

start_gateway() {
  . "$STATE/session.env"
  stop_gateway
  ( cd "$ROOT" && MODE=live PORT=$GW_PORT PUBLIC_WSS_URL="${RIG_GATEWAY_PUBLIC/https:/wss:}" DATA_DIR="$STATE/data" \
      TWILIO_FROM_NUMBER="$AGENT_NUMBER" ADMIN_API_KEY= \
      setsid nohup node --import tsx src/index.ts > "$STATE/gateway.log" 2>&1 < /dev/null & )
  for _ in $(seq 1 40); do curl -s -m 2 "http://127.0.0.1:$GW_PORT/health" >/dev/null 2>&1 && { echo "gateway up on :$GW_PORT"; return 0; }; sleep 0.5; done
  echo "gateway failed to start:" >&2; tail -20 "$STATE/gateway.log" >&2; return 1
}

case "${1:-}" in
  up)
    GW_URL=$(tunnel pgw-rig-gateway $GW_PORT); CALLER_URL=$(tunnel pgw-rig-caller $CALLER_PORT)
    cat > "$STATE/session.env" <<ENV
RIG_GATEWAY_PUBLIC=$GW_URL
RIG_CALLER_PUBLIC=$CALLER_URL
RIG_GATEWAY_LOCAL=http://127.0.0.1:$GW_PORT
RIG_CALLER_PORT=$CALLER_PORT
RIG_AGENT_NUMBER=$AGENT_NUMBER
RIG_CALLER_NUMBER=$CALLER_NUMBER
ENV
    start_gateway
    echo "waiting for $GW_URL to resolve publicly..."
    for _ in $(seq 1 60); do [ "$(curl -s -m 6 "$GW_URL/health" || true)" = '{"ok":true}' ] && break; sleep 3; done
    curl -s -m 6 "$GW_URL/health" | grep -q ok || { echo "gateway tunnel unreachable" >&2; exit 1; }
    echo "agent number webhook -> $GW_URL/twilio/voice: HTTP $(voice_url $AGENT_SID "$GW_URL/twilio/voice")"
    echo "session up: gateway=$GW_URL caller=$CALLER_URL"
    ;;
  gateway) start_gateway ;;
  caller)
    # Robot caller only, for grading a gateway that is deployed somewhere else:
    # export RIG_GATEWAY_LOCAL=<its URL> and RIG_GATEWAY_TOKEN=<client key> for rig/run.ts.
    CALLER_URL=$(tunnel pgw-rig-caller $CALLER_PORT)
    cat > "$STATE/session.env" <<ENV
RIG_CALLER_PUBLIC=$CALLER_URL
RIG_CALLER_PORT=$CALLER_PORT
RIG_AGENT_NUMBER=$AGENT_NUMBER
RIG_CALLER_NUMBER=$CALLER_NUMBER
ENV
    echo "caller tunnel up: $CALLER_URL"
    ;;
  down)
    stop_gateway || true
    docker rm -f pgw-rig-gateway pgw-rig-caller >/dev/null 2>&1 || true
    echo "agent number webhook cleared: HTTP $(voice_url $AGENT_SID "")"
    rm -f "$STATE/session.env"; echo "session down"
    ;;
  *) echo "usage: $0 up|gateway|caller|down" >&2; exit 2 ;;
esac
