# Memory Layer Design

## Problem

The orchestrator agent needs persistent context across calls and sessions:
- Contact history: who was called, when, outcome, follow-up needed
- Campaign state: which contacts have been reached, which are pending
- User preferences: calling hours, preferred greeting style, recurring objectives
- Call outcomes: structured data extracted from transcripts (appointment confirmed, callback time, etc.)

Currently, session logs (`~/.outreach/sessions/`) and transcripts (`~/.outreach/transcripts/`) are raw append-only JSONL. The orchestrator has no structured way to query "did I already call this number?" or "what was the outcome of the last call to Dr. Smith's office?"

## Requirements

1. **Contact registry**: store contact info + call history per phone number
2. **Campaign tracking**: which contacts belong to which campaign, status per contact
3. **Outcome extraction**: structured data from call transcripts (not just raw text)
4. **Query interface**: CLI commands for the orchestrator to look up context before placing calls
5. **File-system native**: no database — JSONL or JSON files, readable by any agent

## Design options

### Option A: Flat file per contact

```
~/.outreach/contacts/
  +15551234567.json    # { name, numbers, history: [...], tags: [...] }
  +15559876543.json
```

- Simple, one file per phone number
- History array grows unbounded
- Hard to query across contacts ("all contacts in campaign X")

### Option B: Contact registry + campaign index

```
~/.outreach/
  contacts.jsonl          # one line per contact: { id, name, phone, tags }
  campaigns/
    hair-appt.jsonl       # one line per action: { contactId, callId, status, outcome, ts }
  transcripts/            # (existing) raw transcripts
  sessions/               # (existing) raw session logs
```

- Campaign files are the query surface — grep for contact, status, outcome
- Contacts file is a flat registry — dedup by phone number
- Outcome is a structured field written by orchestrator after reviewing transcript

### Option C: SQLite

- Powerful queries, but breaks "file-system native" principle
- Requires SQLite dependency
- Overkill for current scale

## Recommended: Option B

Reasons:
- Campaigns are the natural unit of work for the orchestrator
- JSONL is grep-friendly — agents can search without special tooling
- Contact registry prevents duplicate calls
- Outcome extraction is the orchestrator's job (it reads the transcript and writes the outcome)

## Proposed CLI commands

```bash
# Contact management
outreach contact add --phone "+1555..." --name "Dr. Smith" --tags "dentist,priority"
outreach contact list [--tag <tag>]
outreach contact get --phone "+1555..."

# Campaign management
outreach campaign create --id "dental-appts" --description "Schedule dental appointments"
outreach campaign add-contact --id "dental-appts" --phone "+1555..."
outreach campaign status --id "dental-appts"
outreach campaign update --id "dental-appts" --phone "+1555..." --status "completed" --outcome "Appointment confirmed for Thursday 2pm"
```

## Outcome extraction pattern

After a call, the orchestrator:
1. `outreach call listen --id <callId>` — gets full transcript
2. LLM analyzes transcript → extracts structured outcome
3. `outreach campaign update --id <campaign> --phone <number> --status completed --outcome "<structured summary>"`

This keeps outcome extraction in the orchestrator (where the LLM lives), not in the CLI.

## Open questions

- Should contacts store multiple phone numbers per person?
- Should campaigns support retry logic (max attempts, backoff)?
- Should the CLI auto-link calls to campaigns, or is that the orchestrator's job?
- Do we need a "do not call before" / scheduling constraint?

## Priority

Medium — the orchestrator can function without this (it can read raw transcripts), but it becomes essential once we're making more than a handful of calls per session.
