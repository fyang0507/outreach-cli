# Campaign management (full SOP)

Covers anything tied to a named outreach goal — campaign-coupled sends **and** record-only updates (logging replies, resolving outcomes, amending decisions) with no new send. Campaign state lives in JSONL files you read and write directly; the CLI does not wrap that I/O.

If your task is a genuinely one-off send with no follow-up, use [once.md](./once.md) instead.

Per-channel flag/output details: [call.md](./call.md), [sms.md](./sms.md), [email.md](./email.md), [calendar.md](./calendar.md).

## Prerequisites

See [SKILL.md § Prerequisites](./SKILL.md) for `outreach health`, data repo resolution, and daemon lifecycle (sundial + relay). Campaign work requires both daemons to be healthy — watchers and `ask-human` depend on them.

---

# Part 1 — Data schema

Outreach state lives in an external git repo; this CLI does not manage that repo's lifecycle. You read and write these files directly with standard tools (`jq`, `grep`, `cat`, plain appends); the CLI does not wrap file I/O.

```
$DATA_REPO/outreach/
  config.yaml            # app config (identity, voice, watch) — operator-managed, do not edit
  contacts/              # one JSON file per contact (mutable)
  campaigns/             # one JSONL file per campaign (append-only)
  transcripts/           # call transcripts (CLI-written)
```

(`cli-feedback.jsonl` also lives here — see Part 2.)

## Contacts

One JSON file per contact, filename is `<id>.json` (e.g. `c_a1b2c3.json`). Mutable — rewrite in place as you learn more.

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

- **`id`** — `c_` prefix + random hex (e.g. `c_a1b2c3`). Also the filename stem.
- **`phone`** — primary number, used for calls.
- **`sms_phone`** — optional SMS-specific number. When present, SMS uses it instead of `phone`.
- **`email`** — send target for new email threads; `null` when unknown.

Build contacts progressively — identifier first, then `name`, `tags`, `notes` after the first interaction. Search existing contacts before creating a new one to avoid duplicates.

## Campaigns

One JSONL file per campaign in `campaigns/`. **Strictly append-only — never edit existing lines.**

**Filename**: `YYYY-MM-DD-<slug>.jsonl`. The date is the campaign creation date; the slug is a short kebab-case description. Example: `2026-04-15-dental-cleaning.jsonl`. The date prefix makes lifespan obvious and avoids logging to the wrong file.

**Line 1 — campaign header:**
```json
{"type":"campaign_header","campaign_id":"2026-04-15-dental-cleaning","created":"2026-04-15T10:00:00Z","objective":"Schedule dental cleaning before end of April","contacts":["c_a1b2c3","c_d4e5f6"],"status":"active"}
```

The `status` field is informational only — this CLI never rewrites it. Infer effective campaign state from the latest un-amended `decision` / `amendment` entries, not from the header.

**Lines 2+ — events.** One JSON object per line.

| `type` | Author | Purpose |
|---|---|---|
| `attempt` | CLI (send commands) | Procedural record of a send |
| `outcome` | Agent | Judgment + extracted info after an attempt |
| `human_input` | Agent **or** external observer | Off-horizon info (callbacks, in-person, replies from another channel) |
| `human_question` | CLI (`ask-human`) | The agent's question to the operator |
| `decision` | Agent | Campaign objective resolved |
| `amendment` | Agent | Post-decision change (cancel, reschedule, swap) |
| `watch` | CLI (send commands) | Reply-watcher schedule registration |
| `callback_run` | CLI (callback dispatcher) | Record per dispatch when the watcher fires a session |

You write the four **Agent** rows (schemas below). CLI-authored rows are opaque — read their fields in `outreach context` output as needed, but never edit or hand-author them.

