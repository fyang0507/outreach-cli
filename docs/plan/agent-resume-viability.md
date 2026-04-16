# Agent `--resume` for Callback Sessions — Viability Analysis

Issue: #55

## Problem

Each callback invocation starts a fresh agent session. The agent spends ~10 seconds reading SKILL.md, campaign logs, contact records, and channel history — context already loaded in previous callback sessions for the same campaign/contact. This wastes tokens and adds latency.

## Agent Resume Capabilities

Verified experimentally (Claude Code) and via documentation (others):

| Feature | Claude Code | Codex CLI | Hermes | OpenClaw |
|---|---|---|---|---|
| Resume by ID | `--resume <id> -p` | `exec resume <id>` | `--resume <id>` | `--session-id <uuid>` |
| Headless resume | Yes (`-p` flag) | Yes (`exec` mode) | Limited (cron only) | Yes (`--non-interactive`) |
| Session ID capture | `--output-format json` → `.session_id` | `--json` → first line `.thread_id`, or `$CODEX_THREAD_ID` env var | N/A | N/A |
| Session TTL | None (persists indefinitely) | None | Inactivity timeout | Daily 4 AM reset |
| Permission bypass | `--dangerously-skip-permissions` | `--yolo` | N/A | N/A |

### Verified on Claude Code (v2.1.110)

| Test | Result |
|---|---|
| `-p` returns `session_id` in `--output-format json` | Yes |
| Session file persists after `-p` exit | Yes (`~/.claude/projects/<path>/<id>.jsonl`) |
| `--resume <id> -p` recovers full context | Yes |
| `--session-id <uuid>` sets deterministic ID | Yes |
| `--resume` on deterministic ID | Yes |

### Verified on Codex CLI (v0.120.0)

| Test | Result |
|---|---|
| `exec --json` returns `thread_id` in first NDJSON line | Yes (`{"type":"thread.started","thread_id":"..."}`) |
| Session file persists after exec exit | Yes (`~/.codex/sessions/<date>/<id>.jsonl`) |
| `exec resume <id> --json` recovers full context | Yes |
| Same thread ID returned on resume | Yes |

### Viability verdict

| Agent | Viable? | Verified? | Notes |
|---|---|---|---|
| **Claude Code** | Yes | Experimentally verified | Capture via `--output-format json` → `.session_id` |
| **Codex CLI** | Yes | Experimentally verified | Capture via `--json` first line → `.thread_id` |
| **Hermes** | No | Docs only | Limited headless support; global sessions risk cross-campaign collision |
| **OpenClaw** | No | Docs only | Daily 4 AM session reset + known data-loss bugs in v2026.3.x |

## Design

### Entry scenarios

Not all callbacks have a preceding agent session to resume:

| Scenario | First callback has prior session? |
|---|---|
| Headless agent sends | No — callback is a separate process |
| Interactive agent sends | No — session ID not captured |
| Passive watch (human sends) | No — no agent session at all |

**The first callback for any (campaign, contact, channel) tuple is always a cold start.** The reliable capture point is the first callback itself — once `outreach callback` spawns an agent and captures the session ID, that ID becomes the durable handle for all subsequent callbacks.

### Session ID capture and cascade

**Capture:** After the first callback agent completes, `outreach callback` parses the session ID from the agent's structured output and appends a `callback_session` event to the campaign JSONL.

**Cascade:** When the callback agent sends a reply (triggering a new `registerReplyWatch()`), the new sundial schedule points to the same static `outreach callback` command. On next fire, `outreach callback` reads the campaign log, finds the stored `callback_session` event, and resumes.

```
1. Any agent sends       → registerReplyWatch()      → sundial: "outreach callback ..."
2. Reply detected        → outreach callback          → no stored session → cold start
                           → agent runs, session captured
                           → append callback_session event to campaign JSONL
3. Callback agent replies → registerReplyWatch()      → sundial: "outreach callback ..."  (same static command)
4. Next reply detected   → outreach callback          → reads callback_session → --resume <id>
                           → agent resumes with full context
                           → update callback_session event
```

The sundial command never contains session IDs — it's always the same:
```
outreach callback --campaign-id {campaign_id} --contact-id {contact_id} --channel {channel}
```

All session state lives in the campaign JSONL, looked up at callback time.

### Campaign JSONL event

New event type alongside existing `attempt` and `watch`:

```jsonl
{"ts":"2026-04-16T14:30:00Z","contact_id":"c_a1b2c3","type":"callback_session","channel":"sms","agent":"claude","agent_session_id":"019bd457-0bfc-7272-9f80-2c709bc6a6bb"}
```

Lookup: scan campaign events in reverse for the latest `callback_session` matching `(contact_id, channel)`.

### Config change: `callback_agent` replaces `callback_command`

The CLI owns a fixed mapping from agent name to invocation flags. The config specifies only the agent:

```yaml
watch:
  enabled: true
  callback_agent: "claude"    # "claude" | "codex"
  callback_prompt: "Reply detected from {contact_name} on {channel} for campaign {campaign_id}. You are running headless with no human in the loop — do NOT ask for confirmation, just act. Read the conversation, then take the appropriate next action (reply, log outcome, etc). Run: outreach {channel} history --contact-id {contact_id}"
  default_timeout_hours: 72
  poll_interval_minutes: 2
```

