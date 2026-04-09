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

You manage these files directly with standard tools (`jq`, `grep`, `cat`, `echo`). The CLI does not wrap file I/O.

### Contacts

One JSON file per contact in `outreach/contacts/`. Mutable — overwritten in place as you learn more.

**Schema:**
```json
{
  "id": "c_a1b2c3",
  "phone": "+15551234567",
  "email": null,
  "name": "Dr. Smith's Office",
  "tags": ["dentist", "downtown"],
  "notes": "Front desk prefers morning calls",
  "created": "2026-04-06T10:00:00Z",
  "updated": "2026-04-06T14:30:00Z"
}
```

- **ID convention**: `c_` prefix + random hex (e.g., `c_a1b2c3`). Use this as the filename.
- Contacts are built up progressively — phone number first, then name/notes after a call.
- Before creating a new contact, grep by phone to avoid duplicates.

```bash
# Create a contact
echo '{"id":"c_a1b2c3","phone":"+15551234567","name":null,"email":null,"tags":[],"notes":null,"created":"2026-04-06T10:00:00Z","updated":"2026-04-06T10:00:00Z"}' > "$DATA_REPO/outreach/contacts/c_a1b2c3.json"

# Find a contact by phone
grep -rl "+15551234567" "$DATA_REPO/outreach/contacts/"

# Update a contact after learning new info
jq '.name = "Dr. Smith Office" | .notes = "Front desk prefers morning calls" | .updated = "2026-04-06T14:30:00Z"' \
  "$DATA_REPO/outreach/contacts/c_a1b2c3.json" > /tmp/c_a1b2c3.json && \
  mv /tmp/c_a1b2c3.json "$DATA_REPO/outreach/contacts/c_a1b2c3.json"
```

### Campaigns

One JSONL file per campaign in `outreach/campaigns/`. Strictly append-only — never edit existing lines.

**Line 1 — campaign header:**
```json
{
  "campaign_id": "dental-2026-04",
  "created": "2026-04-06T10:00:00Z",
  "objective": "Schedule dental cleaning, ideally before end of April",
  "contacts": ["c_a1b2c3", "c_d4e5f6"],
  "status": "active"
}
```

**Lines 2+ — append-only event log** with three entry types:

**`attempt`** — procedural record of an outreach effort:
```json
{"ts":"2026-04-06T10:15:00Z","contact_id":"c_a1b2c3","type":"attempt","channel":"call","result":"no_answer","call_id":"call_abc123"}
```
Call `result` values: `connected`, `no_answer`, `busy`, `voicemail`, `failed`

**`outcome`** — what was learned + orchestrator's judgment:
```json
{"ts":"2026-04-06T11:05:00Z","contact_id":"c_d4e5f6","type":"outcome","outcome":"Available Apr 22 2pm, $180 cleaning","verdict":"viable","note":"Good availability and pricing"}
```
`verdict` values: `viable`, `eliminated`, `pending`, `unreachable`

**`decision`** — campaign-level resolution:
```json
{"ts":"2026-04-06T12:00:00Z","type":"decision","chosen":"c_d4e5f6","reason":"Best price and availability","resolution":"Booked Apr 22 2pm with Dr. Smith, $180"}
```

```bash
# Create a campaign
echo '{"campaign_id":"dental-2026-04","created":"2026-04-06T10:00:00Z","objective":"Schedule dental cleaning","contacts":["c_a1b2c3"],"status":"active"}' > "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"

# Record an outcome (after reviewing transcript)
echo '{"ts":"2026-04-06T11:05:00Z","contact_id":"c_a1b2c3","type":"outcome","outcome":"Available Apr 22 2pm","verdict":"viable"}' >> "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"

# Query all outcomes in a campaign
jq 'select(.type=="outcome")' "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"
```

Note: when `--campaign` is passed to `call place`, the CLI auto-appends the `attempt` entry. You are responsible for writing `outcome` and `decision` entries after reviewing transcripts.

### Sync

Sync the data repo with git directly:

```bash
cd "$DATA_REPO" && git add -A && git commit -m "update" && git push
```

## Voice agent behavior layers

The voice agent's behavior is assembled from three independent layers. Each owns a distinct concern — do not duplicate or contradict across layers.

| Layer | What it controls | Set where | Changes per call? |
|---|---|---|---|
| Phone mechanics | IVR/DTMF navigation, call screening, `end_call` rules, partial info handling | Built-in (static prompt) | No |
| Identity | Who: user name, AI disclosure | `outreach.config.yaml` → `identity.user_name` | No |
| Persona | How: tone, formality, domain-specific behavior | `--persona` flag on `call place` | Yes |

**Phone mechanics** are built into the voice agent. It already knows how to navigate IVR menus, handle call screening, decide when to hang up, and accept partial information gracefully. You do not need to instruct the voice agent on any of these.

**Identity** is configured once in `outreach.config.yaml`. The voice agent always identifies itself as "[user_name]'s assistant" and never pretends to be human. You do not need to include identity information in `--persona`.

**Persona** is per-call behavioral guidance passed via `--persona`. Use it **only** for call-specific adjustments: "Be formal, this is a medical office" or "Speak in Spanish if the receptionist prefers." Do **not** include:
- Identity info (already handled by config — adding a different name will confuse the agent)
- Phone mechanics ("navigate the IVR", "hang up when done" — already built in)

If `--persona` is omitted, the default from `outreach.config.yaml` → `voice_agent.default_persona` is used.

## Placing a call

```bash
outreach call place \
  --to "+15551234567" \
  --objective "Schedule a haircut appointment for Thursday afternoon" \
  --persona "Be conversational and flexible on timing" \
  --hangup-when "The appointment is confirmed or they say no availability"
```

**Required**: `--to`
**Recommended**: `--objective`, `--persona`, `--hangup-when`
**Optional**: `--max-duration <seconds>` — override the default 300s max call duration. Use higher values for complex service inquiries where 5 minutes may not be enough.

Returns JSON: `{ "id": "<callId>", "status": "ringing" }`

The voice agent handles the entire call — IVR navigation, conversation, and hangup — based on the objective and persona you provide. You do not need to send messages during the call.

### Campaign integration

When placing a call as part of a campaign, pass `--campaign` to auto-log the attempt:

```bash
outreach call place \
  --to "+15551234567" \
  --campaign "dental-2026-04" \
  --objective "Schedule dental cleaning" \
  --persona "Be polite and concise" \
  --hangup-when "Appointment confirmed or no availability"
```

This auto-appends an `attempt` entry to the campaign JSONL with the call ID, result, and timestamp. You are still responsible for writing the `outcome` entry after reviewing the transcript.

## Monitoring a call

`listen` is the primary monitoring command. It returns the call's current status and any new transcript entries since your last listen. Transcripts are batched at the turn level — each entry is a complete utterance, not word-by-word fragments.

```bash
outreach call listen --id <callId>
```

Returns:
```json
{
  "id": "<callId>",
  "status": "ringing" | "in_progress" | "ended",
  "transcript": [{"speaker": "remote", "text": "...", "ts": 1234567890}],
  "silence_ms": 5000
}
```

Call `listen` in a loop until `status` is `"ended"`. Each call returns only new entries since the last listen, so you build up the full conversation incrementally without duplicates.

`call status` is available for lightweight metadata checks (duration, from/to) but `listen` is what you should use by default.

The voice agent is fire-and-forget: once `call place` is issued, there is no way to inject new instructions during the call. You are monitoring, not steering.

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

# Monitor each — call listen in round-robin until all show status "ended"
outreach call listen --id call_aaa
outreach call listen --id call_bbb

# Hangup individually if needed
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

# --- campaign setup (direct file I/O) ---
# create contacts, create campaign JSONL header

# --- outreach ---
outreach call place --to "..." --campaign "dental-2026-04" --objective "..." --persona "..." --hangup-when "..."
outreach call listen --id <id>
# (repeat listen if status != "ended")