### `outcome`
```json
{"ts":"2026-04-06T11:05:00Z","contact_id":"c_d4e5f6","type":"outcome","outcome":"Available Apr 22 2pm, $180 cleaning","verdict":"viable","note":"Good availability and pricing"}
```
`verdict` enum:
- `viable` — contact can fulfill the objective
- `eliminated` — contact cannot (no availability, wrong service, declined)
- `pending` — more info needed (follow-up required, callback expected)
- `unreachable` — no conversation happened (voicemail, no answer after retries)

### `human_input`
Information from outside the agent's observation horizon.
```json
{"ts":"2026-04-07T14:00:00Z","type":"human_input","contact_id":"c_g7h8i9","channel":"callback","content":"Vendor called back, quoted $350, available next Thursday","context":"Vendor seemed flexible on scheduling"}
```
`channel` enum: `callback`, `email`, `text`, `in_person`, `research`, `other`.

- `contact_id` is optional (some inputs are campaign-level, e.g. "my schedule changed").
- `context` is optional — the human's color/interpretation beyond raw facts.
- There is no `verdict` on `human_input`. If the input materially changes a contact's standing, produce a follow-up `outcome` with your own judgment.

**External-observer entries.** A separate process may append `human_input` entries directly to the campaign JSONL when the operator replies via an external channel (independent of any agent session). These entries may carry the body under `text` instead of `content`, and may add an opaque `source` field identifying the external channel. Normalization rule: **always read `content ?? text`** — both forms carry the body. Treat `source` as an opaque string: its **presence** signals the entry came from outside, but specific values are passthrough — do not branch on them. Agent-authored and external-observer entries are otherwise consumed identically.

For inbound email specifically, include `thread_id` so `outreach context` can fetch the thread:
```json
{"ts":"2026-04-12T09:00:00Z","type":"human_input","contact_id":"c_a1b2c3","channel":"email","thread_id":"18f1a2b3c4d5e6f7","content":"Received reply confirming Thursday availability"}
```

### `decision`
Campaign-level resolution.
```json
{"ts":"2026-04-06T12:00:00Z","type":"decision","chosen":"c_d4e5f6","reason":"Best price and availability","resolution":"Booked Apr 22 2pm with Dr. Smith, $180"}
```
A `decision` is **not necessarily the final entry**. The operator may later cancel, reschedule, or change their mind — record those as `amendment`.

### `amendment`
Modifies a prior decision.
```json
{"ts":"2026-04-10T09:00:00Z","type":"amendment","action":"cancelled","reason":"Schedule conflict, need to rebook","note":"Operator asked to cancel Apr 22 appointment"}
```
`action` enum: `cancelled`, `rescheduled`, `changed_provider`.

After an amendment the campaign is effectively active again — more `attempt` / `outcome` / `decision` entries may follow. The latest un-amended `decision` reflects current state.

---

# Part 2 — CLI reference

All commands emit JSON on stdout. Errors: `{ "error": "<code>", "message": "<details>" }`. Exit codes: 0 success, 1 input error, 2 infra error, 3 operation failed, 4 timeout.

## Identifier model (send commands)

Every send command — `call place`, `sms send`, `email send`, `calendar add`, `calendar remove` — shares a unified identifier pattern:

- **`--campaign-id`** (required) — campaign JSONL to append to.
- **`--contact-id`** (required) — the person. The CLI resolves the channel-appropriate address: `phone` for calls, `sms_phone ?? phone` for SMS, `email` for email.
- **`--to`** (optional, `call place` / `sms send` / `email send` only) — override the resolved address.

Every send **auto-appends an `attempt`** to the campaign JSONL. You are responsible for the downstream `outcome`, `human_input` (when relaying off-horizon info), `decision`, and `amendment` events.

**Ad-hoc sends (`--once`)** — not a campaign use case; see [once.md](./once.md). Mutually exclusive with `--campaign-id` / `--contact-id` / `--fire-and-forget`. Do not use `--once` as a workaround for failing to find an existing campaign.

## Auto reply-watcher

