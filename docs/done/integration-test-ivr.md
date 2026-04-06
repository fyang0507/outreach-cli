# Integration Test Plan: IVR Tool Usage

## Goal

Verify the voice agent correctly navigates IVR (Interactive Voice Response) menus using the `send_dtmf` function calling tool, and terminates calls using `end_call`.

## Test targets

### Free IVR test lines

| Number | What it does | Tests |
|---|---|---|
| +1-800-444-4444 | MCI/Verizon directory — multi-level IVR with "press 1 for..." menus | DTMF navigation, menu comprehension |
| +1-800-275-2273 | Apple Support — "press 1 for iPhone, 2 for Mac..." | DTMF, complex IVR tree |
| +1-800-555-1212 | Directory assistance — asks for city/state, then name | Speech response + DTMF hybrid |
| +1-712-432-1500 | FreeConferenceCall.com — "enter your access code followed by pound" | DTMF sequence + # key |

### Twilio test numbers (no real call)

| Number | Behavior |
|---|---|
| +15005550006 | Always valid, call connects (no IVR — baseline) |
| +15005550001 | Invalid number — tests error handling |

## Test cases

### TC-1: Basic DTMF — single key press
**Target**: Any IVR with "press 1 for..."
**Objective**: "Press 1 when prompted"
**Verify**:
- Transcript shows IVR prompt detected
- `send_dtmf` tool call fired with correct digit
- Gemini received tool response and continued
- Call progresses past first menu level

### TC-2: DTMF sequence with pound
**Target**: Conference call line (+1-712-432-1500)
**Objective**: "Enter access code 123456 followed by pound"
**Verify**:
- `send_dtmf` called with "123456#"
- Digits sent via Twilio REST API
- Agent hears confirmation or next prompt

### TC-3: Multi-level IVR navigation
**Target**: Apple Support or similar
**Objective**: "Navigate to iPhone support, then battery replacement"
**Verify**:
- Multiple `send_dtmf` calls with different digits
- Agent waits for each menu before pressing next key
- Transcript shows progressive menu navigation

### TC-4: end_call on objective met
**Target**: Any line that answers
**Objective**: "Say hello and hang up immediately"
**Hangup-when**: "After saying hello"
**Verify**:
- Agent speaks greeting
- `end_call` tool fires with reason
- Call terminated via Twilio REST API
- Transcript written to `~/.outreach/transcripts/`
- `call listen` returns `status: "ended"`

### TC-5: end_call on no progress
**Target**: Number that goes to voicemail or holds
**Objective**: "Speak to a human about scheduling"
**Verify**:
- Agent detects voicemail / hold music
- After multiple attempts, `end_call` fires
- Reason reflects inability to reach a human

### TC-6: Baseline — no IVR
**Target**: Personal phone number (pick up manually)
**Objective**: "Ask what day it is and hang up"
**Verify**:
- No `send_dtmf` calls (no IVR present)
- Normal conversation flow
- `end_call` fires after answer received

## How to run

```bash
outreach init

# TC-1: Basic DTMF
outreach call place \
  --to "+18004444444" \
  --objective "Press 1 when you hear the menu" \
  --persona "You are a caller navigating a phone menu" \
  --hangup-when "You have navigated past the first menu"

outreach call listen --id <id> --wait --timeout 60000
# repeat until ended

# Check transcript for send_dtmf tool calls in daemon logs
# Check ~/.outreach/transcripts/<id>.jsonl for full transcript

outreach teardown
```

## What to inspect

1. **Daemon stdout**: look for `[bridge] Tool call: send_dtmf` and `[bridge] Tool call: end_call` log lines
2. **Transcript JSONL**: verify `{speaker: "agent", text: "..."}` entries show IVR-appropriate responses
3. **Twilio call logs**: verify DTMF was actually sent (Twilio console > Calls > call SID > properties)
4. **Timing**: check `ts` gaps between IVR prompt and DTMF response — should be <2s

## Pass criteria

- `send_dtmf` fires within 3 seconds of hearing an IVR prompt
- Correct digits are sent (matches what the IVR menu asked for)
- `end_call` fires when objective is met or call is stuck
- No orphaned calls (all calls end cleanly)
- Transcripts are written for all calls
