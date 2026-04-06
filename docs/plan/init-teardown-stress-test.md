# Stress Test Plan: `init` and `teardown` Robustness

## Motivation

`outreach init` is the one-stop bootstrap command for agents. It must work reliably on first try and handle every edge case gracefully — stale state, lingering processes from other machines, port conflicts, partial failures mid-init. Today there are several known gaps where `init` can leave the system in a broken state or `teardown` can miss cleanup.

## Current behavior

`init` does 6 things in sequence:
1. Check for existing runtime.json + alive daemon PID → skip if already running
2. Validate Twilio creds in .env
3. Spawn ngrok as detached child → sleep 3s → fetch tunnel URL from ngrok local API
4. Fork daemon process with webhook URL in env
5. Poll daemon /health for up to 5s
6. Write runtime.json with PIDs and webhook URL

`teardown` does:
1. Read runtime.json → error if missing
2. Check active calls → refuse unless --force
3. SIGTERM daemon → wait 3s → SIGKILL
4. SIGTERM ngrok → wait 3s → SIGKILL
5. Delete runtime.json, PID file, Unix socket

## Edge cases and gaps

### E1: Lingering ngrok from another machine/session

**Problem**: ngrok was started outside of `outreach init` (e.g., from another machine, a prior manual run, or a crashed session that didn't teardown). Port 4040 is already bound. `init` spawns a new ngrok which silently fails (port conflict), then `fetchNgrokUrl()` reads the *old* tunnel's URL — pointing to the wrong host/port.

**Current behavior**: Silently succeeds with wrong webhook URL. Calls fail with no obvious error.

**Fix**: Before spawning ngrok, check if port 4040 is already in use. If so, either:
- (a) Kill the existing ngrok and start fresh, or
- (b) Validate the existing tunnel points to our daemon port, and reuse it if valid

### E2: Stale runtime.json with dead processes

**Problem**: Machine rebooted or processes were killed externally. runtime.json exists with old PIDs. PIDs may have been recycled by the OS to unrelated processes.

**Current behavior**: `init` checks `isProcessRunning(existing.daemon_pid)` — if the PID was recycled, it thinks the daemon is alive and returns "Already initialized" with a stale webhook URL.

**Fix**: Health-check the daemon (fetch `/health`) rather than just checking if the PID is alive. If health check fails, treat as stale and re-init.

### E3: Partial init failure — ngrok started but daemon failed

**Problem**: ngrok spawns successfully, but daemon fork fails (e.g., port 3001 already in use, server.js crash on startup). ngrok is left running as an orphan.

**Current behavior**: `init` exits with INFRA_ERROR but does not clean up the ngrok process it just spawned. Next `init` hits E1.

**Fix**: Wrap init in a try/finally that kills ngrok on any failure after it was spawned.

### E4: Daemon port already in use

**Problem**: Port 3001 is occupied (by a prior daemon, another app, or a zombie process). The forked daemon silently fails to bind.

**Current behavior**: `waitForHealth` times out after 5s with a generic "Daemon failed to start within timeout" error. No guidance on what went wrong.

**Fix**: Before forking daemon, check if port 3001 is in use. If so, report which PID owns it and suggest resolution.

### E5: ngrok startup race condition

**Problem**: `init` sleeps 3s then queries ngrok API. On slow machines or cold starts, ngrok may not be ready. On fast machines, 3s is wasted time.

**Current behavior**: `fetchNgrokUrl()` throws "ngrok API returned 5xx" or connection refused.

**Fix**: Replace fixed sleep with a polling loop (like `waitForHealth`) that retries `fetchNgrokUrl()` with backoff up to a timeout.

### E6: teardown with missing/recycled PID

**Problem**: runtime.json has a PID that was recycled to an unrelated process. `teardown` kills it.

**Current behavior**: Sends SIGTERM to a random process.

**Fix**: Before killing, verify the process is actually a node/ngrok process related to outreach (e.g., check process name or command line via `ps`), or use the health endpoint to confirm identity.

### E7: Double init

**Problem**: Agent calls `init` twice in quick succession (e.g., retry logic). Second call could spawn duplicate ngrok/daemon.

**Current behavior**: Second call might pass the "already initialized" check if runtime.json hasn't been written yet by the first call.

**Fix**: Use a lockfile (`~/.outreach/init.lock`) with PID to prevent concurrent init.

### E8: teardown when not initialized

**Problem**: Agent calls `teardown` without prior `init`, or after a reboot cleared runtime.json.

**Current behavior**: Outputs error "Not initialized" with INFRA_ERROR exit code.

**Verdict**: Acceptable. But consider: should teardown also opportunistically kill any orphaned ngrok/daemon processes it finds? (See E1.)

### E9: ngrok auth/account issues

**Problem**: ngrok requires auth token (`ngrok config add-authtoken`), or free plan only allows one tunnel. Agent gets cryptic ngrok error.

**Current behavior**: "Failed to start ngrok" with whatever error message ngrok printed.

**Fix**: Detect common ngrok errors (no auth token, tunnel limit) and surface actionable guidance.

### E10: Webhook URL expires or rotates

**Problem**: ngrok free tier URLs change on restart. If ngrok crashes and auto-restarts (or is restarted externally), the daemon still has the old URL. Active calls break.

**Current behavior**: No detection. Calls placed after URL rotation silently fail.

**Fix**: Periodically verify the webhook URL is still valid (daemon could ping its own ngrok URL), or detect ngrok tunnel changes and update.

## Test matrix

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| T1 | Clean init | No prior state → `init` | ngrok + daemon start, runtime.json written, health OK |
| T2 | Idempotent init | `init` → `init` | Second call returns "Already initialized" with same state |
| T3 | Init after unclean shutdown | Kill daemon+ngrok manually, leave runtime.json → `init` | Detects stale state, re-initializes cleanly |
| T4 | Init with lingering ngrok | Start ngrok manually on 4040 → `init` | Detects conflict, handles gracefully (kill or reuse) |
| T5 | Init with port 3001 occupied | Start something on 3001 → `init` | Clear error message naming the conflict |
| T6 | Partial init cleanup | Block daemon from starting → `init` | ngrok is killed on failure, no orphans |
| T7 | Clean teardown | `init` → `teardown` | Both processes killed, all files cleaned, exit 0 |
| T8 | Teardown with active calls | `init` → place call → `teardown` | Refuses without --force, proceeds with --force |
| T9 | Teardown when not init'd | `teardown` (no prior init) | Error with clear message, exit 2 |
| T10 | Teardown with dead processes | `init` → kill processes → `teardown` | Cleans up files gracefully, no errors about dead PIDs |
| T11 | Double init race | `init & init` (parallel) | Only one succeeds, no duplicate processes |
| T12 | Init → reboot → init | Simulate reboot (kill all, keep runtime.json) → `init` | Detects stale, re-inits cleanly |
| T13 | Slow ngrok startup | Simulate slow ngrok (network delay) → `init` | Retries fetch, succeeds within timeout |

## Priority

**P0 (fix before relying on init in production):**
- E1 (lingering ngrok) — this already bit us
- E2 (stale runtime with PID recycling) — silent corruption
- E3 (partial init cleanup) — leaves orphans
- E5 (ngrok race condition) — fragile timing

**P1 (fix soon):**
- E4 (port conflict diagnostics)
- E6 (teardown PID safety)
- E7 (double init lockfile)

**P2 (nice to have):**
- E9 (ngrok error diagnostics)
- E10 (webhook URL rotation detection)

## Implementation notes

- `isProcessRunning` should be upgraded to `isOurProcess` — verify via health endpoint or process name, not just PID existence
- ngrok spawn should use polling instead of fixed sleep
- Init needs a cleanup-on-failure path (try/finally after ngrok spawn)
- Consider adding `outreach init --recover` that aggressively finds and cleans up any outreach-related processes
- The `isProcessRunning` function is duplicated in 3 files (runtime.ts, init.ts, teardown.ts) — consolidate
