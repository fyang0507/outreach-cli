# Auto-watch for replies on send (#50)

## Context

When an agent sends an SMS or email, it almost always needs to know about the reply. Today there's no async notification — the agent has no way to discover inbound replies after `send`. This feature auto-registers a sundial poll trigger after each send, so the agent gets a callback when a reply arrives.

**Key design insight:** The `reply-check` trigger command derives its watermark from the campaign log at check time — no `--since` parameter in the trigger. This makes the trigger string deterministic for a given `(campaign, contact, channel)` triple, enabling natural dedup: subsequent sends to the same contact produce the same trigger+callback pair, so sundial can match and refresh instead of creating duplicates.

**Watermark semantics:** The watcher tracks replies to the *latest* outbound message. If the agent sends again before seeing a reply to the previous message, the watermark advances to the new send time. This is correct — the agent explicitly moved the conversation forward. Earlier replies remain in the message history and are not lost.

## Implementation (10 steps)

### 1. Add `since` timestamp to `readMessageHistory`

**File:** `src/providers/messages.ts` — modify options type (line 158)

Add optional `since?: string` (ISO 8601) alongside existing `sinceDays`. When provided, convert to CoreData nanoseconds and use as SQL date filter (`AND m.date >= ?`). Takes precedence over `sinceDays`.

```typescript
// Before: options: { limit?: number; sinceDays?: number }
// After:  options: { limit?: number; sinceDays?: number; since?: string }
```

New branch before the `sinceDays` check (line 169):
```typescript
if (options.since !== undefined) {
  const coreDataNs = (Date.parse(options.since) / 1000 - 978_307_200) * 1_000_000_000;
  dateFilter = " AND m.date >= ?";
  params.push(coreDataNs);
} else if (options.sinceDays !== undefined) {
```

### 2. Export `getSelfEmail` from Gmail provider

**File:** `src/providers/gmail.ts` — line 104: add `export` keyword

```typescript
// Before: async function getSelfEmail(
// After:  export async function getSelfEmail(
```

**Why not use campaign-log message_ids instead:** `getSelfEmail` correctly excludes ALL our messages — including ones sent manually via Gmail. If the user already replied to the thread manually, the watcher shouldn't fire (they handled it). Campaign-log matching would miss manual replies and cause false positives.

**Performance:** One `users.getProfile` API call per poll (1 quota unit). At 2-minute intervals, ~30 calls/hour. Gmail daily quota is 1B units. Negligible.

### 3. Add `findLatestOutboundAttempt` to sessionLog

**File:** `src/logs/sessionLog.ts` — new export near bottom

```typescript
export interface OutboundAttempt {
  ts: string;
  contact_id: string;
  channel: string;
  message_id?: string;  // email only
  thread_id?: string;   // email only
}

export async function findLatestOutboundAttempt(
  campaignId: string,
  contactId: string,
  channel: string,
): Promise<OutboundAttempt | null>
```

