# Outreach CLI

Agent-native CLI for real-world outreach — calls, SMS, email, calendar. The CLI is a tool for AI agents, not humans. An orchestrator agent delegates tasks to sub-agents, each using this CLI to make calls, send messages, or send emails.

## Quick start

```bash
npm install
npm run build          # compiles TS + syncs skills/ → <data_repo>/.agents/skills/
node dist/cli.js --help
```

## Architecture

Four channel providers behind a unified CLI:

```
                              ┌─ Daemon ─ Twilio Media Streams ↔ Audio Bridge ↔ Gemini Live API
Orchestrator Agent → CLI  ────┼─ iMessage provider (AppleScript + Messages DB)
                              ├─ Gmail provider (OAuth2 + Gmail API)
                              ├─ Google Calendar provider (OAuth2 + Calendar API)
                              └─ Data I/O (campaigns, contacts, transcripts)
```

**Shared:**
- **CLI** (`src/cli.ts`): Commander.js entrypoint. Top-level: `outreach {setup,health,context,reply-check,ask-human,whoami}`. Subcommands: `outreach call {init,teardown,place,listen,status,hangup}`, `outreach sms {send,history}`, `outreach email {send,history,search}`, `outreach calendar {add,remove}`. All send commands require `--campaign-id` + `--contact-id` by default; `--to` is optional (resolved from contact record). Pass `--once` on any send (sms/email/call/calendar add/calendar remove) to bypass campaign tracking — required for adhoc tests/demos; mutually exclusive with `--campaign-id`/`--contact-id`/`--fire-and-forget` and requires `--to` on sms/email/call.
- **Data I/O** (`src/logs/sessionLog.ts`): Reads/writes campaign JSONL (`<data_repo>/outreach/campaigns/`), contacts (`<data_repo>/outreach/contacts/`), and transcripts (`<data_repo>/outreach/transcripts/`). Data repo resolved via `src/dataRepo.ts`. Append-only for campaigns, file-system-native.

**Call channel** (Twilio + Gemini Live):
- **Daemon** (`src/daemon/server.ts`): Background Express + WebSocket server on port 3001. Manages Twilio Media Streams ↔ Gemini Live bridge, transcript buffers, call state. Started via `outreach call init`. Pre-connects Gemini session at call placement time (during PSTN dialing) to eliminate initial latency — the session idles with no-op callbacks until the media stream connects, then the bridge rebinds real callbacks. Supports concurrent calls — each `call.place` creates an independent session in a `Map<string, CallSession>`, with separate Gemini session, Twilio stream, transcript buffer, and guardrail timers.
- **Audio bridge** (`src/daemon/mediaStreamsBridge.ts`): Bridges Twilio Media Streams WebSocket (mulaw 8kHz) to Gemini Live session (PCM 16kHz/24kHz) with real-time transcoding. Includes `TranscriptBatcher` that consolidates per-word Gemini transcript fragments into turn-level entries (flushes on speaker change, 800ms silence, or cleanup).
- **Transcoding** (`src/audio/transcode.ts`): mulaw↔PCM codec conversion + sample rate resampling (8k↔16k↔24k).
- **Gemini client** (`src/audio/geminiLive.ts`): `@google/genai` SDK wrapper for Gemini Live API. Handles audio streaming, function calling (`send_dtmf`, `end_call`), transcript extraction, and `rebindCallbacks()` for pre-connect support.
- **IPC**: CLI ↔ daemon communicate over Unix socket at `/tmp/outreach-daemon.sock`. JSON-RPC style (method + params).

**SMS channel** (iMessage or SMS):
- **Messages provider** (`src/providers/messages.ts`): iMessage DB reader (`better-sqlite3`, readonly) + AppleScript sender. Phone normalization to E.164. Reads `~/Library/Messages/chat.db` for history, sends via `osascript` for outbound. `pickService()` chooses iMessage vs. SMS from recent chat.db history (any iMessage in last 5 inbound → iMessage; else last successful outbound → its service; else last inbound; else SMS default for unknowns). `sendIMessage()` synchronously probes chat.db after send and returns `delivered` / `failed` / `timeout` (90s cap); SMS send requires iPhone Text Message Forwarding.

**Email channel** (Gmail):
- **Gmail provider** (`src/providers/gmail.ts`): Gmail API client — send (with threading/reply-all/attachments via nodemailer MailComposer), history (by address or thread), search (query → thread-grouped metadata), health check. Uses shared Google OAuth2 auth from `googleAuth.ts`.

**Calendar channel** (Google Calendar):
- **Google Calendar provider** (`src/providers/gcalendar.ts`): Calendar API client — add events, remove events, health check. Uses shared Google OAuth2 auth from `googleAuth.ts`.

