# Outreach CLI

This repository is a pure utility CLI for outbound calls, SMS/iMessage, Gmail, and per-channel history/search. It intentionally avoids campaign/process ownership.

## Working Rules

- Preserve the utility boundary: no campaign/contact models, no reply watchers, no callback agents, no calendar/workspace management, no `outreach context`.
- Prefer explicit channel identifiers: phone numbers, email addresses, Gmail message IDs, and Gmail thread IDs.
- Keep command output JSON-only via `outputJson()` / `outputError()`.
- Keep TypeScript ESM imports with `.js` extensions.
- Do not reintroduce `outreach setup`; config/workspace files are external inputs.

## Current Commands

```bash
outreach health
outreach call init|place|listen|steer|status|latency|hangup|teardown
outreach sms send|history
outreach email send|history|search
```

## Configuration Model

- `.env` holds provider secrets, your personal caller ID (`PERSONAL_CALLER_ID`), and the Twilio number (`TWILIO_DEFAULT_FROM_NUMBER`, used as caller ID by `call place --from-twilio`/`--call-operator`).
- Runtime behavior lives at `<data_repo>/outreach/config.yaml`.
- `outreach.config.dev.yaml` is a local dev escape hatch and may include `data_repo_path`.
- Resolution order: `OUTREACH_DATA_REPO`, dev config, walk-up for `.agents/workspace.yaml`.
- Call transcripts are written under `<data_repo>/outreach/transcripts/`.

## Call Internals

Call flow:

```text
CLI -> Unix IPC -> daemon/server.ts
Twilio webhooks/WebSocket -> mediaStreamsBridge.ts -> GeminiLiveSession
```

Important behavior:

- `call init` starts the daemon and tunnel.
- `call place` pre-connects Gemini before Twilio answers.
- Default calls proactively greet. `--wait-for-user` keeps the agent silent until the callee speaks, then relies on Gemini automatic VAD for turn detection.
- Calls always use Twilio answering-machine detection (async AMD via `/call-amd`).
- The bridge sends Twilio `mark` messages after outbound turns and defers `end_call` hangup until playback drains.

## Key Files

| Path | Purpose |
|---|---|
| `src/cli.ts` | Command registration |
| `src/appConfig.ts`, `src/dataRepo.ts` | Config/workspace resolution |
| `src/commands/health.ts` | Readiness checks |
| `src/commands/call/*.ts` | Call commands |
| `src/daemon/server.ts` | Daemon, IPC, Twilio status/webhook handling |
| `src/daemon/mediaStreamsBridge.ts` | Realtime audio bridge, playback drain |
| `src/audio/geminiLive.ts` | Gemini Live wrapper |
| `src/providers/messages.ts` | Messages.app send and history |
| `src/providers/gmail.ts` | Gmail API operations |
| `src/logs/sessionLog.ts` | Transcript read/write and latency event types |
| `skills/outreach/*.md` | Sharable agent-facing docs |

## Development Checks

```bash
npm install
npm run build
node dist/cli.js --help
node dist/cli.js health
node dist/cli.js call place --help
node dist/cli.js sms send --help
node dist/cli.js email send --help
```

`npm run build` compiles TypeScript and best-effort syncs `skills/outreach/` to the configured agent workspace. It should still succeed when no data workspace is configured.