`sms send` and `email send` register a background reply watcher by default. When an inbound reply arrives, the watcher spawns a follow-up agent session that can resume the prior session (context carries across replies). The CLI logs a `watch` event on registration and a `callback_run` event per dispatch.

- **`--fire-and-forget`** — skip watcher registration. Use whenever no further reply is expected. For example **Closing replies** — the final "thanks, all set" / "great, see you then" / confirmation after the conversation is already concluded. Without `--fire-and-forget`, the CLI registers a fresh watcher after the closer, and a future polite "you're welcome" from the contact will spuriously resume an agent session for a campaign that's effectively done.
- Watcher output-shape details are in the per-channel docs.

**Watcher lifecycle is managed by the CLI — treat it as opaque.** You do not inspect, list, or cancel watchers. Your only visible signals are (a) the `human_input` / inbound reply arriving and (b) a `callback_run` entry appearing when the watcher fires a session. Timeouts, polling intervals, and retry policy are CLI-configured. Do not try to infer liveness from the JSONL.

## `outreach health`

Validates the data repo (existence, git sync), ensures required directories exist, and reports readiness of every channel (call, SMS, email, calendar). Run first in any session. The JSON output includes `data_repo.path` — use that as `$DATA_REPO` for direct file reads. Resolve any failure in a channel you intend to use; failures in unused channels are tolerable.

## `outreach context`

Builds a just-in-time briefing from campaign events + recent channel messages.

```bash
# Full campaign — all contacts, all events
outreach context --campaign-id "2026-04-15-dental-cleaning"

# Focused on one contact
outreach context --campaign-id "..." --contact-id "c_a1b2c3"

# Wider message history window — value is in days (default 7)
outreach context --campaign-id "..." --contact-id "c_a1b2c3" --since 30
```

Returns `{ campaign, events, recent_messages }`. `recent_messages` is keyed by `contact_id` and may contain `sms` (iMessage history) and/or `email_threads` (`{ thread_id, subject, messages }[]`).

The command reads the campaign JSONL, optionally filters events by `--contact-id`, then — for each included contact with SMS or email activity in the events — fetches recent iMessage history and/or Gmail threads.

`--since <days>` is a unified window: it narrows campaign events, SMS history, and email threads to the last N days. Header is always returned in full, so campaign objective/contacts survive any window. For sub-day filtering (e.g. "last hour"), read the JSONL with `jq` — combine with the `content ?? text` normalization rule for `human_input`:

```bash
for f in "$DATA_REPO/outreach/campaigns/"*.jsonl; do
  jq -r --arg t "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
    'select(.type=="human_input" and .ts > $t) | "\(input_filename): \(.content // .text)"' "$f"
done
```

## `outreach whoami`

Pull user identity fields on demand when a reply needs them (sign-off name, signature, address, phone, etc.).

```bash
outreach whoami --list                             # discover available keys
outreach whoami --field first_name,email_signature # pull specific fields (comma-separated)， add --campaign-id to auto append audit record to JSONL
```

Pull only what the next reply actually uses. If a needed field isn't in `--list`, use `outreach ask-human` instead of guessing.

Only pass `--campaign-id` after confirming the campaign file already exists and begins with a `campaign_header`. Do not use `--campaign-id` during pre-campaign discovery or before creating the campaign header — the CLI will reject the audit append with `INPUT_ERROR` rather than create a stray headerless JSONL.

## `outreach ask-human`

Writes a `human_question` event, registers a background watcher that resumes your work when the operator answers, then exits.

```bash
outreach ask-human \
  --campaign-id "2026-04-15-dental-cleaning" \
  --question "Prioritize same-week availability or lowest price?" \
  [--contact-id "c_a1b2c3"] \
  [--context "Two viable options with tradeoffs"]
```

