# Outreach CLI

This repository is a pure utility CLI for outbound calls, SMS/iMessage, Gmail, Discord, and per-channel history/search. It intentionally avoids campaign/process ownership.

## Working Rules

- In scope: channel utilities, readiness checks, call daemon lifecycle, call transcripts/latency, per-channel history/search.
- Preserve the utility boundary: no campaign/contact models, no reply watchers, no callback agents, no human-in-the-loop prompts, no local campaign JSONL management, no calendar/workspace management, no `outreach context`.
- SMS/email async follow-up is workflow-layer work. After sending, an agent may schedule an external check with another tool, but this repo does not do it automatically.
- Do not add generic wrappers around filesystem data. Agents can read/write their own workflow data directly.
- Prefer explicit channel identifiers: phone numbers, email addresses, Gmail message IDs, and Gmail thread IDs.
- Keep command output JSON-only via `outputJson()` / `outputError()`.
- End a success path with `process.exitCode = SUCCESS`, never `process.exit(SUCCESS)`. When stdout is a pipe the write is async and `process.exit()` does not wait for it to drain, so a payload past the pipe buffer (64KB on macOS) reaches the caller truncated mid-string with exit 0 — unparseable JSON wearing a success code, the worst failure shape a JSON-only CLI has. Redirecting to a file hides this, because file writes are synchronous. `outputError()` paths keep their immediate `process.exit()`: those payloads are one short line. `call init` is the one success path that still exits explicitly — it `fork()`s the daemon with an `"ipc"` stdio channel, and that channel holds the parent's event loop open even after `child.unref()`, so a natural exit would hang the CLI on its own daemon; its payload is bounded. `tests/unit/stdout-flush.test.mjs` holds the whole command surface to this, including commands that need live credentials.
- Keep TypeScript ESM imports with `.js` extensions.
- Do not reintroduce `outreach setup`; config/workspace files are external inputs.

## Command Surface

All command output is JSON.

```bash
outreach health

outreach call init [--tunnel ngrok|manual] [--webhook-url <url>] [--skip-preflight]
outreach call place (--to <number> | --call-operator) --objective <text> \
  [--persona <text>] [--hangup-when <text>] [--max-duration <seconds>] \
  [--wait-for-user] [--from-twilio]
outreach call listen --id <callId> [--since <seq>]
outreach call steer --id <callId> --text <note> [--mode nudge|say]
outreach call status --id <callId>
outreach call latency (--id <callId> | --latest)
outreach call hangup --id <callId>
outreach call teardown [--force]

outreach sms send --to <number> --body <text> [--service iMessage|SMS]
outreach sms history --phone <number> [--limit <n>]

outreach email send --subject <text> --body <text> (--to <address> | --reply-to-id <messageId>) \
  [--cc <addresses>] [--bcc <addresses>] [--no-reply-all] [--attach <paths...>]
outreach email history (--address <email> | --thread-id <threadId>) [--limit <n>] [--verbose]
outreach email search --query <gmail-query> [--limit <n>]

outreach discord post --body <text> [--channel <id|name>] [--silent]
outreach discord channels list
outreach discord channels create --name <name> [--topic <text>] [--category <id|name>]
outreach discord history --channel <id|name> [--limit <n>] [--after <messageId>] \
  [--before <messageId>] [--since <iso>] [--count]

outreach contacts find --query <text> [--limit <n>] [--verbose]
```

`call steer --mode nudge` (the default) folds a realtime hint into the agent's own voice without restarting its turn; `--mode say` forces a verbatim turn.

`contacts find` reads the local macOS Contacts stores (`~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`, plus the legacy top-level `AddressBook-v22.abcddb` beside `Sources`, read-only, deduped across stores) and routes on the query's shape: a phone number matches on longest shared digit suffix, an address on canonicalized email, everything else is fuzzy text over name, organization, job title, phone and email. A structured route that finds nothing falls back to text. Array order is the rank. Zero matches (including an empty query) is an ordinary result with `count: 0` and exit 0; missing stores, and stores that are all unreadable, are an `INFRA_ERROR`. `--verbose` adds `kind`/`route`, per-match `score` and `matched_on`, and makes notes both searchable and visible.

Its ranking rules — the four-voter ensemble and why it is four, the score floor, the confidence tiers and the fallback cap, the email and phone route specifics, and the four AddressBook schema traps — are tuned decisions with measurements behind them. Read [`docs/done/contacts-find-ranking.md`](docs/done/contacts-find-ranking.md) before changing any of it.

## Configuration Model