## Key files

| Path | Purpose |
|---|---|
| `src/contacts.ts` | Contact interface + `resolveContactAddress()` — shared contact→address resolution |
| `src/once.ts` | `validateOnce()` — shared validator for the `--once` adhoc-send flag across all send commands |
| `src/cli.ts` | CLI entrypoint, wires all commands |
| `src/daemon/server.ts` | Daemon: HTTP server, WebSocket handler, IPC handler, call logic |
| `src/daemon/mediaStreamsBridge.ts` | Twilio Media Streams ↔ Gemini Live audio bridge + turn-level transcript batching |
| `src/daemon/sessions.ts` | In-memory call session store with EventEmitter for transcript events |
| `src/daemon/lifecycle.ts` | `ensureDaemon()` — daemon process management |
| `src/daemon/ipc.ts` | `sendToDaemon()` — IPC client for CLI → daemon |
| `src/audio/geminiLive.ts` | Gemini Live API WebSocket client |
| `src/audio/transcode.ts` | mulaw↔PCM codec + sample rate resampling |
| `src/audio/systemInstruction.ts` | Builds system instruction: static prompt (phone mechanics) + identity + persona + per-call params |
| `src/runtime.ts` | Runtime state: read/write `~/.outreach/runtime.json` |
| `src/dataRepo.ts` | `resolveDataRepo()` — env var > dev config sticky > walk-up for `.agents/workspace.yaml`; single source of truth for data repo location |
| `src/appConfig.ts` | Loads `<data_repo>/outreach/config.yaml` (identity, voice agent, Gemini tuning, watch). Dev fallback: reads `outreach.config.dev.yaml` directly when resolution source is `dev` and the data-repo config is absent. Exposes `config_path` + `config_source` on AppConfig |
| `src/config.ts` | Loads `.env` — secrets and infrastructure only |
| `src/commands/setup.ts` | `outreach setup` — scaffolds data repo (`.agents/workspace.yaml` marker, `outreach/{config.yaml,campaigns,contacts,transcripts}`), syncs skills, runs full-stack readiness check (sundial + relay on PATH, workspace.yaml registrations, daemon pings) |
| `src/commands/health.ts` | `outreach health` — omnichannel readiness check (includes resolved `config_path` + resolution source) |
| `src/commands/context.ts` | `outreach context` — cross-channel JIT briefing assembly |
| `src/commands/replyCheck.ts` | `outreach reply-check` — sundial poll trigger, checks for inbound replies |
| `src/commands/askHuman.ts` | `outreach ask-human` — write human_question + register watch |
| `src/commands/askHumanCheck.ts` | [internal] sundial trigger — fires on new human_input or timeout |
| `src/commands/whoami.ts` | `outreach whoami` — tool-gated pull of user identity fields for callback agents |
| `src/watch.ts` | Sundial registration helper — `registerReplyWatch()` for auto-watch on send |
| `src/commands/call/*.ts` | One file per call command (init, teardown, place, listen, status, hangup) |
| `src/commands/sms/send.ts` | `outreach sms send` — send iMessage + log campaign attempt |
| `src/commands/sms/history.ts` | `outreach sms history` — read iMessage thread |
| `src/commands/email/send.ts` | `outreach email send` — send email via Gmail + log campaign attempt |
| `src/commands/email/history.ts` | `outreach email history` — read email thread or address history |
| `src/commands/email/search.ts` | `outreach email search` — Gmail query search, returns thread-grouped metadata |
| `src/commands/calendar/add.ts` | `outreach calendar add` — create Google Calendar event + log campaign attempt |
| `src/commands/calendar/remove.ts` | `outreach calendar remove` — delete Google Calendar event + log campaign attempt |
| `src/providers/messages.ts` | Messages DB reader + AppleScript sender + phone normalization + service picker + delivery probe |
| `src/providers/googleAuth.ts` | Shared Google OAuth2 auth — token management, interactive flow, cached client |
| `src/providers/gmail.ts` | Gmail API client: send, history, search, health check |
| `src/providers/gcalendar.ts` | Google Calendar API client: add event, remove event, health check |
| `src/logs/sessionLog.ts` | JSONL file helpers for campaign logs, contacts, and transcripts |
| `src/output.ts` | `outputJson()` / `outputError()` — all CLI output is JSON |
| `src/exitCodes.ts` | Exit code constants (0-4) |
| `scripts/sync-skills.js` | Build hook — copies `skills/outreach/` → `<data_repo>/.agents/skills/outreach/` to keep agent workspace in sync |
| `prompts/voice-agent.md` | Static system prompt — phone mechanics only (IVR, screening, ending calls) |
| `outreach.config.dev.yaml` | Dev escape hatch (gitignored). Only `data_repo_path` is consumed by production path; ships as `.example` template. The real config is `<data_repo>/outreach/config.yaml` |
| `skills/outreach/SKILL.md` | Agent onboarding — catalog/router + shared prerequisites (synced to data repo on build) |
| `skills/outreach/once.md` | Agent reference — one-off send path (`--once`, utility mode) |
| `skills/outreach/campaign.md` | Agent reference — campaign management SOP (data schema, CLI reference, workflow) |
| `skills/outreach/call.md` | Agent reference — call channel (Twilio + Gemini Live) |
| `skills/outreach/sms.md` | Agent reference — SMS channel (iMessage) |
| `skills/outreach/email.md` | Agent reference — email channel (Gmail) |
| `skills/outreach/calendar.md` | Agent reference — calendar channel (Google Calendar) |

