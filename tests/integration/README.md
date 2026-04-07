# Integration Tests: IVR Tool Usage

Live integration tests that exercise the voice agent's ability to navigate IVR menus using `send_dtmf` function calling and terminate calls using `end_call`.

**These tests make real phone calls and cost money.**

## Prerequisites

1. **Twilio account** with a configured phone number
   - `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env`
   - `OUTREACH_DEFAULT_FROM` set to your Twilio number

2. **Google Gemini API key**
   - `GOOGLE_GENERATIVE_AI_API_KEY` in `.env`

3. **ngrok** installed and authenticated
   - `outreach init` uses ngrok to expose the local daemon

4. **jq** installed
   - `brew install jq` (macOS) or `apt-get install jq` (Linux)

5. **Project built**
   - `npm run build` (the script will build if `dist/cli.js` is missing)

## Running

From the project root:

```bash
# IVR tests (TC-1, TC-4):
./tests/integration/ivr-test.sh

# All IVR tests (TC-4 requires you to answer your phone):
OUTREACH_TEST_BASELINE_NUMBER="+1YOUR_NUMBER" ./tests/integration/ivr-test.sh

# Concurrent calls test:
./tests/integration/concurrent-calls-test.sh
```

Each script is idempotent: it tears down any existing daemon before starting and cleans up on exit.

## Test Cases

### TC-1: Basic DTMF (single key press)

- **Calls**: +1-800-444-4444 (MCI/Verizon directory IVR)
- **Objective**: Press 1 when prompted by the IVR menu
- **Validates**: Agent detects IVR prompt, fires `send_dtmf` with the correct digit, call progresses past the first menu level
- **Pass criteria**: Call ends with transcript entries present

### TC-4: end_call on objective met

- **Calls**: Your number via `OUTREACH_TEST_BASELINE_NUMBER` (you answer, agent says hello, hangs up)
- **Objective**: Say hello and hang up immediately
- **Validates**: Agent speaks greeting, fires `end_call` with a reason, call terminates cleanly
- **Pass criteria**: Call ends within the max duration
- **Note**: Skipped if `OUTREACH_TEST_BASELINE_NUMBER` is not set. Uses a real number you answer to avoid robocalling businesses.

### TC-C1 through TC-C4: Concurrent calls (concurrent-calls-test.sh)

- **Calls**: Two IVR lines simultaneously (+1-800-444-4444 and +1-800-222-1111)
- **Validates**:
  - TC-C1: Two calls get independent IDs
  - TC-C2: Both calls report independent status
  - TC-C3: Hanging up one call does not affect the other
  - TC-C4: Both calls produce separate transcript files

## Inspecting Results

### Daemon logs

The daemon writes to stdout/stderr. To see tool call logs (`send_dtmf`, `end_call`), check the daemon output. When running via `outreach init`, daemon logs go to the spawned background process. You can find the PID in `/tmp/outreach-daemon.pid` and inspect its output.

### Transcript files

Each call writes a JSONL transcript to `~/.outreach/transcripts/<call_id>.jsonl`. Inspect with:

```bash
cat ~/.outreach/transcripts/call_*.jsonl | jq .
```

### Session logs

Session events (call.started, call.ended) are written to `~/.outreach/sessions/`. Inspect with:

```bash
cat ~/.outreach/sessions/*.jsonl | jq .
```

### Twilio console

For definitive proof that DTMF was sent, check the Twilio console:
Calls > select the call SID > Properties/Events. Look for DTMF send events.

## Timing expectations

- `send_dtmf` should fire within 3 seconds of the agent hearing an IVR prompt
- `end_call` should fire promptly when the objective is met
- All calls are capped at 60 seconds via `--max-duration`

## Cost

Each test call costs standard Twilio per-minute rates. With 60-second caps, expect roughly 2-3 minutes of call time per full test run (under $0.10 USD with standard Twilio pricing).
