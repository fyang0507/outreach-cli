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
outreach call init [--skip-preflight]
outreach call place|listen|steer|status|latency|hangup|teardown
outreach sms send|history
outreach email send|history|search
outreach discord post
outreach discord channels list|create
outreach discord history
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

- `call init` starts the daemon and tunnel, then runs a preflight *inside the daemon* (`daemon.preflight` over IPC) so it validates the exact process, env, config and credentials a call will use: required `.env` variables, `config.yaml`, the rendered system instruction, the transcripts directory, Twilio auth, both caller IDs, a real Gemini Live connect, and a round trip through the public webhook URL back to this daemon's `instance_id`. Any failing check is an `INFRA_ERROR` carrying the whole report; on a fresh start init tears down only what it started and writes no `runtime.json`. `--skip-preflight` bypasses it. The preflight also runs on the "Already initialized" path — a healthy daemon is not a ready one — but there it leaves the running daemon and the existing `runtime.json` alone, so a failure has to be resolved with `teardown` + `init`. The whole run is bounded (`PREFLIGHT_BUDGET_MS`) so a stalling probe returns a partial report instead of an IPC timeout.
- The daemon lives from `call init` until `call teardown`; there is no idle self-shutdown. Ended sessions stay listenable for an hour (and at most 100 are retained), then are reaped by the same 10s interval that runs the cost guards.
- `call place` pre-connects Gemini before Twilio answers. At pickup the media-stream path waits for that same in-flight handshake (`PRECONNECT_HANDOVER_WAIT_MS`) instead of starting a second, colder one; it only builds a fresh session if the warm one never lands or has already closed. A pre-connect failure is a `preconnect_failed` transcript event, and an answered call left without a usable Gemini session is hung up with a `Gemini unavailable: …` reason instead of left silent — including the common case where Gemini accepts the socket and then closes it (bad key, rejected model, exhausted quota).
- Default calls proactively greet. The greeting is generated during ringing on the warm session and buffered. From the moment the bridge adopts that session until the buffer is flushed (`INITIAL_GREETING_DELAY_MS` after the bridge is built, which on a `handover` outcome is itself up to `PRECONNECT_HANDOVER_WAIT_MS` after the stream starts), the buffer *is* the outbound queue: audio arriving live in that window is appended to it rather than sent, so the tail of a still-streaming greeting cannot play ahead of its own opening words. Local transcript follows the same queue; if the flush finds no audio because the greeting turn is still generating, the held words go back to the batcher to be logged with the rest of that turn rather than dropped. The pre-connect session tracks real generation/turn completion, so a greeting that finished during ringing still gets its `outbound_turn_generated` and Twilio mark, and one that completed without producing audio falls back to asking for a live greeting instead of holding a silent line. An interrupt inside that window leaves the held greeting alone — nothing has played yet, so it is the callee speaking into a silent line rather than a barge-in — and a pending `end_call` waits for the flush instead of hanging up on buffered audio. A second bridge for the same call (a `send_dtmf` reconnect) does not greet again. `--wait-for-user` skips pre-generation entirely and keeps the agent silent until the callee speaks, then relies on Gemini automatic VAD for turn detection.
- Calls always use Twilio answering-machine detection (async AMD via `/call-amd`).
- The bridge sends Twilio `mark` messages after outbound turns and defers `end_call` hangup until playback drains.
- `send_dtmf` swaps the call's TwiML, so Twilio drops the media stream and opens a replacement for the same call — one call, two bridges. The teardown of the first one deliberately does not end or finalize the session (`expectingStreamReconnect`), because finalizing mid-call writes the transcript at the DTMF and `finalizeCall`'s idempotency guard then drops every later event. A bridge that has been superseded by a newer one also leaves the session alone, covering the case where the replacement stream lands first. If the stream never returns, the 10s sweep's inactivity check ends and finalizes the call. Note that the replacement bridge builds a *fresh* Gemini session, so the agent keeps its system instruction but loses the conversation so far.

## Key Files

| Path | Purpose |
|---|---|
| `src/cli.ts` | Command registration |
| `src/appConfig.ts`, `src/dataRepo.ts` | Config/workspace resolution |
| `src/commands/health.ts` | Readiness checks |
| `src/commands/call/*.ts` | Call commands |
| `src/daemon/server.ts` | Daemon, IPC, Twilio status/webhook handling |
| `src/daemon/preflight.ts` | In-daemon readiness checks run by `call init` |
| `src/daemon/mediaStreamsBridge.ts` | Realtime audio bridge, playback drain |
| `src/audio/geminiLive.ts` | Gemini Live wrapper |
| `src/providers/messages.ts` | Messages.app send and history |
| `src/providers/gmail.ts` | Gmail API operations |
| `src/providers/discord.ts` | Discord bot REST: channel list/create, message post, channel history read |
| `src/logs/sessionLog.ts` | Transcript read/write and latency event types |
| `skills/outreach/*.md` | Sharable agent-facing docs |
| `skills/contact-operator/*.md` | Sharable proactive operator contact policy |

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

`npm run build` compiles TypeScript and best-effort syncs shipped skills to the configured agent workspace. It should still succeed when no data workspace is configured.
