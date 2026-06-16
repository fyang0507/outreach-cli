# Reaching the operator

This note is about contacting the operator (the human you act for) when you are running **headless / non-interactive** — no live session is attached and no one can answer you in-line.

In an **interactive session, do not call or post.** Just ask the user directly; they are right there.

## When to reach the operator

Only when you are headless and genuinely need the operator's attention: you are blocked on a decision you cannot make, or you have status/results worth surfacing. Reaching out has a cost (a phone ringing, a notification), so reach out deliberately, not for routine progress.

## Mode choice — the decision rule

One heuristic decides the channel:

> **Do I need an answer before my next step? Yes + urgent → call. No → Discord.**

- **Blocking & time-sensitive → voice call.** Use `outreach call place --call-operator --objective '<what you need decided>'` when you cannot proceed without a human decision *and* it can't wait. The voice agent will state your ask and capture the operator's answer. Write the objective so the agent can present the decision and read back a clear yes/no — see [call.md](./call.md) for objective-writing. `--call-operator` dials the operator from the Twilio number; you don't pass a caller ID.
- **Informational / non-blocking → Discord.** Use `outreach discord post` for status, progress, results, and digests where you do **not** need an answer before continuing. It sends and returns.

If the answer to the heuristic is "yes, but it can wait," prefer Discord and keep working on whatever isn't blocked.

## Discord channel selection

`discord post` defaults to `#general`, but route topical updates to a topical channel:

1. `outreach discord channels list` first to see what exists.
2. If an existing channel fits the topic, `outreach discord post --channel <name> --body '<text>'`.
3. If none fits and the topic recurs, `outreach discord channels create --name <topic>` (it returns the existing channel with `existed: true` if it's already there), then `outreach discord post --channel <topic> --body '<text>'`.
4. When no specific channel is warranted, omit `--channel` and let it land in `#general`.

Single-quote `--body` and `--name` so the shell doesn't expand `$`, backticks, or `!`.

Add `--silent` for low-priority updates (digests, routine progress) that should land in the channel without pinging the recipient with a push/desktop notification.

## Boundary reminder

`discord post` is **fire-and-forget**. It does not watch for replies or reactions — nothing in this CLI does. If you need a response, that's the call path, not Discord. On infrastructure failure (Discord unreachable, bad token), log it and move on; do not invent hidden commands or poll for a human to react.

## Worked examples

**1. Blocking file-deletion approval (→ call).** A headless cleanup job wants to delete a file in the operator's personal Drive. You cannot proceed without permission, and the job is waiting — yes + urgent. Call:

```bash
outreach call place --call-operator \
  --objective 'Need approval to delete the file "Q2-draft.docx" from your personal Drive; it looks like a leftover duplicate. Ask for a yes or no and read the answer back to confirm.'
```

Then monitor the call and act on the captured yes/no.

**2. Weekly reflection digest (→ Discord).** You've read the week's activity logs and assembled a reflection digest. Nobody needs to answer before you continue — no. Post it; pick or create a topical channel:

```bash
outreach discord channels list
# no fitting channel exists:
outreach discord channels create --name weekly-reflections --topic 'Weekly reflection digests'
outreach discord post --channel weekly-reflections --body 'Week of 2026-06-15 reflection: ...'
```

Long digests are split into ordered chunks automatically. Posting completes the task; do not wait for a reply.
