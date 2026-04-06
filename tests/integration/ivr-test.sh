#!/usr/bin/env bash
# Integration test runner for IVR tool usage (Issue #4)
# Makes REAL phone calls — costs money. See README.md for prerequisites.
set -euo pipefail

# --- Config ---

OUTREACH="node dist/cli.js"
MAX_DURATION=60
LISTEN_TIMEOUT=60000
POLL_INTERVAL=5

# IVR test line — MCI/Verizon directory with "press 1 for..." menus
IVR_NUMBER="+18004444444"
# Personal number for TC-4 (end_call test) — you pick up, agent says hello, hangs up.
# Leave empty to skip TC-4.
PERSONAL_NUMBER="${OUTREACH_TEST_BASELINE_NUMBER:-}"

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

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
  $OUTREACH teardown 2>/dev/null || true
}

# Always teardown on exit
trap cleanup EXIT

# Place a call and return the call ID. Exits test on failure.
# Usage: CALL_ID=$(place_call --to ... --objective ... etc)
place_call() {
  local output
  output=$($OUTREACH call place "$@" --max-duration "$MAX_DURATION" 2>/dev/null) || {
    echo ""
    return 1
  }
  echo "$output" | jq -r '.id // empty'
}

# Poll call status until ended or timeout
# Usage: wait_for_end <call_id> <max_seconds>
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

  # Force hangup if still going
  log "Call $call_id still active after ${max_wait}s, forcing hangup"
  $OUTREACH call hangup --id "$call_id" 2>/dev/null || true
  sleep 2
  return 0
}

# Collect full transcript from a call using listen (non-blocking, gets buffered entries)
# Usage: get_transcript <call_id>
get_transcript() {
  local call_id="$1"
  $OUTREACH call listen --id "$call_id" 2>/dev/null || echo '{}'
}

# --- Preflight checks ---

log "Preflight checks..."

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

if [ ! -f "dist/cli.js" ]; then
  log "Building project..."
  npm run build --silent
fi

# Teardown any existing daemon before starting fresh
log "Cleaning up any existing daemon..."
$OUTREACH teardown 2>/dev/null || true
sleep 1

# --- Init ---

log "Running outreach init..."
INIT_OUTPUT=$($OUTREACH init 2>/dev/null) || {
  echo "Error: 'outreach init' failed. Check .env and prerequisites."
  echo "$INIT_OUTPUT"
  exit 1
}
log "Daemon started."
sleep 2

# ============================================================
# TC-1: Basic DTMF — call IVR line, press 1 when prompted
# ============================================================

log ""
log "=========================================="
log "TC-1: Basic DTMF — single key press"
log "=========================================="
log "Calling $IVR_NUMBER — expecting agent to detect IVR and press 1"

TC1_ID=$(place_call \
  --to "$IVR_NUMBER" \
  --objective "Press 1 when you hear the menu" \
  --persona "You are a caller navigating a phone menu. Listen to the options and press the correct key." \
  --hangup-when "You have navigated past the first menu level")

if [ -z "$TC1_ID" ]; then
  fail "TC-1: Basic DTMF" "Failed to place call"
