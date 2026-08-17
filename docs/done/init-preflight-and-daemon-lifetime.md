# Init Preflight, Preconnect Handover, and Daemon Lifetime

Shipped 2026-08-16 (issue #96 plus the readiness work around it). The goal was a single guarantee: **if `call init` returns `ready`, a subsequent `call place` failure is about the destination number or the callee — not about setup, credentials, the tunnel, or the daemon.** Three things stood between the code and that sentence: a preconnect handover that never happened, an `init` that reported ready without checking anything, and a daemon that could walk away five minutes after it was started.

## Part 1 — Issue #96: the handover window was zero

### Problem

`call place` warms a Gemini Live session while Twilio dials, so the model is ready the moment the callee picks up. Every answered call still paid a second, cold handshake after pickup, and the greeting could only be requested after that second handshake resolved.

### Why (root cause)

The preconnect body closed its own session when the media stream had already started:

```ts
await geminiSession.connect();
if (session.status === "ended" || session.mediaStreamStartedAt || session.bridge) {
  geminiSession.close();
  return null;   // <- discarded
}
```

`session.mediaStreamStartedAt` is assigned **synchronously** in the media-stream `start` handler, before the first `await` in that handler. So by the time the pickup path reached its 500ms wait, the flag was always set, and any preconnect that had not *already* resolved would close itself and resolve `null`. The two states — "already resolved" (fast path, never waits) and "will be discarded" (wait can only fail) — are exhaustive, so:

| Piece | Intent | Actual |
|---|---|---|
| `PRECONNECT_PICKUP_WAIT_MS = 500` | Catch a handshake that is nearly done | Could only ever resolve `undefined`; pure dead air of `min(time-until-preconnect-settles, 500ms)` before the fallback could even start |
| `mediaStreamStartedAt` term in the guard | "Nobody will claim this session anymore" | Fired precisely when the pickup path *wanted* the session |
| `latePreconnect` orphan reaper | Close a preconnect that lands late | Unreachable: the promise always resolved `null` |
| `bridge.connectGemini()` on the pickup path | Fallback | The only path — a full second `ai.live.connect()` handshake after answer, on every call |

### Before / after

```text
Before
  place    ── calls.create ──────────────┐
           └─ gemini connect (in flight) │
  answer   ── start event ───────────────┴─ mediaStreamStartedAt = now
           ── wait up to 500ms ───────────── always returns nothing
           ── gemini connect #2 (cold) ───── greeting requested only after this
  preconnect resolves later ─ self-closes, discarded

After
  place    ── calls.create ──────────────┐
           └─ gemini connect (in flight) │
  answer   ── start event ───────────────┘
           ── warm session ready?  yes ──── adopt it            (outcome: "warm")
                                   no  ──── await THE SAME handshake, ≤1500ms
                                             landed  → adopt    (outcome: "handover")
                                             didn't  → abandon + fresh connect
                                                              (outcome: "fresh_fallback")
```

### Fix

| Change | Where |
|---|---|
| Guard keys on an explicit `session.preconnectAbandoned` instead of `mediaStreamStartedAt` — a started stream now means the bridge *wants* the warm session | `server.ts` preconnect body |
| Pickup awaits the single in-flight handshake (`PRECONNECT_HANDOVER_WAIT_MS = 1500`) instead of racing it with a second connection, then re-reads `session.preConnectedGemini` once to adopt a preconnect that landed in the same tick as the timeout | `server.ts:44`, media-stream start handler |
| `usableWarmSession()` rejects an `isClosed` session on both the fast path and the post-wait result. A warm session that died during ringing used to be adopted anyway: the bridge skips its own connect, every send silently no-ops, and the call greeted from the buffer and then went deaf until the 90s sweep | `server.ts:428` |
| `abandonPreconnect()` closes the warm session and blocks a late arrival. Called from every path that gives up without building a bridge: missing API key, any throw after the start event, WS close before initialization, WS close *during* the handover wait, `forceHangup`, `handleCallHangup` | `server.ts:390` |
| On `fresh_fallback`, the pre-generated greeting buffers are cleared so the fresh session greets for itself instead of replaying audio it has no memory of producing | media-stream start handler |
| A callee who hangs up *during* the handover wait ends the call right there. The session was already `in_progress`, so returning bare would have left `status`/`listen` reporting a live call, `teardown` refusing, and the 60s sweep eventually relabelling it as an inactivity hangup | media-stream start handler |
| Callee audio buffered during the wait is dropped before the bridge replays it (control frames kept), so a "hello?" burst cannot trigger Gemini's VAD at the same moment we greet. Kept intact for `--wait-for-user`, where that audio *is* the turn trigger | `server.ts:444` |
| A failed Gemini connect is now a `preconnect_failed` transcript event, and a call left with no usable session is hung up with reason `Gemini unavailable: …` rather than held open in silence for 60s | `server.ts`, `sessionLog.ts` |
| Gemini's *dominant* failure shape is not a rejected `connect()` — a bad key, a rejected model and an exhausted quota all open the socket and close it moments later. So a Live session that ends before the callee ever heard audio is treated the same as a failed connect: `preconnect_failed` with the server's close reason, then a hangup carrying it. A pre-connect that dies while the call is still ringing records the same event and stays recoverable (pickup falls back to a fresh session) | `mediaStreamsBridge.ts` `handleGeminiEnd`, `server.ts` preconnect `onEnd` |

Why 1500ms and not longer: the wait is serial, so a genuinely *hung* handshake costs the whole bound in silence before a cold connect can start. The bound is sized to the p95 handshake — long enough to catch a slow one, short enough that a stuck one is not the callee's problem.

### Measuring it

The outcome is recorded three ways, so this is not a blind swap:

- transcript event `preconnect_handover` `{outcome, waited_ms}`
- `call_summary.preconnect_handover` and `call_summary.preconnect_handover_wait_ms` (back-filled from the event for partial transcripts)
- `outreach call latency` diagnoses `gemini_preconnect_handover_failed` (outcome `fresh_fallback`) and `gemini_preconnect_handover_wait` (wait ≥250ms and ≥ half of stream-start-to-audible-greeting), both attributed *before* the greeting-pregeneration symptoms they cause

Expected shape: `warm` on nearly every call, `handover` on a slow handshake, `fresh_fallback` only on a failed or hung one. Frequent `handover` with a large wait means Gemini handshake latency, not this code path.

## Part 2 — `call init` preflight

### Problem

`init` verified that Twilio credentials were *present* in `.env`, that ngrok produced a URL, and that the daemon answered `GET /health` on localhost. Everything else — whether the credentials work, whether the caller ID is verified, whether the config parses, whether the Gemini key or model is accepted, whether the public tunnel URL still reaches *this* daemon — was discovered at call time, by a call that had already started ringing.

Two structural reasons a CLI-side check could not close this:

- The daemon has its own env snapshot (taken at `fork`), its own cwd, and its own resolved data repo. The CLI can only guess at them.
- On the "Already initialized" path `init` does not fork at all, so there is no state it can assume. `/health` returned `{status, calls}` — nothing to cross-check.

So the preflight runs **inside the daemon** (`daemon.preflight` over the Unix socket — IPC, not HTTP, because the HTTP server is published to the internet through the tunnel) and `init` reports what it returns. Running there also warms the DNS/TLS paths the real call uses.

### The checklist

Checks run in order, a failure never aborts the rest, and a dependent check reports `skipped` rather than repeating a root cause. Each one exists to delete a specific place-time failure:

| Check | What it does | Place-time failure it removes |
|---|---|---|
| `env` | The 5 variables a call needs (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY`, `PERSONAL_CALLER_ID`, `TWILIO_DEFAULT_FROM_NUMBER`) | Dialing with an empty caller ID, or a daemon that cannot construct a client. Both caller IDs are required: `place` uses `PERSONAL_CALLER_ID` by default and `TWILIO_DEFAULT_FROM_NUMBER` for `--from-twilio`/`--call-operator` |
| `config` | `loadAppConfig()` — data-repo resolution and `config.yaml` parse. It reports the config the daemon is *using*, which is memoized for the daemon's lifetime, so a `config.yaml` edited since startup is neither re-parsed nor picked up until `teardown` + `init` | `call place` failing on an unresolvable data repo or malformed YAML |
| `system_instruction` | Renders the voice-agent instruction from `prompts/voice-agent.md` | A missing/unreadable prompt file killing the call at placement |
| `transcripts_dir` | `ensureDataDirs()` on `<data_repo>/outreach/transcripts`, then writes and removes a probe file — `mkdir -p` resolves happily on a directory that exists but cannot be written to | A completed call losing its entire transcript at write time — the one artifact the call exists to produce |
| `twilio_auth` | Fetches the account; requires `status === "active"` | A 401 or a suspended/closed account surfacing as a failed call |
| `caller_ids` | `TWILIO_DEFAULT_FROM_NUMBER` is on the account; `PERSONAL_CALLER_ID` is a verified caller ID or owned | Twilio error 21210/21212 at call time. Presence checks cannot catch this — an unverified number is well-formed and non-empty |
| `gemini_live` | Opens a real Live session, waits 750ms, fails if it closed, reports the server's close reason | An invalid API key or a rejected `gemini.model` / `voice_name` surfacing as a call that answers and stays silent. `connect()` *resolves* for a bad key — the rejection arrives as a close ~50ms later, so connect-then-close alone is a false green |
| `webhook` | `GET <public webhook URL>/health` and compares `instance_id` against this process | The single cheapest way to break the guarantee: ngrok's free tier re-randomizes the hostname on restart, so a perfectly healthy daemon can sit behind a URL that resolves to nothing, or behind another daemon. Twilio's status callbacks and the `wss` stream URL would both go nowhere |

Plus `daemon_startup`, prepended when the startup preload failed. The daemon now preloads config + prompt + transcripts dir at startup, but a failure there must not stop it from listening: `/health` answering is what lets the preflight name the real cause instead of the CLI guessing "daemon failed to start". A stored startup error is re-attempted before being reported, so fixing the config does not require a teardown.

### Behavior

- **Fails instead of reporting ready.** A failing check exits `INFRA_ERROR` with the whole report (`{error, message, preflight:{ok, checks:[{name, ok, status, detail, hint}]}}`), kills only the daemon/ngrok *this* init started, and writes no `runtime.json`.
- **Runs on the reuse path too.** A healthy daemon is not a ready one.
- **`--skip-preflight`** is the escape hatch. Measured cost of the gate on a green setup: ~6.8s cold (three Twilio round trips dominate), ~1.6s warm.
- A millisecond-fast local env check runs in the CLI *before* anything is spawned, so a misconfigured `.env` fails immediately rather than after ngrok and the daemon are up.
- Every probe is bounded (Twilio 8s per request, Gemini 10s + a 750ms settle, webhook 8s) and `init` uses a 30s IPC timeout. Per-probe bounds alone do not add up: `caller_ids` issues two more Twilio requests after `twilio_auth` passes, so a slow-but-alive network could sum past 30s, and the CLI would then report "daemon not responding" — the one diagnosis that is never true here — and kill the daemon holding the real report. So the whole run is bounded by `PREFLIGHT_BUDGET_MS` (25s): the caller-ID lookups are issued together, and if the budget expires the report still comes back, naming the probe that stalled and marking the rest `skipped`.

Two adjacent correctness fixes landed with it: `--tunnel manual --webhook-url` now strips a trailing slash (otherwise the daemon builds `<url>//call-status/<id>`, which Express 404s, silently dropping every Twilio callback), and the ngrok tunnel-reuse test compares the parsed port exactly instead of substring-matching the digits (`localhost:13001` used to satisfy port `3001`).

## Part 3 — Daemon lifetime and session reaping

### Why the 5-minute idle shutdown is gone

| Claim for it | Reality |
|---|---|
| Bounds cost | It only fired when there were **zero** active calls, so it never bounded a runaway call. The real guards are per-call max duration, the 60s inactivity sweep, and the 90s no-transcript (voicemail/hold) sweep — all untouched |
| Cleans up | `shutdown()` removes the PID and socket files but never deletes `runtime.json`, so a self-exited daemon left `runtime.json` pointing at a dead PID. `teardown` tolerated that; `call place` did not — `requireRuntime()` health-checks the recorded port and fails |
| Matches how it is used | Lifecycle belongs to the orchestrator: `init` → spawn sub-agents → collect results → `teardown` (see `lifecycle-commands.md`). A daemon that walks away mid-session breaks that contract, and it is exactly what a long-running agent workflow would hit |

The daemon now lives from `call init` until `call teardown`, so `runtime.json` no longer goes stale underneath a working session. It is still only removed by `teardown` — a crashed or killed daemon leaves it behind — which is why `requireRuntime()` and `init` both health-check it rather than trusting its existence.

### Session reaping replaces the GC the idle exit was accidentally providing

With an immortal daemon the session map would grow for the life of the process, holding each call's transcript twice plus its system instruction.

- `finalizeCall` stamps `session.finalizedAt` and frees `preGeneratedGreetingAudio` / `preGeneratedGreetingTranscriptParts` in a `finally` around the transcript write. The greeting audio is base64 24kHz PCM (~200KB for a 3s greeting) and is never drained for a call that was not answered. The `finally` matters: a failed write would otherwise leave `finalizedAt` unset forever, i.e. an un-reapable session — the exact leak this closes.
- `reapEndedSessions()` runs on the existing 10s interval (`server.ts:1083`). It drops ended sessions older than `SESSION_RETENTION_MS` (1h), and above `MAX_RETAINED_ENDED_SESSIONS` (100) drops the oldest first.
- It never touches a session whose status is not `"ended"`, and never one whose transcript write is still in flight (finalized but no `finalizedAt`). A session that ended *without* finalizing — e.g. Twilio rejected the placement — ages out on `lastActivityTime` instead.
- `transcriptBuffer` / `fullTranscript` are deliberately retained: a final `call listen` reads the tail of one and the status/listen summaries read the other.

Dead code removed in the same pass: `src/daemon/lifecycle.ts` (zero importers, and it contained a competing auto-forking `ensureDaemon` that forked a daemon with no webhook URL) and `getSessionByCallSid`.

## Gemini Live concurrent-session ceiling

Gemini Live caps **concurrent sessions per API key**: 3 on the free tier, ~50 on Tier 1. The preconnect holds a session from the moment `place` is called, through the whole ringing period, until pickup or abandonment.

**So the ceiling applies to calls in flight, not calls answered.** Three simultaneously ringing calls exhaust a free-tier key even though none of them has been picked up. The preflight's `gemini_live` probe is itself a session, which is why it self-skips whenever the daemon reports active calls.

**Deliberately deferred:** no explicit max-concurrent-in-flight guard was added. Exhausting the cap therefore surfaces late — as a `preconnect_failed` event and, if the post-answer fallback connect also fails, an explicit hangup with reason `Gemini unavailable: …` — rather than as a place-time refusal. That is a visible, attributable failure instead of dead air, which is the point of the handover work above, but a cap-aware `call place` that refuses up front is the better answer and remains open.

## Not addressed

Known gaps left standing, in rough order of how much they still cost:

- Terminal Twilio statuses (`busy`, `no-answer`, `failed`, `canceled`) are still dropped at `/call-status`, so the one failure the guarantee is *allowed* to have — a wrong or unreachable destination — still reads as `ringing` until the 60s sweep force-hangs up.
- Nothing re-points a running daemon's webhook URL. `OUTREACH_WEBHOOK_URL` is a fork-time snapshot that wins over `runtime.json`, so the preflight *detects* a stale tunnel but the remedy is always `teardown` then `init`.
- No place-time tunnel probe: the tunnel can die at any moment after `init` returns.
- The daemon is still forked with `stdio: "ignore"`, so its console diagnostics are destroyed. Transcript events and the preflight report are the durable diagnosis channels.
- The DTMF re-`Connect` still builds a second bridge over a live one.
