# Voice Agent CLI Bridge

> **Status: CLOSED — not pursuing.**
> After discussion, we concluded the CLI is a management tool for the orchestrator, not an operational tool for the voice agent. See [Decision](#decision) at the bottom for full reasoning.

## Idea

Give the voice agent access to the same CLI that the orchestrator uses, via a single generic `cli` function calling tool. The bridge receives the function call, execs the command locally, and returns stdout as the tool response.

This unifies the tool interface: one CLI, two consumers (orchestrator via shell, voice agent via function calling bridge).

## Why

Function calling as currently implemented has scaling problems:

| Concern | Function calling | CLI |
|---|---|---|
| Add a new tool | Code change in geminiLive.ts + mediaStreamsBridge.ts + tool declaration | Add a CLI command, done |
| Model portability | Tied to Gemini's tool format | Any model with shell access or a generic tool |
| Context cost | Every tool declaration consumes tokens in session setup | Zero — discovery via `--help` on demand |
| Discovery | Hardcoded at connection time | Self-documenting, `--help` at any level |

Today we have 2 function calling tools (`send_dtmf`, `end_call`). If the voice agent needs to look up contacts, check calendars, record outcomes, transfer calls — each one is a bespoke code change. With a CLI bridge, they're just new `outreach` subcommands.

## Design

### Single tool declaration

```json
{
  "name": "cli",
  "description": "Run an outreach CLI command. Use 'outreach --help' to discover available commands.",
  "parameters": {
    "command": {
      "type": "string",
      "description": "The full CLI command to execute, e.g. 'outreach contact get --phone +15551234567'"
    }
  }
}
```

### Bridge handler

When Gemini calls `cli`:
1. Parse the command string
2. Check against allowlist (reject disallowed commands)
3. `execFile("outreach", args)` as a subprocess
4. Return stdout as tool response (already JSON — our CLI outputs JSON)

### Allowlist

The voice agent should not be able to run every command. Proposed tiers:

**Allowed (read / record):**
- `outreach contact get` — look up contact before or during call
- `outreach contact list` — search contacts
- `outreach log append` — record call outcome
- `outreach log read` — check prior interactions
- `outreach call status` — check own call state
- (future) `outreach calendar check` — check availability

**Blocked (infrastructure / destructive):**
- `outreach init` / `teardown` / `status` — orchestrator's job
- `outreach call place` — voice agent shouldn't spawn calls
- `outreach call hangup` — keep as `end_call` function call (needs to be instant, in-process)

**Keep as native function calls:**
- `send_dtmf` — latency-sensitive, happens mid-conversation, needs direct Twilio API access

**⚠ `end_call` — design limitation (applies regardless of CLI bridge):**

Live voice models are designed to always end their turn with audio/text output — tool calls are mid-turn actions, not session terminators. When Gemini calls `end_call`, it will receive the tool response and then try to speak (e.g., "Goodbye!"). The model has no concept of "call this tool and then stop existing."

This means `end_call` is not a clean agent-level shutdown. The actual termination must happen at the **connection level**: the bridge monitors for the end signal (Twilio call status change, or the model's post-tool audio completing), then force-closes the Gemini session. The model doesn't end itself — we end it.

Current code (`mediaStreamsBridge.ts`) sends the tool response then immediately calls `cleanup()`, which is a race condition we're getting away with (the model's post-tool audio gets dropped). A proper fix would wait for `generationComplete` or a brief drain period before closing. `FunctionResponseScheduling.SILENT` (tell model not to respond to the tool result) would be ideal but is not yet supported in Gemini 3.1 Flash Live.

### Timing

The user's insight: the voice agent wouldn't call CLI mid-conversation. It would use it:
- **Before the conversation starts** — look up contact, check calendar, review prior call notes
- **After the conversation ends** — record outcome, update contact, log campaign event

This means latency from fork+exec (~50-100ms) is not a concern — these aren't in the audio hot path.

### Post-call action constraint

LLM APIs require the agent to end its turn with an assistant message. This creates a problem for post-call CLI actions: after `end_call` fires, the Gemini session closes — there's no turn left to run `outreach log append`.

Three options considered:
- **(a) Pre-hangup logging** — model calls `cli` before `end_call`. Works but burns Twilio seconds on bookkeeping.
- **(b) Keep Gemini alive after call end** — hang up Twilio but hold the Gemini session open for post-call tool use. Cleanest but adds bridge lifecycle complexity.
- **(c) Orchestrator handles post-call** — voice agent's job ends at hangup. The orchestrator (watching via `call listen --wait`) sees the call end and runs `outreach log append` itself.

**Recommendation: option (c).** It sidesteps the constraint entirely and aligns with the existing architecture — orchestrator owns lifecycle and logging. The CLI bridge then only needs **pre-call** tools (contact lookup, calendar check), which run before the audio session starts with no turn-ending issue.

## Open questions

### Q1: Can Gemini learn CLI effectively?

This is the biggest unknown. Gemini needs to:
- Parse `--help` output to understand available commands and flags
- Construct correct command strings with proper flag syntax
- Interpret JSON stdout responses

**Experiment**: Give Gemini the `cli` tool + a system instruction with a brief CLI overview. Test with a real call where the objective requires a contact lookup. Measure: does it call the right command with correct flags? How many attempts does it need?

### Q2: System instruction vs discovery

Two approaches for teaching Gemini the CLI:
- **Upfront**: Include a condensed CLI reference in the system instruction (costs tokens but reliable)
- **Discovery**: Let Gemini run `outreach --help` and `outreach <cmd> --help` as needed (zero upfront cost but adds round-trips)

Probably start with upfront (like a condensed SKILL.md) and see if Gemini can graduate to discovery.

### Q3: How to handle errors

CLI commands exit with non-zero codes and JSON error output on failure. The bridge should:
- Return both stdout and stderr in the tool response
- Include exit code so Gemini can reason about what went wrong
- Not retry automatically — let the model decide

### Q4: Allowlist enforcement

Where to enforce:
- **(a) Bridge-side**: Parse the command, check first two tokens against allowlist, reject before exec
- **(b) CLI-side**: Add a `--caller voice-agent` flag that restricts available commands
- **(c) Config-side**: Allowlist in `outreach.config.yaml`

Recommend (a) for simplicity — the bridge is already the trust boundary.

## Experiment plan

1. Add the `cli` tool declaration to Gemini session setup (alongside existing `send_dtmf` and `end_call`)
2. Add a bridge handler that execs allowlisted commands and returns stdout
3. Add a brief CLI reference to the system instruction
4. Test with a call where the objective requires pre-call contact lookup
5. Evaluate: correctness, number of attempts, whether Gemini hallucinates flags
6. If successful: migrate read-only tools to CLI-first, keep only `send_dtmf` and `end_call` as native function calls

## Success criteria

- Gemini correctly invokes CLI commands ≥90% of the time with correct flags
- No security escapes (blocked commands stay blocked)
- Adding a new voice agent capability = adding a CLI command (no bridge code change)
- `send_dtmf` and `end_call` remain native function calls (latency-sensitive, mid-conversation)

## Decision

**Not pursuing.** The CLI bridge idea was explored and rejected after deeper analysis of the voice agent's role and the live model's capabilities.

### Why not

1. **CLI is a management plane, not an operational plane.** The CLI provides abstractions for the orchestrator to dispatch and monitor voice agents — it's a manager's tool (`init`, `teardown`, `call place`, `call listen`, `log append`). The voice agent is an executor that operates within a call, not a manager that dispatches work. Giving the voice agent CLI access conflates these two layers.

2. **`end_call` exposes a fundamental model limitation, not a CLI opportunity.** Live voice models always end their turn with audio/text output — tool calls are mid-turn actions. `end_call` is a "dirty" workaround where the bridge force-terminates at the connection level after the tool fires. It doesn't offer feature parity with other `outreach call` commands and shouldn't be treated as one.

3. **Post-call actions belong to the orchestrator.** The voice agent can't run CLI commands after hangup (Gemini session is dead). The orchestrator is already watching via `call listen --wait` and naturally handles post-call logging (`outreach log append`). Pre-call actions (contact lookup, calendar) are also orchestrator decisions — the orchestrator prepares context and passes it to the voice agent via `--objective` and system instructions.

4. **`send_dtmf` should stay native.** Even though it could theoretically be wrapped as `outreach call dtmf`, it's a mid-conversation action that needs to be in-process. Wrapping it in fork+exec adds unnecessary complexity for no architectural benefit.

### What stays

- Voice agent keeps `send_dtmf` and `end_call` as native Gemini function calls
- Orchestrator keeps all CLI commands (`call place`, `call listen`, `log append`, etc.)
- New voice agent capabilities (if needed) are added as native function calls, not CLI wrappers
- The separation is clean: **orchestrator manages via CLI, voice agent operates via function calls**
