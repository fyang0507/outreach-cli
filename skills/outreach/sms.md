# SMS channel

SMS via iMessage (AppleScript sender + Messages DB reader).

## Sending an SMS

```bash
outreach sms send \
  --body "Hi, following up on our conversation about scheduling." \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

**Required**: `--body`, `--campaign-id`, `--contact-id`
**Optional**: `--to <number>` — override the phone number resolved from the contact record.

The destination phone is resolved from the contact's `sms_phone` field (falling back to `phone`). Pass `--to` only to override. The CLI auto-picks iMessage vs. SMS based on recent history with that number (most recent successful outbound → its service; else most recent inbound; else iMessage), sends via AppleScript, then **synchronously probes chat.db for delivery** before returning. On confirmed delivery it appends an `attempt` entry with `channel: "sms"` to the campaign JSONL and registers the reply watcher. On failed/timeout delivery, neither the campaign event nor the watcher is written — the agent sees `OPERATION_FAILED` and should treat the send as not done.

Returns (success): `{ "to": "+15551234567", "status": "sent", "service": "iMessage" | "SMS", "watch": ... }`

Failure modes (exit 3, `OPERATION_FAILED`):
- `"Message not delivered (error code N) over <service>"` — macOS reported a failure (e.g. iMessage service rejection, SMS relay error). Try a different channel or `ask_human`.
- `"Delivery status unknown after 90s over <service>"` — probe timed out. Messages.app may still be retrying. Check the Messages UI or retry after confirming.
- `"AppleScript could not find an SMS service"` — Text Message Forwarding is not enabled on a paired iPhone. Requires iPhone Settings → Messages → Text Message Forwarding to send SMS.

**Ad-hoc test (`--once`):** `outreach sms send --once --to +15551234567 --body "ping"` — no campaign state, no reply watcher. Use only for smoke-tests or demos; real outreach belongs in a campaign. Mutually exclusive with `--campaign-id`, `--contact-id`, and `--fire-and-forget`. Output: `{ "to": "...", "status": "sent", "watch": { "status": "skipped", "reason": "once" } }`.

When signing off or referencing the user, use `outreach whoami --field <name>` (e.g. `first_name`, `email_signature`). See `SKILL.md § outreach whoami`.

## Reading SMS history

```bash
# By contact — resolves phone from contact record (sms_phone ?? phone)
outreach sms history --contact-id "c_a1b2c3" --limit 20

# By raw phone number
outreach sms history --phone "+15551234567" --limit 20
```

One of `--contact-id` or `--phone` is required. Returns the most recent messages from the iMessage thread for that phone number, including attachments (as MIME types) and tapback reactions. Empty thread returns `{ phone, messages: [] }`.

## Auto-watch for replies

By default, `sms send` registers a background reply watcher that monitors for inbound replies and fires a callback when one arrives. This is automatic — no extra flags needed.

- **`--fire-and-forget`**: Skip watcher registration. Use when no reply is expected (e.g., one-way notifications).
- **Dedup**: Sending again to the same contact on the same campaign reuses the existing watcher. The watermark advances to the latest send — earlier unreplied messages don't trigger the callback.
- **Session resume**: Each callback spawns the configured agent. First callback is a cold start; subsequent callbacks for the same (contact, channel) resume the prior session so context carries across replies. Each run appends a `callback_run` event to the campaign JSONL.
- **Output**: The `watch` field in send output is one of: `null` (fire-and-forget), `{ status: "skipped" }` (no watch config), `{ status: "failed", error }` (watcher unavailable), or `{ schedule_id, status }` where `status` is the watcher's status (e.g. `active` for a fresh schedule, `refreshed` when an existing one was updated).

## SMS-specific notes

SMS is asynchronous — the send and reply happen in different agent sessions. Use `outreach context` to gather reply context in a follow-up session. Use `sms history` only when context is insufficient (e.g., need a specific phone thread not tied to a campaign).
