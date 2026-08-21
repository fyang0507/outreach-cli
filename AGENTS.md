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
```

`call steer --mode nudge` (the default) folds a realtime hint into the agent's own voice without restarting its turn; `--mode say` forces a verbatim turn.

## Configuration Model

- `.env` holds provider secrets. Calls require all five of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY`, `PERSONAL_CALLER_ID` and `TWILIO_DEFAULT_FROM_NUMBER` (`REQUIRED_CALL_ENV` in `src/config.ts`; `call init` refuses without them). Both caller IDs are required because `call place` dials from `PERSONAL_CALLER_ID` by default and from `TWILIO_DEFAULT_FROM_NUMBER` for `--from-twilio`/`--call-operator`. `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_DEFAULT_CHANNEL` are needed only for those channels.
- Runtime behavior lives at `<data_repo>/outreach/config.yaml`: operator identity, `voice_agent.default_persona`, `call.max_duration_seconds`, and the Gemini model, speech/voice, generation, thinking, VAD, turn-taking and transcription settings.
- The daemon's stdout and stderr go to `~/.outreach/daemon.log` (path echoed by `call init` and recorded in `runtime.json`), rotated once at 10MB. Without it the bridge's own logs are discarded, and a call that went wrong cannot be diagnosed after the fact.
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
- `call listen` reads `fullTranscript` directly rather than a separately-cursored buffer, so a read never mutates session state: it's a peek, not a consume, and an IPC timeout after the daemon has computed a response can never drop entries from a later read. Omitting `--since` (or passing `0`) returns the transcript from the start — this is what makes `call status`'s "use `call listen` to get the full transcript" hint actually true, including after the call has ended. A caller polling a live call carries the response's `next_since` forward as `--since <seq>` to read only what's new since its last read.
- `call listen` and `call status` both report an `activity` block — computed fresh on every read, no background timer — replacing `call listen`'s old `silence_ms` field (a breaking output-contract change): `{ remote: { last_turn_ms_ago, audio_on_line }, local: { last_turn_ms_ago, speaking } }`. `last_turn_ms_ago` is time since that side's last *flushed* turn (`null` before that side has ever flushed one), from genuinely per-side `lastRemoteTurnFlushedAt`/`lastLocalTurnFlushedAt` on the session — a single speaker-agnostic timestamp can't answer this alone. `local.speaking` is gated on recency of the active outbound turn's last audio chunk, not on the raw presence of that turn: the turn only clears once Twilio's mark returns, and a lost mark (a stream stall, a reconnect, a dropped Twilio message) would otherwise read `speaking: true` for the rest of the call; recency also self-corrects a barged-over (cleared) turn instead of waiting on a mark that may never matter again. `remote.audio_on_line` is `"recent"`/`"quiet"` on whether `lastRemoteAudioActivityAt` (RMS-gated line energy, independent of the transcript) falls within `ACTIVITY_LOOKBACK_MS`, or `"unknown"` if no activity was ever recorded — named for what it measures, not for callee engagement: hold music, a voicemail greeting, a TV, road noise or an open speakerphone all clear the low RMS threshold continuously, so this alone cannot tell any of those from a responsive callee. Both classifiers live in `callActivity.ts`, pure functions of timestamps so they're unit-testable without the daemon's module-scope side effects.
- `call place` pre-connects Gemini before Twilio answers. At pickup the media-stream path waits for that same in-flight handshake (`PRECONNECT_HANDOVER_WAIT_MS`) instead of starting a second, colder one; it only builds a fresh session if the warm one never lands or has already closed. A pre-connect failure is a `preconnect_failed` transcript event, and an answered call left without a usable Gemini session is hung up with a `Gemini unavailable: …` reason instead of left silent — including the common case where Gemini accepts the socket and then closes it (bad key, rejected model, exhausted quota).
- `preconnect_failed` only covers that pre-answer/pre-adoption window. After the bridge has adopted a session, a real runtime exception on either socket is a `runtime_error` event (`subsystem: "gemini" | "twilio_ws"`, `message`, `fatal`) instead — previously these were `console.error`-only and invisible to `call listen`/`call status`, which is exactly what left a real callee on a silent, connected line for 66+ seconds in one incident: nothing told Twilio to hang up and nothing on the operator-facing API showed a failure had occurred. `fatal: false` — from either the Gemini WS's or the Twilio WS's `onerror` — means the anomaly is logged and the call otherwise continues on its own; no hangup follows from that event alone. `fatal: true` is only ever appended by `handleGeminiEnd()` (Gemini's `onEnd`, i.e. an unexpected close), immediately before it hangs up the call with a `call_ended` reason of `"Gemini unavailable: <detail>"` — regardless of whether audio had already played earlier in the call. Treating every `onEnd` as fatal is safe because `onEnd` only ever fires for a remote/unexpected closure: `GeminiLiveSession.close()` sets `closed = true` synchronously before closing the underlying socket, and `onclose`'s own guard (`if (!this.closed)`) then skips `onEnd` whenever the daemon closed the session itself — so this path never fires on the daemon's own intentional shutdown, only on Gemini dying on its own.
- Default calls proactively greet. The greeting is generated during ringing on the warm session and buffered. From the moment the bridge adopts that session until the buffer is flushed (`INITIAL_GREETING_DELAY_MS` after the bridge is built, which on a `handover` outcome is itself up to `PRECONNECT_HANDOVER_WAIT_MS` after the stream starts), the buffer *is* the outbound queue: audio arriving live in that window is appended to it rather than sent, so the tail of a still-streaming greeting cannot play ahead of its own opening words. Local transcript follows the same queue; if the flush finds no audio because the greeting turn is still generating, the held words go back to the batcher to be logged with the rest of that turn rather than dropped. The pre-connect session tracks real generation/turn completion, so a greeting that finished during ringing still gets its `outbound_turn_generated` and Twilio mark, and one that completed without producing audio falls back to asking for a live greeting instead of holding a silent line. An interrupt inside that window leaves the held greeting alone — nothing has played yet, so it is the callee speaking into a silent line rather than a barge-in — and a pending `end_call` waits for the flush instead of hanging up on buffered audio. An interrupt *after* the flush still clears Twilio's queue, which is correct, but the greeting is the one turn where Gemini's context and the callee's ears can disagree: its turn completed during ringing, so the model believes it introduced itself. Once per bridge, if the callee heard less than `GREETING_IDENTIFIED_MS` of it *and* more than `GREETING_CLIPPED_TAIL_MS` was discarded, the bridge sends a realtime `steer` note (logged as `call_steered`) telling the model to re-identify — realtime rather than a turn barrier, because the callee is mid-sentence. Both halves are load-bearing: a barge-in three seconds into a long greeting is someone who already knows who is calling, and a clear that only trims the tail delivered the whole thing. The tail half applies only to a greeting that finished generating: a callee fast enough to talk over the opening syllable also kills generation, so the greeting is *entirely* opening syllable — barely anything discarded and barely anything heard — and judging that as a trimmed tail reads it as delivered (`call_cf7deb620076`). "Heard" is wall-clock since the flush, measured against every byte in the greeting turn — including the remainder that streams in live when the callee answers before generation finished. It deliberately does not use Twilio's `first_outbound_audio` mark as the start of playback, because a `clear` releases whatever marks Twilio still had queued, so that mark can arrive after the greeting was already discarded. Two cases are owed no re-introduction and suppress the note: a hangup already draining (the note would be spoken over the goodbye, and its turn would hold the hangup open), and an AMD verdict of machine or fax — though async AMD runs `DetectMessageEnd`, so that verdict usually lands after the first interrupt on a voicemail, and `unknown` counts as a person. Every clear that discarded more than the tail writes a `greeting_delivery` event (`heard_ms`, `greeting_ms`, `answered_by`, and an `outcome` of `re_identify_requested`/`identified`/`machine`/`hangup_draining`) whether or not the note was sent, so `call listen` shows the numbers the thresholds were judged on. A second bridge for the same call (a `send_dtmf` reconnect) does not greet again. `--wait-for-user` skips pre-generation entirely and keeps the agent silent until the callee speaks, then relies on Gemini automatic VAD for turn detection.
- Callee audio that arrives before the bridge exists — buffered during the handover wait — is dropped rather than replayed into the warm session: delivered as one burst it would trip Gemini's automatic VAD, which would answer it instead of greeting. Control frames are kept, and `--wait-for-user` keeps the audio too, since there it is the turn trigger.
- `audio_cleared` fires once per interrupt that had buffered audio to discard, marking the real-time moment the callee's speech is known to have interrupted the agent; the actual transcribed content follows later as an ordinary remote `speech` entry whenever transcription completes, and there is no fixed threshold or precomputed gap event — a reader already has both timestamps and can judge for itself whether a given gap is unusual.
- `TranscriptBatcher` has no idle-timeout flush: a pending turn is only flushed when it genuinely ends — a speaker change, an explicit flush inside `handleInterrupted` (not left as an incidental side effect of `clearBufferedOutboundAudio`/`finalizeActiveOutboundTurn`, both of which no-op when there's no outbound audio in flight), an explicit structured event (`appendDirect`), or call end (`cleanup`). Every flushed `speech` event carries `flush_reason: "turn_change" | "interrupted" | "call_ended"` saying which. This is safe only because G3 no longer reads a flush-gated timestamp — it reads `lastTranscriptFragmentAt`, stamped on every transcript fragment as it arrives — so a genuinely long, uninterrupted turn sitting unflushed here can't freeze the voicemail-silence guard's clock.
- Calls always use Twilio answering-machine detection (async AMD via `/call-amd`).
- Every outbound turn records how its audio arrived, not just that it did: `outbound_turn_generated` carries `audio_ms` (playable duration), `stream_span_ms` (wall clock from its first chunk to its last) and `max_audio_gap_ms`. When the span exceeds the duration, Gemini produced audio slower than it plays, Twilio's queue emptied mid-sentence and the callee heard the gaps — a stalled generation and a short reply are indistinguishable in the transcript otherwise. The worst turn of the call lands in the summary as `max_outbound_audio_starvation_ms` / `max_outbound_audio_gap_ms`, and `call latency` reports it as `audio_delivery`. Only audio actually sent counts: greeting audio buffered during ringing arrives while nothing is playing and is flushed in one burst, so its gaps are meaningless.
- The bridge sends Twilio `mark` messages after outbound turns and defers `end_call` hangup until playback drains.
- `send_dtmf` swaps the call's TwiML, so Twilio drops the media stream and opens a replacement for the same call — one call, two bridges. The teardown of the first one deliberately does not end or finalize the session (`expectingStreamReconnect`), because finalizing mid-call writes the transcript at the DTMF and `finalizeCall`'s idempotency guard then drops every later event. A bridge that has been superseded by a newer one also leaves the session alone, covering the case where the replacement stream lands first. If the stream never returns, the 10s sweep's inactivity check ends and finalizes the call. Note that the replacement bridge builds a *fresh* Gemini session, so the agent keeps its system instruction but loses the conversation so far.
- Raw call audio is captured for record-keeping/audit only — no STT, no analysis. Both directions' mu-law 8kHz bytes are already available with zero extra transcoding at one choke point each (`handleTwilioMessage`'s `case "media"` for the callee, `sendOutboundAudio` for the agent, which also covers the pre-generated-greeting flush) and are pushed into `CallSession.remoteAudioChunks` / `localAudioChunks`. Those arrays live on the session, not the bridge, so they span a `send_dtmf` bridge swap exactly like `fullTranscript` does. `finalizeCall` concatenates each non-empty side, wraps it in a minimal WAV (`buildMulawWav`, `WAVE_FORMAT_MULAW`, no transcoding) and writes it to `<data_repo>/outreach/transcripts/<callId>.remote.wav` / `<callId>.local.wav` before appending `call_summary` — a write failure is logged and never blocks the transcript write. The summary's `remote_audio_path`/`local_audio_path`/`remote_audio_ms`/`local_audio_ms` fields are present only when that side produced audio; a call with no media stream writes no audio files.
- `cleanup()` appends its own `call_ended` (reusing `endTwilioCall`'s idempotency check: only if `fullTranscript` doesn't already have one) so a Twilio-initiated teardown — WS `close`, Twilio's `stop` event, or Gemini ending the session — still leaves a `call_ended` event, not just the paths that call `endTwilioCall`/`forceHangup`/`handleCallHangup` directly. That append sits after both of `cleanup()`'s early returns (a superseded bridge, an in-flight `expectingStreamReconnect`), alongside where `session.status` is set to `"ended"` — appending it any earlier would write a mid-call `call_ended` on every DTMF reconnect and every superseded-bridge handoff.

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
