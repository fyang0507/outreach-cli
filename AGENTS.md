# Outreach CLI

Utility CLI for outbound calls, SMS/iMessage, Gmail, and per-channel history/search. The repo is intentionally not a campaign manager.

## Boundary

- In scope: channel utilities, readiness checks, call daemon lifecycle, call transcripts/latency, per-channel history/search.
- Out of scope: campaigns, contacts, `outreach context`, reply watchers, callback agents, human-in-the-loop prompts, local campaign JSONL management, calendar/workspace management.
- SMS/email async follow-up is workflow-layer work. After sending, an agent may schedule an external check with another tool, but this repo does not do it automatically.
- Do not add generic wrappers around filesystem data. Agents can read/write their own workflow data directly.

## Command Surface

Top-level:

- `outreach health`

Calls:

- `outreach call init`
- `outreach call place --to <number> --objective <text> [--from <number>] [--persona <text>] [--hangup-when <text>] [--max-duration <seconds>] [--wait-for-user]`
- `outreach call listen --id <callId>`
- `outreach call status --id <callId>`
- `outreach call latency (--id <callId> | --latest)`
- `outreach call hangup --id <callId>`
- `outreach call teardown`

SMS:

- `outreach sms send --to <number> --body <text> [--service iMessage|SMS]`
- `outreach sms history --phone <number> [--limit <n>]`

Email:

- `outreach email send --subject <text> --body <text> (--to <address> | --reply-to-id <messageId>) [--cc <addresses>] [--bcc <addresses>] [--no-reply-all] [--attach <paths...>]`
- `outreach email history (--address <email> | --thread-id <threadId>) [--limit <n>]`
- `outreach email search --query <gmail-query> [--limit <n>]`

All command output is JSON.

## Configuration

- `.env`: provider secrets (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OUTREACH_DEFAULT_FROM`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`).
- `<data_repo>/outreach/config.yaml`: voice identity, default persona, call max duration, Gemini model/voice/VAD/thinking/transcription config.
- `outreach.config.dev.yaml`: gitignored dev pointer/config next to the CLI; `data_repo_path` is meaningful only here.

There is no `outreach setup`. Data path resolution is `OUTREACH_DATA_REPO`, then `outreach.config.dev.yaml`, then walk-up for `.agents/workspace.yaml`.

## Key Files

| Path | Purpose |
|---|---|
| `src/cli.ts` | Commander.js entrypoint |
| `src/appConfig.ts`, `src/dataRepo.ts` | Config and workspace resolution |
| `src/commands/health.ts` | Channel readiness checks; no scaffolding |
| `src/commands/call/*.ts` | Call lifecycle, monitoring, latency commands |
| `src/commands/sms/*.ts` | SMS/iMessage send and history |
| `src/commands/email/*.ts` | Gmail send/history/search |
| `src/providers/messages.ts` | Messages DB reader and AppleScript sender |
| `src/providers/gmail.ts` | Gmail API client |
| `src/providers/googleAuth.ts` | Gmail OAuth2 token management |
| `src/daemon/server.ts` | Call daemon, Twilio webhook server, Gemini bridge orchestration |
| `src/daemon/mediaStreamsBridge.ts` | Twilio Media Streams <-> Gemini Live bridge, playback drain |
| `src/audio/geminiLive.ts` | Gemini Live API wrapper |
| `src/audio/transcode.ts` | μ-law/PCM conversion and resampling |
| `src/audio/systemInstruction.ts` | Voice-agent system instruction builder |
| `src/logs/sessionLog.ts` | Call transcript JSONL writer/reader |
| `skills/outreach/*.md` | Agent-facing sharable utility docs |

## Call Architecture Notes

- Calls require `outreach call init`, which starts the local daemon and webhook tunnel.
- `call place` pre-connects Gemini while Twilio dials.
- Normal calls proactively greet. Greeting audio can be pre-generated while ringing and is flushed after a short post-stream delay.
- `--wait-for-user` keeps the agent silent until the callee speaks first, then relies on Gemini automatic activity detection for turn-taking.
- The bridge tracks outbound turns with Twilio `mark`; `end_call` hangups are deferred until the active outbound turn drains, preventing clipped goodbyes.

## Development

```bash
npm install
npm run build
node dist/cli.js --help
node dist/cli.js health
```

`npm run build` compiles TypeScript, marks `dist/cli.js` executable, and best-effort installs `.agents/skills/outreach` as an agent skill symlink to `skills/outreach/` in the configured agent workspace. If no data workspace is configured, symlink installation is skipped.

TypeScript is ESM. Local imports use `.js` extensions. All CLI output must go through `outputJson()` / `outputError()`.
