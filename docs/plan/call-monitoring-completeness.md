# Call Monitoring Completeness and Operator Question-Resolution

Tracks #105 (media capture / transcript gaps / long-turn timeouts) and #106
(operator question-resolution / degraded-monitoring gates).

## Problem

#105 and #106 look like separate concerns — raw-audio evidence gaps vs. an
operator misjudging a live call — but investigation traced both to the same
bug, plus a handful of independent gaps found along the way.

**The incident.** During `call_257cce0c2810`, the callee asked twice about
Fred's pre-Indeed experience (`19:33:09`) and his most impressive capability
(`19:33:33`) — both real questions, the first answered with an explicit
"I don't have that" limitation, never corrected. The operator then issued two
`call_steered` wrap-up nudges (`19:34:18`, `19:34:37`) asserting "no
substantive response," directly contradicted by the saved transcript, and
reported the call that way afterward.

## Root cause: one timestamp gates two different guards

`TranscriptBatcher` (`mediaStreamsBridge.ts:49-100`) only writes a `speech`
event on flush, and only flushes on speaker change, an explicit
`appendDirect`, or `SILENCE_TIMEOUT_MS = 800` ms (`mediaStreamsBridge.ts:10`)
of no new fragments (`append`, lines 58-73). `session.lastTranscriptTime` /
`lastSpeechTime` (`sessions.ts:84-97`) only advance when that flush runs.

Gemini's `outputTranscription`/`inputTranscription` fragments
(`geminiLive.ts:157-163`) arrive continuously during one long, densely
transcribed turn, each one resetting the 800ms timer — so during a single
uninterrupted monologue, the batcher never flushes and the timestamp freezes
at the turn's start. That one frozen timestamp feeds two different consumers:

- **#105:** `VOICEMAIL_SILENCE_MS = 90_000` (`server.ts:36`, checked at
  `1172-1178`) compares "now" against it. A long agent monologue can trip
  `forceHangup` mid-sentence — a false voicemail hangup during genuine,
  active conversation. `docs/done/call-cost-guardrails.md:49` specified
  "last time a meaningful transcript entry was added" without accounting for
  batching lag on a single turn — a real defect in the original G3 design,
  not just missing observability.
