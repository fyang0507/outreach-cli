---
name: outreach-cli
description: Outreach CLI for calls, SMS, and email
---

Tool for making phone calls, sending SMS (iMessage), and sending email (Gmail) on behalf of a user. The voice agent (Gemini Live) handles calls autonomously — you provide the objective and persona, then monitor via transcript. SMS is stateless fire-and-forget. The `context` command assembles cross-channel briefings from campaign data + recent messages.

## Prerequisites

Before any outreach, check system health and initialize the data repo:

```bash
outreach health        # validates data repo, shows readiness of all channels (call, sms, email)
```

`health` returns `data_repo.path` in its JSON output — use this as `$DATA_REPO` for all file operations below. It validates the data repo exists and is in sync with remote, and ensures the directory structure is created.

Before placing calls, the call channel must be initialized:

```bash
outreach call init     # starts tunnel + daemon (required once per session)
```

When done with calls:

```bash
outreach call teardown # stop daemon + tunnel, clean up
```

Note: `call teardown` stops call infrastructure only. You may still need to process transcripts and update campaign outcomes afterward — do that before syncing the data repo.

## Data repo

Outreach data (contacts, campaigns, transcripts) lives in an external git repo, not managed by this CLI. `outreach init` creates these directories automatically.

```
<data-repo>/outreach/
  contacts/        # one JSON file per contact (mutable)
  campaigns/       # one JSONL file per campaign (append-only)
  transcripts/     # call transcripts (JSONL, auto-saved by CLI)
```

You manage these files directly with standard tools (`jq`, `grep`, `cat`, `echo`). The CLI does not wrap file I/O.

### Contacts

One JSON file per contact in `outreach/contacts/`. Mutable — overwritten in place as you learn more.

**Schema:**
```json
{
  "id": "c_a1b2c3",
  "phone": "+15551234567",
  "sms_phone": "+15559876543",
  "email": null,
  "name": "Dr. Smith's Office",
  "tags": ["dentist", "downtown"],
  "notes": "Front desk prefers morning calls",
  "created": "2026-04-06T10:00:00Z",
  "updated": "2026-04-06T14:30:00Z"
}
```

- **ID convention**: `c_` prefix + random hex (e.g., `c_a1b2c3`). Use this as the filename.
- **`phone`**: primary phone number, used for calls.
- **`sms_phone`**: optional SMS-specific phone number. When present, SMS commands use it instead of `phone`. Use this when a contact has a landline for calls and a mobile for texts.
- **`email`**: email address for sending. Used as send target for new threads; `null` when unknown.
- Contacts are built up progressively — phone number first, then name/notes after a call.
- Before creating a new contact, grep by phone to avoid duplicates.

### Campaigns

One JSONL file per campaign in `outreach/campaigns/`. Strictly append-only — never edit existing lines.

**Naming convention**: `YYYY-MM-DD-<slug>` — date is campaign creation date, slug is a short kebab-case description. Examples: `2026-04-15-dental-cleaning`, `2026-04-20-hood-cleaning-quote`. The date prefix makes it easy to see campaign lifespan and avoids logging to the wrong file.

**Line 1 — campaign header:**
```json
{
  "campaign_id": "2026-04-15-dental-cleaning",
  "created": "2026-04-15T10:00:00Z",
  "objective": "Schedule dental cleaning, ideally before end of April",
  "contacts": ["c_a1b2c3", "c_d4e5f6"],
  "status": "active"
}
```

**Lines 2+ — append-only event log** with five entry types:

**`attempt`** — procedural record of an outreach effort:
```json
{"ts":"2026-04-06T10:15:00Z","contact_id":"c_a1b2c3","type":"attempt","channel":"call","result":"no_answer","call_id":"call_abc123"}
```
Call `result` values: `connected`, `no_answer`, `busy`, `voicemail`, `failed`

**`outcome`** — what was learned + orchestrator's judgment:
```json
{"ts":"2026-04-06T11:05:00Z","contact_id":"c_d4e5f6","type":"outcome","outcome":"Available Apr 22 2pm, $180 cleaning","verdict":"viable","note":"Good availability and pricing"}
```
`verdict` values:
- `viable` — contact can fulfill the objective
- `eliminated` — contact cannot (no availability, wrong service, declined)
- `pending` — more info needed (follow-up required, callback expected)
- `unreachable` — no conversation happened (voicemail, no answer after retries)

