# Calendar channel

Calendar events via Google Calendar API (OAuth2 auth, shared with Gmail).

## Adding an event

```bash
outreach calendar add \
  --summary "Dental cleaning" \
  --start "2026-04-22T14:00:00" \
  --end "2026-04-22T15:00:00" \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

**Required**: `--summary`, `--start`, `--end`, `--campaign-id`, `--contact-id`
**Optional**: `--description <text>`, `--location <text>`, `--attendees <email...>` (space-separated email addresses)

Start and end are ISO 8601 datetimes (e.g., `2026-04-22T14:00:00`). Timezone offset is optional — if omitted, the system's local timezone is used. End must be after start.

The CLI creates the event via Google Calendar API, then auto-appends an `attempt` entry with `channel: "calendar"`, `result: "created"`, `event_id`, `summary`, `start`, and `end` to the campaign JSONL.

Returns: `{ "event_id": "...", "html_link": "...", "summary": "...", "start": "...", "end": "...", "status": "created" }`

**Ad-hoc add (`--once`):** `outreach calendar add --once --summary "test" --start 2099-01-01T10:00:00 --end 2099-01-01T11:00:00` — suppresses the campaign JSONL append. The event itself is real on Google Calendar regardless. Output includes `"mode": "once"`. Mutually exclusive with `--campaign-id` and `--contact-id`.

## Removing an event

```bash
outreach calendar remove \
  --event-id "abc123xyz" \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

**Required**: `--event-id`, `--campaign-id`, `--contact-id`

The `event_id` comes from a previous `calendar add` result or from the campaign JSONL attempt entry.

The CLI deletes the event via Google Calendar API, then auto-appends an `attempt` entry with `channel: "calendar"`, `result: "removed"`, and `event_id` to the campaign JSONL.

Returns: `{ "event_id": "...", "status": "removed" }`

**Ad-hoc remove (`--once`):** `outreach calendar remove --once --event-id <id>` — suppresses the campaign JSONL append. Output: `{ "event_id": "...", "status": "removed", "mode": "once" }`. Mutually exclusive with `--campaign-id` and `--contact-id`.

## Rescheduling

There is no dedicated reschedule command. To reschedule, remove the old event and add a new one:

1. `outreach calendar remove --event-id <old_id> --campaign-id ... --contact-id ...`
2. `outreach calendar add --summary ... --start <new_start> --end <new_end> --campaign-id ... --contact-id ...`

Both operations are logged as separate attempt entries in the campaign JSONL.

## First-time auth

Calendar uses the same OAuth2 token as Gmail, stored at `<data_repo_path>/outreach/gmail-token.json`. The token includes the `calendar.events` scope.

If you previously authorized Gmail only, the existing token may lack calendar scope. Delete the token file and re-authorize — the new flow requests all scopes (Gmail + Calendar). The `outreach health` command checks calendar access separately and will indicate if re-authorization is needed.

## Calendar-specific notes

- **Timezone**: Timezone offset in `--start` and `--end` is optional. If omitted (e.g., `2026-04-22T14:00:00`), the system's local timezone is applied automatically. You can still include an explicit offset (e.g., `2026-04-22T14:00:00-04:00`) when needed.
- **Event ID preservation**: The `event_id` returned by `calendar add` is the permanent identifier for the event. Store it in campaign attempt entries and use it for subsequent `calendar remove` operations.
- **Attendees**: When `--attendees` is provided, Google Calendar sends invitation emails to the listed addresses. Only include attendees when the user explicitly requests it.
