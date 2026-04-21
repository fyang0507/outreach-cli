# One-off send (utility mode)

For smoke tests, demos, or one-shot notifications — **not for real outreach**. Under `--once` the CLI writes no campaign event, creates no contact record, and registers no reply watcher. Any reply that lands will be invisible to this skill.

If the send belongs to ongoing work with any expected follow-up, switch to [campaign.md](./campaign.md) instead.

## Usage

Pass `--once` on any send command. Requires `--to` (or event fields for calendar). Mutually exclusive with `--campaign-id`, `--contact-id`, and `--fire-and-forget`.

```bash
outreach sms send     --once --to +15551234567 --body "ping"
outreach email send   --once --to a@b.com --subject "..." --body "..."
outreach call place   --once --to +15551234567 --objective "..."
outreach calendar add --once --summary "..." --start ... --end ...
```

Per-channel flag details: [call.md](./call.md), [sms.md](./sms.md), [email.md](./email.md), [calendar.md](./calendar.md).

## Prerequisites

Run `outreach health` first — only the channel you're using needs to be healthy. Data repo must resolve (see [SKILL.md § Prerequisites](./SKILL.md)), but sundial/relay daemons are **not** required for `--once` since no watcher is registered.

## When to switch to campaign mode

If any of these apply, stop and go to [campaign.md](./campaign.md):

- The destination is someone you expect to reach again.
- The operator asked you to "start outreach," "reach out," or "follow up."
- A reply landing on this send would matter.
- You're updating a record for a prior send — `--once` leaves no trail to update.
- You can't find an existing campaign and are tempted to skip campaign setup. **Don't.** Create the campaign properly.
