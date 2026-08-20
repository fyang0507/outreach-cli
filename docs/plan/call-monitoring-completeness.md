# Call Monitoring Completeness and Operator Question-Resolution

Tracks #105 (media capture / transcript gaps / long-turn timeouts) and #106
(operator question-resolution / degraded-monitoring gates).

## Update — 2026-08-20

An adversarial review (Opus 5) checked every citation in the first draft
against source and against the actual incident transcript
(`call_257cce0c2810.jsonl`) and found the draft's central thesis — "one
frozen timestamp causes both issues" — did not survive contact with that
transcript. This revision corrects the root-cause narrative, replaces the
G3 fix with a materially better one the first draft never considered, fixes
several implementation-breaking bugs in the original design (a type
mismatch, an unbounded-liveness failure mode, an unimplementable
dependency), and restores acceptance-criteria items that had silently
dropped. The first draft is preserved in git history
(`5403b25`) for anyone who wants the diff.

## Problem

#105 and #106 look like separate concerns — raw-audio evidence gaps vs. an
operator misjudging a live call — and, after checking the actual evidence,
they mostly *are* separate. They share a repo and a general theme
(transcript/monitoring completeness), not a single root-cause bug.

## What actually happened in the incident (verified against the raw transcript)

`call_257cce0c2810.jsonl` (all timestamps 2026-08-19):

| Time | Event |
|---|---|
| 19:33:09.821 | Callee: "can you tell me a little bit more about his experience prior to Indeed?" |
| 19:33:10.911 | Agent replies (**1.09s** later): "I don't have the specifics on his experience before Indeed right now, but I can definitely pass that question along..." |
| 19:33:33.350 | Callee: "...if you had to pick one, a singular one that you think is the most impressive?" |
| 19:33:33.873 | Agent replies (**0.52s** later) |
| 19:33:51.776 | Agent's turn 4 finishes playing. This is the last transcript activity from either party. |
| 19:34:18.133 | `call_steered`: *"There has been no substantive response **after the capability pitch**. Please give one brief, polite closing line and end the call..."* — **26.4s** after the last activity. |
| 19:34:37.108 | `call_steered`: second wrap-up nudge |
| 19:34:39.235 | `call_summary` — call ends |

