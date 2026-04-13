# Thread-Grouped Email History in `context` Command

## Problem

`outreach context` fetches email history by address, returning a flat chronological list of all messages involving that email. When a contact has multiple email threads (scheduling, insurance, CRM), the flat list makes it hard for a fresh agent to identify which thread to continue or reply to.

## Design

### Core idea: campaign events as thread index

`email send` already logs `thread_id` in attempt events. `human_input` events can carry `thread_id` for inbound-discovered threads (found via `email search`, #39). The `context` command reads these event-tracked thread IDs and fetches each thread individually, returning messages grouped by thread.

### Algorithm

```
1. Read campaign events for contact
2. Collect unique thread_ids where channel === "email" (any event type)
3. If thread_ids found:
     Fetch each via Gmail threads.get() — full messages with bodies
     Return as email_threads: [{ thread_id, subject, messages }]
4. If no thread_ids AND contact.email exists:
     Fallback: address-based search, group results by threadId
     Return same shape
5. If neither:
     No email context (correct — nothing to fetch)
```

### Thread discovery — two paths

Both paths end with `thread_id` in the campaign event log.

**Outbound-first** (already works): `email send` auto-logs `thread_id` in the `attempt` event. Thread is tracked from the first send.

**Inbound-first** (requires #39): User reports receiving an email. Agent runs `email search` to find the thread, confirms with user, then records a `human_input` event with `channel: "email"` and `thread_id`. Future `context` calls discover it.

### Output shape change

Before (flat):
```json
{
  "recent_messages": {
    "c_a1b2c3": {
      "sms": [...],
      "email": [{ "id": "...", "threadId": "...", "from": "...", "subject": "...", ... }]
    }
  }
}
```

After (thread-grouped):
```json
{
  "recent_messages": {
    "c_a1b2c3": {
      "sms": [...],
      "email_threads": [
        {
          "thread_id": "18f1a2b3c4d5e6f7",
          "subject": "Re: Scheduling appointment",
          "messages": [
            { "id": "...", "threadId": "...", "from": "...", "subject": "...", "body": "...", ... },
            { "id": "...", "threadId": "...", "from": "...", "subject": "...", "body": "...", ... }
          ]
        },
        {
          "thread_id": "18f9c8d7e6f5a4b3",
          "subject": "Insurance verification",
          "messages": [...]
        }
      ]
    }
  }
}
```

Key rename from `email` to `email_threads` is intentional — consumers that read `.email` get `undefined` rather than silently misinterpreting a new shape.

### `human_input` with `thread_id`

When an agent records inbound email activity, the event should include `thread_id`:

```json
{
  "ts": "2026-04-12T09:00:00Z",
  "type": "human_input",
  "contact_id": "c_a1b2c3",
  "channel": "email",
  "thread_id": "18f1a2b3c4d5e6f7",
  "content": "Received reply confirming Thursday availability"
}
```

The `context` command extracts `thread_id` from any event with `channel === "email"` — no filter on event type. This naturally picks up both `attempt` and `human_input` events.

### Contact `email` field semantics

- `email` is the **send target** for initiating new threads, not a history index
- `email: null` is valid when only tracked threads exist — agent replies via `--reply-to-id`
- If tracked threads exist, `context` uses them; if not, falls back to address search

## Implementation

### `src/providers/gmail.ts`

New type:
```typescript
export interface EmailThread {
  thread_id: string;
  subject: string;
  messages: EmailSummary[];
}
```

New function:
```typescript
export async function readEmailThreads(opts: {
  threadIds?: string[];
  address?: string;
  limit?: number;
}): Promise<EmailThread[]>
```

- **Thread-ID path**: `Promise.allSettled` over `readEmailHistory({ threadId })` for each ID. Skips rejected/empty results (handles stale thread_ids from deleted emails). Maps fulfilled results into `EmailThread` objects, extracting `subject` from the first message.
- **Address fallback**: calls existing `readEmailHistory({ address, limit })`, groups the flat `EmailSummary[]` by `threadId` (already present on every summary), builds `EmailThread` per group.
- Both paths return threads sorted chronologically by first message date.

### `src/commands/context.ts`

Replace the email fetch block (lines 99-112):

1. Extract thread_ids from campaign events:
   ```typescript
   const emailThreadIds = new Set<string>();
   for (const e of events) {
     if (e.contact_id === cid && e.channel === "email" && typeof e.thread_id === "string") {
       emailThreadIds.add(e.thread_id);
     }
   }
   ```

2. Fetch via `readEmailThreads`:
   - If `threadIds.length > 0` → `readEmailThreads({ threadIds })`
   - Else if `contact.email` → `readEmailThreads({ address, limit: 10 })`
   - Store as `channelMessages.email_threads`

### Skill docs

**`skill/SKILL.md`**: Update context output format. Add `human_input` + `thread_id` convention with example.

**`skill/email.md`**: Document thread-grouped context, inbound discovery workflow via `email search` (#39).

## Edge cases

- **Deleted thread**: `Promise.allSettled` catches Gmail 404, thread silently omitted
- **Duplicate thread_ids**: `Set<string>` deduplication prevents re-fetching
- **No email channel activity**: entire block skipped (unchanged)
- **No thread_ids AND no email address**: no email context returned (correct)
- **Gmail auth failure**: caught by existing try/catch, `email_threads` key not added

## References

- #35 — this issue
- #39 — email search command (inbound thread discovery)
- #33 — parent discussion on unified identifier model
