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

- **CLI** (`src/cli.ts`): Commander.js entrypoint. Top-level: `outreach {init,teardown,status}`. Subcommands: `outreach call {place,listen,status,hangup}`, `outreach log {append,read}`
- **Daemon** (`src/daemon/server.ts`): Background Express + WebSocket server on port 3001. Manages Twilio Media Streams ↔ Gemini Live bridge, transcript buffers, call state. Started via `outreach init`. Pre-connects Gemini session at call placement time (during PSTN dialing) to eliminate initial latency — the session idles with no-op callbacks until the media stream connects, then the bridge rebinds real callbacks.
- **Audio bridge** (`src/daemon/mediaStreamsBridge.ts`): Bridges Twilio Media Streams WebSocket (mulaw 8kHz) to Gemini Live session (PCM 16kHz/24kHz) with real-time transcoding.
- **Transcoding** (`src/audio/transcode.ts`): mulaw↔PCM codec conversion + sample rate resampling (8k↔16k↔24k).
- **Gemini client** (`src/audio/geminiLive.ts`): `@google/genai` SDK wrapper for Gemini Live API. Handles audio streaming, function calling (`send_dtmf`, `end_call`), transcript extraction, and `rebindCallbacks()` for pre-connect support.
- **IPC**: CLI ↔ daemon communicate over Unix socket at `/tmp/outreach-daemon.sock`. JSON-RPC style (method + params).
- **Session logs** (`src/logs/sessionLog.ts`): JSONL files in `~/.outreach/sessions/` and `~/.outreach/transcripts/`. Append-only, file-system-native.

## Key files

| Path | Purpose |
|---|---|
| `src/cli.ts` | CLI entrypoint, wires all commands |
| `src/daemon/server.ts` | Daemon: HTTP server, WebSocket handler, IPC handler, call logic |
| `src/daemon/mediaStreamsBridge.ts` | Twilio Media Streams ↔ Gemini Live audio bridge |
| `src/daemon/sessions.ts` | In-memory call session store with EventEmitter for transcript events |
| `src/daemon/lifecycle.ts` | `ensureDaemon()` — daemon process management |
| `src/daemon/ipc.ts` | `sendToDaemon()` — IPC client for CLI → daemon |
| `src/audio/geminiLive.ts` | Gemini Live API WebSocket client |
| `src/audio/transcode.ts` | mulaw↔PCM codec + sample rate resampling |
| `src/audio/systemInstruction.ts` | Builds system instruction from persona/objective/greeting |
| `src/runtime.ts` | Runtime state: read/write `~/.outreach/runtime.json` |
| `src/appConfig.ts` | Loads `outreach.config.yaml` — all Gemini tuning parameters |
| `src/config.ts` | Loads `.env` — secrets and infrastructure only |
| `src/commands/init.ts` | `outreach init` — start ngrok + daemon, write runtime |
| `src/commands/teardown.ts` | `outreach teardown` — stop everything, clean up |
| `src/commands/runtimeStatus.ts` | `outreach status` — show runtime state |
| `src/commands/call/*.ts` | One file per call command (place, listen, status, hangup) |
| `src/commands/log/*.ts` | Session log commands (append, read) |
| `src/logs/sessionLog.ts` | JSONL file helpers for session logs and transcripts |
| `src/output.ts` | `outputJson()` / `outputError()` — all CLI output is JSON |
| `src/exitCodes.ts` | Exit code constants (0-4) |
| `prompts/voice-agent.md` | Static system prompt for voice agent (IVR, screening, style) |
| `outreach.config.yaml` | Application behavior config (model, voice, VAD, thinking, etc.) |
| `SKILL.md` | Agent onboarding reference — how to use the CLI |

## Configuration

**Two config sources, no overlap:**

| Source | Contains | Example |
|---|---|---|
| `.env` | Secrets + infrastructure | `TWILIO_ACCOUNT_SID`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| `outreach.config.yaml` | Application behavior | Gemini model, voice, VAD, thinking level, persona, see `docs/done/tuning-reference.md` for full parameter documentation. |

## Running a call

```bash
npm run build
outreach init                          # start ngrok + daemon
outreach call place \
  --to "+1555..." \
  --objective "Schedule appointment" \
  --persona "You are Fred's assistant" \
  --welcome-greeting "Hi, calling about..." \
  --hangup-when "Appointment confirmed"
outreach call listen --id <id> --wait  # monitor transcript
outreach teardown                      # clean up
```

The voice agent handles the entire call autonomously. Use `call listen` to monitor progress and `call hangup` to end early if needed.

## Design principles

- **Agent-native**: inputs are structured (flags + JSON), outputs are compact JSON. No human-oriented formatting.
- **Voice-native model**: Gemini handles STT+reasoning+TTS in one hop. No sub-agent loop needed during calls.
- **Orchestrator owns lifecycle**: `init`/`teardown`/`status` are the orchestrator's responsibility. Sub-agents only execute tasks (place calls, monitor transcripts).
- **File-system state**: session logs are JSONL files, not databases. Agents read/write them directly.
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
| `docs/done/v2-vendor-research.md` | Voice API vendor comparison |
| `docs/done/latency-analysis.md` | Latency measurement and optimization |
| `docs/done/lifecycle-commands.md` | Init/teardown/status design |
| `docs/done/call-cost-guardrails.md` | Call duration and cost guardrails |
| `docs/done/v1-legacy-cleanup.md` | V1 code removal checklist |
| `docs/done/voice-clone.md` | Voice cloning research |
| `docs/done/integration-test-ivr.md` | IVR integration test plan |
| `docs/plan/memory-layer.md` | Memory/context layer design (planned) |
