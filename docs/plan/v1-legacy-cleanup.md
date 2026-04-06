# V1 Legacy Cleanup: CLI & Daemon

## Problem

The CLI still exposes V1 commands and the daemon still contains V1 code paths. In V2, Gemini handles the call autonomously — `say` and `dtmf` are V1 concepts where an external sub-agent drove the conversation turn-by-turn. Keeping them confuses agents and adds maintenance burden.

## What to remove

### CLI commands

| Command | V1 purpose | V2 status | Action |
|---|---|---|---|
| `outreach call say` | Sub-agent sends TTS text to ConversationRelay | **Obsolete** — Gemini speaks autonomously | **Remove** |
| `outreach call dtmf` | Sub-agent sends DTMF via ConversationRelay WS or TwiML redirect | **Obsolete** — Gemini uses `send_dtmf` function calling tool | **Remove** |
| `outreach call place` | Place call via webhook → ConversationRelay TwiML | V2 uses inline TwiML → Media Streams | **Keep** (already V2) |
| `outreach call listen` | Poll transcript | Same in V2 | **Keep** |
| `outreach call status` | Check call state | Same in V2 | **Keep** |
| `outreach call hangup` | End call | Same in V2 | **Keep** |

Target V2 CLI surface:

```
outreach init
outreach teardown
outreach status
outreach call place [options]
outreach call listen [options]
outreach call status [options]
outreach call hangup [options]
outreach log append [options]
outreach log read [options]
```

### CLI files to delete

- `src/commands/call/say.ts`
- `src/commands/call/dtmf.ts`

### CLI registration to update

- `src/cli.ts` — remove `registerSayCommand`, `registerDtmfCommand` imports and calls

### Daemon IPC handlers to remove

In `src/daemon/server.ts`:
- `"call.say"` case in IPC method type and switch (~line 284, 298)
- `handleCallSay()` function (~lines 449-471) — sends text via V1 ConversationRelay WS
- `"call.dtmf"` case in IPC method type and switch (~line 285, 300)
- `handleCallDtmf()` function (~lines 473-511) — sends DTMF via ConversationRelay WS or TwiML redirect with ConversationRelay reconnect

### Daemon V1 WebSocket path to remove

In `src/daemon/server.ts`:
- `/webhook/voice` POST endpoint (~lines 37-74) — generates ConversationRelay TwiML. V2 passes TwiML inline via `calls.create({twiml})`.
- `/conversation-relay` WS upgrade path (~lines 95-98) — the `httpServer.on("upgrade")` handler branch
- `/conversation-relay` WS connection handler (~lines 110+) — the `handleConversationRelayConnection()` equivalent code block that processes V1 text messages (setup, prompt, interrupt, dtmf events)
- `escapeXml()` helper — check if still used by V2 code before removing

### Daemon session fields to audit

In `src/daemon/sessions.ts`:
- `ws?: WebSocket` — used by V1 for ConversationRelay WS. Check if V2 still references it (the inactivity timer at line 651 closes `session.ws`). If only V1 uses it, remove.

### Docs to update

- `SKILL.md` — remove `say` and `dtmf` from command reference if present
- `CLAUDE.md` — remove `say` and `dtmf` from CLI description
- `README.md` — verify no V1 commands in usage examples

## What to keep (for now)

- `escapeXml()` — verify first, likely still used in V2 DTMF TwiML generation in `mediaStreamsBridge.ts`
- Twilio REST API call patterns — used by both V1 hangup and V2 `end_call`/`send_dtmf` tool handlers

## Verification

After cleanup:

1. `npm run build` — zero errors, no dead imports
2. `outreach call --help` — shows only: place, listen, status, hangup
3. `outreach call say` / `outreach call dtmf` — "unknown command" error
4. Place a V2 call — still works (Gemini handles DTMF and conversation)
5. Grep for `conversation-relay` in src/ — zero hits (except maybe comments)
6. Grep for `call.say` and `call.dtmf` — zero hits
