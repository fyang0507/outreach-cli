# Outreach CLI — Agent Skill Reference

Tool for making phone calls on behalf of a user. The voice agent (Gemini Live) handles the call autonomously — you provide the objective and persona, then monitor via transcript.

## Prerequisites

Before placing calls, the runtime must be initialized:

```bash
outreach init          # starts tunnel + daemon (required once per session)
outreach status        # verify everything is running
```

When done:

```bash
outreach teardown      # stop daemon + tunnel, clean up
```

## Placing a call

```bash
outreach call place \
  --to "+15551234567" \
  --objective "Schedule a haircut appointment for Thursday afternoon" \
  --persona "You are Alex's personal assistant" \
  --welcome-greeting "Hi, I'm calling to schedule an appointment" \
  --hangup-when "The appointment is confirmed or they say no availability"
```

**Required**: `--to`
**Recommended**: `--objective`, `--persona`, `--welcome-greeting`, `--hangup-when`

Returns JSON: `{ "id": "<callId>", "status": "ringing" }`

The voice agent handles the entire call — IVR navigation, conversation, and hangup — based on the objective and persona you provide. You do not need to send messages during the call.

## Monitoring a call

```bash
# Poll for new transcript entries (non-blocking)
outreach call listen --id <callId>

# Block until new speech is detected (up to timeout)
outreach call listen --id <callId> --wait --timeout 60000

# Check call state
outreach call status --id <callId>
```

`listen` returns JSON with `status` ("ringing" | "in_progress" | "ended") and `transcript` (array of `{speaker, text, ts}` entries since last listen).

## Ending a call early

```bash
outreach call hangup --id <callId>
```

The voice agent will also end the call automatically when `--hangup-when` condition is met.

## Typical workflow

```
outreach init
outreach call place --to "..." --objective "..." --persona "..." --welcome-greeting "..." --hangup-when "..."
# poll until call ends:
outreach call listen --id <id> --wait --timeout 120000
# (repeat listen if status != "ended")
outreach call listen --id <id> --wait --timeout 120000
outreach teardown
```

## Output format

All commands output JSON. Errors: `{ "error": "<code>", "message": "<details>" }`.

Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.

## Transcripts

Full call transcripts are saved to `~/.outreach/transcripts/<callId>.jsonl` after the call ends.
