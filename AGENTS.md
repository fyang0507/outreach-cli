# Outreach CLI

This repository is a pure utility CLI for outbound calls, SMS/iMessage, Gmail, Discord, and per-channel history/search. It intentionally avoids campaign/process ownership.

## Working Rules

- In scope: channel utilities, readiness checks, call daemon lifecycle, call transcripts/latency, per-channel history/search.
- Preserve the utility boundary: no campaign/contact models, no reply watchers, no callback agents, no human-in-the-loop prompts, no local campaign JSONL management, no calendar/workspace management, no `outreach context`.
- SMS/email async follow-up is workflow-layer work. After sending, an agent may schedule an external check with another tool, but this repo does not do it automatically.
- Do not add generic wrappers around filesystem data. Agents can read/write their own workflow data directly.
- Prefer explicit channel identifiers: phone numbers, email addresses, Gmail message IDs, and Gmail thread IDs.
- Keep command output JSON-only via `outputJson()` / `outputError()`.
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
outreach call listen --id <callId>
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
```

`call steer --mode nudge` (the default) folds a realtime hint into the agent's own voice without restarting its turn; `--mode say` forces a verbatim turn.

## Configuration Model

- `.env` holds provider secrets. Calls require all five of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY`, `PERSONAL_CALLER_ID` and `TWILIO_DEFAULT_FROM_NUMBER` (`REQUIRED_CALL_ENV` in `src/config.ts`; `call init` refuses without them). Both caller IDs are required because `call place` dials from `PERSONAL_CALLER_ID` by default and from `TWILIO_DEFAULT_FROM_NUMBER` for `--from-twilio`/`--call-operator`. `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_DEFAULT_CHANNEL` are needed only for those channels.
- Runtime behavior lives at `<data_repo>/outreach/config.yaml`: operator identity, `voice_agent.default_persona`, `call.max_duration_seconds`, and the Gemini model, speech/voice, generation, thinking, VAD, turn-taking and transcription settings.
- `outreach.config.dev.yaml` is a gitignored local dev escape hatch next to the CLI, and the only place `data_repo_path` is meaningful.
- Resolution order: `OUTREACH_DATA_REPO`, dev config, walk-up for `.agents/workspace.yaml`.
- Call transcripts are written under `<data_repo>/outreach/transcripts/`.

## Call Internals

Call flow:

```text
CLI -> Unix IPC -> daemon/server.ts
Twilio webhooks/WebSocket -> mediaStreamsBridge.ts -> GeminiLiveSession
```

Important behavior:

- `call init` starts the daemon and tunnel, then runs a preflight *inside the daemon* (`daemon.preflight` over IPC) so it validates the exact process, env, config and credentials a call will use: required `.env` variables, `config.yaml`, the rendered system instruction, the transcripts directory, Twilio auth, both caller IDs, a real Gemini Live connect, and a round trip through the public webhook URL back to this daemon's `instance_id`. Any failing check is an `INFRA_ERROR` carrying the whole report; on a fresh start init tears down only what it started and writes no `runtime.json`. `--skip-preflight` bypasses it. The preflight also runs on the "Already initialized" path — a healthy daemon is not a ready one — but there it leaves the running daemon and the existing `runtime.json` alone, so a failure has to be resolved with `teardown` + `init`. The whole run is bounded (`PREFLIGHT_BUDGET_MS`) so a stalling probe returns a partial report instead of an IPC timeout.
- The daemon lives from `call init` until `call teardown`; there is no idle self-shutdown. Ended sessions stay listenable for an hour (and at most 100 are retained), then are reaped by the same 10s interval that runs the cost guards.
- `call place` pre-connects Gemini before Twilio answers. At pickup the media-stream path waits for that same in-flight handshake (`PRECONNECT_HANDOVER_WAIT_MS`) instead of starting a second, colder one; it only builds a fresh session if the warm one never lands or has already closed. A pre-connect failure is a `preconnect_failed` transcript event, and an answered call left without a usable Gemini session is hung up with a `Gemini unavailable: …` reason instead of left silent — including the common case where Gemini accepts the socket and then closes it (bad key, rejected model, exhausted quota).
- Default calls proactively greet. The greeting is generated during ringing on the warm session and buffered. From the moment the bridge adopts that session until the buffer is flushed (`INITIAL_GREETING_DELAY_MS` after the bridge is built, which on a `handover` outcome is itself up to `PRECONNECT_HANDOVER_WAIT_MS` after the stream starts), the buffer *is* the outbound queue: audio arriving live in that window is appended to it rather than sent, so the tail of a still-streaming greeting cannot play ahead of its own opening words. Local transcript follows the same queue; if the flush finds no audio because the greeting turn is still generating, the held words go back to the batcher to be logged with the rest of that turn rather than dropped. The pre-connect session tracks real generation/turn completion, so a greeting that finished during ringing still gets its `outbound_turn_generated` and Twilio mark, and one that completed without producing audio falls back to asking for a live greeting instead of holding a silent line. An interrupt inside that window leaves the held greeting alone — nothing has played yet, so it is the callee speaking into a silent line rather than a barge-in — and a pending `end_call` waits for the flush instead of hanging up on buffered audio. An interrupt *after* the flush still clears Twilio's queue, which is correct, but the greeting is the one turn where Gemini's context and the callee's ears can disagree: its turn completed during ringing, so the model believes it introduced itself. Once per bridge, if the callee heard less than `GREETING_IDENTIFIED_MS` of it *and* more than `GREETING_CLIPPED_TAIL_MS` was discarded, the bridge sends a realtime `steer` note (logged as `call_steered`) telling the model to re-identify — realtime rather than a turn barrier, because the callee is mid-sentence. Both halves are load-bearing: a barge-in three seconds into a long greeting is someone who already knows who is calling, and a clear that only trims the tail delivered the whole thing. "Heard" is wall-clock since the flush, measured against every byte in the greeting turn — including the remainder that streams in live when the callee answers before generation finished. It deliberately does not use Twilio's `first_outbound_audio` mark as the start of playback, because a `clear` releases whatever marks Twilio still had queued, so that mark can arrive after the greeting was already discarded. Two cases are owed no re-introduction and suppress the note: a hangup already draining (the note would be spoken over the goodbye, and its turn would hold the hangup open), and an AMD verdict of machine or fax — though async AMD runs `DetectMessageEnd`, so that verdict usually lands after the first interrupt on a voicemail, and `unknown` counts as a person. Every clear that discarded more than the tail writes a `greeting_delivery` event (`heard_ms`, `greeting_ms`, `answered_by`, and an `outcome` of `re_identify_requested`/`identified`/`machine`/`hangup_draining`) whether or not the note was sent, so `call listen` shows the numbers the thresholds were judged on. A second bridge for the same call (a `send_dtmf` reconnect) does not greet again. `--wait-for-user` skips pre-generation entirely and keeps the agent silent until the callee speaks, then relies on Gemini automatic VAD for turn detection.
- Callee audio that arrives before the bridge exists — buffered during the handover wait — is dropped rather than replayed into the warm session: delivered as one burst it would trip Gemini's automatic VAD, which would answer it instead of greeting. Control frames are kept, and `--wait-for-user` keeps the audio too, since there it is the turn trigger.
- Calls always use Twilio answering-machine detection (async AMD via `/call-amd`).
- The bridge sends Twilio `mark` messages after outbound turns and defers `end_call` hangup until playback drains.
- `send_dtmf` swaps the call's TwiML, so Twilio drops the media stream and opens a replacement for the same call — one call, two bridges. The teardown of the first one deliberately does not end or finalize the session (`expectingStreamReconnect`), because finalizing mid-call writes the transcript at the DTMF and `finalizeCall`'s idempotency guard then drops every later event. A bridge that has been superseded by a newer one also leaves the session alone, covering the case where the replacement stream lands first. If the stream never returns, the 10s sweep's inactivity check ends and finalizes the call. Note that the replacement bridge builds a *fresh* Gemini session, so the agent keeps its system instruction but loses the conversation so far.

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
| `src/daemon/server.ts` | Daemon, IPC, Twilio status/webhook handling |
| `src/daemon/ipc.ts`, `src/runtime.ts` | Unix socket protocol and `runtime.json` |
| `src/daemon/sessions.ts` | In-memory call sessions and retention |
| `src/daemon/preflight.ts` | In-daemon readiness checks run by `call init` |
| `src/daemon/mediaStreamsBridge.ts` | Realtime audio bridge, playback drain |
| `src/audio/geminiLive.ts` | Gemini Live wrapper |
| `src/audio/transcode.ts` | mu-law/PCM conversion and resampling |
| `src/audio/systemInstruction.ts` | Voice-agent system instruction builder |
| `prompts/voice-agent.md` | Static half of the call system instruction |
| `src/providers/messages.ts` | Messages.app send and history |
| `src/providers/gmail.ts`, `src/providers/googleAuth.ts` | Gmail API operations and OAuth2 tokens |
| `src/providers/discord.ts` | Discord bot REST: channel list/create, message post, channel history read |
| `src/logs/sessionLog.ts` | Transcript read/write and latency event types |
| `skills/outreach/*.md` | Sharable agent-facing docs |
| `skills/contact-operator/*.md` | Sharable proactive operator contact policy |
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
