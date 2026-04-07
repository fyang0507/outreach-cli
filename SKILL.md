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

## Concurrent calls

The daemon supports multiple simultaneous calls. Each `call place` creates an independent session with its own call ID, transcript buffer, and lifecycle. You can place, monitor, and hang up calls independently.

```bash
# Place multiple calls
outreach call place --to "+15551111111" --objective "..." --persona "..."
# => { "id": "call_aaa", "status": "ringing" }

outreach call place --to "+15552222222" --objective "..." --persona "..."
# => { "id": "call_bbb", "status": "ringing" }

# Monitor each independently
outreach call listen --id call_aaa --wait --timeout 60000
outreach call listen --id call_bbb --wait --timeout 60000

# Check status / hangup individually
outreach call status --id call_aaa
outreach call hangup --id call_bbb
```

### Practical limits

- **Twilio**: Trial accounts allow 1 concurrent call. Paid accounts support multiple concurrent outbound calls per number, but carrier limits vary — spreading calls across multiple `--from` numbers is safer for high concurrency.
- **Gemini Live**: Each call opens one Gemini Live session. Google enforces per-API-key rate limits (requests per minute). For parallel calls, monitor for 429 errors.
- **ngrok**: Free tier allows 1 tunnel (sufficient — all calls share one tunnel). Connection limits depend on your plan.

## Typical workflow

### Single call

```
outreach init
outreach call place --to "..." --objective "..." --persona "..." --welcome-greeting "..." --hangup-when "..."
# poll until call ends:
outreach call listen --id <id> --wait --timeout 120000
# (repeat listen if status != "ended")
outreach call listen --id <id> --wait --timeout 120000
outreach teardown
```

### Parallel outreach

```
outreach init

# Place all calls
outreach call place --to "+15551111111" --objective "..." --persona "..." --welcome-greeting "..." --hangup-when "..."
outreach call place --to "+15552222222" --objective "..." --persona "..." --welcome-greeting "..." --hangup-when "..."

# Monitor in round-robin (non-blocking listen returns immediately if no new transcript)
outreach call listen --id call_aaa
outreach call listen --id call_bbb
# ... repeat until all calls show status "ended"

outreach teardown
```

## Output format

All commands output JSON. Errors: `{ "error": "<code>", "message": "<details>" }`.

Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.

## Transcripts

Full call transcripts are saved to `~/.outreach/transcripts/<callId>.jsonl` after the call ends.
