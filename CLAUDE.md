# Outreach CLI

Agent-native CLI for real-world outreach — calls, SMS, email. The CLI is a tool for AI agents, not humans. An orchestrator agent delegates tasks to sub-agents, each using this CLI to make calls, send messages, or send emails.

## Quick start

```bash
npm install
npm run build
node dist/cli.js --help
```

## Architecture (V1)

**Twilio ConversationRelay** handles STT/TTS. The CLI is a text-in/text-out interface — no raw audio.

```
Orchestrator Agent → Sub-Agent (LLM) → CLI commands → Daemon → Twilio ConversationRelay
```

- **CLI** (`src/cli.ts`): Commander.js entrypoint. Subcommands: `outreach call {place,listen,say,dtmf,status,hangup}`, `outreach log {append,read}`
- **Daemon** (`src/daemon/server.ts`): Background Express + WebSocket server on port 3001. Manages Twilio ConversationRelay WebSocket connections, transcript buffers, call state. Auto-starts on first `call place`, auto-stops after 5min idle.
- **IPC**: CLI ↔ daemon communicate over Unix socket at `/tmp/outreach-daemon.sock`. JSON-RPC style (method + params).
- **Session logs** (`src/logs/sessionLog.ts`): JSONL files in `~/.outreach/sessions/` and `~/.outreach/transcripts/`. Append-only, file-system-native.

## Key files

| Path | Purpose |
|---|---|
| `src/cli.ts` | CLI entrypoint, wires all commands |
| `src/daemon/server.ts` | Daemon: HTTP server, WebSocket handler, IPC handler, all call logic |
| `src/daemon/sessions.ts` | In-memory call session store with EventEmitter for transcript events |
| `src/daemon/lifecycle.ts` | `ensureDaemon()` — auto-start/stop daemon |
| `src/daemon/ipc.ts` | `sendToDaemon()` — IPC client for CLI → daemon |
| `src/commands/call/*.ts` | One file per CLI command (place, listen, say, dtmf, status, hangup) |
| `src/commands/log/*.ts` | Session log commands (append, read) |
| `src/logs/sessionLog.ts` | JSONL file helpers for session logs and transcripts |
| `src/config.ts` | Loads env vars from `.env` |
| `src/output.ts` | `outputJson()` / `outputError()` — all CLI output is JSON |
| `src/exitCodes.ts` | Exit code constants (0-4) |

## Environment variables

Defined in `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `OUTREACH_DEFAULT_FROM` | Default caller ID for outbound calls |
| `OUTREACH_PERSONAL_CALLER_ID` | User's personal number |
| `OUTREACH_WEBHOOK_URL` | Public URL for Twilio webhooks (ngrok in dev) |

## Running a call (dev)

1. Start ngrok: `ngrok http 3001`
2. Set `OUTREACH_WEBHOOK_URL` in `.env` to the ngrok HTTPS URL
3. `npm run build`
4. `node dist/cli.js call place --to "+1555..." --welcome-greeting "Hi, this is..."`
5. The daemon auto-starts. Use `call listen`, `call say`, `call hangup` to interact.

## Design principles

- **Agent-native**: inputs are structured (flags + JSON), outputs are compact JSON. No human-oriented formatting.
- **Sub-agent is the brain**: the CLI makes zero decisions about what to say. All reasoning lives in the calling agent.
- **File-system state**: session logs are JSONL files, not databases. Agents read/write them directly.
- **Pluggable internals**: the CLI interface stays the same regardless of backend (ConversationRelay, raw Media Streams, voice-native model).

## Conventions

- TypeScript, ESM (`import/export`), target Node 20+
- Local imports use `.js` extension (ESM requirement)
- All CLI output via `outputJson()` / `outputError()` — never `console.log`
- Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout
- Daemon writes to stdout/stderr for logging (not visible to CLI users)

## V2 planning

See `docs/plan/` for V2 architecture options:
- `v2-architecture-options.md` — three paths: raw STT/TTS pipeline, voice-native model (OpenAI Realtime), or hybrid
- `v2-vendor-research.md` — full comparison tables for telephony, STT, TTS, and voice-native providers
- `latency-analysis.md` — measured V1 latency data from live testing

Key V2 decision: whether to use GPT-4o Realtime API (~0.3-0.5s latency, autonomous calls) vs raw Deepgram+Cartesia pipeline (~0.8-1.2s, full agent control). Not yet decided — depends on latency vs voice-cloning priority.

## Design doc

`docs/design.md` — comprehensive engineering design document covering: problem statement, real-world constraints (caller ID, call screening, IVR, latency), CLI interface spec, architecture, interaction patterns, technology choices, state management, and resolved design questions.
