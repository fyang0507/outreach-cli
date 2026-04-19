# Relay Integration — outreach side (#67)

Issue: #67
Status: Active. `docs/plan/relay.md` covers relay-core design; this doc captures the outreach-side execution.

## Context

Relay (github.com/fyang0507/relay) is built and documented — a standalone observability daemon that mirrors JSONL files to Telegram forum topics and writes human replies back into the same files. This closes #67: wire outreach's campaign JSONL into relay so a human operator can observe agent progress in Telegram and steer by replying.

The integration is deliberately thin because filesystem is the only contract — outreach does not import, depend on, or communicate with relay. All outreach does is:

1. Continue writing well-typed JSONL (already doing this — audit below).
2. Document async `human_input` arrivals so agents check for them on resume.
3. Ship a sample `relay.config.yaml` pre-tuned for outreach's type vocabulary.

Canonical integration guide lives in relay: https://github.com/fyang0507/relay/tree/master/skills/relay-integration.

## Design decisions

1. **`human_input` is a single unified type.** Agent-authored entries (agent recording what the live user told it) and relay-authored entries (Telegram replies) both use `type: "human_input"`. Relay's entries carry `source: "relay-inbound"` and use `text` instead of `content`, but the agent does not distinguish — it reads any `human_input` line identically and produces a follow-up `outcome` if the content changes a contact's standing. What matters is the agent scans for new `human_input` entries before starting any new follow-up action.

2. **Keep coarse type vocabulary.** Existing types (`attempt`, `outcome`, `decision`, `amendment`, `human_input`, `watch`, `callback_run`, plus the new `campaign_header`) stay. No rename to `sms.sent` / `call.placed`. Avoids breaking `findLatestOutboundAttempt` / `findLatestCallbackRun` filters and historical JSONL, and the observer-side tier policy works fine on coarse types.

3. **`outreach ask-human` is a follow-up feature, not in this issue.** A future CLI command plus a sundial watch that polls for new `human_input` entries and fires callback-dispatch on arrival will let agents explicitly ask a question and wait. Tracked separately after #67 lands.

## Audit — all write sites already carry `type`

| File | Types written |
|---|---|
| `src/commands/sms/send.ts:58,77` | `attempt`, `watch` |
| `src/commands/email/send.ts:82,103` | `attempt`, `watch` |
| `src/commands/calendar/add.ts:78` | `attempt` |
| `src/commands/calendar/remove.ts:41` | `attempt` |
| `src/commands/callbackDispatch.ts:198` | `callback_run` |
| `src/daemon/server.ts:196` | `attempt` |

Agent-authored types (`outcome`, `decision`, `amendment`, `human_input`, and the campaign header) are documented in `skills/outreach/SKILL.md`. Transcript events (call_placed, speech, etc.) live in `<data_repo>/outreach/transcripts/*.jsonl`, which relay does not watch.

## Deliverables

### A. `skills/outreach/SKILL.md` — three edits

- **campaign header** gains a `"type": "campaign_header"` field in the example (~line 70). Lines without a join-key field are silently skipped by relay, so adding this lets the header publish as the first message in a new forum topic, giving the Telegram observer campaign context. Backwards-compatible (readers ignore unknown fields).
- **`human_input` subsection** (~line 104) gets one paragraph acknowledging that some entries may be authored asynchronously by external observers, in differing shapes (`text` instead of `content`, or a `source` field), but are consumed identically.
- **"Step 1: Find or create a campaign"** (~line 181) extends the "Found" bullet with a requirement to scan the latest `human_input` entries before taking any new outreach action.

Framing stays producer-agnostic — the agent never learns the words "relay" or "Telegram". If more inbound sources arrive later, the guidance doesn't need updating.

### B. `relay.config.example.yaml` — new sample config at repo root

Pre-tuned for outreach's type vocabulary. Loop prevention uses `inbound_types: [human_input]`. Tier defaults:

- `silent`: `campaign_header`, `attempt`, `watch`, `callback_run`, `callback_session` (legacy, still in historical files) — procedural noise, reviewable but no phone buzz.
- `notify`: `outcome`, `decision`, `amendment`, `human_input` — judgment events the observer wants to see.

`human_input` at `notify` applies only to agent-authored entries (the relay-written ones are filtered upstream by `inbound_types`). Operator edits `<DATA_REPO_PATH>` and `<GROUP_ID>` placeholders per machine. Full setup per relay's integration SKILL.

### C. No source code changes

- `src/logs/sessionLog.ts` untouched. `appendCampaignEvent` does atomic O_APPEND; interleaves safely with relay appends.
- `findLatestOutboundAttempt` / `findLatestCallbackRun` filter on specific types; relay's `human_input` lines are invisible to them.
- `src/watch.ts`, sundial reply-check, all providers untouched. Relay runs alongside existing reply watchers — not a replacement.

## Explicit non-goals

- No rename of existing types (breaks historical JSONL, no observer-side benefit).
- No `outreach ask-human` command (follow-up feature).
- No relay imports, npm dep, or IPC in outreach.
- No `outreach.config.yaml` changes.
- No `relay health` proxy from `outreach health` (separate tools, separate boundaries).
- No schema validation for relay-written lines (`readCampaignEvents` tolerates shape variance).

## Verification

Four stages. Stage 1 runs locally without Telegram; 2–3 require a real bot.

**Stage 1 — local dry-run.** Point relay at a scratch dir with its stdout/dev provider. Create a test campaign (header with `type: "campaign_header"`), run `outreach sms send`. Observe relay stdout: header and `attempt` (silent) / `watch` (silent) lines are mirrored. Manually append `{"ts":"...","type":"human_input","text":"test","source":"relay-inbound"}` — verify relay does NOT re-emit (loop prevention). Run `outreach context --campaign-id ...`, confirm the `human_input` surfaces in the events array.

**Stage 2 — Telegram outbound.** Per relay's `skills/relay-integration/telegram-setup.md`: create bot, create forum supergroup, promote bot with "Manage Topics", resolve `chat_id`. Set `TELEGRAM_BOT_API_TOKEN` in relay's `.env`, run `relay init` once. Fill in `relay.config.example.yaml` placeholders, save as a real config. Run `relay add --config <abs>`, confirm with `relay list`. Create a new campaign → new topic appears, header shows silently. Run `outreach sms send` → `attempt` silent (no observer-phone buzz). Append `outcome` manually → notify tier pings.

**Stage 3 — Telegram inbound roundtrip.** From observer device, reply in the test topic with "confirmed for Thursday". Within seconds, verify a new line lands in the campaign JSONL with shape `{type: "human_input", ..., text, source: "relay-inbound"}`. Verify the line does NOT re-publish back to Telegram. Launch an agent session with a resume prompt ("check campaign X, take the next step"). Per SKILL Edit B the agent scans `human_input`, ingests the Telegram reply, writes a follow-up `outcome`. That `outcome` mirrors back to Telegram with notify tier. Loop closed.

**Stage 4 — restart & edge cases.** (a) Kill relay mid-stream, append 3 events, restart → either published or skipped to EOF; document whichever behavior relay ships. (b) Create a new campaign while relay is running in a populated directory → verify existing campaigns' history is NOT backfilled (mark-as-EOF default). (c) Delete a topic in Telegram, append an event — relay disables that source mapping per its reconciliation contract; outreach keeps writing unaffected. (d) 24h soak on a live campaign — no duplicates, no memory growth, no impact on outreach CLI latency.

## Follow-up work

- **`outreach ask-human` command + sundial watch on `human_input` arrivals.** Agent runs `outreach ask-human --campaign-id X --question "..."` which (a) appends `{type: "human_question", ...}` to the JSONL (notify tier → pings observer), (b) registers a sundial watch that polls the JSONL for new `human_input` entries and fires callback-dispatch on arrival. File as a separate issue once #67 lands.
- **Document relay's restart-resilience** (offset persistence behavior, duplicate-delivery window) in the operator checklist once verified.