Both turns flushed in about half a second to a second — the batcher was
never frozen during this call. And the steer text is scoped ("no
substantive response *after the capability pitch*"), issued after a real
26-second silence with the callee never speaking again before the call
ended. Given what the live system could see, both steers were **factually
defensible**, not a monitoring failure.

#106's actual complaint — "the operator... reported that the callee gave no
substantive response, although the final transcript contained two
substantive questions" — describes the **post-call report**, an artifact
that lives outside this repo (wherever the calling agent writes its
outcome), not the live `call_steered` text above. That report isn't
recoverable now, so its exact wording can't be re-verified, but the
transcript rules out the mechanism the first draft blamed: nothing here
shows a monitoring signal misleading the operator mid-call. The failure — as
best it can be reconstructed — is that the operator's final report didn't
re-read the two earlier, successfully-answered exchanges before summarizing
the call, exactly the check `skills/outreach/call.md:31` already asks for
and, on this evidence, didn't get.

**One thing this transcript does independently confirm is relevant to
#105:** two real transcription gaps sit right in it — `audio_cleared` at
19:33:02.726 (a barge-in) to the next remote speech at 19:33:09.821 is a
7.1s hole; `audio_cleared` at 19:33:21.937 to the next remote speech at
19:33:33.350 is an 11.4s hole. These are plausible candidates for the
"additional risk-factor question absent from the transcript" #106
separately mentions a human listener reported. See D7.

## The real latent defect (narrower than first thought)

`TranscriptBatcher` (`mediaStreamsBridge.ts:49-101`) only writes a `speech`
event on flush: speaker change, `appendDirect`, or `SILENCE_TIMEOUT_MS =
800` (`mediaStreamsBridge.ts:10`) of no new fragments (`append`, lines
58-73). `lastTranscriptTime` (`sessions.ts:86-87`) only advances on flush.
So far this matches the first draft. What the first draft missed:
`appendDirect` always flushes first (`mediaStreamsBridge.ts:76-79`), and
`finalizeActiveOutboundTurn` — called on every `generationComplete`,
`turnComplete`, and `interrupted` — calls `appendDirect` at line 666. So in
practice `lastTranscriptTime` also refreshes at the end of *every* outbound
turn, not just at a flush caused by speaker change or the idle timer.

`finalizeActiveOutboundTurn` fires when Gemini finishes **generating**, not
when Twilio finishes **playing**. Gemini generates noticeably faster than
realtime — already documented in this repo's own `CLAUDE.md` ("Gemini
generates faster than realtime when healthy") — and this call measured it
directly: turn 2 was 42.9s of audio generated in an 11.8s span (3.64x);
turn 3, 3.75x; turn 4, 3.69x. So the window in which `lastTranscriptTime`
can sit frozen is bounded by a turn's *generation* time, not how long the
audio takes to play out over the phone. At a ~3.7x ratio, tripping
`VOICEMAIL_SILENCE_MS = 90_000` (`server.ts:36`) this way needs roughly
**5.5 minutes of audio generated in one uninterrupted turn with no
interrupt, no turn boundary, and no `generationComplete` firing along the
way** — a real, latent bug, but a much narrower one than "a long agent
monologue can trip forceHangup mid-sentence." That 3.7x figure comes from
one call, four turns, one model config — treat it as a starting estimate,
not a constant, and don't scale test durations off it without re-measuring
(see Live test 2).

There's a second, more realistic way to freeze it, on the leg the ratio
above doesn't touch: a genuinely long, uninterrupted turn from the
**callee**. Callee audio isn't generated faster than realtime — it arrives
as fast as the person talks — so if they hold the floor for 90+ seconds
without a pause long enough to trip the 800ms idle flush and without the
agent interjecting, `lastTranscriptTime` freezes for the real duration of
their speech, no 3.7x cushion. This is the actual mechanism worth fixing,
and D1 (below) was about to make it *more* likely, not less — see D1.

## Signals that already exist and are just unused

| Signal | Where computed | Currently used for | Gap |
|---|---|---|---|
| `lastRemoteAudioActivityAt` (RMS-gated, `REMOTE_AUDIO_RMS_THRESHOLD = 500`) | `noteRemoteAudioActivity`/`rmsForMulaw`, `mediaStreamsBridge.ts:755-783`, updated on every inbound Twilio frame independent of the batcher | Two one-shot fields in `call latency` (`server.ts:302-307`) | Never exposed in `call listen`/`call status`. Deliberately not fed into any guard — see D2's `remote` caveat. |
| Outbound turn generation state (`activeOutboundTurn`) | `mediaStreamsBridge.ts` (private bridge field), finalized in `finalizeActiveOutboundTurn`, lines 649-675 | Audio delivery metrics only | Never exposed as an "agent is still talking" signal. Not a clean boolean in practice — see D2's `local` caveat. |
| Speaker attribution (`remote`/`local`) | Structural: `inputTranscription` vs. `outputTranscription`, `geminiLive.ts:157-163` | Already correct everywhere it's used | None — not a gap, confirmed unambiguous. Each is a permanently separate channel; there is no cross-talk to infer. |

RMS energy and turn-generation state are real, already-computed signals
worth wiring up — but neither is a clean drop-in fix for anything that
currently depends on `lastTranscriptTime`; each has its own failure mode,
detailed in D2/D3 below.

## What was ruled out

- **Real VAD** (speech-vs-non-speech classification) — overkill for this
  scope. Energy-above-threshold ("is anything audible happening") is cheap
  and already computed, but it's a much blunter instrument than initially
  presented — see D2's `remote` caveat before assuming it's a good stand-in
  for "the callee is engaged."
- **RMS energy as a G3 input** — considered and rejected: it can't
  distinguish real callee speech from hold music, a voicemail greeting, a
  TV, an open speakerphone, or echo, all of which clear the low
  `REMOTE_AUDIO_RMS_THRESHOLD = 500` (~-36 dBFS) continuously. Using it to
  suppress G3 would quietly defeat the guard's own purpose. See D3 for what
  replaces it.
- **Gemini's native `Transcription.finished` flag** — would have been a
  clean per-fragment finalization signal, but it's confirmed non-functional:
  [googleapis/js-genai#1429](https://github.com/googleapis/js-genai/issues/1429),
  opened 2026-03-23T17:03:21Z, reproduced by Google, internally filed
  2026-03-25, still open. `finished?: boolean` is declared exactly as
  described in the `@google/genai` package's `Transcription` type (pin the
  citation to the type name and package version — `"@google/genai": "^1.48.0"`
  in `package.json` — rather than a `node_modules` path, which is
  gitignored and not stable). The issue's own workaround — flush the input
  buffer when the first output fragment arrives, flush the output buffer on
  `turnComplete` — is effectively what D1 already does; worth citing as
  independent, upstream corroboration that this is the standard approach
  given the missing native signal.

## Proposed design

### D1: Flush only on genuine turn-change, tagged with why

Unchanged from the first draft in mechanism, but its safety claim needed
correcting and it now **depends on D3 landing first or alongside it** — see
below.

Drop `SILENCE_TIMEOUT_MS` (`mediaStreamsBridge.ts:10`) and the `setTimeout`
machinery in `TranscriptBatcher.append()` entirely. The transcript updates
only when a turn genuinely ends:

- **speaker change** — `append()`'s existing check, unchanged.
- **interrupted** — make this an *explicit* flush inside `handleInterrupted()`
  (`mediaStreamsBridge.ts:524-535`) rather than relying on it as a side
  effect of `clearBufferedOutboundAudio`/`finalizeActiveOutboundTurn`, both
  of which early-return when there's no pending outbound audio
  (`outboundTurnsByMark.size === 0` at :785, or `turn.audioChunks === 0` at
  :651). In practice Gemini only sends `interrupted` while generating, so
  these currently coincide — but D1 is removing the 800ms safety net, so the
  flush trigger shouldn't be an incidental side effect of an unrelated
  function.
- **explicit structured events** — `appendDirect`, unchanged.
- **call end** — `cleanup()` → `batcher.cleanup()` → `flush()`
  (`mediaStreamsBridge.ts:1025`), unchanged.

**Corrected safety claim.** The first draft argued this was risk-free
because "nothing internal to the live call depends on flush timing," citing
only the `transcriptBuffer`/`fullTranscript` arrays. That's true of the
arrays but false of `appendEvent`'s side effects: every flush also sets
`lastSpeechTime`, `lastTranscriptTime` (`sessions.ts:86-87`), and
`lastActivityTime` (`:99`) — and `lastTranscriptTime` is G3's input
(`server.ts:1173-1176`). Today, the 800ms idle flush is the *only* thing
that keeps `lastTranscriptTime` fresh during a long, uninterrupted **callee**
turn with no speaker change. Removing it without also fixing G3 would make
a real callee monologue *more* likely to false-trip the guard, not less —
directly widening the gap identified above. D3 (below) removes G3's
dependency on `lastTranscriptTime` entirely, which is what actually makes
D1 safe. **Sequence D3 before or together with D1, never after.**

Tag every flushed `speech` event with why it flushed:
`flush_reason: "turn_change" | "interrupted" | "call_ended"`.

### D2: Per-side activity telemetry on `call listen` and `call status`

Computed fresh, only on read — no new background timer. Two real,
independent problems in the first draft's version of this needed fixing:
a type bug that would have made the feature always report the worst-case
wrong answer, and an overclaim about what the signal means.

```json
"activity": {
  "remote": { "last_turn_ms_ago": 4200, "audio_on_line": "recent" },
  "local":  { "last_turn_ms_ago": 15300, "speaking": false }
}
```

- `last_turn_ms_ago`: time since that side's last flushed turn. This needs
  genuinely new, per-side fields — `lastSpeechTime` (`sessions.ts`, bumped
  for *either* speaker) can't serve this; add
  `lastRemoteTurnFlushedAt`/`lastLocalTurnFlushedAt`, set alongside the
  existing speaker-agnostic field wherever `appendEvent` records a `speech`
  event.
- **`local.speaking`** — not the raw presence of `activeOutboundTurn`.
  `activeOutboundTurn` is only cleared when Twilio's mark comes back
  (`mediaStreamsBridge.ts:808-809`), and `sendMark` silently no-ops when
  `cleaned || !streamSid` (`:683`). If a mark is ever lost — a stream
  stall, a reconnect, a dropped Twilio message — `activeOutboundTurn` stays
  non-null for the rest of the call, so this would read `speaking: true`
  forever. Gate on recency instead: `speaking = now - turn.lastAudioAtMs <=
  SOME_SHORT_WINDOW` (a second or two — audio chunks arrive continuously
  while a turn is actually generating, so a real gap is a strong signal the
  turn ended even without its mark). This also self-corrects a cleared
  (barged-over) turn, which today would otherwise read as still speaking
  until its mark eventually returns.
- **`remote.audio_on_line`** — deliberately *not* named or framed as
  `"continuing"`/engagement. `REMOTE_AUDIO_RMS_THRESHOLD = 500` on 8kHz
  mu-law is roughly -36 dBFS, a low bar that hold music, a voicemail
  greeting, a TV, an open speakerphone, road noise, or an echo of our own
  outbound audio will all clear *continuously*. On a call like that this
  field would be permanently `"recent"` and never inform anything — not
  stale by a few seconds, but structurally unable to answer the question an
  operator actually has ("is the callee engaged"). Name it for what it
  measures — raw line energy — so nobody downstream reads it as proof of
  callee engagement: `"recent"` if `now - lastRemoteAudioActivityAt <=
  ACTIVITY_LOOKBACK_MS`, `"quiet"` otherwise, `"unknown"` if
  `lastRemoteAudioActivityAt` was never set (see the type/undefined fix
  below — reporting `"quiet"` for "no data yet" would itself be a false
  "quiet" reading on every call's first second, the exact failure mode this
  design is trying to avoid).
- `ACTIVITY_LOOKBACK_MS`, proposed `5000`: `lastRemoteAudioActivityAt` is
  stored as an ISO string (`isoNow()`, `mediaStreamsBridge.ts:763`), not a
  number — the comparison needs `Date.now() - new
  Date(lastRemoteAudioActivityAt).getTime()`, not raw subtraction. A flat
  window on raw audio energy can't distinguish "mid-conversation thinking
  pause, more is coming" (observed up to ~3s of pure silence while someone
  checks calendar availability) from "a short utterance just ended and
  nothing else is happening" — both look identical: N seconds with no RMS
  activity. Bias toward the longer side, because a false `"quiet"` risks
  repeating the actual incident's failure mode (a signal read as "nothing's
  happening" when something still might be), while a stale `"recent"` only
  costs a few seconds of an operator waiting slightly longer before
  concluding real silence — but be honest about the combined cost: adding
  the documented 2-3s poll cadence on top means an operator could be
  looking at up to ~8 real seconds of accumulated staleness before acting on
  genuine silence, in a system whose own turn-taking VAD reacts in hundreds
  of milliseconds. That's a real, accepted tradeoff, not something the poll
  cadence quietly absorbs for free. This constant has no exact derivation
  and should be tuned from real call observations (see Live test 1).

