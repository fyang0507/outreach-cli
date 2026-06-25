# Discord Channel

Use this note for Discord **read / intake** behavior, not command syntax. For *posting* to
Discord and the call-vs-Discord decision when reaching the operator, see
[operator.md](./operator.md).

`outreach discord history` reads a channel's messages back — the async-intake half of the
channel, where a human dumps scattered thoughts and a scheduled agent later digests them.
It is a **stateless, one-shot fetch**: no polling, no watching, no stored cursor. The
caller owns the cursor and the digest; the CLI only transports.

## Output Shape

Lean by default — empty fields are omitted to stay token-cheap:

```json
{
  "channel": { "id": "...", "name": "capture-this" },
  "count": 9,
  "newest_id": "1519790632749629450",
  "has_more": false,
  "messages": [
    { "id": "...", "ts": "2026-06-25T19:45:23.192000+00:00", "author": "freddie0104", "content": "你好啊" },
    { "id": "...", "ts": "...", "author": "freddie0104",
      "attachments": [ { "url": "https://cdn.discordapp.com/...", "name": "IMG.png", "size": 2867126, "type": "image/png" } ] }
  ]
}
```

`content` is absent when empty; `bot: true` appears only for the agent's own posts;
`reply_to` only on replies; `attachments` only when present. `newest_id` is the cursor to
persist after a successful digest. `--count` drops `messages` entirely for cheap triage.

## Read Semantics

- **Cursor.** Paging is by snowflake id. Pass `--after <newest_id-you-last-processed>` to
  fetch only what's new; `--since <iso>` is a coarser alternative. Advance the cursor only
  **after** a successful digest, and dedupe by message `id` so a crash-and-rerun doesn't
  double-ingest.
- **Content is full UTF-8.** Any language/emoji round-trips intact (`你好啊` stays `你好啊`).
- **Edits are not resurfaced.** `--after` keys on creation id, so editing an already-read
  message changes nothing the cursor can see. Treat a message as captured once, at first read.
- **Permissions.** Reading needs the bot's Message Content intent + Read Message History
  (see `.env.example`); without them `content` comes back empty.

## Attachments — Fetch at Digest Time

Attachment `url`s are **signed Discord CDN links that expire (~24h)**: the `ex=` query param
is a hex Unix expiry. Once it passes, the link 403s forever. The primitive returns the live
URL at read time — it cannot make it durable. So on first sight of a message, download and
store the bytes immediately (rehost into the durable store), keyed by type:

- `image/*` → download / run vision
- `video/*` → download; extract frames or transcribe audio
- `audio/ogg` (voice notes, filename `voice-message.ogg`) → download and transcribe
- `application/*` (e.g. `application/pdf`) → download and extract text

Never persist only the URL to fetch later. Also: Discord sanitizes non-ASCII out of the
stored **filename** (a Chinese-named PDF arrives as `UaBvDlQn__.pdf`) — the bytes are
untouched, so branch on `type` and the file's contents, never the filename.

## Keep the Dump Channel Pure

Messages the agent itself posts return with `"bot": true`. If the agent ever posts into the
intake channel, filter `bot` out before digesting. Better: route digests, questions, and
syntheses to a **separate** channel and keep the dump channel human-only — agent chatter in
the capture surface re-introduces the friction the async flow exists to remove.

## Triage Before Digesting

Don't wake a digest agent on every tick. Gate it on "anything new?" using the exit code of
[`scripts/discord-triage.sh`](./scripts/discord-triage.sh):

```bash
if scripts/discord-triage.sh capture-this ~/.local/state/outreach/capture-cursor; then
    # exit 0 → new intake present; launch the async digest job
    claude -p "$(cat digest-this-channel.md)"
fi
# exit 1 → nothing new; no-op
```

It checks for newer messages without pulling bodies (`--count`) and does **not** advance the
cursor — the digest job does that when it finishes.

## Boundary

This CLI does not schedule, watch, or digest. Reading is one-shot and stateless. Any cadence,
cursor persistence, and digestion live outside, in the scheduler + digest skill.
