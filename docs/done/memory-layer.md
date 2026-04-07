# Memory Layer Design (v2)

> **Scope note**: The memory layer (contacts, campaigns, sync) is implemented through plain file I/O and git — not as CLI commands. This doc remains here as a reference for the data schemas and design decisions, but implementation lives in the orchestrator agent harness, not in this CLI repo. The only CLI-side change is the `--campaign` flag on `call place` for auto-logging attempts.

## Problem

The orchestrator agent needs persistent, structured context across calls and sessions:
- Contact history: who was called, when, outcome, follow-up needed
- Campaign state: which contacts have been reached, what was learned, what decisions were made
- Cross-device access: data must be available from any machine the orchestrator runs on

Currently, session logs (`~/.outreach/sessions/`) and transcripts (`~/.outreach/transcripts/`) are raw append-only JSONL. The orchestrator has no structured way to query "what did I learn from calling Dr. Smith?" or "which vendors are still viable for this campaign?"

## Design decisions

### External data repo

Outreach data lives in a dedicated private git repo (`fred-agent-data`), not in `~/.outreach/`. Rationale:
- **Cross-device sync** via git push/pull — no custom sync protocol needed
- **Larger scope**: the data repo serves multiple agent data streams, not just outreach
- **Separation of concerns**: `outreach-cli` is the tool, `fred-agent-data` is the data

Directory structure:
```
fred-agent-data/
  outreach/
    contacts/        # one JSON file per contact (mutable)
    campaigns/       # one JSONL file per campaign (append-only)
    sessions/        # session event logs (JSONL, append-only)
    transcripts/     # call transcripts (JSONL, append-only)
```

### Sync mechanism

The orchestrator syncs the data repo directly via git (`git pull`/`git push`). No CLI wrapper needed — git operations are straightforward for an AI agent.

Key design constraint: `init`/`teardown` are infrastructure lifecycle, not data lifecycle. `teardown` stops the phone system but the orchestrator may still be processing transcripts and updating campaign outcomes afterward. Sync timing is the orchestrator's decision.

## Data model

### Contacts

**One JSON file per contact** in `outreach/contacts/`. Mutable — overwritten in place as the orchestrator learns more.

```
outreach/contacts/c_a1b2c3.json
```

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

Design notes:
- **Mutable by design**: contacts are created progressively — a phone number first, then a name after a call, then an email when SMS/email channels are added. JSON (not JSONL) supports in-place updates naturally.
- **Stable ID as filename**: `c_` prefix + random hex. Phone/email are lookup fields, not identifiers (a contact may gain multiple channels over time).
- **Lookup**: the orchestrator greps `contacts/` by phone or email to find existing contacts before creating duplicates. A separate index file can be added later if performance requires it.

### Campaigns

**One JSONL file per campaign** in `outreach/campaigns/`. Strictly append-only.

```
outreach/campaigns/dental-2026-04.jsonl
```

#### Line 1: Campaign header

```json
{
  "campaign_id": "dental-2026-04",
  "created": "2026-04-06T10:00:00Z",
  "objective": "Schedule dental cleaning, ideally before end of April",
  "contacts": ["c_a1b2c3", "c_d4e5f6", "c_g7h8i9"],
  "status": "active"
}
```

The header defines the campaign's objective and the intended reach list. `contacts` is the set of contacts the orchestrator plans to try.

#### Lines 2+: Append-only event log

Three entry types:

**`attempt`** — procedural record of an outreach effort. Schema varies by channel because failure modes are fundamentally different.

**Call attempt** (synchronous, real-time connection):
```json
{
  "ts": "2026-04-06T10:15:00Z",
  "contact_id": "c_a1b2c3",
  "type": "attempt",
  "channel": "call",
  "result": "no_answer",
  "call_id": "call_abc123"
}
```
`result` enum: `connected`, `no_answer`, `busy`, `voicemail`, `failed`

**SMS attempt** (asynchronous, fire-and-forget):
```json
{
  "ts": "2026-04-06T10:15:00Z",
  "contact_id": "c_a1b2c3",
  "type": "attempt",
  "channel": "sms",
  "result": "delivered",
  "message_id": "msg_abc123"
}
```
`result` enum: `delivered`, `undelivered`, `failed`

**Email attempt** (asynchronous, fire-and-forget):
```json
{
  "ts": "2026-04-06T10:15:00Z",
  "contact_id": "c_a1b2c3",
  "type": "attempt",
  "channel": "email",
  "result": "sent",
  "message_id": "email_abc123"
}
```
`result` enum: `sent`, `bounced`, `failed`

Attempts are recorded whether or not they produce an outcome. This captures the procedural reality — "we tried twice, nobody picked up" — which drives retry decisions. The `channel` field determines which `result` values are valid.

**`outcome`** — what was learned from a conversation and the orchestrator's judgment, in one entry.

```json
{
  "ts": "2026-04-06T11:00:00Z",
  "contact_id": "c_d4e5f6",
  "type": "outcome",
  "outcome": "Available Apr 22 2pm, $180 cleaning. Also offers whitening.",
  "verdict": "viable",
  "note": "Good availability and pricing"
}
```