Reads campaign events, iterates in reverse, returns first match where `type === "attempt"` AND `contact_id === contactId` AND `channel === channel` AND `result === "sent"`. Catches ENOENT (campaign doesn't exist) → returns null.

Performance is fine: campaign JSONL files have at most hundreds of lines. Linear scan is microseconds.

### 4. Add watch config to appConfig

**File:** `src/appConfig.ts`

New interface:
```typescript
export interface WatchConfig {
  callback_command: string;    // e.g. "codex exec {message}"
  default_timeout_hours: number;
  poll_interval_minutes: number;
}
```

Add `watch?: WatchConfig` to `AppConfig` (after `gemini`, line 57). Optional field — existing users without this section won't break.

In `loadAppConfig()`, add validation after gemini block (~line 149): if `watch` section present, require `callback_command` as non-empty string, default `default_timeout_hours` to 72, default `poll_interval_minutes` to 2. If section absent, leave as undefined.

**File:** `outreach.config.yaml` — add at end:
```yaml
watch:
  callback_command: "echo {message}"
  default_timeout_hours: 72
  poll_interval_minutes: 2
```

### 5. Create `src/commands/replyCheck.ts`

**New file.** Top-level command: `outreach reply-check --campaign-id X --contact-id Y --channel sms|email`

Registration: `registerReplyCheckCommand(program: Command)` following existing pattern.

**SMS path:**
1. `findLatestOutboundAttempt(campaignId, contactId, "sms")` → watermark
2. If null → exit 1: `{ replied: false, reason: "no_outbound_attempt" }`
3. `resolveContactAddress(contactId, "sms")` → phone
4. `readMessageHistory(phone, { since: attempt.ts, limit: 50 })`
5. Filter: `is_from_me === false` (belt-and-suspenders)
6. If any → exit 0: `{ replied: true, channel: "sms", contact_id, campaign_id, reply_count }`
7. If none → exit 1: `{ replied: false }`

**Email path:**
1. `findLatestOutboundAttempt(campaignId, contactId, "email")` → watermark + thread_id
2. If null → exit 1
3. `getGmailClient()` then `getSelfEmail(gmail)`
4. `readEmailHistory({ threadId: attempt.thread_id })` — falls back to `{ address }` via `resolveContactAddress` if no thread_id
5. Filter: `new Date(msg.date) > new Date(watermark)` AND `!msg.from.toLowerCase().includes(selfEmail.toLowerCase())`
6. Broad detection: any non-self message in the thread counts (includes CC'd recipients, out-of-office replies — the agent reads the full thread in the callback and decides what's actionable)
7. If any → exit 0; else → exit 1

**Exit codes:** 0 = reply found (sundial fires callback), 1 = no reply (sundial retries), 2 = infra error (bad config, missing contact, provider failure).

### 6. Create `src/watch.ts`

**New file.** Sundial registration helper.

```typescript
export interface WatchResult {
  schedule_id?: string;
  // "skipped"/"failed" are set by this module; any other value is sundial's
  // status string passed through verbatim (e.g. "active", "refreshed").
  status: "skipped" | "failed" | string;
  error?: string;
}

export async function registerReplyWatch(opts: {
  campaignId: string;
  contactId: string;
  channel: "sms" | "email";
  contactName?: string;
}): Promise<WatchResult>
```

**Implementation:**
1. Load config. If no `watch` section → return `{ status: "skipped" }`.
2. Build deterministic name: `outreach-${sanitize(campaignId)}-${sanitize(contactId)}-${channel}` where `sanitize` replaces `[^a-zA-Z0-9_-]` with `_`.
3. Build trigger: `outreach reply-check --campaign-id ${campaignId} --contact-id ${contactId} --channel ${channel}`
4. Compose notification message: `"Reply from ${contactName ?? contactId} on ${channel} for campaign ${campaignId}. Run: outreach ${channel} history --contact-id ${contactId}"`
5. Build callback from config template. Replace `{message}` with POSIX shell-quoted message, `{contact_id}` / `{campaign_id}` / `{channel}` with literal values:
   ```typescript
   function shellQuote(s: string): string {
     return "'" + s.replace(/'/g, "'\\''") + "'";
   }
   ```
   `{message}` is always emitted as a properly quoted shell token — users should NOT add their own quotes around it in the config template. Example: config `"codex exec {message}"` becomes `codex exec 'Reply from Dr. O'\''Brien...'`.
6. Call sundial via `execFile` (promisified, not shell string) with args as array. **Always pass `--refresh`** — outreach-cli is the sole consumer of these watchers, and every send should unconditionally create-or-refresh:
   ```typescript
   execFile("sundial", [
     "add", "--type", "poll",
     "--trigger", trigger,
     "--interval", `${interval}m`,
     "--timeout", `${timeout}h`,
     "--once",
     "--refresh",
     "--command", callback,
     "--name", name,
     "--json",
   ], { timeout: 10_000 });
   ```
7. Parse JSON result:
   - Success → return `{ schedule_id: result.id, status: result.status }` — `result.status` is sundial's status string, passed through verbatim (e.g. `"active"` for a new schedule, `"refreshed"` when an existing one was updated).
   - ENOENT → `{ status: "failed", error: "sundial not installed" }`
   - Other error → `{ status: "failed", error }`

Because `--refresh` is always passed, there is no duplicate rejection to handle. Sundial resolves the identity by `--name` and reports whatever lifecycle status applies (e.g. a new schedule reports `"active"`, an updated one reports `"refreshed"`).

### 7. Wire auto-watch into SMS send

**File:** `src/commands/sms/send.ts`

Changes:
1. Add `.option("--fire-and-forget", "Skip reply watcher registration")` after `--contact-id`
2. Add `fireAndForget?: boolean` to opts type
3. Add `await_reply: !opts.fireAndForget` to the attempt event:
   ```typescript
   await appendCampaignEvent(opts.campaignId, {
     ts: isoNow(),
     contact_id: opts.contactId,
     type: "attempt",
     channel: "sms",
     result: "sent",
     await_reply: !opts.fireAndForget,
   });
   ```
4. After the attempt event, register watcher (wrapped in try/catch — never blocks send):
   ```typescript
   let watchResult: WatchResult | null = null;
   if (!opts.fireAndForget) {
     try {
       watchResult = await registerReplyWatch({
         campaignId: opts.campaignId,
         contactId: opts.contactId,
         channel: "sms",
       });
       if (watchResult.schedule_id) {
         await appendCampaignEvent(opts.campaignId, {
           ts: isoNow(),
           contact_id: opts.contactId,
           type: "watch",
           channel: "sms",
           watch_schedule_id: watchResult.schedule_id,
           watch_status: watchResult.status,
         });
       }
     } catch {
       watchResult = { status: "failed", error: "sundial unavailable" };
     }
   }
   ```
5. Include watch in output JSON:
   ```typescript
   outputJson({
     to: normalized,
     status: "sent",
     watch: opts.fireAndForget ? null : (watchResult ?? { status: "skipped" }),
   });
   ```

**Design:** `watch: null` means explicitly opted out (`--fire-and-forget`). `watch: { status: "skipped" }` means no watch config. On success the status is sundial's verbatim value (e.g. `"active"`, `"refreshed"`). `failed` means sundial was unavailable. The agent has full visibility but doesn't need to act on any of these — they're informational.

### 8. Wire auto-watch into email send

**File:** `src/commands/email/send.ts`

Same pattern as step 7, with `channel: "email"`. Same flag, same try/catch, same campaign events, same output shape.

### 9. Wire `reply-check` in CLI

**File:** `src/cli.ts`

```typescript
import { registerReplyCheckCommand } from "./commands/replyCheck.js";
// ... after registerContextCommand(program):
registerReplyCheckCommand(program);
```

Top-level because it spans both channels, like `health` and `context`.

### 10. Update docs

**`skills/outreach/sms.md`** and **`skills/outreach/email.md`**: Add "Auto-watch for replies" section covering default behavior, `--fire-and-forget`, dedup, manual `reply-check` usage.

**`CLAUDE.md`**: Add `reply-check` to top-level commands listing, `src/commands/replyCheck.ts` and `src/watch.ts` to key files table, `watch` to config table, `--fire-and-forget` to identifier model table.

## Sundial interaction model

Outreach-cli always passes `--refresh` when calling `sundial add`. The agent never interacts with sundial directly — it only sees `outreach [channel] send` and the `watch` field in the output. Sundial is invisible infrastructure.

Because `--refresh` is always passed and watcher identity is keyed by `--name` (`outreach-{campaign}-{contact}-{channel}`), all three lifecycle scenarios resolve cleanly:

| Scenario | What sundial does | Status returned (sundial) |
|---|---|---|
| First send (no watcher) | Creates new poll schedule | `active` |
| Re-send before reply (active watcher) | Updates in place, resets timeout | `refreshed` |
| Re-send after completion | Reactivates with fresh countdown | (sundial-owned, see sundial docs) |

No duplicate rejection, no error handling branches, no special cases. The watch module is stateless — it fires `sundial add --refresh` and reads the result.

**Sundial prerequisites:** fyang0507/sundial#19 (refresh semantics), fyang0507/sundial#24 (name-based reactivation), fyang0507/sundial#25 (config bootstrap).

## Key design decisions

**No `--since` in trigger command:** Watermark is derived from campaign log at check time. This makes the trigger deterministic per (campaign, contact, channel) — enabling sundial dedup without parameter parsing. Trade-off: if agent sends again before a reply to the previous message, the watermark advances and the earlier reply doesn't trigger the callback. This is correct: the watcher tracks the latest send, earlier replies remain in history.

**Callback composed at send time:** The notification message (who replied, on what channel, what command to run) is fully known at send time. No runtime substitution needed. Sundial receives a complete shell command.

**`execFile` instead of shell string for sundial:** The CLI constructs sundial arguments as an array and calls `execFile("sundial", [...args])`. This avoids the outer shell escaping layer entirely. Only the inner escaping (for `{message}` in the callback template) is needed.

**Watch never blocks send:** Attempt event is logged before watch registration. If sundial is down/absent, the send succeeds with `watch: { status: "failed" }`. The agent decides what to do.

**Broad email reply detection:** Any non-self message in the thread counts — CC'd recipients, auto-replies, etc. The agent reads the full thread and decides what's actionable.

**Polling over event-driven:** Gmail push requires Cloud Pub/Sub infrastructure. iMessage file-watching requires a persistent daemon and is unreliable on WAL files. 2-minute polling is simple, debuggable, requires no new infrastructure, and adequate for human reply timescales.

## Verification

1. `npm run build` succeeds
2. `outreach reply-check --campaign-id X --contact-id Y --channel sms` → exit 1 (no outbound)
3. `outreach sms send --campaign-id X --contact-id Y --body "Hi"` → output includes `watch: { schedule_id: "...", status: "active" }` (sundial's verbatim status)
4. `outreach sms send ... --fire-and-forget` → output has `watch: null`
5. `sundial list --json` shows watcher after send (when sundial running)
6. Reply from target phone → `outreach reply-check ...` → exit 0
7. Same flow for email channel
8. No `watch` in config → send works, `watch: { status: "skipped" }`
9. Sundial not on PATH → send works, `watch: { status: "failed" }`
10. Send twice to same contact → second send shows `watch: { status: "refreshed" }` (same schedule ID, timeout refreshed)
