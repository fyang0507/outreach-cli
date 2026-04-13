# Plan: SMS Channel + Cross-Channel Context (Issue #23)

## Context

The outreach-cli currently supports voice calls only. Issue #23 adds SMS (iMessage) support and a cross-channel `context` command that assembles JIT briefings from campaign JSONL + recent channel messages. Unlike calls, SMS is stateless fire-and-forget — the hard problem is context assembly across sessions, which `outreach context` solves as a channel-agnostic command.

## Key design decisions from discussion

- **CLI enables outreach, doesn't own data format.** No typed interfaces for campaign data. `context` reads JSONL lines as raw JSON, filters by `contact_id`, and passes through as-is. Malformed lines are kept, not skipped.
- **`chat_identifier` is exact match.** Messages DB stores phone numbers in E.164 (`+15551234567`). Normalize input to E.164, then `WHERE c.chat_identifier = ?`. No fuzzy matching.
- **Attachments use canonical `mime_type`** from the DB (e.g., `image/jpeg`, `video/quicktime`). Fallback to `uti` if `mime_type` is null.
- **Tapbacks are included** as a `reactions` array on each message, not filtered out. Codes: 2000=love, 2001=like, 2002=dislike, 2003=laugh, 2004=emphasis, 2005=question, 2006=custom. 3000-3006=removals.
- **`attributedBody` fallback.** Newer macOS stores some text only in `attributedBody` (NSKeyedArchiver blob) with `text` null. Need a simplified parser to extract the UTF-8 string.
- **`--campaign-id` + `--contact-id` are required on `sms send`** — every outreach SMS is campaign-tracked. Separate issue to enforce the same on `call place`.
- **README update** needed for expanded scope and new dependency (`better-sqlite3`).

## Implementation Order

### 1. Add `better-sqlite3` dependency

```
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

Synchronous API, readonly mode for `chat.db`. Native module — needs Xcode CLI tools.

### 2. Create `src/providers/messages.ts`

Core infrastructure — Messages DB reader + AppleScript sender.

**`normalizePhone(raw: string): string`** — strip non-digits, normalize to E.164 (`+15551234567`). Simple rules: 10 digits → `+1` prefix, 11 digits starting with `1` → `+` prefix, already has `+` → keep.

**`readMessageHistory(phone: string, options: { limit?: number, sinceDays?: number }): MessageEntry[]`**

- Open `~/Library/Messages/chat.db` readonly via `better-sqlite3`
- Normalize phone to E.164
- Query with exact match on `chat_identifier`:
  ```sql
  SELECT m.ROWID, m.text, m.attributedBody, m.is_from_me, m.date,
         m.cache_has_attachments, m.associated_message_type, m.guid
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE c.chat_identifier = ?
  ORDER BY m.date DESC
  LIMIT ?
  ```
- For regular messages (`associated_message_type` is 0 or null): build `MessageEntry` with `text`, `is_from_me`, `date`, `attachments[]`
- Text resolution: use `text` if non-null, else parse `attributedBody` blob for UTF-8 string
- For messages with `cache_has_attachments = 1`, secondary query:
  ```sql
  SELECT a.mime_type, a.uti FROM attachment a
  JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
  WHERE maj.message_id = ?
  ```
  Represent as `mime_type` string (e.g., `image/jpeg`). If `mime_type` null, fall back to `uti`.
- For tapbacks (`associated_message_type` 2000-2006): collect separately, then attach to the message they reference via `associated_message_guid` (format `p:X/GUID`, extract GUID after last `/`). Net removals (3000-3006) cancel the corresponding add.
- Date conversion: CoreData nanoseconds since 2001-01-01 → ISO 8601: `new Date((raw / 1_000_000_000 + 978_307_200) * 1000).toISOString()`
- Return chronological order (reverse DESC result)
- Close DB after each call (stateless)

**Return type:**
```typescript
interface MessageEntry {
  text: string;                          // body or null if no text
  is_from_me: boolean;
  date: string;                          // ISO 8601
  attachments?: string[];                // ["image/jpeg", "video/quicktime"] — canonical mime_type or uti
  reactions?: { emoji: string; is_from_me: boolean }[];  // resolved from tapbacks on this message
}
```

**`sendIMessage(to: string, body: string): Promise<void>`**

- AppleScript via `execFileSync`, passing script on stdin and arguments via argv (no shell escaping):
  ```applescript
  on run argv
    set theRecipient to item 1 of argv
    set theMessage to item 2 of argv
    tell application "Messages"
      set targetBuddy to buddy theRecipient of (service 1 whose service type is iMessage)
      send theMessage to targetBuddy
    end tell
  end run
  ```
- 15s timeout. Throws on failure.

### 3. Add read helpers to `src/logs/sessionLog.ts`

No typed campaign interfaces. Two new functions:

**`readCampaignEvents(campaignId: string): Promise<{ header: Record<string, unknown>; events: Record<string, unknown>[] }>`**
- Reads `{campaignsDir}/{campaignId}.jsonl`
- Line 1 → `header` (parsed JSON, or raw string wrapped in `{ raw: line }` if malformed)
- Lines 2+ → `events` array (each parsed JSON, malformed lines kept as `{ raw: line }`)
- No schema validation, no type enforcement

**`readContact(contactId: string): Promise<Record<string, unknown>>`**
- Reads `{contactsDir}/{contactId}.json`
- Returns parsed JSON as-is

Add `import { readFile }` to existing imports.

### 4. Create `src/commands/sms/history.ts`

```
outreach sms history --phone <number> [--limit 20]
```

- Calls `readMessageHistory(phone, { limit })`
- Outputs `{ phone: normalizedPhone, messages: [...] }`
- Empty thread → `{ phone, messages: [] }` (not an error)
- DB not accessible → `INFRA_ERROR` with hint about Full Disk Access

### 5. Create `src/commands/sms/send.ts`

```
outreach sms send --to <number> --body <text> --campaign-id <id> --contact-id <id>
```

All four flags are **required**.

1. Normalize phone
2. `sendIMessage(normalized, body)`
3. Auto-append attempt: `appendCampaignEvent(campaignId, { ts: isoNow(), contact_id: contactId, type: "attempt", channel: "sms", result: "sent" })`
4. Output `{ to: normalized, status: "sent" }`
5. On AppleScript failure → `OPERATION_FAILED`, no campaign event logged

### 6. Create `src/commands/context.ts`

```
outreach context --campaign-id <id> [--contact-id <id>] [--since <days=7>]
```

**Single assembly pipeline** — `--contact-id` is a filter, not a different mode:

1. `readCampaignEvents(campaignId)` → header + events
2. If `--contact-id`: filter events — exclude lines with a `contact_id` that doesn't match; keep lines with matching `contact_id` or no `contact_id` field (campaign-level entries)
3. Determine contacts to include: if `--contact-id` → `[contactId]`; if not → header's `contacts` array
4. For each included contact:
   - `readContact(contactId)` → get `phone` field
   - Detect channels from events (scan for `channel` field values where `contact_id` matches)
   - If `"sms"` in channels and phone available: `readMessageHistory(phone, { limit: 10, sinceDays: since })`
5. Assemble `recent_messages` keyed by `contact_id` → `channel` → messages
6. Output: `{ campaign: header, events, recent_messages }`

`--contact-id` narrows the scope (fewer events, one contact's messages instead of all). Same output shape either way. `--since` (default 7) only filters `recent_messages`, never campaign events.

### 7. Wire commands in `src/cli.ts`

```typescript
import { registerContextCommand } from "./commands/context.js";
import { registerSendCommand } from "./commands/sms/send.js";
import { registerHistoryCommand } from "./commands/sms/history.js";