**`human_input`** — information from outside the agent's observation horizon:
```json
{"ts":"2026-04-07T14:00:00Z","type":"human_input","contact_id":"c_g7h8i9","channel":"callback","content":"Vendor called back, quoted $350 for hood cleaning, available next Thursday","context":"Vendor seemed flexible on scheduling"}
```
`channel` values: `callback`, `email`, `text`, `in_person`, `research`, `other`

The human provides raw information; the agent processes it. `contact_id` is optional (some inputs are campaign-level, e.g. "my schedule changed"). `context` is optional — human's interpretation or color beyond the facts. There is no `verdict` — the agent should ingest the `human_input` and produce a follow-up `outcome` with its own judgment if the input materially changes a contact's standing.

**`decision`** — campaign-level resolution:
```json
{"ts":"2026-04-06T12:00:00Z","type":"decision","chosen":"c_d4e5f6","reason":"Best price and availability","resolution":"Booked Apr 22 2pm with Dr. Smith, $180"}
```

A `decision` is **not necessarily the final entry**. The user may cancel, reschedule, or change their mind after a decision is recorded. Use `amendment` entries for post-decision changes:

**`amendment`** — modifies a prior decision:
```json
{"ts":"2026-04-10T09:00:00Z","type":"amendment","action":"cancelled","reason":"Schedule conflict, need to rebook","note":"User asked to cancel Apr 22 appointment"}
```
`action` values: `cancelled`, `rescheduled`, `changed_provider`

After an amendment, the campaign is effectively active again — further `attempt`, `outcome`, and `decision` entries may follow. The latest `decision` (if not amended) reflects the current state.

Note: all send commands (`call place`, `sms send`, `email send`) require `--campaign-id` and `--contact-id`, and auto-append the `attempt` entry to the campaign JSONL. Email attempts also include `message_id` and `thread_id`. You are responsible for writing `outcome`, `human_input`, `decision`, and `amendment` entries after reviewing transcripts or message threads.

### Sync

Sync the data repo with git directly.

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

## Pre-call information gathering

Before placing a call, ask the user for information the voice agent will need to complete the objective. The agent cannot ask the user mid-call, so anything it doesn't know will either be left blank or cause the call to fail.

**Scheduling calls** (dentist, haircut, doctor, etc.):
- User's availability — specific dates/times or a range ("this week, mornings only")
- Any preferences (specific provider, location, service type)

**Medical/insurance-related calls**:
- Insurance provider and member ID
- Whether open to out-of-network providers
- Patient name and date of birth if required

**Service inquiries** (quotes, repairs, etc.):
- Relevant details about the item/property (make, model, address, dimensions)
- Budget range if applicable

Embed gathered information into `--objective` so the voice agent can use it during the call. Don't place the call until you have enough context for the agent to succeed.

## Placing a call

```bash
outreach call place \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3" \
  --objective "Schedule a haircut appointment. Available Thursday or Friday afternoon after 2pm." \
  --persona "Be conversational and flexible on timing" \
  --hangup-when "The appointment is confirmed or they say no availability"
```

**Required**: `--campaign-id`, `--contact-id`
**Recommended**: `--objective`, `--persona`, `--hangup-when`
**Optional**: `--to <number>` — override the phone number resolved from the contact record. `--max-duration <seconds>` — override the default 300s max call duration.

The destination phone number is resolved from the contact's `phone` field. Pass `--to` only to override (e.g., try a different number than what's on file).

Returns JSON: `{ "id": "<callId>", "status": "ringing" }`

The voice agent handles the entire call — IVR navigation, conversation, and hangup — based on the objective and persona you provide. You do not need to send messages during the call.

## Monitoring a call

`listen` is the primary monitoring command. It returns the call's current status and any new transcript entries since your last listen. Transcripts are batched at the turn level.

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

When you want to monitor the call continuously, call `listen` in a loop until `status` is `"ended"`. Each call returns only new entries since the last listen, so you build up the full conversation incrementally without duplicates.
However, if you only want to read transcript after the call ends, `call status` is available for lightweight metadata checks (call status, duration, from/to).

The voice agent is fire-and-forget: once `call place` is issued, there is no way to inject new instructions during the call. You are monitoring, not steering. To force-end a call early: `outreach call hangup --id <callId>`.

## Concurrent calls

The daemon supports multiple simultaneous calls. Each `call place` creates an independent session with its own call ID, transcript buffer, and lifecycle. You can place, monitor, and hang up calls independently.

## Campaign lookup before creation

A campaign may span multiple agent sessions — retries, follow-ups, and post-decision changes all belong in the same campaign. Before creating a new campaign, always check for an existing one:

