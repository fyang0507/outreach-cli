---
name: outreach
description: Omnichannel outreach — calls, SMS, email, and calendar (Google Calendar). Campaign lifecycle, contact management, and cross-channel context via the outreach CLI.
---

Omnichannel outreach capability — voice calls (Twilio + Gemini Live), SMS (iMessage), email (Gmail), and calendar (Google Calendar) through a unified CLI. Covers both the tool (CLI commands for sending, monitoring, and querying) and the protocol (campaign lifecycle, contact management, outcome tracking, cross-channel context assembly).

**Channel-specific references** (load only the channel you need):
- [call.md](./call.md) — voice calls via Twilio + Gemini Live
- [sms.md](./sms.md) — SMS via iMessage
- [email.md](./email.md) — email via Gmail
- [calendar.md](./calendar.md) — calendar events via Google Calendar

## Prerequisites

Before any outreach, check system health and initialize the data repo:

```bash
outreach health        # validates data repo, shows readiness of all channels (call, sms, email, calendar)
```

`health` returns `data_repo.path` in its JSON output — use this as `$DATA_REPO` for all file operations below. It validates the data repo exists and is in sync with remote, and ensures the directory structure is created.

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
- Contacts are built up progressively — an initial identifier (phone, email, or both) first, then name/notes after the first interaction.
- Before creating a new contact, search existing contacts to avoid duplicates.

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
{"ts":"2026-04-06T10:15:00Z","contact_id":"c_a1b2c3","type":"attempt","channel":"call","result":"connected","call_id":"call_abc123"}
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

**Email `human_input` with `thread_id`**: When recording inbound email activity, include `thread_id` so `outreach context` can discover and fetch the thread. The agent finds the thread_id via `outreach email search`, confirms with the user, then records:
```json
{"ts":"2026-04-12T09:00:00Z","type":"human_input","contact_id":"c_a1b2c3","channel":"email","thread_id":"18f1a2b3c4d5e6f7","content":"Received reply confirming Thursday availability"}
```
The `context` command extracts `thread_id` from any event with `channel === "email"` — no filter on event type.

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

**System-written events** — the CLI also appends two event types you should not author or edit manually:
- `watch` — records the sundial schedule ID when a send registers a reply watcher.
- `callback_session` — records the agent session ID captured on a reply callback so the next callback resumes the same session. Tied to `watch.callback_agent` in `outreach.config.yaml`; changing that config invalidates stored sessions and the next callback starts fresh.

### Sync

Sync the data repo with git directly.

## Identifier model

All send commands (`call place`, `sms send`, `email send`) and calendar commands (`calendar add`, `calendar remove`) share a unified identifier pattern:

- **`--campaign-id`** + **`--contact-id`** are required on every send command. The CLI resolves the channel-appropriate address from the contact record.
- **`--to`** is an optional override for when the agent needs to reach a different address than what's on file.

All send commands auto-append an `attempt` entry to the campaign JSONL. You are responsible for writing `outcome`, `human_input`, `decision`, and `amendment` entries after reviewing transcripts or message threads.

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

Returns: `{ campaign: <header>, events: [...], recent_messages: { <contact_id>: { sms: [...], email_threads: [{ thread_id, subject, messages: [...] }, ...] } } }`

The command reads the campaign JSONL, optionally filters events by `--contact-id`, then for each included contact with SMS or email activity, fetches recent iMessage history and/or Gmail history. `--since` controls the SMS message history window (default 7 days) — it does not filter campaign events.

## Campaign lookup before creation

A campaign may span multiple agent sessions — retries, follow-ups, and post-decision changes all belong in the same campaign. Before creating a new campaign, always check for an existing one:

1. **Search** `$DATA_REPO/outreach/campaigns/` for campaigns with a related slug or objective (e.g., `ls` + `head -1` to read headers).
2. **If found**: present the match to the user — confirm it's the right campaign before appending to it.
3. **If not found**: confirm with the user that a new campaign should be created, agree on the name (`YYYY-MM-DD-<slug>`), then create the header line.

Never silently create a new campaign when an existing one might apply — the user should always confirm the campaign choice.

## Typical workflow

Every outreach task starts the same way: search for an existing campaign before deciding what to do. An agent prompted with "schedule a dentist visit for X" does not know whether a campaign already exists — it must check first.

### Step 1: Find or create a campaign

```
outreach health → search $DATA_REPO/outreach/campaigns/ for matching slug/objective
```

