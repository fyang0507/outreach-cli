---
name: contact-operator
description: Decide whether and how a headless or non-interactive agent should proactively contact the human operator. Use when an agent needs to escalate a blocker, request an urgent decision, or send non-blocking status/results to the operator from an unattended run.
---

# Contact Operator

## Overview

This skill governs proactive agent-to-human contact. Use it only when no live interactive session is attached; if the operator is present in the current chat, ask inline instead.

## Decision Rule

One heuristic decides the channel:

> Do I need an answer before my next step? Yes + urgent -> call. No -> Discord.

- Blocking and time-sensitive -> voice call. Use this only when the run cannot proceed without a human decision and waiting would materially hurt the task.
- Informational or non-blocking -> Discord. Use this for status, progress, results, digests, and decisions that can wait.
- Blocking but not time-sensitive -> Discord, then continue any work that is not blocked. Do not call just because an answer would be useful.

Reaching out has a cost: a phone ringing, a push notification, or an interruption. Prefer the quietest channel that still preserves the task.

## Call Path

Use a call for urgent blocking decisions:

```bash
outreach call place --call-operator --objective '<what you need decided>'
```

Write the objective so the voice agent can present the decision clearly and capture a concrete answer. Prefer yes/no or bounded choices, and include enough context for the operator to decide without reading logs.

When channel readiness is unknown, run `outreach health` first. If call mechanics or objective-writing details matter, read `.agents/skills/outreach/call.md`.

## Discord Path

Use Discord for non-blocking updates:

```bash
outreach discord post --channel <name-or-id> --body '<short update>'
```

Choose an existing topical channel when one fits:

```bash
outreach discord channels list
outreach discord post --channel <name-or-id> --body '<short update>'
```

If no channel fits and the topic will recur, create one before posting:

```bash
outreach discord channels create --name <topic>
outreach discord post --channel <topic> --body '<short update>'
```

Use `--silent` for low-priority digests or routine progress that should not push a notification. Keep Discord updates concise, include the result or blocker, and point to durable artifacts when detail exists elsewhere.

## Boundaries

- Do not use this skill during an interactive session; ask the user directly.
- Do not wait for Discord replies or reactions. `outreach discord post` is fire-and-forget.
- Do not turn status updates into polling loops. Any cadence belongs in a scheduler such as `sundial`.
- If outreach infrastructure fails, preserve the failure in the run artifact or error report and continue when possible; do not invent hidden commands.

## Examples

Blocking deletion approval:

```bash
outreach call place --call-operator \
  --objective 'Need approval to delete "Q2-draft.docx" from your personal Drive; it appears to be a leftover duplicate. Ask for yes or no and read the answer back.'
```

Non-blocking weekly digest:

```bash
outreach discord post --channel weekly-reflections --body 'Week of 2026-06-15 reflection: ...'
```
