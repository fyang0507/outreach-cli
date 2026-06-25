# Outreach CLI

Utility CLI for outbound calls, SMS/iMessage, Gmail, and per-channel history/search.

This repo is intentionally not a campaign manager. It does not own contacts, campaign files, async follow-up policy, reply watchers, callback agents, calendar/workspace management, or cross-channel context assembly. Calling agents/workflows pass explicit phone numbers, email addresses, Gmail IDs, and task text.

## Command Surface

All command output is JSON.

```bash
outreach health

outreach call init
outreach call place --to <number> --objective <text> [--from <number>] [--persona <text>] [--hangup-when <text>] [--max-duration <seconds>] [--wait-for-user]
outreach call listen --id <callId>
outreach call status --id <callId>
outreach call latency (--id <callId> | --latest)
outreach call hangup --id <callId>
outreach call teardown

outreach sms send --to <number> --body <text> [--service iMessage|SMS]
outreach sms history --phone <number> [--limit <n>]

outreach email send --subject <text> --body <text> (--to <address> | --reply-to-id <messageId>) [--cc <addresses>] [--bcc <addresses>] [--no-reply-all] [--attach <paths...>]
outreach email history (--address <email> | --thread-id <threadId>) [--limit <n>]
outreach email search --query <gmail-query> [--limit <n>]

outreach discord post --body <text> [--channel <id|name>]
outreach discord channels list
outreach discord channels create --name <name> [--topic <text>] [--category <id|name>]
```

There is no `outreach setup` command. Create config/workspace files outside this CLI, or point the CLI at an existing workspace.

## Configuration

Secrets live in `.env` next to the CLI checkout:

```bash
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
OUTREACH_DEFAULT_FROM=+15551234567
GOOGLE_GENERATIVE_AI_API_KEY=...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
DISCORD_DEFAULT_CHANNEL=General
```

### Discord bot setup

`outreach discord` posts async operator updates via a Discord bot. One-time manual setup:

1. Create an application and a bot at <https://discord.com/developers>.
2. No privileged intents are required (the CLI uses REST only).
3. Generate an OAuth2 invite URL with `scope=bot` and permissions **View Channels (1024)**, **Send Messages (2048)**, and **Manage Channels (16)**; open it to invite the bot to your server.
4. Copy the bot token into `DISCORD_BOT_TOKEN`.
5. With Developer Mode on, right-click the server -> **Copy Server ID** into `DISCORD_GUILD_ID`.
6. Optionally set `DISCORD_DEFAULT_CHANNEL` (channel name or id used when `discord post` omits `--channel`; defaults to `General`).

`outreach health` reports the `discord` channel state once these are set.

Behavior config is loaded from `<data_repo>/outreach/config.yaml`; for dev-only use, `outreach.config.dev.yaml` next to the CLI may carry the same config plus `data_repo_path`.

Data/workspace path resolution order:

1. `OUTREACH_DATA_REPO`
2. `outreach.config.dev.yaml` next to the CLI with `data_repo_path`
3. Walk up from `cwd` for `.agents/workspace.yaml`

The config shape is documented in `outreach.config.dev.yaml.example`. Call transcripts are written to `<data_repo>/outreach/transcripts/<callId>.jsonl`; the writer creates that directory on demand.

## Architecture

Calls are stateful and use a local daemon:

```text
CLI command -> Unix IPC -> daemon/server.ts
Twilio webhook tunnel -> Express + WebSocket
Twilio Media Streams <-> mediaStreamsBridge.ts <-> Gemini Live
```

Important call behavior:

- `call init` starts the daemon and ngrok tunnel.
- `call place` pre-connects Gemini while Twilio dials.
- Normal calls proactively greet by default; greeting audio is pre-generated while ringing and flushed after a short post-stream delay.
- `--wait-for-user` makes the agent stay silent until the callee speaks first, then respond using Gemini automatic VAD for turn detection.
- `end_call` is deferred until Twilio confirms the active outbound audio turn has played via media `mark`; this prevents clipped goodbyes.
- `latency` reports pickup-to-audible-greeting for proactive calls and user-speech-to-audible-response for wait-for-user calls.

SMS is stateless except for optional history reads from the local Messages database. Sending uses Messages.app AppleScript and does not read `chat.db`.

Email is stateless apart from Gmail OAuth tokens stored under the configured data repo. Replies with `--reply-to-id` derive Gmail threading headers and reply-all recipients.

## Development

```bash
npm install
npm run build
node dist/cli.js --help
node dist/cli.js health
```

`npm run build` compiles TypeScript, marks `dist/cli.js` executable, and best-effort installs `.agents/skills/outreach` as an agent skill symlink to `skills/outreach/` in the configured agent workspace. If no data workspace is configured, symlink installation is skipped and the build still succeeds.

TypeScript is ESM. Local imports use `.js` extensions. All CLI output must go through `outputJson()` / `outputError()`. Exit codes: `0` success, `1` input error, `2` infrastructure error, `3` operation failed, `4` timeout.

## Key Files

| Path | Purpose |
|---|---|
| `src/cli.ts` | Commander.js entrypoint and command registration |
| `src/appConfig.ts`, `src/dataRepo.ts` | Config loading and data/workspace resolution |
| `src/commands/health.ts` | Readiness checks without scaffolding |
| `src/commands/call/*.ts` | Call lifecycle, monitoring, latency commands |
| `src/daemon/server.ts` | Call daemon, Twilio webhooks, IPC handling |
| `src/daemon/mediaStreamsBridge.ts` | Twilio Media Streams <-> Gemini Live bridge, playback drain |
| `src/audio/geminiLive.ts` | Gemini Live API wrapper and tool/callback plumbing |
| `src/audio/transcode.ts` | μ-law/PCM conversion and resampling |
| `src/commands/sms/*.ts`, `src/providers/messages.ts` | SMS/iMessage send and history |
| `src/commands/email/*.ts`, `src/providers/gmail.ts` | Gmail send/history/search |
| `src/commands/discord/*.ts`, `src/providers/discord.ts` | Discord post and channel list/create |
| `skills/outreach/*.md` | Agent-facing sharable utility docs |

## Release Checklist

Before cutting a major release:

```bash
npm run build
node dist/cli.js --help
node dist/cli.js health
node dist/cli.js call place --help
node dist/cli.js call latency --help
node dist/cli.js sms send --help
node dist/cli.js email send --help
npm pack --dry-run
```

For live call releases, also run:

```bash
node dist/cli.js call init
node dist/cli.js call place --to <verified-test-number> --objective 'Say a brief goodbye, then end the call.' --max-duration 30
node dist/cli.js call latency --latest
node dist/cli.js call teardown
```