A future agent session resumes automatically when **either** (a) **any** new `human_input` lands on that campaign, **or** (b) the watcher's configured timeout elapses. The timeout duration is set in the operator's CLI config; from the agent's POV it is opaque — treat a `callback_run` entry firing as the signal a resume has occurred. The watcher does not pair replies with questions — any `human_input` fires the resume, including one unrelated to the pending question (e.g. an external-observer reply about a different contact). On resume, read the latest `human_question` plus all `human_input` entries since it, decide which (if any) answers the question, and act accordingly — the agent does the pairing.

Use `ask-human` only when a decision genuinely requires operator input — not for thoroughness. Ambiguity that can be resolved from campaign state and recent messages should be resolved from those instead.

## `cli-feedback.jsonl`

You (the agent) are the primary caller of this CLI; your observations drive its improvement. When you hit a rough edge, missing capability, confusing output, or workflow friction, append one JSON line to `$DATA_REPO/outreach/cli-feedback.jsonl`:

```json
{"ts":"2026-04-13T15:30:00Z","category":"friction","command":"outreach context","description":"No way to filter context by channel","suggestion":"Add --channel flag"}
```

- `category`: one of `bug`, `friction`, `missing_feature`, `unclear_behavior`.
- `command` and `suggestion` are optional.

Append at natural pauses (end of task or session), not mid-workflow. One-liners are fine.

---

# Part 3 — Workflow

A campaign may span many sessions — initial outreach, follow-up, post-decision changes. The algorithm below is what to run for any outreach prompt.

In this workflow, an **outreach action** means a send (`call place`, `sms send`, `email send`, `calendar add`). Appending `outcome`/`decision`/`amendment` is bookkeeping, not an action.

## 1. Orient and find the campaign

Run `outreach health` if you have not already. Then search `$DATA_REPO/outreach/campaigns/` for an existing campaign matching the operator's request (slug, objective, contacts). An agent prompted with "schedule a dentist visit for X" does not know whether a campaign already exists — it **must check first**.

**Canonical discovery pattern** (a future CLI subcommand may replace it; the workflow stays the same):

```bash
for f in "$DATA_REPO/outreach/campaigns/"*.jsonl; do
  head -n 1 "$f" | jq -c '{file: "'"$f"'", campaign_id, objective, contacts}'
done
```

