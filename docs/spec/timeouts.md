# Timeouts — reference spec

Catalog of every timeout / interval / deadline in the codebase, with its default, where it lives, what it protects against, and the rationale behind the value. Update this doc when defaults change.

Numbers in `code refs` use the `path:line` form so you can jump straight to the source. Configurable values are tunable via `<data_repo>/outreach/config.yaml`; everything else is a hard-coded constant.

---

## 1. Configurable (config.yaml)

These are the user-facing knobs. Cold-start fallbacks live in `src/appConfig.ts` and template defaults in `outreach.config.dev.yaml.example`.

### `call.max_duration_seconds` — **600** (10 min)

- **Code refs**: `src/appConfig.ts:138, 142`, `src/daemon/server.ts:333-339, 426-427`
- **What it does**: hard cap per call. Daemon sets a `setTimeout(forceHangup, …)` at place time. Force-hangs up if the call is still alive when the timer fires.
- **Override**: `--max-duration <seconds>` flag on `outreach call place`.
- **Rationale for 600s**: typical outbound calls hit answering machines, hold queues, or IVR menus that eat time *before* the conversation starts. The agent itself can also be verbose. 5 min was tight; 10 min gives headroom while still bounding worst-case Gemini Live + Twilio spend (~$0.15–0.30 per ceiling-hit call).

### `watch.default_timeout_hours` — **72** (3 days)

- **Code refs**: `src/appConfig.ts:243`, `src/watch.ts:29, 53-54, 90, 112-113`, `src/commands/askHumanCheck.ts:62`
- **What it does**: how long the sundial poll watcher keeps polling for a reply (SMS/email) or a human answer (`ask-human`) before giving up and firing the timeout callback.
- **Two-tier behavior for `ask-human`**: `watch.ts:113` passes `default_timeout_hours * 2` as sundial's hard outer cap, while the trigger (`askHumanCheck.ts:62`) fires the *soft* timeout by exiting 0 once `elapsedHours > default_timeout_hours`. This gives sundial slack so its outer cap never races the soft cap.
- **Rationale for 72h**: matches realistic human reply windows for SMS/email. Long enough that overnight + weekend gaps don't trip the timeout; short enough that abandoned campaigns auto-clean.

### `watch.poll_interval_minutes` — **2**

- **Code refs**: `src/appConfig.ts:246`, `src/watch.ts:52, 111`
- **What it does**: sundial poll cadence — how often the trigger script checks for new inbound messages or `human_input` events.
- **Rationale for 2m**: sweet spot between reply latency (worst case 2 min from arrival to callback fire) and resource cost. Faster polling burns CPU on `chat.db` reads / Gmail history checks for marginal latency gain on human-pace channels.

---

## 2. Daemon call guardrails (hard-coded)

`src/daemon/server.ts:28-30` — these run for every active call and are not currently exposed as config.

### `IDLE_SHUTDOWN_MS` — **5 min** (`5 * 60 * 1000`)

- **Code ref**: `src/daemon/server.ts:28, 642`
- **What it does**: if no calls are active, daemon auto-shuts-down after 5 minutes. Saves resources between campaign batches.
- **Rationale**: long enough that a sub-agent placing several calls back-to-back doesn't re-pay startup (ngrok + Gemini connect ≈ 2–3s); short enough that idle dev sessions reclaim port 3001 / the Unix socket.

### `CALL_INACTIVITY_MS` — **60 s** (`60 * 1000`)

- **Code ref**: `src/daemon/server.ts:29, 651-654`
- **What it does**: if no audio events arrive on the Twilio Media Stream for 60s, force-hangup. Catches dead WebSocket connections.
- **Rationale**: a real call always emits *some* audio (ring, hold music, breathing). 60s of pure silence = network or carrier failure. Lower would risk false hangups during brief network blips; higher wastes Twilio billing on dead sockets.

### `VOICEMAIL_SILENCE_MS` — **90 s** (`90 * 1000`)

- **Code ref**: `src/daemon/server.ts:30, 657-662`
- **What it does**: distinct from inactivity — fires when *audio is flowing* but no transcript turns have been recorded for 90s. Heuristic for voicemail recordings or hold music with no human pickup.
- **Rationale**: 90s tolerates long IVR menus and hold queues that don't produce STT-eligible speech. The trade-off is real: lower would catch voicemail faster but risk false positives on legitimate hold; higher burns more Gemini Live tokens on background music.
- **Known tension**: some real call queues hold callers >90s. If false-positive hangups become a problem, promote this to config.

