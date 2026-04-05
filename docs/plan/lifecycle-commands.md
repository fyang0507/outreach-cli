# Lifecycle Commands — `outreach init` / `outreach teardown`

## Problem

The CLI currently has no way to set up or tear down its runtime environment. Users must manually:

1. Start ngrok (`ngrok http 3001`)
2. Copy the ngrok URL into `.env`
3. Rebuild (`npm run build`)
4. Hope the daemon auto-starts correctly

Teardown is worse — there's no command to stop the daemon, kill ngrok, or clean up stale PID files. This caused a real issue in dev: a stale ngrok endpoint blocked new tunnel creation (ERR_NGROK_334), requiring manual intervention via the ngrok dashboard.

## Proposed commands

### `outreach init`

Start all services and verify connectivity.

```bash
outreach init [--tunnel ngrok|manual] [--webhook-url <url>]
```

Steps:
1. Load config from `.env`
2. Verify Twilio credentials (make a test API call)
3. Start tunnel:
   - `--tunnel ngrok` (default): start ngrok, extract public URL automatically
   - `--tunnel manual`: skip tunnel, require `--webhook-url`
4. Start the daemon on port 3001
5. Verify daemon health (`GET /health`)
6. Verify webhook reachable from outside (`GET <webhook-url>/health` via curl or Twilio validation)
7. Write runtime state to `~/.outreach/runtime.json`:
   ```json
   {
     "daemon_pid": 12345,
     "daemon_port": 3001,
     "ngrok_pid": 12346,
     "webhook_url": "https://xxx.ngrok-free.dev",
     "started_at": "2026-04-05T14:00:00Z"
   }
   ```
8. Output: `{"status":"ready","webhook_url":"...","daemon_pid":12345}`

### `outreach teardown`

Stop all services and clean up.

```bash
outreach teardown [--force]
```

Steps:
1. Read `~/.outreach/runtime.json`
2. Check for active calls — warn if any are in progress (require `--force` to proceed)
3. Hang up any active calls
4. Stop daemon (SIGTERM → wait → SIGKILL if needed)
5. Stop ngrok (if managed by us)
6. Clean up: PID file, socket file, runtime.json
7. Output: `{"status":"stopped"}`

### `outreach status`

Show current runtime state (useful for debugging).

```bash
outreach status
```

Output:
```json
{
  "daemon": {"running": true, "pid": 12345, "port": 3001, "active_calls": 2},
  "tunnel": {"running": true, "url": "https://xxx.ngrok-free.dev"},
  "twilio": {"configured": true, "from": "+15513454136"}
}
```

## Runtime state file

`~/.outreach/runtime.json` is the source of truth for what's running. It's written by `init`, read by all commands, and deleted by `teardown`.

This replaces the current approach of PID files in `/tmp/` which:
- Can't track ngrok
- Can go stale without detection
- Don't store the webhook URL

## Separation of concerns: orchestrator vs sub-agent

The orchestrator manages infrastructure lifecycle. Sub-agents only execute tasks.

```
Orchestrator (owns environment):
  1. outreach init              ← provision
  2. spawn sub-agents for tasks
  3. collect results
  4. outreach teardown          ← cleanup

Sub-agent (owns task execution):
  1. outreach call place ...
  2. listen/say/dtmf loop
  3. outreach call hangup
  4. outreach log append ...
  (never touches init/teardown)
```

This means `call place` should **fail with a clear error if init hasn't been run**, not silently auto-start the daemon. `ensureDaemon()` is replaced by a check for `runtime.json` — if absent, exit with: `{"error":"not_initialized","message":"Run 'outreach init' first"}`.

## Impact on existing commands

- Remove `ensureDaemon()` auto-start from `call place`. Replace with a `requireRuntime()` check that reads `runtime.json` and fails if not found.
- The webhook URL is discovered automatically by `init` (from ngrok) and stored in `runtime.json`. Sub-agent commands read it from there, not `.env`.

## Stale state recovery

If `outreach init` detects stale state (runtime.json exists but services aren't running):
1. Clean up stale PID files and socket
2. Kill stale ngrok if PID is found
3. Remove stale runtime.json
4. Start fresh

This prevents the ERR_NGROK_334 issue we hit in testing.

## Priority

This should be built before V2 work — it's a prerequisite for reliable dev/test cycles regardless of which V2 architecture is chosen.