### D3: Fix G3 by gating on fragment *arrival*, not flush

Replaces the first draft's `activeOutboundTurn`-gated design entirely — a
materially better fix the first draft never considered.

The defect is that `lastTranscriptTime` is stamped at *flush* time, which
can lag far behind when transcription content actually arrived. Fix it at
the source: add `session.lastTranscriptFragmentAt`, stamped inside
`handleGeminiTranscript` (`mediaStreamsBridge.ts:380-387`) on *every*
fragment from either channel, before it ever reaches the batcher. Gate G3
on this instead of `lastTranscriptTime`:

- Fixes **both** legs uniformly — local and remote — with one field and
  about three lines, not the local-only patch the first draft settled for.
- Preserves G3's original anti-voicemail semantics exactly, and for free:
  Gemini's own ASR is already doing the speech-vs-non-speech
  discrimination RMS can't provide. A voicemail greeting followed by dead
  air, or hold music with no recognizable speech, still produces no
  transcription fragments and still trips the guard at 90s, same as today.
- Immune to whatever D1 does to flush cadence, because it never touches the
  batcher at all — this is what makes D1 safe to ship (see D1).
- Doesn't need the `activeOutboundTurn`-recency fallback the first draft's
  design required, and doesn't inherit that mechanism's lost-mark failure
  mode.