Skills are the source of truth in this repo. `npm run build` copies them to `<data_repo_path>/.agents/skills/outreach/` so the agent workspace always has docs matching the current CLI version.

## Configuration

**Config sources, no overlap:**

| Source | Contains | Example |
|---|---|---|
| `.env` (CLI repo) | Secrets + infrastructure (dev) | `TWILIO_ACCOUNT_SID`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` |
| `<data_repo>/outreach/config.yaml` | Real app behavior | Identity (`user_name` + optional pullable fields — first_name, address, email_signature, `other` catch-all, etc.), Gemini model, voice, VAD, thinking level, persona, watch (auto-reply watcher config). No `data_repo_path` (self-evident from location). See `docs/done/tuning-reference.md` for full parameter documentation. |
| `outreach.config.dev.yaml` (CLI repo, gitignored) | Dev escape hatch | Only `data_repo_path` is load-bearing — points a dev checkout at a data repo. Ship `.example` template; live file is gitignored. |

**Data repo resolution order** (`src/dataRepo.ts` → `resolveDataRepo()`):

1. `OUTREACH_DATA_REPO` env var — highest priority; CI and ad-hoc overrides.
2. `outreach.config.dev.yaml` next to the CLI binary — dev sticky (wins over walk-up so a dev `cd`-ing into a real data repo doesn't silently hit prod).
3. Walk up from cwd looking for `.agents/workspace.yaml` — normal agent path (agents run inside the data repo).
4. Error with remediation pointing at `outreach setup` and `OUTREACH_DATA_REPO`.

In dev mode (source 2), if `<data_repo>/outreach/config.yaml` doesn't exist yet, `loadAppConfig()` falls back to reading the dev file directly so `npm run dev` works before running `outreach setup`.

## Identifier model

All send commands (`call place`, `sms send`, `email send`) and calendar commands (`calendar add`, `calendar remove`) share a unified identifier pattern. `--contact-id` is the universal person identifier — the CLI resolves the channel-appropriate address from the contact record. `--to` is an optional override for when the agent needs to reach a different address than what's on file.

**Flags by command:**

| Command | Required | Resolved from contact | Override |
|---|---|---|---|
| `call place` | `--campaign-id`, `--contact-id` | `contact.phone` | `--to` |
| `sms send` | `--campaign-id`, `--contact-id`, `--body` | `contact.sms_phone ?? contact.phone` | `--to`, `--fire-and-forget` |
| `email send` | `--campaign-id`, `--contact-id`, `--subject`, `--body` | `contact.email` | `--to`, `--fire-and-forget` |
| `sms history` | one of: `--contact-id`, `--phone` | `contact.sms_phone ?? contact.phone` | `--phone` |
| `email history` | one of: `--contact-id`, `--address`, `--thread-id` | `contact.email` | `--address` |
| `reply-check` | `--campaign-id`, `--contact-id`, `--channel` | — | — |

Resolution lives in `src/contacts.ts` → `resolveContactAddress(contactId, channel)`.

**Adhoc sends (`--once`).** Every send command accepts `--once` to skip campaign coupling — no `campaign-id`/`contact-id`, no JSONL append, no reply watcher. For smoke tests, demos, and one-off notifications only. Requires `--to` on sms/email/call; `--event-id`/event fields already required on calendar. Validation lives in `src/once.ts` → `validateOnce(channel, opts)`.

## Outreach quickstart

```bash
npm run build
outreach setup --data-repo ~/my-data   # one-time: scaffold data repo + run stack readiness check
outreach health                        # check data repo + all channel readiness

