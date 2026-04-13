# Outreach CLI

Agent-native CLI for real-world outreach — calls, SMS, email. The CLI is a tool for AI agents, not humans. An orchestrator agent delegates tasks to sub-agents, each using this CLI to make calls, send messages, or send emails.

## Quick start

```bash
npm install
npm run build
node dist/cli.js --help
```

## Architecture (V2 — Gemini Live)

**Gemini Live API** (`gemini-3.1-flash-live-preview`) handles the entire call autonomously — STT, reasoning, and TTS in a single voice-native model. No sub-agent needed during the call.

```
Orchestrator Agent → CLI commands → Daemon → Twilio Media Streams ↔ Audio Bridge ↔ Gemini Live API
```

- **CLI** (`src/cli.ts`): Commander.js entrypoint. Top-level: `outreach {health,context}`. Subcommands: `outreach call {init,teardown,place,listen,status,hangup}`, `outreach sms {send,history}`, `outreach email {send,history}`. All send commands require `--campaign-id` + `--contact-id`; `--to` is optional (resolved from contact record).
- **Daemon** (`src/daemon/server.ts`): Background Express + WebSocket server on port 3001. Manages Twilio Media Streams ↔ Gemini Live bridge, transcript buffers, call state. Started via `outreach call init`. Pre-connects Gemini session at call placement time (during PSTN dialing) to eliminate initial latency — the session idles with no-op callbacks until the media stream connects, then the bridge rebinds real callbacks. Supports concurrent calls — each `call.place` creates an independent session in a `Map<string, CallSession>`, with separate Gemini session, Twilio stream, transcript buffer, and guardrail timers.
- **Audio bridge** (`src/daemon/mediaStreamsBridge.ts`): Bridges Twilio Media Streams WebSocket (mulaw 8kHz) to Gemini Live session (PCM 16kHz/24kHz) with real-time transcoding. Includes `TranscriptBatcher` that consolidates per-word Gemini transcript fragments into turn-level entries (flushes on speaker change, 800ms silence, or cleanup).
- **Transcoding** (`src/audio/transcode.ts`): mulaw↔PCM codec conversion + sample rate resampling (8k↔16k↔24k).
- **Gemini client** (`src/audio/geminiLive.ts`): `@google/genai` SDK wrapper for Gemini Live API. Handles audio streaming, function calling (`send_dtmf`, `end_call`), transcript extraction, and `rebindCallbacks()` for pre-connect support.
- **IPC**: CLI ↔ daemon communicate over Unix socket at `/tmp/outreach-daemon.sock`. JSON-RPC style (method + params).
- **Data I/O** (`src/logs/sessionLog.ts`): Reads/writes campaign JSONL (`<data_repo_path>/outreach/campaigns/`), contacts (`<data_repo_path>/outreach/contacts/`), and transcripts (`<data_repo_path>/outreach/transcripts/`). Path from `outreach.config.yaml`. Append-only for campaigns, file-system-native.
- **Messages provider** (`src/providers/messages.ts`): iMessage DB reader (`better-sqlite3`, readonly) + AppleScript sender. Phone normalization to E.164. Reads `~/Library/Messages/chat.db` for history, sends via `osascript` for outbound.
- **Gmail provider** (`src/providers/gmail.ts`): Gmail API client — OAuth2 auth + token management, send (with threading/reply-all/attachments via nodemailer MailComposer), history (by address or thread), health check.

## Key files