- **#106:** `call listen`'s `silence_ms` field (`server.ts:964`, `Date.now()
  - session.lastSpeechTime`) has the identical flaw. During dense
  transcription or an IPC hiccup, this can't be told apart from genuine
  callee silence — the most plausible mechanism behind the operator reading
  the incident call as unresponsive.

## Signals that already exist and are just unused

| Signal | Where computed | Currently used for | Gap |
|---|---|---|---|
| `lastRemoteAudioActivityAt` (RMS-gated, `REMOTE_AUDIO_RMS_THRESHOLD = 500`) | `noteRemoteAudioActivity`/`rmsForMulaw`, `mediaStreamsBridge.ts:755-779`, updated on every inbound Twilio frame independent of the batcher | Two one-shot fields in `call latency` (`server.ts:293-306`) | Never exposed in `call listen`/`call status`, never feeds G2/G3 |
| Outbound turn generation state (`activeOutboundTurn`) | `mediaStreamsBridge.ts` (private bridge field), finalized in `finalizeActiveOutboundTurn`, lines 649-675 | Audio delivery metrics only | Never exposed as a simple "agent is still talking" boolean |
| Speaker attribution (`remote`/`local`) | Structural: `inputTranscription` vs. `outputTranscription`, `geminiLive.ts:157-163` | Already correct everywhere it's used | None — not a gap, confirmed unambiguous. Each is a permanently separate channel; there is no cross-talk to infer. |

Both existing timestamps mean neither the RMS energy signal nor the
outbound-turn-in-progress signal need to be built from scratch — they need to
be wired to the places that currently rely on the frozen batcher timestamp
instead.

## What was ruled out

- **Real VAD** (speech-vs-non-speech classification) — overkill for what
  this needs. Energy-above-threshold ("is anything audible happening") is
  sufficient for operator visibility; it just can't distinguish real speech
  from hold music, which only matters for G3's original anti-voicemail
  intent, not for the operator-visibility use case this doc is scoped to.
- **Gemini's native `Transcription.finished` flag** — would have been a
  clean per-fragment finalization signal, but it's confirmed non-functional:
  [googleapis/js-genai#1429](https://github.com/googleapis/js-genai/issues/1429),
  filed 2026-03-23, reproduced and internally filed by Google, still open.
  The field is documented (`node_modules/@google/genai/dist/genai.d.ts:10552-10557`)
  but the server never sets it on either transcription channel. Do not build
  on it; the code should note the upstream issue so a future reader doesn't
  assume it was never worth using. `turnComplete` is a real, working signal
  but only fires once at the very end of a whole generation — it doesn't
  give incremental segments during a multi-minute monologue.

## Proposed design

### D1: Flush only on genuine turn-change, tagged with why

Drop `SILENCE_TIMEOUT_MS` (`mediaStreamsBridge.ts:10`) and the `setTimeout`
machinery in `TranscriptBatcher.append()` entirely — no punctuation
heuristics, no idle-timer guessing. The transcript updates only when a turn
genuinely ends:

- **speaker change** — `append()`'s existing check (`pending.speaker !==
  speaker`), unchanged.
- **interrupted** — the flush that already happens inside
  `handleInterrupted()` (`mediaStreamsBridge.ts:524-535`, via
  `clearBufferedOutboundAudio`'s call to `appendDirect`, which flushes before
  appending `audio_cleared`). This isn't a timing hack — Gemini's own
  `interrupted` control signal (`geminiLive.ts:165-167`) is itself a
  turn-ending event, often arriving before the first transcribed word of the
  new speaker would.
- **explicit structured events** — `appendDirect` (DTMF, `call_ended`, etc.),
  unchanged.
- **call end** — `cleanup()` → `batcher.cleanup()` → `flush()`
  (`mediaStreamsBridge.ts:1025`), unchanged.

Nothing internal to the live call depends on flush timing — the only
consumers of `transcriptBuffer`/`fullTranscript` are `call listen`
(`server.ts:967`) and finalize/summary (`server.ts:1005`); steering is
operator-driven, not automated off recent transcript text. So this is purely
a display simplification, with no correctness risk: the final pending turn
of a call always flushes regardless, via the unconditional `cleanup()` call.

One consequence worth being explicit about: during one long, uninterrupted
monologue, the transcript itself still shows nothing new until the turn
actually ends — `lastTranscriptTime` still freezes at the turn's start, same
as today. That's fine and intentional: liveness during that stretch is D2's
job (real, continuously-updated signals), not the transcript's. D1 no longer
needs to double as a fix for G3 — see D3.

Tag every flushed `speech` event with why it flushed:
`flush_reason: "turn_change" | "interrupted" | "call_ended"`. Today an
interrupted flush is silent about *why* it happened; a caller has to infer
"this was a barge-in" from the adjacent `audio_cleared`/
`outbound_turn_generated(reason: "interrupted")` events. This makes a
cut-off turn self-describing without needing adjacency inference, matching
what the audio side already tracks via `OutboundTurn.cleared`.

### D2: Per-side activity telemetry on `call listen`

Replace the flat `silence_ms` field (`server.ts:964`) with a per-side block,
computed fresh, only inside `handleCallListen` — no new background timer.
The underlying signals already update continuously and cheaply regardless
(RMS per inbound frame, `activeOutboundTurn` as turns start/finalize); only
the classification into `state` is new, and it's computed on read:

```json
"activity": {
  "remote": { "last_turn_ms_ago": 4200, "state": "continuing" },
  "local":  { "last_turn_ms_ago": 15300, "state": "silent" }
}
```

- `last_turn_ms_ago`: time since that side's last flushed turn (post-D1,
  turn-granular — the transcript only updates on real turn changes now).
- `local.state`: `activeOutboundTurn` presence, no window — exact, since we
  generated that audio ourselves. Either a turn is actively
  generating/playing or it isn't.
- `remote.state`: `"continuing"` if `now - lastRemoteAudioActivityAt <=
  ACTIVITY_LOOKBACK_MS` (proposed `5000`), else `"silent"`.

**Why 5000ms, not something tighter:** a flat window on raw audio energy
cannot distinguish "mid-conversation thinking pause, more is coming" (e.g.
someone checking calendar availability — observed up to ~3s of pure silence
before a filler sound resumes) from "a short utterance just ended and
nothing else is happening." Both look identical: N seconds with no RMS
activity. Too short a window (an early candidate was ~1.5s) reads a normal
thinking pause as `"silent"` — a false negative, which is exactly the
failure mode from the actual incident (the operator prematurely concluding
"no response"). Too long a window makes `"continuing"` linger long after a
genuinely short turn ends — stale, but only costs a few seconds of an
operator waiting slightly longer before concluding real silence, and that
cost is largely absorbed by the documented 2-3s poll cadence
(`skills/outreach/call.md`). Given that asymmetry, bias toward the longer
side: 5000ms gives margin above the observed ~3s thinking-pause case. The
window's behavior is self-adjusting at the low end for free — early in a gap
(elapsed time under 5s) the comparison is checking the *entire* elapsed gap,
since there's nothing further back to look at; only once the gap exceeds 5s
does it matter that older activity has aged out. No separate "early call"
branch is needed. This constant has no exact derivation and should be
tuned from real call observations later; it's deliberately conservative for
now given the cost asymmetry.

This gives the operator exactly: "callee's last full turn was 4s ago, and
they're still making sound since" vs. "...and it's gone quiet" — the
distinction #106 needs between monitoring-degraded and genuinely-silent.

### D3: Fix G3's local leg only — leave the remote leg alone

Gate the 90s guard on `activeOutboundTurn` for its "audio still flowing"
leg, in addition to (not instead of) the existing `lastTranscriptTime`
check: if the agent is actively mid-turn, never fire G3. That's unambiguous
— it's audio we generated ourselves, definitely not voicemail or hold
music — and it fully fixes the scenario this whole doc set out to
reproduce: a long *agent* monologue false-tripping the guard.

Deliberately **not** using `lastRemoteAudioActivityAt` here, even though D2
computes it: RMS energy can't tell a real, long *callee* monologue apart
from hold music or a voicemail greeting looping audio — that discrimination
is G3's entire original purpose (`docs/done/call-cost-guardrails.md`, G3).
Feeding the same energy signal into the guard would silently defeat the one
thing it exists to catch. So a genuinely long, uninterrupted callee turn
with no interruption remains a known, accepted gap in G3 — same category as
the "no VAD" trade-off above — rather than something this doc's remote-side
telemetry should be repurposed to paper over. If real incidents later show
that gap matters, revisit with a purpose-built check then; don't preempt it
by weakening G3 now.

### D4: `call_ended` on Twilio-initiated teardown

`call_ended` is only ever appended inside `endTwilioCall`
(`mediaStreamsBridge.ts:959-980`), guarded by an idempotency check. Every
direct `cleanup()` call — Twilio `stop` event (line 733), WS `close` (line
229), and a few internal paths (lines 646, 995, 998) — bypasses it entirely.
The incident transcript has no `call_ended` at all as a result, so neither
the operator nor a later reader can tell whether a wrap-up steer landed, was
ignored, or was moot because the callee had already hung up. Fix: append
`call_ended` from the `cleanup()` path too, with a reason distinguishing
Twilio-initiated teardown from an explicit hangup.

### D5: Non-destructive `call listen` cursor

`handleCallListen` (`server.ts:958-978`) advances `session.lastListenIndex`
unconditionally before the response is confirmed delivered. If the 10s IPC
round trip (`ipc.ts:4`) times out after the daemon computes the response,
those entries are gone from future `listen` calls forever (they survive only
in `fullTranscript`, used by `finalizeCall`/summary, never re-served by
`listen`). Replace with sequence-numbered acknowledged reads plus a
non-destructive peek, so a dropped response doesn't permanently lose
transcript coverage.

### D6: Skill doc updates (`skills/outreach/call.md`)

The doc already says (line 31) to use "the final transcript and summary" as
evidence — the incident violated that instruction, so part of the fix is
procedural, not just new capability. No new outreach-cli code — the
judgment involved ("was this question really answered") is inherently
semantic, can only be made once the call is over, and the operator doing
the reading is itself an LLM already capable of it; mechanizing it as a
deterministic heuristic inside this repo would both overstep the CLAUDE.md
utility boundary ("no reply watchers, no callback agents") and do the
judgment worse than the operator already can.

- Define "monitoring degraded" (D2's `state: "continuing"` with no new
  turn) vs. "callee silent" (`state: "silent"`) explicitly, replacing the
  current undifferentiated silence read.
- Add a pre-call factual-dossier convention (permitted claims, sources,
  honest fallback) and an unknown-question fallback line so the agent says
  it will verify rather than inventing or permanently deferring.
- Require a final-transcript loose-end check before reporting any outcome —
  a re-check step, not a new capability, since the instruction to use the
  final transcript already existed and wasn't followed. Require the
  operator to produce, from the transcript it already gets via
  `call listen`, a structured loose-end list before reporting any outcome:

  ```
  callee question | voice-agent answer/limitation | evidence completeness | required next action
  ```

  A loose end is a substantive callee question that got no answer, got an
  explicit "I don't have that," has no confirmed resolution by call end, or
  sits in a transcript-completeness gap (aided by D1's clean turn boundaries
  and D4's reliable `call_ended`, which make the transcript itself more
  trustworthy). Delivery to the originating task/workflow is the operator's
  responsibility per #106, not this repo's — `outreach` stays a transport
  utility and never touches the canonical task record itself.

## Deferred, explicitly out of scope for this doc

- **Raw audio capture** (inbound/outbound persistence) and **Twilio
  dual-channel recording** — #105's acceptance criteria items on recoverable
  audio need an explicit consent/retention/privacy design decision before any
  code; not bundled here.
- **Real VAD** — ruled out above.
- **Explicit cross-talk/overlap duration** in the transcript — a genuine
  barge-in has a real physical window where both parties' audio was present
  on the line (whatever Twilio already played before a `clear` message
  landed isn't un-played), but the transcript is a strictly sequential event
  list with no duration/overlap fields, and reconstructing actual overlap
  needs raw audio timing. Tracked under the raw-audio-capture deferral above,
  not solved by D1-D6.

## Unit test plan: reproduce the long-monologue false trip

This is the fake-harness, mocked-timer version of "recreate the experience
with a long monologue": have the voice agent produce a multi-minute
continuous reply and watch the G3 guard's decision. See "Live-call
validation" below for the real-provider counterpart.

1. Extract the G2/G3 predicate out of `server.ts` into a pure, testable
   function — today it lives inline in a module with import-time side
   effects (starts the HTTP server and IPC socket), so no existing unit test
   imports it.
2. Add a case to `tests/unit/` reusing `tests/unit/helpers/bridgeHarness.mjs`
   (fake Twilio WS + fake Gemini session + mocked timers, already used by
   `outbound-audio-delivery.test.mjs` for multi-chunk turns): drive
   `gemini.callbacks.onTranscript("local", ...)` for >90s of mocked time with
   no speaker change, confirming `lastTranscriptTime` stays frozen at the
   turn's start throughout — expected under the simplified D1, not a bug to
   fix there.
   - **Before D3:** assert the extracted G3 predicate would fire on the
     frozen timestamp alone — the red test reproducing the bug.
   - **After D3:** assert the predicate no longer fires once it's gated on
     `activeOutboundTurn` too, despite `lastTranscriptTime` still being
     frozen. Add a separate case confirming a long, uninterrupted *callee*
     monologue with no matching agent turn still trips the guard —
     documenting the accepted gap from D3, not a regression.
3. Add a case asserting an interrupt mid-monologue produces a `speech` event
   with `flush_reason: "interrupted"`, not `"turn_change"`.
4. Add a case asserting `call listen`'s `activity.local` reports
   `"continuing"` during a long agent turn with no flushed turn yet (exact,
   via `activeOutboundTurn`).
5. Add a case asserting `call listen`'s `activity.remote` reports
   `"continuing"` through a ~3-4s gap in RMS activity (the thinking-pause
   case) and `"silent"` once the gap exceeds `ACTIVITY_LOOKBACK_MS`.

## Live-call validation (manual)

The unit tests above prove the logic against mocked timers and a fake
Gemini/Twilio; they can't prove the fix holds against real provider timing,
real ASR behavior, or real human pauses. Run these after D1-D3 land, against
a controlled test number or consenting operator, matching #105's own request
for a long-turn/timeout test matrix under real conditions rather than
simulated ones. `tests/integration/` is already the manual/shell-script home
for this kind of test in the repo.

### Live test 1: normal conversation stays correct, and real silence reads correctly

Hold an ordinary back-and-forth call, but deliberately include one short
natural pause (~3s — e.g. "let me check my calendar") and one clearly longer,
genuine silence (well past `ACTIVITY_LOOKBACK_MS`, e.g. 10s+) where the
callee intentionally stops responding. Poll `call listen` throughout,
including immediately after each deliberate pause.

Assert: transcript entries land at real turn boundaries with correct
`flush_reason` values, matching what was actually said (no fragmentation, no
dropped turns vs. D1's simplified flush); `activity.remote.state` reads
`"continuing"` through the short pause and only flips to `"silent"` after
the longer one, within roughly `ACTIVITY_LOOKBACK_MS` of the callee actually
stopping; no guard misfires anywhere in the daemon log; the final transcript
and `call_summary` match what was actually said. This is also the first real
tuning point for `ACTIVITY_LOOKBACK_MS = 5000` — adjust it if real pauses
show it reading wrong in either direction.

### Live test 2: a long monologue is identified and allowed to play out

Once connected, steer or prompt the agent into a long, continuous,
uninterrupted reply, reusing #105's own proposed durations (90s, 3m, and
ideally 7m) with the callee staying connected and not interrupting.

Assert: the call is not force-hung-up mid-monologue (no G3 `forceHangup`/"no
conversational activity detected" in the daemon log or transcript);
`call status` reports `in_progress` throughout; `activity.local.state` reads
`"continuing"` for the full duration when polled mid-turn; the monologue's
full text lands in the transcript once it genuinely ends, tagged
`flush_reason: "turn_change"` (or `"call_ended"` if the call ends right
after); total call duration is not truncated near the 90s mark. This is the
direct, real-provider version of "recreate the experience" from the top of
this doc, and produces the measured-duration evidence #105's acceptance
criteria ask for.

## Implementation order

1. **D2** — wire up the already-existing `lastRemoteAudioActivityAt`/
   `activeOutboundTurn` signals as `call listen` telemetry. Independent of
   D1; the highest-leverage piece since it's almost entirely plumbing.
2. **D3** — fix G3's local leg using `activeOutboundTurn`. Depends on D2's
   plumbing for the field, not on D1's flush behavior, and does not touch
   G3's remote leg.
3. **Test plan steps 1-2** — red test against current G3 behavior, green
   after D3 lands.
4. **D1** — simplify the batcher to flush only on turn-change, drop the idle
   timer, add `flush_reason`. Independent of D2/D3 — a transcript
   cleanliness/evidence improvement, not a guard fix.
5. **D4** — `call_ended` on Twilio-initiated teardown. Small, independent,
   closes an evidence gap relevant to both issues.
6. **D5** — non-destructive `call listen` cursor. Independent, can slot in
   anytime.
7. **D6** — skill doc updates, including the structured loose-end
   requirement. Sequenced last since it references D2's `state` field
   directly.
8. **Live-call validation** — both live tests, run once D1-D3 are in and the
   unit tests are green. Confirms the fix against real provider timing and
   real human pauses, and is the first real tuning point for
   `ACTIVITY_LOOKBACK_MS`.

## Changes needed

| File | Change |
|---|---|
| `src/daemon/mediaStreamsBridge.ts` | D1: remove `SILENCE_TIMEOUT_MS`/idle-flush timer from `TranscriptBatcher`; add `flush_reason` (`turn_change`/`interrupted`/`call_ended`) to `speech` events. D4: append `call_ended` from `cleanup()`. |
| `src/audio/geminiLive.ts` | Note the upstream `Transcription.finished` bug inline so it isn't silently relied on later. |
| `src/logs/sessionLog.ts` | Add `flush_reason` to the `speech` event type; add `call_ended` reason variants. |
| `src/daemon/sessions.ts` | Expose `activeOutboundTurn` presence (used by D2 `local` and D3) and `lastRemoteAudioActivityAt` read access (used by D2 `remote` only, not D3). |
| `src/daemon/server.ts` | D2: `activity` block in `handleCallListen`, replacing `silence_ms`; define `ACTIVITY_LOOKBACK_MS = 5000`. D3: extract the G3 predicate and add the `activeOutboundTurn` escape hatch, leaving the remote leg unchanged. D5: sequence-numbered/non-destructive listen cursor. |
| `tests/unit/` | New long-monologue and interrupt-tagging cases per test plan, reusing `helpers/bridgeHarness.mjs`. |
| `skills/outreach/call.md` | D6: monitoring-degraded vs. silent definitions, factual-dossier convention, required structured loose-end check before reporting outcome. |

## Acceptance criteria mapping

| #105/#106 acceptance criterion | Status after this doc |
|---|---|
| Long-turn tests publish measured turn duration, transcript coverage, which timeout fired | Covered by the test plan |
| Repo documents tested provider/local timeout boundaries | Covered — this doc plus the js-genai#1429 reference |
| Loose ends delivered as machine-readable data to the originating task | Covered by D6 — the operator's own structured report, not new CLI code |
| Empty/delayed poll is "monitoring degraded," not proof of silence | Covered by D2/D6 |
| A known spoken test phrase can be recovered from raw inbound audio even when mistranscribed | **Not covered** — needs the deferred raw-audio-capture decision |
| Twilio dual-channel recording prototype with consent/retention design | **Not covered** — deferred, needs a policy decision first |