### Activity check interval — **10 s** (`10_000`)

- **Code ref**: `src/daemon/server.ts:664`
- **What it does**: poll cadence for the inactivity / voicemail checks above.
- **Rationale**: 10s gives tight enough resolution for the 60s/90s ceilings without wasted polling.

---

## 3. Audio bridge

### `SILENCE_TIMEOUT_MS` (TranscriptBatcher) — **800 ms**

- **Code ref**: `src/daemon/mediaStreamsBridge.ts:10, 39`
- **What it does**: TranscriptBatcher consolidates Gemini's per-word transcript fragments into turn-level entries. Flushes when 800ms passes with no new fragment from the current speaker.
- **Rationale**: matches typical end-of-utterance pause; aligns with Gemini Live VAD's own `silence_duration_ms` knob. Lower would split mid-sentence pauses into separate transcript entries; higher would conflate quick exchanges into one entry.

---

## 4. Daemon lifecycle / IPC

### `DEFAULT_TIMEOUT_MS` (IPC client) — **10 s**

- **Code ref**: `src/daemon/ipc.ts:4, 7`
- **What it does**: how long a CLI command waits for a daemon response over the Unix socket. Applies to all `call.*` IPC methods.
- **Rationale**: covers the slowest legitimate roundtrip (`call.place` triggers a Twilio API request + Gemini pre-connect, both <2s typical). 10s gives 5x margin over normal-case latency. If a `call.place` ever exceeds this, something is wrong upstream and failing fast is preferable.

### Daemon health-check timeouts

| Where | Timeout | Purpose |
|---|---|---|
| `src/commands/call/init.ts:26` (`DAEMON_HEALTH_TIMEOUT_MS`) | **5 s** | Wait for newly forked daemon to answer `/health` |
| `src/daemon/lifecycle.ts:78` | **5 s** | Same, from `ensureDaemon()` |
| `src/daemon/lifecycle.ts:51` | **2 s** | Re-verify an already-running daemon is still healthy |

Polling step within these waits: 100 ms (`init.ts:45`, `lifecycle.ts:40`). Daemon boots in <500ms typical; 5s is generous, 2s for re-verification is correct since a healthy daemon answers immediately.

### ngrok tunnel polling

| Const | Value | Code | Purpose |
|---|---|---|---|
| `NGROK_POLL_TIMEOUT_MS` | **10 s** | `init.ts:24` | Wait for ngrok HTTPS tunnel to be ready |
| `NGROK_POLL_INTERVAL_MS` | **300 ms** | `init.ts:25` | Poll cadence for above |

ngrok's tunnel is typically up in 1–2s; 10s covers slow networks.

### `killAndWait` grace period — **3 s**

- **Code ref**: `src/runtime.ts:88`, used by `src/daemon/lifecycle.ts:86` and `src/commands/call/init.ts` (port-stealing)
- **What it does**: SIGTERM, wait up to 3s for the process to exit cleanly, then SIGKILL.
- **Rationale**: standard SIGTERM grace. Daemon's `shutdown()` handler closes WebSocket + HTTP + IPC servers and unlinks files in well under 3s.

---

## 5. SMS provider (`src/providers/messages.ts`)

### `sendIMessage.timeoutMs` — **90 s** (default)

- **Code refs**: `messages.ts:419, 462-492`
- **What it does**: after AppleScript dispatches the message, poll `chat.db` for the delivery flag (`is_delivered=1`) or error code. Returns `delivered` / `failed` / `timeout` accordingly.
- **Rationale for 90s**: iMessage delivery flags usually appear within a few seconds; **SMS via Text Message Forwarding** can lag because the iPhone is the actual carrier path. 90s reduces false `timeout` returns, especially for SMS.
- **Tunable**: callers can pass `timeoutMs` via `SendOptions`. The CLI command (`sms send`) currently uses the default.

### `sendIMessage.pollIntervalMs` — **750 ms** (default)

- **Code ref**: `messages.ts:420, 482`
- **What it does**: how often to re-query `chat.db` for the new outbound row.
- **Rationale**: balances responsiveness against `chat.db` query cost (read-only SQLite open on every poll). Sub-second feels live without hammering.

### AppleScript exec timeout — **15 s**