No VAD, no RMS, no new capture — just moving one timestamp write earlier in
the pipeline.

### D4: `call_ended` on Twilio-initiated teardown

The gap is real — confirmed in `~/.outreach/daemon.log` for the incident:
the call ended via Twilio's `stop` event → `cleanup()`, and no
`call_ended` event exists anywhere in that transcript. But the first
draft's description of *where* the event is appended today was wrong, and
missed a real ordering hazard in the fix.

`call_ended` is appended in three places, not one:
`endTwilioCall` (`mediaStreamsBridge.ts:972-979`), **guarded** by
`!fullTranscript.some(e => e.type === "call_ended")`; `forceHangup`
(`server.ts:372-378`), **unguarded**; `handleCallHangup`
(`server.ts:1057-1063`), **unguarded**. The actual bypass set — direct
`cleanup()` calls that append nothing at all — is the WS `close` handler
(`mediaStreamsBridge.ts:229`), the Twilio `stop` handler (`:733`), and
`handleGeminiEnd` (`server.ts:646`).

Fix: append `call_ended` from inside `cleanup()` too, reusing the same
`fullTranscript.some(...)` idempotency check `endTwilioCall` already uses —
that alone prevents a double `call_ended` on the `forceHangup`/
`handleCallHangup` paths, which already append their own unguarded and then
call `cleanup()` afterward. **Ordering matters**: `cleanup()` calls
`batcher.cleanup()` (line 1025) *before* the two guards that decide whether
this is actually the end of the call — `session.bridge !== this` (a newer
bridge already owns the call, line 1039) and `session.expectingStreamReconnect`
(a `send_dtmf` stream swap in flight, line 1053). The new `call_ended`
append must sit **after** both of those `return`s, alongside where
`session.status = "ended"` is set (line 1059), not next to the unconditional
`batcher.cleanup()` call. Appending it earlier would write a mid-call
`call_ended` on every DTMF reconnect and every superseded-bridge handoff —
exactly the premature-finalization failure `CLAUDE.md`'s "Call Internals"
section already documents for this exact code path. (`CallEndedEvent.reason`
is already a free-form string, `sessionLog.ts:137-140` — no type change
needed here.)