`verdict` enum: `viable`, `eliminated`, `pending`, `unreachable`

Outcome and verdict are on the same logic chain — the orchestrator reads the transcript, extracts what was learned, and judges viability in one step. For `unreachable` verdicts (no conversation happened), `outcome` is null and the verdict summarizes the procedural failure.

**`decision`** — campaign-level resolution.

```json
{
  "ts": "2026-04-06T12:00:00Z",
  "type": "decision",
  "chosen": "c_g7h8i9",
  "reason": "Earliest availability and lowest cost",
  "resolution": "Booked Apr 25 10am with Dr. Park, $150"
}
```

Written by the orchestrator when it resolves the campaign. The CLI does not manage campaign lifecycle — when and how to close campaigns is orchestrator agent behavior, outside this repo's scope.

#### Full example

```jsonl
{"campaign_id":"dental-2026-04","created":"2026-04-06T10:00:00Z","objective":"Schedule dental cleaning, ideally before end of April","contacts":["c_a1b2c3","c_d4e5f6","c_g7h8i9"],"status":"active"}
{"ts":"2026-04-06T10:15:00Z","contact_id":"c_a1b2c3","type":"attempt","channel":"call","result":"no_answer","call_id":"call_abc123"}
{"ts":"2026-04-06T10:45:00Z","contact_id":"c_a1b2c3","type":"attempt","channel":"call","result":"no_answer","call_id":"call_abc456"}
{"ts":"2026-04-06T10:50:00Z","contact_id":"c_a1b2c3","type":"outcome","outcome":null,"verdict":"unreachable","note":"No answer after 2 call attempts"}
{"ts":"2026-04-06T11:00:00Z","contact_id":"c_d4e5f6","type":"attempt","channel":"call","result":"connected","call_id":"call_def789"}
{"ts":"2026-04-06T11:05:00Z","contact_id":"c_d4e5f6","type":"outcome","outcome":"No availability until June","verdict":"eliminated","note":"Too late for objective timeline"}
{"ts":"2026-04-06T11:15:00Z","contact_id":"c_g7h8i9","type":"attempt","channel":"call","result":"connected","call_id":"call_ghi012"}
{"ts":"2026-04-06T11:20:00Z","contact_id":"c_g7h8i9","type":"outcome","outcome":"Available Apr 25 10am, $150 cleaning","verdict":"viable"}
{"ts":"2026-04-06T12:00:00Z","type":"decision","chosen":"c_g7h8i9","reason":"Only reachable option with availability before end of April","resolution":"Booked Apr 25 10am with Dr. Park, $150"}
```

### Sessions and transcripts

Existing JSONL formats, relocated from `~/.outreach/` to `fred-agent-data/outreach/`. No schema changes — these are raw operational data that the orchestrator reads when extracting outcomes.

## CLI surface

### What the CLI wraps (infrastructure complexity)

- **`outreach call/sms/email`** — complex service integrations (Twilio, Gemini, ngrok). This is what the CLI exists for.
- **`outreach init/teardown/status`** — lifecycle management for the above services.
- ~~`outreach sync`~~ — removed. Git operations (`cd <data-repo> && git pull/push`) are straightforward for an AI agent. No infrastructure complexity to wrap.

### What the CLI does NOT wrap

Contacts, campaigns, and data sync are plain file and git operations. No CLI wrappers — the orchestrator agent manipulates them directly with standard tools (`jq`, `grep`, `git`).

### Auto-logging from `call place`

When `--campaign <id>` is provided, `call place` auto-appends an `attempt` entry to the campaign JSONL. This is tightly coupled to call infrastructure (the CLI knows the call_id, result, and timestamp) and worth automating.

```bash
outreach call place --to "+1555..." --campaign "dental-2026-04" --objective "..."
# → auto-appends: {"ts":"...","contact_id":"...","type":"attempt","channel":"call","result":"...","call_id":"call_xxx"}
```

## Resolved questions

- **Auto-logging from `call place`**: Yes. When a campaign ID is provided, `call place` auto-logs an `attempt` entry. Automate as much as possible.
- **Data repo path config**: In `outreach.config.yaml` (e.g., `data_repo_path: ~/Downloads/fred-agent-data`). Env vars are strictly for credentials.
- **Multichannel**: Same schema with a `channel` field on attempts and outcomes — not separate entry types.

## Scope boundary

This repo owns the **CLI tool and its data contract** — schemas, data repo structure, config, and the `--campaign` integration on `call place` for auto-logging attempts.

Everything else — when to write outcomes, when to close campaigns, how to search contacts, sync timing, retry logic — is **orchestrator agent behavior**. That belongs in the agent harness/prompt, not in this CLI.

## Deferred

- **Recurring goal templates**: reusable definitions for periodic campaigns (e.g., "dental cleaning every 6 months"). Not needed until the pattern is proven with manual campaigns.
- **Contact index file**: phone/email → contact ID lookup. Grep is sufficient at current scale; add an index if performance requires it.

## Priority

High — this is the foundation for the orchestrator to operate autonomously across multi-call campaigns.
