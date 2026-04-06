# Issue Sequencing

Five open issues in `docs/plan/`. Here's the dependency graph and recommended order.

> **Note**: `voice-agent-cli-bridge` (#6) was closed — CLI stays as orchestrator's management tool, voice agent keeps native function calls. See `docs/plan/voice-agent-cli-bridge.md` for decision record.

## Dependency graph

```
v1-legacy-cleanup
  ↓ (clean slate for CLI surface)
call-cost-guardrails
  ↓ (fixes V2 inactivity timer bug exposed during cleanup)
init-teardown-stress-test
  ↓ (hardened lifecycle — prerequisite for reliable testing)
integration-test-ivr
  ↓ (validates core V2 call flow works)
memory-layer
    (adds contact/campaign CLI commands)
```

## Why this order

### 1. `v1-legacy-cleanup` — first

Remove dead code before building anything new. Every other issue touches the CLI surface or daemon — doing cleanup last means merge conflicts and confusion about what's V1 vs V2. After this, `outreach call --help` shows only V2 commands and the daemon has no ConversationRelay code paths.

### 2. `call-cost-guardrails` — second

The V2 inactivity timer bug (G2) is a billing leak that exists *now*. The V1 cleanup will remove the `session.ws` codepath that the broken timer currently targets, making the bug more visible. Hard max duration (G1) and voicemail detection (G3) are safety nets needed before any real usage or testing.

### 3. `init-teardown-stress-test` — third

Reliable lifecycle is a prerequisite for everything downstream. Integration tests, memory layer commands, and the CLI bridge all assume `init` works cleanly and `teardown` doesn't leave orphans. Fix the edge cases (lingering ngrok, stale runtime, partial init cleanup) before building on top.

### 4. `integration-test-ivr` — fourth

With clean CLI, cost guardrails, and reliable init/teardown, we can safely run live tests against IVR lines without worrying about runaway calls or orphaned processes. This validates the core V2 flow before adding more features.

### 5. `memory-layer` — fifth

Adds `outreach contact` and `outreach campaign` commands. Depends on the CLI surface being stable (after cleanup) and lifecycle being reliable (after init hardening).

## Parallelism

Issues 1-3 are strictly sequential (each changes overlapping files).

Issues 4 and 5 can partially overlap — IVR tests exercise existing commands while memory layer adds new ones, with no file conflicts.

```
Time →

1. v1-legacy-cleanup     ████
2. call-cost-guardrails       ████
3. init-teardown-stress        ████
4. integration-test-ivr            ████
5. memory-layer                    ██████
```