`callback_command` is removed. The mapping lives in code:

```typescript
interface AgentAdapter {
  /** Args for first invocation (no prior session) */
  buildCreateArgs(prompt: string): string[];
  /** Args for resume invocation */
  buildResumeArgs(sessionId: string, prompt: string): string[];
  /** Extract session ID from agent's structured output */
  parseSessionId(output: string): string | undefined;
}

const AGENTS: Record<string, AgentAdapter> = {
  claude: {
    buildCreateArgs: (p) => [
      "claude", "--dangerously-skip-permissions", "-p", p,
      "--output-format", "json",
    ],
    buildResumeArgs: (id, p) => [
      "claude", "--resume", id, "--dangerously-skip-permissions", "-p", p,
      "--output-format", "json",
    ],
    parseSessionId: (out) => JSON.parse(out).session_id,
  },
  codex: {
    buildCreateArgs: (p) => [
      "codex", "exec", "--yolo", "--json", p,
    ],
    buildResumeArgs: (id, p) => [
      "codex", "exec", "resume", id, "--yolo", "--json", p,
    ],
    parseSessionId: (out) => {
      const first = out.split("\n")[0];
      return JSON.parse(first).thread_id;
    },
  },
};
```

Benefits:
- Less config surface, less room for misconfiguration
- Resume/parse logic can't get out of sync with invocation flags
- Adding a new agent = adding one adapter object + documenting it

### Agent mismatch guard

Changing `callback_agent` between callbacks invalidates stored sessions. The callback dispatch checks:

```
stored callback_session.agent = "claude"
current config callback_agent = "codex"
→ mismatch → skip resume, start fresh, log new callback_session
```

A config change is a clean reset point — no stale session baggage carries over.

### Hidden subcommands

Reply checking and callback dispatch are **internal to the watch feature**. They are registered as CLI subcommands with Commander's `.hidden()` — callable by sundial, but invisible in `outreach --help` output. Agents never see them.

**`outreach reply-check`** (existing, now hidden):
- Sundial's `--trigger` target
- Checks for inbound replies by comparing message timestamps to campaign watermark
- Exits 0 (reply found) or 1 (no reply)

**`outreach callback-dispatch`** (new, hidden):
- Sundial's `--command` target
- Owns the full agent invocation lifecycle with session resume

Steps:
1. Load config → get `callback_agent` and `callback_prompt`
2. Resolve prompt template (replace `{contact_id}`, `{campaign_id}`, `{channel}`, `{contact_name}`)
3. Read campaign log → find latest `callback_session` for `(contact_id, channel)`
4. If found AND `agent` matches config:
   - Invoke with `buildResumeArgs(sessionId, prompt)`
   - If resume fails (exit code != 0), fall back to `buildCreateArgs(prompt)`
5. If not found or agent mismatch:
   - Invoke with `buildCreateArgs(prompt)`
6. Parse session ID from agent output via `parseSessionId()`
7. Append `callback_session` event to campaign JSONL
8. Exit with agent's exit code

Working directory is set to `data_repo_path` so the agent has access to skills and campaign data.

**Sundial registration** (`watch.ts`) composes both:
```
sundial add \
  --type poll \
  --trigger "outreach reply-check --campaign-id X --contact-id Y --channel sms" \
  --command "outreach callback-dispatch --campaign-id X --contact-id Y --channel sms" \
  --interval 2m --timeout 72h --once --refresh \
  --name outreach-X-Y-sms
```

Both share the same argument signature. Both are part of the `outreach` binary — clean, integrated, on PATH.

## Changes Required

| File | Change |
|---|---|
| `src/commands/callbackDispatch.ts` | **New** — hidden subcommand; agent invocation with session resume |
| `src/commands/replyCheck.ts` | Mark `.hidden()` on the Commander registration |
| `src/agents.ts` | **New** — agent adapter registry (fixed mapping from agent name to invocation/parse logic) |
| `src/watch.ts` | Replace raw `callback_command` construction with `outreach callback-dispatch` invocation |
| `src/cli.ts` | Wire `callback-dispatch` hidden subcommand |
| `src/logs/sessionLog.ts` | Add `findLatestCallbackSession()` helper |
| `src/appConfig.ts` | Replace `callback_command` with `callback_agent` in config schema |
| `outreach.config.yaml` | Update config: `callback_agent: "claude"` replaces `callback_command` |
| `skills/outreach/SKILL.md` | Document `callback_agent` config |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Session doesn't exist on resume (expired, corrupted) | Fall back to fresh session, log new `callback_session` |
| Agent mismatch after config change | Guard checks `agent` field; mismatch starts fresh |
| Stale context after many resumes | Include "check for updates" instruction in prompt; consider resume count cap |
| Context window bloat | Track resume count in `callback_session`; after N resumes, start fresh |
| Agent output format changes across versions | Adapter's `parseSessionId` isolates parsing; version-specific adapters if needed |
| New agent not yet supported | `outreach callback` errors clearly: "unsupported agent: X" |

## Expected Impact

- **Cold start reduction:** ~10s → ~1-2s (skip skill/file reading on resume)
- **Token savings:** ~2-3K tokens per callback (cached context vs. re-read)
- **Conversational continuity:** agent remembers prior exchanges in the campaign, makes better decisions