1. **Search** `$DATA_REPO/outreach/campaigns/` for campaigns with a related slug or objective (e.g., `ls` + `head -1` to read headers).
2. **If found**: present the match to the user — confirm it's the right campaign before appending to it.
3. **If not found**: confirm with the user that a new campaign should be created, agree on the name (`YYYY-MM-DD-<slug>`), then create the header line.

Never silently create a new campaign when an existing one might apply — the user should always confirm the campaign choice.

## Sending an SMS

```bash
outreach sms send \
  --body "Hi, following up on our conversation about scheduling." \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

**Required**: `--body`, `--campaign-id`, `--contact-id`
**Optional**: `--to <number>` — override the phone number resolved from the contact record.

The destination phone is resolved from the contact's `sms_phone` field (falling back to `phone`). Pass `--to` only to override. The CLI sends via iMessage (AppleScript), then auto-appends an `attempt` entry with `channel: "sms"` to the campaign JSONL.

Returns: `{ "to": "+15551234567", "status": "sent" }`

## Reading SMS history

```bash
# By contact — resolves phone from contact record (sms_phone ?? phone)
outreach sms history --contact-id "c_a1b2c3" --limit 20

# By raw phone number
outreach sms history --phone "+15551234567" --limit 20
```

One of `--contact-id` or `--phone` is required. Returns the most recent messages from the iMessage thread for that phone number, including attachments (as MIME types) and tapback reactions. Empty thread returns `{ phone, messages: [] }`.

## Sending an email

```bash
outreach email send \
  --subject "Following up on our conversation" \
  --body "Hi, I wanted to follow up on scheduling." \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

**Required**: `--subject`, `--body`, `--campaign-id`, `--contact-id`
**Optional**: `--to <address>` — override the email address resolved from the contact record. `--cc <addresses>`, `--bcc <addresses>`, `--reply-to-id <gmail-message-id>` (enables threading), `--no-reply-all` (reply to sender only; default is reply-all when replying), `--attach <path...>` (file attachments)

The destination email is resolved from the contact's `email` field. Pass `--to` only to override.

The CLI sends via Gmail API (OAuth2), then auto-appends an `attempt` entry with `channel: "email"`, `message_id`, and `thread_id` to the campaign JSONL.

Returns: `{ "to": "...", "subject": "...", "message_id": "...", "thread_id": "...", "status": "sent" }`

**Replying to a thread**: pass `--reply-to-id` with the Gmail message ID from a previous send or history lookup. The CLI auto-resolves threading headers (`In-Reply-To`, `References`), sets `Re:` subject prefix, and reply-all recipients (original sender → To, original To+Cc minus self → Cc). Use `--no-reply-all` to reply to sender only. Explicit `--to`/`--cc` override auto-resolved recipients.

**First-time auth**: if no Gmail token exists in the data repo (`<data_repo_path>/outreach/gmail-token.json`), the CLI triggers an interactive OAuth flow — opens the browser, spins up a local callback server on port 8089, and exchanges the code for tokens. Subsequent runs reuse the stored token (auto-refreshed). The token syncs across machines via git along with the rest of the data repo.

## Reading email history

```bash
# By contact — resolves email from contact record
outreach email history --contact-id "c_a1b2c3" --limit 20

# By email address — metadata only (from, to, subject, date, snippet)
outreach email history --address "recipient@example.com" --limit 20

# By thread ID — full messages with body text
outreach email history --thread-id "18f1a2b3c4d5e6f7"
```

One of `--contact-id`, `--address`, or `--thread-id` is required. Contact and address modes return recent messages involving that email address (chronological order, metadata only). Thread mode returns the full thread with message bodies.

## Assembling context

`outreach context` builds a JIT briefing from campaign data + recent channel messages. Use it before placing a call or sending an SMS to understand the full picture.

```bash
# Full campaign overview — all contacts, all events
outreach context --campaign-id "2026-04-15-dental-cleaning"

# Focused on one contact — filtered events + recent messages
outreach context --campaign-id "2026-04-15-dental-cleaning" --contact-id "c_a1b2c3"

# Wider message window (default is 7 days)
outreach context --campaign-id "2026-04-15-dental-cleaning" --contact-id "c_a1b2c3" --since 30
```

Returns: `{ campaign: <header>, events: [...], recent_messages: { <contact_id>: { sms: [...], email: [...] } } }`

The command reads the campaign JSONL, optionally filters events by `--contact-id`, then for each included contact with SMS or email activity, fetches recent iMessage history and/or Gmail history. `--since` controls the SMS message history window (default 7 days) — it does not filter campaign events.

## Typical workflow

Every outreach task starts the same way: search for an existing campaign before deciding what to do. An agent prompted with "schedule a dentist visit for X" does not know whether a campaign already exists — it must check first.

