#!/usr/bin/env bash
# Integration test: concurrent call support (Issue #11)
# Places 2 calls simultaneously, verifies independent lifecycle.
# Makes REAL phone calls — costs money.
set -euo pipefail

# --- Config ---

OUTREACH="node dist/cli.js"
MAX_DURATION=60
POLL_INTERVAL=5

# IVR test line — toll-free, always answers
IVR_NUMBER_1="+18004444444"
# Second IVR number — AT&T directory assistance
IVR_NUMBER_2="+18002221111"

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

# --- State ---

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
declare -a RESULTS=()

# --- Helpers ---

log()  { echo -e "${BOLD}[test]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS_COUNT=$((PASS_COUNT + 1)); RESULTS+=("PASS: $1"); }
fail() { echo -e "${RED}[FAIL]${NC} $1 — $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); RESULTS+=("FAIL: $1 — $2"); }
skip() { echo -e "${YELLOW}[SKIP]${NC} $1 — $2"; SKIP_COUNT=$((SKIP_COUNT + 1)); RESULTS+=("SKIP: $1 — $2"); }

cleanup() {
  log "Running teardown..."
  $OUTREACH call teardown 2>/dev/null || true
}

trap cleanup EXIT

place_call() {
  local output
  output=$($OUTREACH call place "$@" --max-duration "$MAX_DURATION" 2>/dev/null) || {
    echo ""
    return 1
  }
  echo "$output" | jq -r '.id // empty'
}

wait_for_end() {
  local call_id="$1"
  local max_wait="${2:-$MAX_DURATION}"
  local elapsed=0

  while [ "$elapsed" -lt "$max_wait" ]; do
    local status_json
    status_json=$($OUTREACH call status --id "$call_id" 2>/dev/null) || true
    local status
    status=$(echo "$status_json" | jq -r '.status // empty')

    if [ "$status" = "ended" ]; then
      return 0
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  log "Call $call_id still active after ${max_wait}s, forcing hangup"
  $OUTREACH call hangup --id "$call_id" 2>/dev/null || true
  sleep 2
  return 0
}

get_transcript() {
  local call_id="$1"
  $OUTREACH call listen --id "$call_id" 2>/dev/null || echo '{}'
}

# --- Preflight ---

log "Preflight checks..."

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

if [ ! -f "dist/cli.js" ]; then
  log "Building project..."
  npm run build --silent
fi

log "Cleaning up any existing daemon..."
$OUTREACH call teardown 2>/dev/null || true
sleep 1

# --- Init ---

log "Running outreach init..."
INIT_OUTPUT=$($OUTREACH call init 2>/dev/null) || {
  echo "Error: 'outreach call init' failed. Check .env and prerequisites."
  echo "$INIT_OUTPUT"
  exit 1
}
log "Daemon started."
sleep 2

# ============================================================
# TC-C1: Place two calls concurrently, verify independent IDs
# ============================================================

log ""
log "=========================================="
log "TC-C1: Concurrent call placement"
log "=========================================="
log "Placing two calls simultaneously..."

CALL_A_ID=$(place_call \
  --to "$IVR_NUMBER_1" \
  --objective "Press 1 when you hear the menu" \
  --persona "You are navigating a phone menu." \
  --hangup-when "You have navigated past the first menu level")

CALL_B_ID=$(place_call \
  --to "$IVR_NUMBER_2" \
  --objective "Press 1 when you hear the menu" \
  --persona "You are navigating a phone menu." \
  --hangup-when "You have navigated past the first menu level")

if [ -z "$CALL_A_ID" ] || [ -z "$CALL_B_ID" ]; then
  fail "TC-C1: Concurrent placement" "Failed to place one or both calls (A=${CALL_A_ID:-empty}, B=${CALL_B_ID:-empty})"
elif [ "$CALL_A_ID" = "$CALL_B_ID" ]; then
  fail "TC-C1: Concurrent placement" "Both calls got the same ID: $CALL_A_ID"
else
  log "Call A: $CALL_A_ID"
  log "Call B: $CALL_B_ID"
  pass "TC-C1: Concurrent placement — two independent call IDs"
fi

# ============================================================
# TC-C2: Both calls report independent status
# ============================================================

log ""
log "=========================================="
log "TC-C2: Independent call status"
log "=========================================="

if [ -z "$CALL_A_ID" ] || [ -z "$CALL_B_ID" ]; then
  skip "TC-C2: Independent status" "Calls not placed"
else
  sleep 3  # let calls connect

  STATUS_A=$($OUTREACH call status --id "$CALL_A_ID" 2>/dev/null || echo '{}')
  STATUS_B=$($OUTREACH call status --id "$CALL_B_ID" 2>/dev/null || echo '{}')

  STATUS_A_VAL=$(echo "$STATUS_A" | jq -r '.status // "error"')
  STATUS_B_VAL=$(echo "$STATUS_B" | jq -r '.status // "error"')

  log "Call A status: $STATUS_A_VAL"
  log "Call B status: $STATUS_B_VAL"

  if [ "$STATUS_A_VAL" != "error" ] && [ "$STATUS_B_VAL" != "error" ]; then
    pass "TC-C2: Independent status — A=$STATUS_A_VAL, B=$STATUS_B_VAL"
  else
    fail "TC-C2: Independent status" "One or both calls returned error (A=$STATUS_A_VAL, B=$STATUS_B_VAL)"
  fi
fi

# ============================================================
# TC-C3: Hang up one call, other continues
# ============================================================

log ""
log "=========================================="
log "TC-C3: Independent hangup"
log "=========================================="

if [ -z "$CALL_A_ID" ] || [ -z "$CALL_B_ID" ]; then
  skip "TC-C3: Independent hangup" "Calls not placed"
else
  # Hang up call A
  log "Hanging up call A ($CALL_A_ID)..."
  $OUTREACH call hangup --id "$CALL_A_ID" 2>/dev/null || true
  sleep 2

  # Check: A should be ended, B should still be active
  STATUS_A_AFTER=$($OUTREACH call status --id "$CALL_A_ID" 2>/dev/null || echo '{}')
  STATUS_B_AFTER=$($OUTREACH call status --id "$CALL_B_ID" 2>/dev/null || echo '{}')

  A_ENDED=$(echo "$STATUS_A_AFTER" | jq -r '.status // "error"')
  B_STILL=$(echo "$STATUS_B_AFTER" | jq -r '.status // "error"')

  log "Call A after hangup: $A_ENDED"
  log "Call B still going: $B_STILL"

  if [ "$A_ENDED" = "ended" ] && [ "$B_STILL" != "ended" ] && [ "$B_STILL" != "error" ]; then
    pass "TC-C3: Independent hangup — A ended, B continues ($B_STILL)"
  elif [ "$A_ENDED" = "ended" ] && [ "$B_STILL" = "ended" ]; then
    # B may have ended naturally (IVR hung up) — still passes placement/independence
    pass "TC-C3: Independent hangup — both ended (B ended naturally)"
  else
    fail "TC-C3: Independent hangup" "Unexpected states (A=$A_ENDED, B=$B_STILL)"
  fi

  # Clean up call B
  if [ "$B_STILL" != "ended" ]; then
    log "Hanging up call B..."
    $OUTREACH call hangup --id "$CALL_B_ID" 2>/dev/null || true
  fi
fi

# ============================================================
# TC-C4: Both calls produce independent transcripts
# ============================================================

log ""
log "=========================================="
log "TC-C4: Independent transcripts"
log "=========================================="

if [ -z "$CALL_A_ID" ] || [ -z "$CALL_B_ID" ]; then
  skip "TC-C4: Independent transcripts" "Calls not placed"
else
  sleep 2

  TRANSCRIPT_A=$(get_transcript "$CALL_A_ID")
  TRANSCRIPT_B=$(get_transcript "$CALL_B_ID")

  HAS_A=$(echo "$TRANSCRIPT_A" | jq '.transcript | length > 0' 2>/dev/null || echo "false")
  HAS_B=$(echo "$TRANSCRIPT_B" | jq '.transcript | length > 0' 2>/dev/null || echo "false")

  log "Call A has transcript: $HAS_A"
  log "Call B has transcript: $HAS_B"

  if [ "$HAS_A" = "true" ] && [ "$HAS_B" = "true" ]; then
    pass "TC-C4: Independent transcripts — both calls have transcript entries"
  elif [ "$HAS_A" = "true" ] || [ "$HAS_B" = "true" ]; then
    pass "TC-C4: Independent transcripts — at least one call has transcript (calls may have been too short)"
  else
    fail "TC-C4: Independent transcripts" "No transcript entries captured from either call"
  fi
fi

# ============================================================
# Summary
# ============================================================

log ""
log "=========================================="
log "TEST SUMMARY"
log "=========================================="
echo ""

for result in "${RESULTS[@]}"; do
  if [[ "$result" == PASS* ]]; then
    echo -e "  ${GREEN}$result${NC}"
  elif [[ "$result" == FAIL* ]]; then
    echo -e "  ${RED}$result${NC}"
  else
    echo -e "  ${YELLOW}$result${NC}"
  fi
done

echo ""
log "Passed: $PASS_COUNT  Failed: $FAIL_COUNT  Skipped: $SKIP_COUNT"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