# --- Call ---
outreach call init                     # start ngrok + daemon (on demand, voice only)
outreach call place \
  --campaign-id "2026-04-15-dental" \
  --contact-id "c_a1b2c3" \
  --objective "Schedule appointment" \
  --persona "Be conversational and flexible on timing" \
  --hangup-when "Appointment confirmed"
outreach call listen --id <id>         # monitor transcript
outreach call teardown                 # clean up

# --- SMS ---
outreach sms send \
  --campaign-id "2026-04-15-dental" \
  --contact-id "c_a1b2c3" \
  --body "Hi, following up on scheduling."
outreach sms history --contact-id "c_a1b2c3"

# --- Email ---
outreach email send \
  --campaign-id "2026-04-15-dental" \
  --contact-id "c_a1b2c3" \
  --subject "Following up" \
  --body "Hi, wanted to follow up on scheduling."
outreach email history --contact-id "c_a1b2c3"
outreach email search --query "from:dentist subject:scheduling"

# --- Calendar ---
outreach calendar add \
  --summary "Dental cleaning" \
  --start "2026-04-22T14:00:00" \
  --end "2026-04-22T15:00:00" \
  --campaign-id "2026-04-15-dental" \
  --contact-id "c_a1b2c3"
outreach calendar remove \
  --event-id "abc123xyz" \
  --campaign-id "2026-04-15-dental" \
  --contact-id "c_a1b2c3"
```

The voice agent handles calls autonomously. Use `call listen` to monitor progress and `call hangup` to end early. SMS and email are fire-and-forget — replies arrive in later sessions. Calendar commands create/remove events on Google Calendar.

## Design principles

- **Agent-native**: inputs are structured (flags + JSON), outputs are compact JSON. No human-oriented formatting.
- **Voice-native model**: Gemini handles STT+reasoning+TTS in one hop. No sub-agent loop needed during calls.
- **Orchestrator owns lifecycle**: `health`/`call init`/`call teardown` are the orchestrator's responsibility. Sub-agents only execute tasks (place calls, monitor transcripts).
- **Concurrent by default**: multiple `call place` invocations run in parallel — each gets an independent session, Gemini connection, and transcript. The daemon, not the CLI, manages multiplexing.
- **File-system state**: campaign logs and transcripts are JSONL files, not databases. Agents read/write them directly.
- **Fail fast**: missing config raises errors immediately — no silent defaults.

## Conventions

- TypeScript, ESM (`import/export`), target Node 20+
- Local imports use `.js` extension (ESM requirement)
- All CLI output via `outputJson()` / `outputError()` — never `console.log`
- Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout
- Daemon writes to stdout/stderr for logging (not visible to CLI users)
- Secrets in `.env`, behavior in `<data_repo>/outreach/config.yaml` — never mix

## V1 legacy

V1 used Twilio ConversationRelay (text-in/text-out, sub-agent as brain) with ~2.4s per-turn latency. V1 code has been removed — all ConversationRelay paths, `say`/`dtmf` commands, and related WebSocket handlers are gone. V2 is the only supported backend, achieving sub-1s latency via voice-native Gemini Live and pre-connected sessions.

## Reference docs

| Path | Purpose |
|---|---|
| `docs/done/design.md` | Initial engineering design document |
| `docs/done/memory-layer.md` | Data layer design — schemas and data repo structure |
| `docs/done/email-channel.md` | Email channel implementation design |
| `docs/done/sms-context.md` | SMS + cross-channel context design |
| `docs/done/thread-grouped-email-context.md` | Thread-grouped email context design |
| `docs/done/tuning-reference.md` | Full parameter reference for Gemini config |
| `docs/done/v2-architecture-options.md` | V2 architecture options analysis |
| `docs/done/lifecycle-commands.md` | Init/teardown/status design |
| `docs/done/call-cost-guardrails.md` | Call duration and cost guardrails |
| `docs/done/integration-test-ivr.md` | IVR integration test plan |
| `docs/spec/timeouts.md` | Reference spec — every timeout/interval in the codebase, defaults, and rationale |
| `skills/outreach/SKILL.md` | Agent-facing user guide — catalog/router + shared prerequisites |
| `skills/outreach/once.md` | Agent-facing user guide — one-off send (`--once`) |
| `skills/outreach/campaign.md` | Agent-facing user guide — campaign management SOP |
| `skills/outreach/call.md` | Agent-facing user guide — call channel |
| `skills/outreach/sms.md` | Agent-facing user guide — SMS channel |
| `skills/outreach/email.md` | Agent-facing user guide — email channel |
| `skills/outreach/calendar.md` | Agent-facing user guide — calendar channel |
