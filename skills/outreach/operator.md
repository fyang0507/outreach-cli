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

## Reading a channel

`outreach discord history --channel <id|name>` reads recent messages back in
chronological order, surfacing each message's id, author (`bot: true` only for the agent's
own posts), timestamp, text content, attachments, and reply reference. Empty fields are
omitted to stay token-cheap. It is a **one-shot, stateless fetch** — it does not poll,
watch, or remember a cursor. To read only what's new, pass `--after <message_id>` (the id
of the last message you processed); `--since <iso>` is a coarser alternative. The caller
owns the cursor. `--count` returns just the count + `newest_id` for cheap "anything new?"
triage.

```bash
outreach discord history --channel intake --after 1399999999999999999 --limit 100
```

This needs the bot's Message Content intent + Read Message History permission (see
`.env.example`); without them, `content` comes back empty. **Attachment URLs are signed and
expire (~24h)** — download/transcribe/store the bytes at read time, never persist the URL
for later. See [discord.md](./discord.md) for the full set of read/intake caveats.

## Boundary reminder

`discord post` is **fire-and-forget**, and `discord history` is a **one-shot read** — neither watches for replies or reactions, and nothing in this CLI schedules, polls, or runs a digest loop. Any cadence/digestion lives outside this CLI. If you need an answer before your next step, that's the call path, not Discord. On infrastructure failure (Discord unreachable, bad token), log it and move on; do not invent hidden commands or poll for a human to react.

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