else
  log "Call placed: $TC1_ID"

  # Listen with wait for initial transcript
  log "Listening for transcript..."
  $OUTREACH call listen --id "$TC1_ID" --wait --timeout "$LISTEN_TIMEOUT" >/dev/null 2>&1 || true

  # Wait for call to end (agent should hang up after navigating past menu)
  wait_for_end "$TC1_ID" "$((MAX_DURATION + 10))"

  # Collect transcript
  TC1_TRANSCRIPT=$(get_transcript "$TC1_ID")
  TC1_STATUS=$($OUTREACH call status --id "$TC1_ID" 2>/dev/null || echo '{}')
  TC1_CALL_STATUS=$(echo "$TC1_STATUS" | jq -r '.status // "unknown"')
  TC1_HAS_TRANSCRIPT=$(echo "$TC1_TRANSCRIPT" | jq '.transcript | length > 0')

  log "Call status: $TC1_CALL_STATUS"
  log "Has transcript: $TC1_HAS_TRANSCRIPT"

  if [ "$TC1_CALL_STATUS" = "ended" ] && [ "$TC1_HAS_TRANSCRIPT" = "true" ]; then
    pass "TC-1: Basic DTMF — call completed with transcript"
  elif [ "$TC1_CALL_STATUS" = "ended" ]; then
    fail "TC-1: Basic DTMF" "Call ended but no transcript captured"
  else
    fail "TC-1: Basic DTMF" "Call did not end cleanly (status: $TC1_CALL_STATUS)"
  fi

  log "Transcript:"
  echo "$TC1_TRANSCRIPT" | jq '.transcript[]?' 2>/dev/null || echo "(empty)"
fi

sleep 3

# ============================================================
# TC-4: end_call on objective met — say hello and hang up
# ============================================================

log ""
log "=========================================="
log "TC-4: end_call on objective met"
log "=========================================="

# Uses your personal number — you pick up, agent says hello, then hangs up.
# This avoids calling real businesses with a robocall.
TC4_NUMBER="$PERSONAL_NUMBER"

if [ -z "$TC4_NUMBER" ]; then
  skip "TC-4: end_call on objective met" "No OUTREACH_TEST_BASELINE_NUMBER set — set it to a number you can answer"
  TC4_ID=""
else
  log "Calling $TC4_NUMBER — pick up when it rings, agent will say hello then hang up"

  TC4_ID=$(place_call \
    --to "$TC4_NUMBER" \
    --objective "Say hello and hang up immediately" \
    --persona "You are making a brief test call. Say hello, then end the call right away." \
    --hangup-when "After saying hello" \
    --welcome-greeting "Hello, this is a test call.")
fi

if [ -z "$TC4_ID" ] && [ -n "$TC4_NUMBER" ]; then
  fail "TC-4: end_call on objective met" "Failed to place call"
elif [ -z "$TC4_ID" ]; then
  : # already skipped above
else
  log "Call placed: $TC4_ID"

  # Listen with wait
  log "Listening for transcript..."
  $OUTREACH call listen --id "$TC4_ID" --wait --timeout "$LISTEN_TIMEOUT" >/dev/null 2>&1 || true

  # Wait for end — should be quick since objective is just "say hello"
  wait_for_end "$TC4_ID" "$((MAX_DURATION + 10))"

  # Collect results
  TC4_TRANSCRIPT=$(get_transcript "$TC4_ID")
  TC4_STATUS=$($OUTREACH call status --id "$TC4_ID" 2>/dev/null || echo '{}')
  TC4_CALL_STATUS=$(echo "$TC4_STATUS" | jq -r '.status // "unknown"')
  TC4_DURATION=$(echo "$TC4_STATUS" | jq -r '.duration_sec // 0')

  log "Call status: $TC4_CALL_STATUS"
  log "Duration: ${TC4_DURATION}s"

  if [ "$TC4_CALL_STATUS" = "ended" ]; then
    # Check that it ended reasonably quickly (within max duration)
    if [ "$TC4_DURATION" -le "$MAX_DURATION" ]; then
      pass "TC-4: end_call on objective met — call ended in ${TC4_DURATION}s"
    else
      fail "TC-4: end_call on objective met" "Call took too long (${TC4_DURATION}s)"
    fi
  else
    fail "TC-4: end_call on objective met" "Call did not end cleanly (status: $TC4_CALL_STATUS)"
  fi

  log "Transcript:"
  echo "$TC4_TRANSCRIPT" | jq '.transcript[]?' 2>/dev/null || echo "(empty)"
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

# Check transcript files
log "Transcript files in ~/.outreach/transcripts/:"
ls -la ~/.outreach/transcripts/ 2>/dev/null || echo "  (none)"
echo ""

# Teardown handled by trap

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