- `.env` holds provider secrets. Calls require all five of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY`, `PERSONAL_CALLER_ID` and `TWILIO_DEFAULT_FROM_NUMBER` (`REQUIRED_CALL_ENV` in `src/config.ts`; `call init` refuses without them). Both caller IDs are required because `call place` dials from `PERSONAL_CALLER_ID` by default and from `TWILIO_DEFAULT_FROM_NUMBER` for `--from-twilio`/`--call-operator`. `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_DEFAULT_CHANNEL` are needed only for those channels.
- Runtime behavior lives at `<data_repo>/outreach/config.yaml`: operator identity, `voice_agent.default_persona`, `call.max_duration_seconds`, and the Gemini model, speech/voice, generation, thinking, VAD, turn-taking and transcription settings.
- The daemon's stdout and stderr go to `~/.outreach/daemon.log` (path echoed by `call init` and recorded in `runtime.json`), rotated once at 10MB. Without it the bridge's own logs are discarded, and a call that went wrong cannot be diagnosed after the fact.
- `outreach.config.dev.yaml` is a gitignored local dev escape hatch next to the CLI, and the only place `data_repo_path` is meaningful.
- Resolution order: `OUTREACH_DATA_REPO`, dev config, walk-up for `.agents/workspace.yaml`.
- `OUTREACH_CONTACTS_SOURCES_DIR` overrides the AddressBook `Sources` directory `contacts find` reads (and with it the legacy top-level store, which is resolved as its parent directory's `AddressBook-v22.abcddb`). It exists so the command can be exercised against fixture stores instead of the machine's own Contacts; leave it unset in normal use.
- Call transcripts are written under `<data_repo>/outreach/transcripts/`.

## Call Internals

Call flow:

```text
CLI -> Unix IPC -> daemon/server.ts
Twilio webhooks/WebSocket -> mediaStreamsBridge.ts -> GeminiLiveSession
```

Calls are the only stateful channel. The daemon lives from `call init` until `call teardown`, with no idle self-shutdown; `call place` connects Twilio Media Streams to Gemini Live, and the remaining call commands inspect, steer, measure or close that one session.

The behavior underneath — preflight, pre-connect handover, the greeting and its re-identification rule, transcript flushing, activity and audio-delivery telemetry, AMD, the `send_dtmf` stream reconnect, raw audio capture, and teardown ordering — is largely incident-derived: most of it exists because something failed on a real call. Read [`docs/done/call-internals.md`](docs/done/call-internals.md) before changing any of it.

## Key Files

| Path | Purpose |
|---|---|
| `src/cli.ts` | Command registration |
| `src/config.ts` | `.env` secrets and `REQUIRED_CALL_ENV` |
| `src/appConfig.ts`, `src/dataRepo.ts` | Config/workspace resolution |
| `src/output.ts`, `src/exitCodes.ts` | JSON output contract and exit codes |
| `src/commands/health.ts` | Readiness checks |
| `src/commands/call/*.ts` | Call commands |
| `src/commands/sms/*.ts` | SMS/iMessage send and history |
| `src/commands/email/*.ts` | Gmail send/history/search |
| `src/commands/discord/*.ts` | Discord post, channels, history |
| `src/commands/contacts/find.ts` | Local Contacts search |
| `src/daemon/server.ts` | Daemon, IPC, Twilio status/webhook handling |
| `src/daemon/ipc.ts`, `src/runtime.ts` | Unix socket protocol and `runtime.json` |
| `src/daemon/sessions.ts` | In-memory call sessions and retention |
| `src/daemon/preflight.ts` | In-daemon readiness checks run by `call init` |
| `src/daemon/callGuards.ts` | Extracted, unit-testable cost-guard predicates (G3 voicemail silence) |
| `src/daemon/callActivity.ts` | Extracted, unit-testable `call listen`/`call status` `activity` classifiers |
| `src/daemon/mediaStreamsBridge.ts` | Realtime audio bridge, playback drain |
| `src/audio/geminiLive.ts` | Gemini Live wrapper |
| `src/audio/transcode.ts` | mu-law/PCM conversion and resampling |
| `src/audio/wavWriter.ts` | Wraps raw mu-law bytes in a minimal WAV for record-keeping capture |
| `src/audio/systemInstruction.ts` | Voice-agent system instruction builder |
| `prompts/voice-agent.md` | Static half of the call system instruction |
| `src/providers/messages.ts` | Messages.app send and history |
| `src/providers/gmail.ts`, `src/providers/googleAuth.ts` | Gmail API operations and OAuth2 tokens |
| `src/providers/discord.ts` | Discord bot REST: channel list/create, message post, channel history read |
| `src/providers/contacts/index.ts` | Public surface of the contacts subsystem, plus the `outreach health` probe |
| `src/providers/contacts/types.ts` | Shared contact/store data model and `ContactsAccessError` |
| `src/providers/contacts/stores.ts` | AddressBook store discovery and per-store SQLite reading (schema traps 1-3) |
| `src/providers/contacts/dedupe.ts` | Cross-store merge into one contact list (schema trap 4), `loadContacts` |
| `src/providers/contacts/searchIndex.ts` | The searchable projection of a contact: atoms, bigrams, structured keys |
| `src/providers/contacts/routes.ts` | Query classification and the phone/email/text ranking routes |
| `src/providers/contacts/search.ts` | The router over those routes: fallback, confidence cap, limit |
| `src/providers/contacts/similarity.ts` | Pure similarity/normalization helpers (no fs/sqlite) used by the contacts routes |
| `src/logs/sessionLog.ts` | Transcript read/write and latency event types |
| `skills/outreach/*.md` | Sharable agent-facing docs |
| `skills/contact-operator/*.md` | Sharable proactive operator contact policy |
| `docs/done/call-internals.md` | Why the call stack behaves as it does; read before changing it |
| `docs/done/contacts-find-ranking.md` | Why `contacts find` ranks as it does; read before changing it |
| `docs/plan/*.md`, `docs/done/*.md` | Design notes, pending and shipped |

## Development Checks

```bash
npm install
npm run build
npm test
node dist/cli.js --help
node dist/cli.js health
node dist/cli.js call place --help
```

`npm test` builds first and then runs `tests/unit/*.test.mjs` against `dist/` with `node --test`; the bridge tests drive `MediaStreamsBridge` with fake Twilio-WS/Gemini objects and mocked timers. `tests/integration/` is manual.

`npm run build` compiles TypeScript, marks `dist/cli.js` executable, and best-effort installs shipped skills as symlinks under `.agents/skills/` in the configured agent workspace. It should still succeed when no data workspace is configured.

`CLAUDE.md` is a symlink to this file — keep documentation here.
