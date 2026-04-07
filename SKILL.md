---
name: outreach-cli
description: Outreach CLI to make a phone call
---

Tool for making phone calls on behalf of a user (future extension to sms+email). The voice agent (Gemini Live) handles the call autonomously — you provide the objective and persona, then monitor via transcript.

## Prerequisites

Before placing calls, the runtime must be initialized:

```bash
outreach init          # starts tunnel + daemon (required once per session)
outreach status        # verify everything is running
```

When done with calls:

```bash
outreach teardown      # stop daemon + tunnel, clean up
```

Note: `teardown` stops infrastructure only. You may still need to process transcripts and update campaign outcomes afterward — do that before syncing the data repo.

## Data repo

Outreach data (contacts, campaigns, sessions, transcripts) lives in an external git repo, not managed by this CLI. The repo path is configured in `outreach.config.yaml` under `data_repo_path`.

```
<data-repo>/outreach/
  contacts/        # one JSON file per contact (mutable)
  campaigns/       # one JSONL file per campaign (append-only)
  sessions/        # session event logs (JSONL)
  transcripts/     # call transcripts (JSONL)
```

You manage these files directly with standard tools (`jq`, `grep`, `cat`, `echo`). The CLI does not wrap file I/O — see [Memory layer design](docs/plan/memory-layer.md) for schemas.

### Contacts

One JSON file per contact. Create and update directly:

```bash
# Create a contact
echo '{"id":"c_a1b2c3","phone":"+15551234567","name":null,"email":null,"tags":[],"created":"2026-04-06T10:00:00Z","updated":"2026-04-06T10:00:00Z"}' > "$DATA_REPO/outreach/contacts/c_a1b2c3.json"

# Find a contact by phone
grep -rl "+15551234567" "$DATA_REPO/outreach/contacts/"
```

### Campaigns

One JSONL file per campaign. Line 1 is the header, lines 2+ are append-only events (`attempt`, `outcome`, `decision`):

```bash
# Create a campaign
echo '{"campaign_id":"dental-2026-04","created":"2026-04-06T10:00:00Z","objective":"Schedule dental cleaning","contacts":["c_a1b2c3"],"status":"active"}' > "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"

# Record an outcome (after reviewing transcript)
echo '{"ts":"2026-04-06T11:05:00Z","contact_id":"c_a1b2c3","type":"outcome","outcome":"Available Apr 22 2pm","verdict":"viable"}' >> "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"

# Query all outcomes in a campaign
jq 'select(.type=="outcome")' "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"
```

### Sync

Sync the data repo with git directly:

```bash
cd "$DATA_REPO" && git add -A && git commit -m "update" && git push
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

### Campaign integration

When placing a call as part of a campaign, pass `--campaign` to auto-log the attempt:

```bash
outreach call place \
  --to "+15551234567" \
  --campaign "dental-2026-04" \
  --objective "Schedule dental cleaning" \
  --persona "You are Fred's assistant" \
  --welcome-greeting "Hi, I'm calling to schedule a cleaning" \
  --hangup-when "Appointment confirmed or no availability"
```

This auto-appends an `attempt` entry to the campaign JSONL with the call ID, result, and timestamp. You are still responsible for writing the `outcome` entry after reviewing the transcript.

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

# --- campaign setup (direct file I/O) ---
# create contacts, create campaign JSONL header

# --- outreach ---
outreach call place --to "..." --campaign "dental-2026-04" --objective "..." --persona "..." --welcome-greeting "..." --hangup-when "..."
outreach call listen --id <id> --wait --timeout 120000
# (repeat listen if status != "ended")

# --- post-call (direct file I/O) ---
# read transcript, extract outcome, append outcome to campaign JSONL
# repeat for remaining contacts

# --- cleanup ---
outreach teardown

# --- sync data repo ---
cd $DATA_REPO && git add -A && git commit -m "campaign update" && git push
```

## Output format

All commands output JSON. Errors: `{ "error": "<code>", "message": "<details>" }`.

Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.

## Transcripts

Full call transcripts are saved to `~/.outreach/transcripts/<callId>.jsonl` after the call ends.
