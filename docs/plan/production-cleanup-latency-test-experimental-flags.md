# Production cleanup: remove latency-test + experimental CLI surfaces

## Goal

Make the call subsystem production-ready by removing the benchmarking harness and
non-production CLI interfaces:

- Delete `latency-test` entirely (its only purpose was benchmarking the
  experimental low-latency path).
- Remove `--no-amd` (always enable Twilio AMD).
- Remove `--experimental-local-vad` and all bridge-side VAD machinery (rely on
  Gemini automatic VAD).

## Decisions (confirmed with user)

- **latency-test**: delete entirely. The production `latency` command (summarize a
  saved transcript) stays and covers production latency analysis.
- **`--wait-for-user`**: KEEP as a production feature (answer-and-wait, relying on
  Gemini automatic VAD). Update docs to stop calling it a "test mode".

## What stays

- `latency` command + transcript summarization.
- Twilio AMD machinery (`/call-amd` webhook, `amd_result` events) — now always on.
- `--wait-for-user` and its latency.ts wait-for-user assessment branch.
- RMS-based remote-activity tracking (`firstRemoteAudioActivityAt` /
  `lastRemoteAudioActivityAt`) — works without local VAD, feeds wait-for-user latency.

## What goes (the experimental local-VAD tier)

- `experimentalLocalVad` everywhere; `manualActivityDetection` in GeminiLiveSession.
- Bridge local-VAD state machine + constants + `VadChunk`.
- `sendActivityStart` / `sendActivityEnd` in geminiLive.
- `remote_activity_start` / `remote_activity_end` events.
- `firstRemoteAudioActivityEndedAt` + derived `first_remote_audio_activity_end_*`
  summary fields and the `local_vad_endpoint_to_playback` bottleneck.
- `autoHangupAfterFirstOutboundAudioPlayedMs` + `scheduleAutoHangupAfterGreeting`
  (only latency-test set the delay).

## File-by-file

1. **src/commands/call/latencyTest.ts** — delete.
2. **src/cli.ts** — drop import + `registerLatencyTestCommand(call)`.
3. **src/commands/call/place.ts** — drop `amd`/`experimentalLocalVad` options + opts
   fields + daemon params; keep `--wait-for-user`.
4. **src/daemon/server.ts** — always-on AMD; drop `experimentalLocalVad`,
   `autoHangupAfterFirstOutboundAudioPlayedMs`, `manualActivityDetection`, the
   `_end_` latency computations, and `experimental_local_vad` in the summary/return.
5. **src/daemon/mediaStreamsBridge.ts** — remove local-VAD constants, `VadChunk`,
   localVad fields, the `experimentalLocalVad` media branch, the four local-VAD
   methods, `durationMsForMulaw`, and `scheduleAutoHangupAfterGreeting` + its call.
6. **src/audio/geminiLive.ts** — drop `manualActivityDetection` option + branch;
   remove `sendActivityStart`/`sendActivityEnd`.
7. **src/daemon/sessions.ts** — drop `autoHangupAfterFirstOutboundAudioPlayedMs`,
   `experimentalLocalVad`, `firstRemoteAudioActivityEndedAt`.
8. **src/logs/sessionLog.ts** — remove RemoteActivityStart/End events + union
   members; remove `experimental_local_vad` + `first_remote_audio_activity_end_*`
   summary fields.
9. **src/commands/call/latency.ts** — drop the `_end_` branches in
   `userSpeechToAudibleResponse` and the `local_vad_endpoint_to_playback` bottleneck.
10. **Docs** — CLAUDE.md, README.md, AGENTS.md, skills/outreach/SKILL.md, .env.example:
    remove latency-test / --no-amd / --experimental-local-vad; reword wait-for-user
    as a production mode; drop release-checklist latency-test lines.

## Verification

- `npm run build` (tsc clean).
- `node dist/cli.js call place --help` shows no `--no-amd` / `--experimental-local-vad`.
- `node dist/cli.js call --help` shows no `latency-test`.
- `node dist/cli.js call latency --help` still works.
- grep confirms zero remaining references to removed identifiers.
</content>
</invoke>