### D5: `call listen` needs a real full-read path, and the false hint fixed

Expanded from the first draft, and now load-bearing for D6.

Two separate problems, not one:

1. **Destructive cursor.** `handleCallListen` (`server.ts:958-979`) advances
   `session.lastListenIndex` unconditionally before the response is
   confirmed delivered. If the 10s IPC round trip (`ipc.ts:4`) times out
   after the daemon computes the response, those entries are gone from
   future `listen` calls forever (they survive only in `fullTranscript`,
   used by `finalizeCall`/summary, never re-served by `listen`). Fix with
   sequence-numbered acknowledged reads plus a non-destructive peek —
   `finalizeCall` already preserves both buffers (`server.ts:355-359`), so
   this needs no new storage.
2. **There is no full-read capability at all, and `call status` claims
   there is.** `handleCallListen` only ever returns
   `transcriptBuffer.slice(lastListenIndex)` — an incremental slice. There
   is no `--since 0` / full-transcript mode. Yet `handleCallStatus`
   (`server.ts:1028`) tells a caller: *"Call has ended. Use `outreach call
   listen --id X` to get the full transcript."* That's false today — running
   `call listen` again after the call ended returns nothing, since the
   cursor is already past the end. `skills/outreach/call.md` never
   documents an alternative either (grepped for `transcripts|jsonl|full
   transcript` — no hits). This is independently a more plausible mechanism
   for a bad final report than anything else in this doc: an operator
   trying to do exactly what D6 requires — re-read the full transcript
   before reporting — hits a tool that can't do that and either gets an
   empty result or has to reconstruct the conversation from memory.

Fix: add a real full/`--since <seq>` read mode to `call listen`, and correct
the `call status` hint to match what the tool can actually do. **D6
hard-depends on this** — it isn't optional infrastructure, it's the
capability D6 assumes already exists.

### D6: Skill doc updates (`skills/outreach/call.md`) — likely the single most important fix here

On the incident evidence, this is not one of several equally-weighted
fixes — it's the one most directly aimed at what actually went wrong. No
new outreach-cli reasoning code: the judgment involved ("was this question
really answered") is inherently semantic, can only be made once the call is
over, and the operator doing the reading is itself an LLM already capable
of it. **Hard-depends on D5** — the instruction below is only followable
once a real full-transcript read exists.

- Define `audio_on_line`/`speaking` (D2) honestly, including their
  limitations (line-energy, not engagement; recency-gated, not exact) —
  don't let the skill doc imply either is proof the callee is responsive.
- Add a pre-call factual-dossier convention (permitted claims, sources,
  honest fallback) and an unknown-question fallback line so the agent says
  it will verify rather than inventing or permanently deferring.
- Require, before reporting any outcome, a full-transcript read (via D5)
  and a structured loose-end list:

  ```
  callee question | voice-agent answer/limitation | evidence completeness | required next action
  ```

  A loose end is a substantive callee question that got no answer, got an
  explicit "I don't have that," has no confirmed resolution by call end, or
  sits in a transcript-completeness gap (aided by D1/D3's more reliable
  transcript and D4/D7's more complete evidence). This directly matches
  #106's acceptance criterion for a deterministic simulated-call test — see
  the test plan below, which the first draft never wrote.
- Add a documented hook for persisting the outcome: `skills/contact-operator/`
  is the natural home for "the calling workflow updates its own canonical
  task record" (`outreach` never touches it directly, per `CLAUDE.md`'s
  transport-utility boundary) — the first draft said delivery was "the
  operator's responsibility" without saying where that responsibility is
  documented. Point to it explicitly.

### D7: `transcription_gap` event (new — evidence-driven)

Not in the first draft; added because the incident transcript itself
contains two concrete examples of exactly what #105 asks for
(`transcription_gap`, work item 2): 7.1s and 11.4s holes between an
`audio_cleared` (barge-in) event and the next remote speech landing. These
are the most plausible source of the "additional risk-factor question
absent from the transcript" a human listener reported per #106.

Log a `transcription_gap` event whenever the time between an `audio_cleared`
event and the next `speech` event on the interrupting side exceeds a
threshold (a few seconds — tune against real barge-in timing, not a guess).
Cheap, purely additive, and gives D6's loose-end check a concrete signal for
"evidence completeness" beyond "was there a `call_ended`."

## Deferred, explicitly out of scope for this doc

- **Raw audio capture** (inbound/outbound persistence) and **Twilio
  dual-channel recording** — #105's acceptance criteria items on recoverable
  audio need an explicit consent/retention/privacy design decision before
  any code; not bundled here.
- **Real VAD** — ruled out above.
- **Explicit cross-talk/overlap duration** in the transcript — a genuine
  barge-in has a real physical window where both parties' audio was present
  on the line, but the transcript is a strictly sequential event list with
  no duration/overlap fields, and reconstructing actual overlap needs raw
  audio timing. Tracked under the raw-audio-capture deferral above.
- **#105's "Long Live connection" (~10-minute Gemini connection lifetime)
  and "Long audio-only Live session" (~15-minute limit) test-matrix rows.**
  The first draft silently dropped these. They're real, explicitly
  requested by #105, and untestable statically — they need a dedicated,
  costed, extended-duration live session against the real Gemini Live API,
  independent of anything else in this doc. Deferred here, not solved, so
  it isn't silently lost a second time.

## Unit test plan

Renamed from "reproduce the long-monologue false trip" — that framing no
longer fits once D3 replaces the flush-dependent fix. G2 was never in scope
here; only G3 is addressed by this doc.

1. Extract the G3 predicate out of `server.ts` into a pure, testable
   function — today it lives inline in a module with import-time side
   effects (`ipcServer.listen`/`httpServer.listen` called at module scope),
   so no existing unit test imports it. Also extract D2's activity
   classifier (the `remote`/`local` state logic) into an importable
   function for the same reason — the first draft's plan to unit-test
   `call listen`'s `activity` block directly against `server.ts` wasn't
   actually writable.
2. Add a case to `tests/unit/` reusing `tests/unit/helpers/bridgeHarness.mjs`:
   call `handleGeminiTranscript`-equivalent fragment delivery (via
   `gemini.callbacks.onTranscript`) repeatedly with no speaker change for
   >90s of mocked time, and separately confirm audio chunks/`generationComplete`
   interleave realistically rather than testing `onTranscript` in isolation
   (a fragment-only drive doesn't exercise the real production path).
   - **Before D3:** assert `lastTranscriptTime` stays frozen at the turn's
     start and the extracted G3 predicate would fire — the red test.
   - **After D3:** assert `lastTranscriptFragmentAt` advances on every
     fragment regardless of flush state, and the predicate no longer fires.
   - Add a case with genuinely no fragments for 90+s (true dead air) and
     confirm the predicate *still* fires — proving D3 doesn't accidentally
     defeat G3's real purpose.
3. Add a case asserting an interrupt mid-turn produces a `speech` event with
   `flush_reason: "interrupted"`, not `"turn_change"`, using D1's explicit
   flush (not the incidental one).
4. Add cases for the extracted D2 classifier: `local.speaking` flips to
   `false` when a turn's last audio chunk ages out, independent of whether
   its mark ever returns (the lost-mark case). `remote.audio_on_line` reads
   `"unknown"` before any RMS activity has ever been recorded, `"recent"`
   through a ~3-4s gap (the thinking-pause case), and `"quiet"` once the gap
   exceeds `ACTIVITY_LOOKBACK_MS`.
5. Add a case for D4 reusing `tests/unit/stream-reconnect.test.mjs`'s
   existing DTMF-reconnect harness: confirm `cleanup()` during
   `expectingStreamReconnect` does **not** append `call_ended`, and that a
   real call end does, exactly once, even when `forceHangup`/
   `handleCallHangup` already appended one.

## Live-call validation (manual)

Run after D1-D4 and D7 land and unit tests are green, against a controlled
test number or consenting operator, matching #105's own request for a
long-turn/timeout test matrix under real conditions. `tests/integration/`
is the existing manual/shell-script home for this.

### Live test 1: normal conversation stays correct, and real silence reads correctly

Hold an ordinary back-and-forth call with one short natural pause (~3s) and
one clearly longer, genuine silence (10s+) where the callee intentionally
stops responding. Poll `call listen` throughout.

Assert: transcript entries land at real turn boundaries with correct
`flush_reason`; `activity.remote.audio_on_line` reads `"recent"` through
the short pause and only flips to `"quiet"` after the longer one, within
roughly `ACTIVITY_LOOKBACK_MS`; no guard misfires; the full-read path (D5)
returns the complete transcript after the call ends, matching what was
actually said. First real tuning point for `ACTIVITY_LOOKBACK_MS = 5000`.

### Live test 2: a long monologue is identified and allowed to play out

Given the corrected math above, a moderate-length monologue (90s-3m of
*played* audio) is very unlikely to have been at real risk even before this
fix, since it likely generates in well under 90s of wall-clock time at a
~3.7x ratio last measured on this call — **re-measure that ratio on this
run rather than assuming it holds**, since it came from one call/config.
Run it anyway as a real-world confirmation, but the case that actually
stresses D3 is longer: aim for 5-7 minutes of played audio, and separately
run a true-dead-air case (both sides silent, e.g. ringing into voicemail)
to confirm G3 still correctly fires there — proving the fix doesn't quietly
disable the guard's real purpose.

Assert: no G3 `forceHangup` in the daemon log during the long monologue;
`activity.local.speaking` reads `true` throughout when polled mid-turn;
`call status` reports `in_progress` throughout; the dead-air case still
gets force-hung-up at ~90s with the voicemail reason.

## Implementation order

Reordered from the first draft: the highest-confidence, most load-bearing
fixes first, telemetry after the things it depends on are true.

1. **D5** — full-read `call listen` + fix the false `call status` hint.
   Foundational: D6 cannot be followed without it, and it's independently a
   more plausible cause of the actual incident than anything the first
   draft prioritized.
2. **D3** — fix G3 via fragment-arrival timestamps. Independent of D1 and
   D2; the correct, narrow fix for the one real latent guard bug found.
3. **D7** — `transcription_gap` event. Cheap, evidence-driven, independent.
4. **D2** — activity telemetry, with the corrected types/semantics/recency
   gating.
5. **D1** — simplify the batcher to flush only on turn-change. Safe to ship
   now that D3 has removed G3's dependency on flush cadence.
6. **D4** — `call_ended` on Twilio-initiated teardown, with the ordering
   fix relative to the DTMF/superseded-bridge guards.
7. **D6** — skill doc updates, including the structured loose-end
   requirement and the `skills/contact-operator/` hook. Depends on D5.
8. Unit tests, interleaved with the corresponding design item per the test
   plan above.
9. **Live-call validation** — both live tests.

## Changes needed

| File | Change |
|---|---|
| `src/daemon/mediaStreamsBridge.ts` | D1: remove `SILENCE_TIMEOUT_MS`/idle-flush timer; add `flush_reason`; make the interrupted flush explicit in `handleInterrupted`. D3: stamp `lastTranscriptFragmentAt` in `handleGeminiTranscript`. D4: append `call_ended` in `cleanup()`, after the `expectingStreamReconnect`/superseded-bridge guards, reusing the idempotency check. |
| `src/audio/geminiLive.ts` | Note the upstream `Transcription.finished` bug inline so it isn't silently relied on later. |
| `src/logs/sessionLog.ts` | Add `flush_reason` to the `speech` event type. Add `transcription_gap` event type (D7). (`call_ended.reason` needs no change — already a free-form string.) |
| `src/daemon/sessions.ts` | Add `lastTranscriptFragmentAt` (D3), `lastRemoteTurnFlushedAt`/`lastLocalTurnFlushedAt` (D2, genuinely new — not derivable from the existing speaker-agnostic `lastSpeechTime`). |
| `src/daemon/server.ts` | D2: `activity` block in `handleCallListen`/`handleCallStatus`, replacing `silence_ms` (a breaking output-contract change — call it out). D3: extract and fix the G3 predicate to use `lastTranscriptFragmentAt`. D5: full-read mode + fix the `:1028` hint. |
| `src/commands/call/listen.ts` | D5: new CLI flag for the full/`--since <seq>` read mode. |
| `tests/unit/` | New cases per the unit test plan, reusing `helpers/bridgeHarness.mjs` and `stream-reconnect.test.mjs`. |
| `skills/outreach/call.md` | D6: honest `audio_on_line`/`speaking` definitions, factual-dossier convention, required full-transcript loose-end check before reporting outcome. |
| `skills/contact-operator/` | D6: documented hook for persisting outcome/loose-end to the calling workflow's own canonical record. |
| `CLAUDE.md` | D1/D2/D4/D5 all change behavior documented under "Call Internals" and "Command Surface" — update alongside implementation, per this repo's own "keep documentation here" convention. |

## Acceptance criteria mapping

| #105/#106 acceptance criterion (full text, not truncated) | Status after this doc |
|---|---|
| "Long-turn tests publish measured turn duration, audio bytes/duration, Twilio marks, clear events, transcript coverage, call-end reason, and which timeout (if any) fired" | Covered by the unit + live test plans |
| "The repo documents the tested provider and local timeout boundaries, including any uncertainty that remains" | **Not covered.** The 3.7x generation ratio is measured but from one call; the ~10-min/~15-min Gemini session limits are explicitly deferred, untested. Don't mark this done until those live sessions actually run. |
| "A post-call report identifies every audio/transcript mismatch and does not claim transcript completeness when a gap exists" | Partially covered by D7 (`transcription_gap`) and D6 (loose-end evidence-completeness field); no code claims blanket completeness anywhere already, so no new false claim to remove |
| Loose ends delivered as machine-readable data to the originating task | Covered by D6 — the operator's own structured report via the documented `skills/contact-operator/` hook, not new CLI code |
| Empty/delayed poll is "monitoring degraded," not proof of silence | Covered by D2/D6, with the corrected honest naming (`audio_on_line`, not "engaged") |
| A deterministic simulated-call test (factual follow-up + missing poll + later transcript containing the question → emits an unresolved loose end, not "no response") | Covered by D6's structured loose-end requirement; add this exact scenario as an eval of the skill doc, not a `tests/unit/*.test.mjs` case — it's operator/prompt behavior, not TypeScript code |
| A known spoken test phrase can be recovered from raw inbound audio even when mistranscribed | **Not covered** — needs the deferred raw-audio-capture decision |
| Twilio dual-channel recording prototype with consent/retention design | **Not covered** — deferred, needs a policy decision first |