- **Clean single match** → load it with `outreach context --campaign-id <id>` and proceed to step 2. The orchestrator's delegation IS the confirmation — do not block on a redundant dialog.
- **No match** → create a new campaign: agree on the name (`YYYY-MM-DD-<slug>`), then write the `campaign_header` line and any new contact files.
- **Multiple plausible matches, or a weak single match** (e.g. slug overlaps but `objective` doesn't fit) → surface candidates to the operator and ask which applies. Treat a weak single match as ambiguous — do not assume.

Never silently create a new campaign when an existing one might apply.

> **Important:** write the `campaign_header` line **before** running any campaign-scoped CLI command, including `outreach whoami --campaign-id`, `outreach ask-human`, and any send (`call place`, `sms send`, `email send`, `calendar add`, `calendar remove`). These commands append audit/event rows to the named campaign file; the CLI now refuses to append when the file is missing or its first line isn't a `campaign_header`, so an out-of-order call exits with `INPUT_ERROR` instead of producing a stray headerless JSONL. A valid campaign file must always start with `campaign_header`.

## 2. Assemble context

Use `outreach context` (optionally scoped to one contact) to review campaign state plus recent channel messages. Prefer `context` over per-channel history commands for campaign-aware work — fall back to `sms history` / `email history` / `call listen` only when you need raw data outside the campaign frame.

## 3. Execute

Pick a channel and run the appropriate send command (see per-channel docs for flags and output).

**Channel selection heuristic:**

- **If the contact has prior activity** — reply on the channel the contact last used (most recent `attempt` or inbound `human_input` for that contact). Escalate to a different channel only after two consecutive `no_answer` / `voicemail` / `failed` results on the current one.
- **If the contact has no prior `attempt`** — prioritize **email → SMS → call**. This ordering reflects agent capability, not contact preference: **the agent can only place outbound calls, not receive inbound ones**, so voice is the least recoverable channel if the first try misses (callbacks land on the operator's phone, not the agent). Email and SMS allow async replies that auto-watchers catch and resume a session on. Use voice only when email/SMS aren't available or the operator explicitly asks.
- **Override with judgment** when campaign state justifies it (e.g. time-sensitive and the contact has only a phone number).

The chosen channel is recorded implicitly via `attempt.channel`.

**Multi-contact selection.** When a campaign has multiple active contacts, advance the one with the most recent `viable` or `pending` `outcome`. Skip `eliminated` contacts. If tied, pick the one with the oldest un-followed-up `human_input` or `attempt`.

**Nothing outstanding.** If the ingested events show no outstanding work on a campaign (a standing un-amended `decision`, and no un-ingested `human_input` / unanswered `human_question`), report a no-op to the orchestrator — do not manufacture a confirmation or check-in send just to take an action.

## 4. Close the loop

After any send — and after any outside information arrives — update the JSONL and contact files:

1. **Outcome** — append an `outcome` with your verdict:
   - Useful info (availability, pricing, confirmation) → `viable` or `eliminated`.
   - Incomplete (callback promised, follow-up needed) → `pending`.
   - Voicemail / no answer → `pending` or `unreachable`.
2. **Contact record** — if you learned something new (name, preferences, alternate address), rewrite the contact JSON in place.
3. **Human-relayed info** — when the operator tells you something off-horizon (callback, in-person, forwarded email), append a `human_input` **and** a follow-up `outcome` if it changes a contact's standing. Keep provenance separate: the raw signal (`human_input`) from your judgment (`outcome`).
4. **Decision** — when the objective is resolved, append a `decision` (`chosen`, `reason`, `resolution`). A decision does not close the campaign.
5. **Calendar** — if the decision involves a scheduled event, run `outreach calendar add` (auto-logs an `attempt` with the `event_id`). For rescheduling (`amendment action: rescheduled`), use the stored `event_id` to `calendar remove`, then `calendar add` a new one. For cancellations (`amendment action: cancelled`), `calendar remove` with the stored `event_id`. See `calendar.md`.
6. **Amendment** — for post-decision changes, append an `amendment`. Further `attempt` / `outcome` / `decision` entries may follow.
7. **Closing reply** — when the next send is a sign-off / "thanks, all set" / acknowledgement after the conversation is already resolved (typically after a `decision` is recorded and you're just being polite), pass `--fire-and-forget` on the send. 

## 5. Before any new outreach action

Applies **whenever you enter an existing campaign**, regardless of entry reason (watcher fired, `ask-human` was answered, operator re-invoked you, etc.).

1. Read the campaign JSONL (or run `outreach context`).
2. Scan for new `human_input` entries since your anchor (rule below), plus any outstanding `human_question` entries without a matching answer.
3. Ingest them — write `outcome` / `decision` / `amendment` as appropriate — *then* decide on the next outreach action.

**Anchor rule** (defines "since your last action"):

- **Campaign has prior agent-authored events** → anchor is the `ts` of the latest agent-authored `outcome` / `decision` / `amendment` on this campaign (any prior agent session counts — events carry no author identity, so "you" means "any earlier agent run"). `attempt`, `watch`, `callback_run`, `human_question` are CLI-authored — skip them. Scan for `human_input` with `ts > anchor`.
- **No prior agent-authored events on this campaign** → no anchor. Scan the entire tail for `human_input` entries and treat any without a subsequent `outcome` / `decision` / `amendment` as un-ingested.

## 6. When stuck — ask-human

If campaign state and recent messages still don't give you enough to decide, run `outreach ask-human` (see Part 2 §`outreach ask-human`). Reserve it for genuine ambiguity.

## 7. Sync

After each batch of updates, sync the data repo with git directly. This CLI does not wrap git.