registerContextCommand(program);  // top-level

const sms = program.command("sms").description("SMS / iMessage commands");
registerSendCommand(sms);
registerHistoryCommand(sms);
```

### 8. Update docs

**`CLAUDE.md`**: update CLI description, key files table, add `src/providers/messages.ts`, `src/commands/sms/*.ts`, `src/commands/context.ts`.

**`SKILL.md`**: add SMS send/history usage, context command usage, post-SMS workflow (parallel to post-call), both agent entry paths (Path A: campaign → context, Path B: phone → sms history → identify campaign → context).

**`README.md`**: update with expanded scope (SMS + context), new dependency (`better-sqlite3`), iMessage/macOS requirements, Full Disk Access prerequisite.

### 9. Follow-up issue

Create issue: make `--campaign-id` + `--contact-id` required on `call place` (breaking change, separate PR).

## Files

| File | Action | Purpose |
|---|---|---|
| `package.json` | modify | add `better-sqlite3` + `@types/better-sqlite3` |
| `src/providers/messages.ts` | **create** | Messages DB reader + AppleScript sender + phone normalization |
| `src/logs/sessionLog.ts` | modify | add `readCampaignEvents()`, `readContact()` |
| `src/commands/sms/send.ts` | **create** | `outreach sms send` (required campaign/contact flags) |
| `src/commands/sms/history.ts` | **create** | `outreach sms history` |
| `src/commands/context.ts` | **create** | `outreach context` — cross-channel assembly |
| `src/cli.ts` | modify | register sms + context commands |
| `CLAUDE.md` | modify | key files table, CLI description |
| `SKILL.md` | modify | SMS + context documentation, post-SMS workflow |
| `README.md` | modify | expanded scope, dependencies, prerequisites |

## Verification

1. `npm run build` — clean compile
2. `outreach health` — SMS section still works
3. `outreach sms history --phone "+14124194399"` — verify thread loads with attachments as `image/jpeg` etc., tapbacks as reactions
4. `outreach sms history --phone "+10000000000"` — empty result, no crash
5. `outreach sms send --to "<test>" --body "CLI test" --campaign-id "test" --contact-id "c_test"` — verify message sent + attempt logged
6. `outreach context --campaign-id "<existing>"` — campaign overview, all events
7. `outreach context --campaign-id "<existing>" --contact-id "<existing>"` — filtered events + recent_messages
8. `outreach context --campaign-id "<existing>" --contact-id "<existing>" --since 30` — wider message window