- **Code ref**: `messages.ts:444`
- **What it does**: hard cap on the synchronous `osascript` call that dispatches the message to Messages.app.
- **Rationale**: AppleScript completes in <1s normally. 15s catches AppleScript hangs (Messages.app stuck, accessibility prompts, etc.) without giving up too soon on a slow Mac.

---

## 6. Google OAuth (`src/providers/googleAuth.ts`)

### OAuth callback timeout — **120 s**

- **Code ref**: `googleAuth.ts:77-80`
- **What it does**: after spawning a local HTTP server on `REDIRECT_PORT` and opening the browser, wait for Google's redirect with the auth code.
- **Rationale**: real users need time to pick the right Google account, click through consent screens, complete 2FA. 60s was tight; 120s gives comfortable headroom for a multi-step interactive flow. Failure mode is a re-run, not a real cost — be generous.

---

## 7. Health / setup `execSync` timeouts

Short-bounded shell-out timeouts. None of these affect call-path latency; they exist to keep `outreach health` and `outreach setup` from hanging on a misbehaving subprocess.

| Where | Timeout | Command | Notes |
|---|---|---|---|
| `src/commands/health.ts:44` | 3 s | `git rev-parse --git-dir` | data-repo git check |
| `src/commands/health.ts:58` | 10 s | `git fetch origin --quiet` | network call; soft-fails to `synced=null` |
| `src/commands/health.ts:63` | 3 s | `git rev-list HEAD..@{u} --count` | local op, fast |
| `src/commands/health.ts:154` | 2 s | `which osascript` | path lookup |
| `src/commands/setup.ts:53` | 3 s | `git rev-parse --git-dir` | repo detection |
| `src/commands/setup.ts:220` | 2 s | `command -v <tool>` | sundial / relay PATH check |
| `src/commands/setup.ts:229` | 3 s | `<tool> health` | companion tool readiness |
| `src/runtime.ts:41` | 2 s | `ps -p <pid> -o comm=` | process name lookup |
| `src/runtime.ts:74` | 3 s | `lsof -ti :<port>` | port owner lookup |

All of these are local shell-outs that complete in <100ms typical. The seconds-scale timeouts exist purely to prevent a hung subprocess from wedging the command.

---

## Summary table

| Timeout | Default | Configurable? | Where |
|---|---|---|---|
| `call.max_duration_seconds` | 600 s | ✅ config + `--max-duration` | `appConfig.ts`, `server.ts` |
| `watch.default_timeout_hours` | 72 h | ✅ config | `appConfig.ts`, `watch.ts` |
| `watch.poll_interval_minutes` | 2 m | ✅ config | `appConfig.ts`, `watch.ts` |
| `IDLE_SHUTDOWN_MS` | 5 min | ❌ | `server.ts:28` |
| `CALL_INACTIVITY_MS` | 60 s | ❌ | `server.ts:29` |
| `VOICEMAIL_SILENCE_MS` | 90 s | ❌ | `server.ts:30` |
| Activity check interval | 10 s | ❌ | `server.ts:664` |
| `SILENCE_TIMEOUT_MS` (transcript) | 800 ms | ❌ | `mediaStreamsBridge.ts:10` |
| IPC `DEFAULT_TIMEOUT_MS` | 10 s | ❌ | `ipc.ts:4` |
| `DAEMON_HEALTH_TIMEOUT_MS` | 5 s | ❌ | `init.ts:26` |
| `NGROK_POLL_TIMEOUT_MS` | 10 s | ❌ | `init.ts:24` |
| `killAndWait` grace | 3 s | ❌ (param) | `runtime.ts:88` |
| `sendIMessage.timeoutMs` | 90 s | ✅ (per-call param) | `messages.ts:419` |
| `sendIMessage.pollIntervalMs` | 750 ms | ✅ (per-call param) | `messages.ts:420` |
| AppleScript exec | 15 s | ❌ | `messages.ts:444` |
| OAuth callback | 120 s | ❌ | `googleAuth.ts:80` |

---

## When to revisit

- **`VOICEMAIL_SILENCE_MS`** is the most likely candidate for promotion to config. If real-world hold queues trip false hangups, expose it on `call.voicemail_silence_seconds`.
- **`watch.poll_interval_minutes`** could go lower (30s–1m) if reply latency becomes a UX issue, at the cost of higher Gmail / `chat.db` poll volume.
- **`call.max_duration_seconds`** — revisit if call-cost telemetry shows a long tail of 10-min ceiling hits; that's a signal the agent isn't recognizing dead-end conversations early enough.
