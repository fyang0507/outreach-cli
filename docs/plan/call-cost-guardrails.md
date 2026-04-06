# Call Cost Guardrails

## Problem

Both Gemini Live API and Twilio are paid per-minute services. A runaway call — voicemail loop, hold music, agent that never decides to hang up — can silently rack up cost. Today's only defense is a 60s inactivity timer, which has gaps and is not sufficient.

## Current safeguards

| Safeguard | Where | Gaps |
|---|---|---|
| 60s inactivity timer | `server.ts:640-657` | Only checks `lastActivityTime`. A voicemail playing audio counts as "active" (Twilio keeps sending media events). Also: the cleanup only closes V1 `ws`, doesn't call `bridge.cleanup()` for V2 — so Gemini session and Twilio call stay alive. |
| `end_call` tool | Gemini function calling | Relies on the model deciding to hang up. Model may not recognize voicemail, hold music, or circular IVR. No fallback if model never calls it. |
| `--hangup-when` flag | System instruction | Advisory only — tells Gemini when to use `end_call`. Not enforced by any hard timer. |
| 5-min idle daemon shutdown | `server.ts:623-637` | Only fires when zero active calls. Doesn't help with a single stuck call. |

## Proposed guardrails

### G1: Hard max call duration (P0)

Add a `--max-duration <seconds>` flag to `call place` (default: 300s / 5 min). The daemon sets a timer when the call starts. When it fires:

1. Log warning: `[daemon] Call ${id} hit max duration (${maxDuration}s) — force hangup`
2. Append transcript entry: `[Call ended: max duration exceeded]`
3. Hang up via Twilio REST API
4. Call `bridge.cleanup()` to close Gemini session
5. Mark session ended

Also add a global default in `outreach.config.yaml`:

```yaml
call:
  max_duration_seconds: 300  # hard cap, overridable per call
```

**Why 5 minutes default**: Most outbound calls (scheduling, inquiries) should complete in 2-3 minutes. 5 minutes gives generous headroom while capping worst-case cost at ~$0.07 Twilio + ~$0.05 Gemini per call.

### G2: Fix the inactivity timer for V2 (P0)

The current inactivity timer at `server.ts:640-657` has a bug for V2 calls: it sets `session.status = "ended"` and closes `session.ws` (V1 WebSocket), but doesn't:
- Call `bridge.cleanup()` (so Gemini session stays open, keeps billing)
- Hang up the Twilio call via REST API (so Twilio keeps billing)

Fix: when the timer fires for a session that has a `bridge`, call `bridge.cleanup()` which handles both Gemini close and Twilio hangup.

### G3: Voicemail / hold music detection heuristic (P1)

The inactivity timer doesn't catch voicemail or hold music because Twilio keeps sending audio (so `lastActivityTime` keeps updating). Add a secondary heuristic:

- Track `lastTranscriptTime` — last time a meaningful transcript entry was added
- If audio is flowing but no transcript activity for N seconds (e.g., 90s), it's likely voicemail playback, hold music, or a dead-end IVR
- Trigger auto-hangup with reason "No conversational activity detected"

This catches:
- Voicemail greeting playing endlessly (or beep → silence → recording)
- Hold music / "your call is important to us" loops
- IVR that the agent got stuck in

### G4: Cost logging per call (P1)

When a call ends, log estimated cost:

```jsonl
{"event":"call_ended","id":"abc123","duration_seconds":142,"estimated_cost":{"twilio_usd":0.03,"gemini_usd":0.02,"total_usd":0.05}}
```

Rates (approximate, for logging only):
- Twilio: ~$0.014/min outbound US
- Gemini Live: ~$0.60/hr audio (~$0.01/min)

This makes cost visible to the orchestrator agent without requiring external dashboards.

### G5: Per-session and daily cost caps (P2)

Add optional cost limits in `outreach.config.yaml`:

```yaml
cost:
  max_per_call_usd: 0.50       # auto-hangup if estimated cost exceeds
  max_daily_usd: 10.00         # refuse new calls if daily total exceeds
```

Daily tracking stored in `~/.outreach/usage/YYYY-MM-DD.json`. Reset daily.

### G6: Twilio call status callback (P2)

Register a Twilio status callback URL when placing calls. Twilio sends webhooks on call state changes (ringing → in-progress → completed/failed). This provides a server-side safety net:

- If the daemon crashes, Twilio eventually times out the call (but could take minutes)
- With a status callback, we could detect orphaned calls and clean up faster
- Also provides accurate duration from Twilio's perspective (for cost logging)

## Implementation order

1. **G2** — Fix V2 inactivity timer (small, P0, prevents billing leak now)
2. **G1** — Hard max duration timer (P0, the most important cap)
3. **G3** — Voicemail/hold detection (P1, catches the main failure mode)
4. **G4** — Cost logging (P1, visibility)
5. **G5/G6** — Caps and callbacks (P2, defense in depth)

## Changes needed

| File | Change |
|---|---|
| `outreach.config.yaml` | Add `call.max_duration_seconds` default |
| `src/appConfig.ts` | Load new config field |
| `src/commands/call/place.ts` | Add `--max-duration` flag, pass to daemon |
| `src/daemon/server.ts` | Set per-call duration timer on call start; fix inactivity timer to use `bridge.cleanup()` |
| `src/daemon/mediaStreamsBridge.ts` | Add `lastTranscriptTime` tracking for G3 |
| `src/daemon/sessions.ts` | Add `startTime`, `maxDurationMs`, `lastTranscriptTime` to `CallSession` |