# --- post-call (direct file I/O) ---
# read transcript, extract outcome, append outcome to campaign JSONL
# repeat for remaining contacts

# --- cleanup ---
outreach teardown

# --- sync data repo ---
cd $DATA_REPO && git add -A && git commit -m "campaign update" && git push
```

### Parallel outreach

```
outreach init

# Place all calls
outreach call place --to "+15551111111" --objective "..." --persona "..." --hangup-when "..."
outreach call place --to "+15552222222" --objective "..." --persona "..." --hangup-when "..."

# Monitor in round-robin until all show status "ended"
outreach call listen --id call_aaa
outreach call listen --id call_bbb

outreach teardown
```

## Output format

All commands output JSON. Errors: `{ "error": "<code>", "message": "<details>" }`.

Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.

## Post-call workflow

After a call ends, the orchestrator is responsible for reviewing the transcript, extracting what was learned, and updating the campaign record. This is not automated — the voice agent only handles the live conversation.

### 1. Review the transcript

```bash
# Get final transcript via CLI
outreach call listen --id <callId>

# Or read the saved file directly
cat ~/.outreach/transcripts/<callId>.jsonl
```

### 2. Record the outcome in the campaign

After reviewing the transcript, append an `outcome` entry to the campaign JSONL:

```bash
# What was learned + orchestrator's judgment
echo '{"ts":"2026-04-06T11:05:00Z","contact_id":"c_a1b2c3","type":"outcome","outcome":"Available Apr 22 2pm, $180 cleaning","verdict":"viable","note":"Good availability, needs photos texted first"}' >> "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"
```

Verdict values: `viable`, `eliminated`, `pending`, `unreachable`
- **viable**: contact can fulfill the objective
- **eliminated**: contact cannot (no availability, wrong service, declined)
- **pending**: more info needed (follow-up required, callback expected)
- **unreachable**: no conversation happened (voicemail, no answer after retries)

### 3. Update the contact record

If you learned new information about the contact (name, preferences, notes):

```bash
# Read, update, and write back
jq '.name = "NY NJ Hoods" | .notes = "Prefers text for photos, (973) 440-8054" | .updated = "2026-04-06T11:10:00Z"' \
  "$DATA_REPO/outreach/contacts/c_a1b2c3.json" > /tmp/c_a1b2c3.json && \
  mv /tmp/c_a1b2c3.json "$DATA_REPO/outreach/contacts/c_a1b2c3.json"
```

### 4. Record human-relayed updates

When the user reports a callback or offline interaction, record it as an outcome:

```bash
# User says: "NY NJ Hoods called back, they quoted $350 for cleaning"
echo '{"ts":"2026-04-07T14:00:00Z","contact_id":"c_g7h8i9","type":"outcome","outcome":"Quoted $350 for hood cleaning, available next Thursday","verdict":"viable","note":"Human-relayed callback"}' >> "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"
```

### 5. Close the campaign

When the objective is resolved, append a `decision` entry:

```bash
echo '{"ts":"2026-04-07T15:00:00Z","type":"decision","chosen":"c_g7h8i9","reason":"Best price and availability","resolution":"Booked Thu Apr 15 10:30am, $350 cleaning"}' >> "$DATA_REPO/outreach/campaigns/dental-2026-04.jsonl"
```

### 6. Sync the data repo

After all post-call processing is complete:

```bash
cd "$DATA_REPO" && git add -A && git commit -m "campaign update" && git push
```

## Voicemail and retry logic

The voice agent will leave a voicemail if it reaches an answering machine. The CLI reports `status: "ended"` for both live conversations and voicemail — distinguish them by reviewing the transcript content.

For retry decisions:
- If the transcript shows a voicemail greeting + message left → record as `attempt` with `result: "voicemail"`, consider retrying during business hours
- If no answer → record as `attempt` with `result: "no_answer"`, retry later
- If connected and conversation happened → record outcome based on content

## Transcripts

Full call transcripts are saved to `~/.outreach/transcripts/<callId>.jsonl` after the call ends.
