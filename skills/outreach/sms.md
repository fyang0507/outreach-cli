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

The destination phone is resolved from the contact's `sms_phone` field (falling back to `phone`). Pass `--to` only to override. The CLI sends via iMessage (AppleScript), then auto-appends an `attempt` entry with `channel: "sms"` to the campaign JSONL.

Returns: `{ "to": "+15551234567", "status": "sent" }`

**Ad-hoc test (`--once`):** `outreach sms send --once --to +15551234567 --body "ping"` — no campaign state, no reply watcher. Use only for smoke-tests or demos; real outreach belongs in a campaign. Mutually exclusive with `--campaign-id`, `--contact-id`, and `--fire-and-forget`. Output: `{ "to": "...", "status": "sent", "watch": { "status": "skipped", "reason": "once" } }`.

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