- **Found** → load it with `outreach context --campaign-id ...`, review events, resume where it left off.
- **Not found** → confirm with user that a new campaign should be created, create contacts + campaign header.

### Step 2: Gather context and execute outreach

```
outreach context --campaign-id ... [--contact-id ...] → decide channel and action → execute
```

Use `outreach context` to review campaign state and recent messages before deciding what to do. If context is insufficient, use channel-specific history commands (`call listen`, `sms history`, `email history`) for more detail. Then execute via the appropriate channel — see the channel-specific docs for command usage.

## Post-action workflow

After any outreach action (call, SMS, or email), the orchestrator is responsible for updating the campaign and contact records. The pattern is the same regardless of channel.

### 1. Record the outcome

Based on what happened, append an `outcome` entry to the campaign JSONL with your verdict:

- **Got useful info** (availability, pricing, confirmation) → verdict `viable` or `eliminated`
- **Incomplete info** (callback promised, follow-up needed) → verdict `pending`
- **Voicemail / no answer** (calls only) → verdict `pending` or `unreachable`

The `attempt` entry is already auto-logged by the CLI. You are writing the `outcome` — what was *learned*, not what was *tried*.

### 2. Update the contact record

If the interaction revealed new information about the contact (name, preferences, best times to reach, additional addresses), update the contact JSON.

### 3. Record human-relayed updates

Between sessions, the user may receive callbacks, emails, or have in-person conversations. When the user reports off-horizon information, record it as a `human_input` entry with the appropriate `channel` (`callback`, `email`, `text`, `in_person`, `research`, `other`). Then process it: if the input materially changes a contact's standing, append a follow-up `outcome` with your own verdict. This two-step pattern keeps provenance clear — a future session sees both the raw signal and the agent's judgment.

### 4. Record a decision

When the campaign objective is resolved, append a `decision` entry with `chosen` (contact ID), `reason`, and `resolution`. A decision does not close the campaign — if the user later cancels or changes plans, append an `amendment` entry (with `action`: `cancelled`, `rescheduled`, or `changed_provider`) and continue.

### 5. Create a calendar event (when applicable)

When a decision involves a scheduled appointment or meeting, create a calendar event:

```bash
outreach calendar add \
  --summary "Dental cleaning" \
  --start "2026-04-22T14:00:00" \
  --end "2026-04-22T15:00:00" \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

The `event_id` is recorded in the campaign JSONL attempt entry and used for subsequent modifications.

- **Rescheduling** (amendment with `action: "rescheduled"`): remove the old event, then add a new one with updated times. The old `event_id` is in the campaign attempt entry from the original `calendar add`.
- **Cancelling** (amendment with `action: "cancelled"`): remove the event using the stored `event_id`.

See [calendar.md](./calendar.md) for full command reference.

### 6. Sync the data repo

After all updates are written, sync the data repo with git.

## Feedback and improvement

Your primary role is executing outreach tasks. But you are also encouraged to surface feedback on the CLI itself — rough edges, missing capabilities, confusing behavior, or workflow friction you encounter while working. You are the primary user of this tool; your observations drive its improvement.

### What to report

- **Bugs**: commands that error unexpectedly, incorrect output, silent failures
- **Friction**: workflows that take too many steps, flags that should have defaults, missing convenience commands
- **Missing features**: capabilities you wished existed while executing a task
- **Unclear behavior**: error messages that don't help, output that's hard to parse, ambiguous flag semantics

### How to report

Append feedback entries to `$DATA_REPO/outreach/cli-feedback.jsonl` (one JSON object per line, append-only):

```json
{"ts":"2026-04-13T15:30:00Z","category":"friction","command":"outreach context","description":"No way to filter context by channel — had to read full output and ignore irrelevant SMS data when only email mattered","suggestion":"Add --channel flag to context command"}
```

**Fields:**
- `ts` — ISO 8601 timestamp
- `category` — one of: `bug`, `friction`, `missing_feature`, `unclear_behavior`
- `command` — the CLI command involved (if applicable)
- `description` — what happened and why it was a problem
- `suggestion` — optional, your proposed improvement

### When to report

Don't interrupt your workflow to write feedback. Append entries after completing a task or at the end of a session when you have a natural pause. If you notice something minor, a one-liner is fine — not every entry needs a detailed suggestion.

## Output format

All commands output JSON. Errors: `{ "error": "<code>", "message": "<details>" }`. Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.