### Step 1: Find or create a campaign

```
outreach health → search $DATA_REPO/outreach/campaigns/ for matching slug/objective
```

- **Found** → load it with `outreach context --campaign-id ...`, review events, resume where it left off.
- **Not found** → confirm with user that a new campaign should be created, create contacts + campaign header.

### Step 2: Execute outreach

With a campaign in hand, decide the next action based on context — place a call, send an SMS, or wait for a callback.

```
outreach context --campaign-id ... [--contact-id ...] → decide channel → outreach {call place,sms send,email send} --contact-id ... --campaign-id ... → post-action workflow
```

### Single call (detailed walkthrough)

```
# --- sync data repo ---
cd $DATA_REPO && git pull

# --- health check + data repo setup ---
outreach health

# --- campaign lookup / setup (direct file I/O) ---
# search for existing campaign; if none found, create contacts + campaign JSONL header

# --- call channel init ---
outreach call init

# --- outreach ---
outreach call place --campaign-id "2026-04-15-dental-cleaning" --contact-id "c_a1b2c3" --objective "..." --persona "..." --hangup-when "..."
outreach call listen/status --id <id> # monitor call or check status

# --- post-call (direct file I/O) ---
# read transcript, extract outcome, append outcome to campaign JSONL
# repeat for remaining contacts

# --- cleanup ---
outreach call teardown

# --- sync data repo ---
cd $DATA_REPO && git add -A && git commit -m "campaign update" && git push
```

## Output format

All commands output JSON. Errors: `{ "error": "<code>", "message": "<details>" }`. Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.

## Post-call workflow

After a call ends, the voice agent is done — the orchestrator is responsible for reviewing the transcript, updating the campaign, and updating contact records. Steps 1-3 happen after every call. Steps 4-6 happen as the campaign progresses.

### 1. Review the transcript

Read the transcript via `outreach call listen --id <callId>` or directly from `$DATA_REPO/outreach/transcripts/<callId>.jsonl`. Note: the CLI reports `status: "ended"` for both live conversations and voicemail — distinguish them by reviewing the transcript content.

### 2. Record the outcome

Based on what happened in the call, append an `outcome` entry to the campaign JSONL with your verdict:

- **Connected, got useful info** (availability, pricing, etc.) → `outcome` with verdict `viable` or `eliminated`
- **Connected, incomplete info** (callback promised, need to follow up) → `outcome` with verdict `pending`
- **Voicemail left** → `outcome` with verdict `pending`, consider retrying during business hours
- **No answer, no voicemail** → `outcome` with verdict `unreachable`, retry later

If `--campaign` was passed to `call place`, the `attempt` entry is already auto-logged. You are writing the `outcome` — what was *learned*, not what was *tried*.

### 3. Update the contact record

If the call revealed new information about the contact (name of person spoken to, preferences, best times to call), update the contact JSON in `$DATA_REPO/outreach/contacts/`.

### 4. Record human-relayed updates

Between sessions, the user may receive callbacks, emails, or have in-person conversations. When the user reports off-horizon information, record it as a `human_input` entry with the appropriate `channel` (`callback`, `email`, `text`, `in_person`, `research`, `other`). Then process it: if the input materially changes a contact's standing, append a follow-up `outcome` with your own verdict. This two-step pattern keeps provenance clear — a future session sees both the raw signal and the agent's judgment.

### 5. Record a decision

When the campaign objective is resolved, append a `decision` entry with `chosen` (contact ID), `reason`, and `resolution`. A decision does not close the campaign — if the user later cancels or changes plans, append an `amendment` entry (with `action`: `cancelled`, `rescheduled`, or `changed_provider`) and continue.

### 6. Sync the data repo

After all updates are written, sync the data repo with git.

## Post-SMS / post-email workflow

Unlike phone calls, SMS and email are asynchronous — the send and the reply happen in different agent sessions.

**Send session**: `sms send` fires the message and auto-logs the `attempt`. The session ends. There is no "wait for reply" step.

**Reply session**: A later invocation (triggered by the user noticing a reply) starts a new session. The typical flow:

1. **Read the reply** — `outreach sms history --contact-id <id>` or `outreach context --campaign-id ... --contact-id ...`
2. **Record the outcome** — if an outcome is reached, append an `outcome` entry.
3. **Update the contact record** — if the reply revealed new info.
4. **Decide next action** — follow-up SMS, escalate to a call, or record a `decision` if the objective is resolved.

This is different from the post-call workflow where attempt → transcript review → outcome all happen in one session.