| Path | Purpose |
|---|---|
| `src/contacts.ts` | Contact interface + `resolveContactAddress()` — shared contact→address resolution |
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
| `src/appConfig.ts` | Loads `outreach.config.yaml` — data repo path, identity, voice agent defaults, Gemini tuning parameters |
| `src/config.ts` | Loads `.env` — secrets and infrastructure only |
| `src/commands/health.ts` | `outreach health` — omnichannel readiness check |
| `src/commands/context.ts` | `outreach context` — cross-channel JIT briefing assembly |
| `src/commands/call/*.ts` | One file per call command (init, teardown, place, listen, status, hangup) |
| `src/commands/sms/send.ts` | `outreach sms send` — send iMessage + log campaign attempt |
| `src/commands/sms/history.ts` | `outreach sms history` — read iMessage thread |
| `src/commands/email/send.ts` | `outreach email send` — send email via Gmail + log campaign attempt |
| `src/commands/email/history.ts` | `outreach email history` — read email thread or address history |
| `src/providers/messages.ts` | Messages DB reader + AppleScript sender + phone normalization |
| `src/providers/gmail.ts` | Gmail API client: OAuth2 auth, send, history, health check |
| `src/logs/sessionLog.ts` | JSONL file helpers for campaign logs, contacts, and transcripts |
| `src/output.ts` | `outputJson()` / `outputError()` — all CLI output is JSON |
| `src/exitCodes.ts` | Exit code constants (0-4) |
| `prompts/voice-agent.md` | Static system prompt — phone mechanics only (IVR, screening, ending calls) |
| `outreach.config.yaml` | Application behavior config (data repo path, identity, model, voice, VAD, thinking, etc.) |
| `SKILL.md` | Agent onboarding reference — how to use the CLI |

## Configuration

**Two config sources, no overlap:**

| Source | Contains | Example |
|---|---|---|
| `.env` | Secrets + infrastructure | `TWILIO_ACCOUNT_SID`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` |
| `outreach.config.yaml` | Application behavior | Data repo path, identity (user_name), Gemini model, voice, VAD, thinking level, persona. See `docs/done/tuning-reference.md` for full parameter documentation. |

## Identifier model

All send commands (`call place`, `sms send`, `email send`) share a unified identifier pattern. `--contact-id` is the universal person identifier — the CLI resolves the channel-appropriate address from the contact record. `--to` is an optional override for when the agent needs to reach a different address than what's on file.

**Flags by command:**

| Command | Required | Resolved from contact | Override |
|---|---|---|---|
| `call place` | `--campaign-id`, `--contact-id` | `contact.phone` | `--to` |
| `sms send` | `--campaign-id`, `--contact-id`, `--body` | `contact.sms_phone ?? contact.phone` | `--to` |
| `email send` | `--campaign-id`, `--contact-id`, `--subject`, `--body` | `contact.email` | `--to` |
| `sms history` | one of: `--contact-id`, `--phone` | `contact.sms_phone ?? contact.phone` | `--phone` |
| `email history` | one of: `--contact-id`, `--address`, `--thread-id` | `contact.email` | `--address` |

Resolution lives in `src/contacts.ts` → `resolveContactAddress(contactId, channel)`.

## Outreach quickstart

```bash
npm run build
outreach health                        # check data repo + all channel readiness

# --- Call ---
outreach call init                     # start ngrok + daemon
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
```

The voice agent handles calls autonomously. Use `call listen` to monitor progress and `call hangup` to end early. SMS and email are fire-and-forget — replies arrive in later sessions.

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
- Secrets in `.env`, behavior in `outreach.config.yaml` — never mix

## V1 legacy

V1 used Twilio ConversationRelay (text-in/text-out, sub-agent as brain) with ~2.4s per-turn latency. V1 code has been removed — all ConversationRelay paths, `say`/`dtmf` commands, and related WebSocket handlers are gone. V2 is the only supported backend, achieving sub-1s latency via voice-native Gemini Live and pre-connected sessions.

## Reference docs

| Path | Purpose |
|---|---|
| `docs/design.md` | Initial engineering design document |
| `docs/done/tuning-reference.md` | Full parameter reference for Gemini config |
| `docs/done/v2-architecture-options.md` | V2 architecture options analysis |
| `docs/done/lifecycle-commands.md` | Init/teardown/status design |
| `docs/done/call-cost-guardrails.md` | Call duration and cost guardrails |
| `docs/done/integration-test-ivr.md` | IVR integration test plan |
| `SKILL.md` | Agent-facing user guide |
