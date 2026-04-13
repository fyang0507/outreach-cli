# Email Channel Implementation Plan (Issue #28)

## Context

The outreach CLI currently supports voice calls and SMS. Issue #28 adds email as the third channel via Gmail API. The design mirrors the SMS command structure (`email send`, `email history`) and integrates with the existing cross-channel `context` command and health checks. Gmail API was chosen over IMAP/Nodemailer-SMTP/Himalaya/Apple Mail specifically for native thread reconstruction (`threads.get()`), not search power.

## Dependencies

```
npm install googleapis nodemailer
npm install -D @types/nodemailer
```

- **`googleapis`** (v171) — Gmail API client with built-in TypeScript types and OAuth2 support
- **`nodemailer`** (v8) — zero-dep, 542KB. Using only its `MailComposer` for MIME construction (not SMTP transport). Battle-tested, handles `In-Reply-To`/`References` headers, multipart/mixed attachments, base64 encoding natively.

`mimetext` was considered but rejected: 729KB with 4 deps (including Babel runtime). Nodemailer is lighter and better tested despite being a larger scope library.

## Implementation Steps

### Step 1: Add Gmail credentials to config

**`src/config.ts`** — Add to `OutreachConfig` interface and exported object:
```typescript
GMAIL_CLIENT_ID: string;    // process.env.GMAIL_CLIENT_ID ?? ""
GMAIL_CLIENT_SECRET: string; // process.env.GMAIL_CLIENT_SECRET ?? ""
```

### Step 2: Create Gmail provider

**`src/providers/gmail.ts`** (new) — self-contained module mirroring `src/providers/messages.ts`

Five sections:

#### 2a: Auth + token management

Constants:
- `SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"]`
- `TOKEN_PATH = join(homedir(), ".outreach", "gmail-token.json")`
- `REDIRECT_PORT = 8089`, `REDIRECT_URI = http://localhost:8089/oauth2callback`

Functions:
- `createOAuth2Client()` — instantiate OAuth2 from config. Fail-fast if client ID/secret empty.
- `loadStoredToken(client)` — read TOKEN_PATH, set credentials. Return boolean.
- `saveToken(client)` — write credentials to TOKEN_PATH.
- `authorizeInteractive(client)` — generate auth URL, spin up temp HTTP server on 8089 to capture callback, auto-open browser via `open` (macOS), exchange code for tokens, 60s timeout. Auth URL and status to stderr (stdout reserved for JSON).
- `getGmailClient(): Promise<gmail_v1.Gmail>` — main entry point. Creates client, loads token or triggers interactive auth, returns Gmail API instance. Module-level cache. Registers `tokens` event listener for auto-persist on refresh.
- `checkGmailAuth(): Promise<{ok, error?, hint?, email?}>` — for health check. Loads token, tries `users.getProfile`. Returns status without triggering interactive auth.

#### 2b: Send

```typescript
export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyToId?: string;    // Gmail message ID — triggers threading
  replyAll?: boolean;    // default true when replyToId set
  attachments?: string[]; // file paths
}

export interface SendEmailResult {
  to: string;
  cc?: string[];
  subject: string;
  messageId: string;
  threadId: string;
}
```

`sendEmail(opts)` implementation:
1. Get Gmail client
2. If `replyToId`: fetch original via `messages.get` (format: "metadata", metadataHeaders: From, To, Cc, Subject, Message-ID, References)
3. Build threading headers: `In-Reply-To` = original's Message-ID, `References` = original's References + Message-ID
4. Reply-all (default when replyToId): To = original sender, Cc = (original To + Cc) minus self. Self-dedup via `users.getProfile({ userId: "me" })` (cached). `--no-reply-all`: To = original sender only.
5. Explicit `--to`/`--cc` override auto-resolved recipients.
6. Build MIME via nodemailer MailComposer: set From (self), To, Cc, Bcc, Subject, text body, In-Reply-To, References, attachments (read files, detect MIME type from extension).
7. `MailComposer.compile().build()` → Buffer → base64url encode
8. `messages.send({ userId: "me", requestBody: { raw, threadId } })`
9. Return result

#### 2c: History

```typescript
export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  body?: string;           // present in thread mode only
  attachments?: { filename: string; mimeType: string; size: number }[];
}
```

`readEmailHistory({ address?, threadId?, limit? })`:
- **By address**: `messages.list({ q: "from:addr OR to:addr", maxResults })` → batch-fetch metadata for each message ID → map to EmailSummary[] without body. Return chronological order (reverse Gmail's newest-first).
- **By thread**: `threads.get({ id, format: "full" })` → extract headers + plain text body (recursive payload walk) + attachment metadata → map to EmailSummary[] with body populated.

Helper: `extractPlainText(payload)` — recursive MIME tree walk looking for `text/plain` part, base64-decode `body.data`. Fallback to snippet if no plain text part found. Mirrors google-workspace-cli's `extract_payload_recursive` pattern.

### Step 3: Create email send command

**`src/commands/email/send.ts`** (new) — mirrors `src/commands/sms/send.ts`

Flags:
- Required: `--to`, `--subject`, `--body`, `--campaign-id`, `--contact-id`
- Optional: `--cc`, `--bcc`, `--reply-to-id`, `--no-reply-all`, `--attach <path...>`

Action: call `sendEmail()`, `appendCampaignEvent()` with `{ channel: "email", result: "sent", message_id, thread_id }`, `outputJson()`.

### Step 4: Create email history command

**`src/commands/email/history.ts`** (new) — mirrors `src/commands/sms/history.ts`

Flags:
- One of: `--address <email>` or `--thread-id <id>` (validated at runtime)
- Optional: `--limit` (default 20)

Action: call `readEmailHistory()`, `outputJson()`. Error hints for token expiry.

### Step 5: Register in CLI

**`src/cli.ts`** — add email subcommand group:
```typescript
import { registerSendCommand as registerEmailSendCommand } from "./commands/email/send.js";
import { registerHistoryCommand as registerEmailHistoryCommand } from "./commands/email/history.js";

const email = program.command("email").description("Email / Gmail commands");
registerEmailSendCommand(email);
registerEmailHistoryCommand(email);
```

### Step 6: Health check integration

**`src/commands/health.ts`** — replace static email placeholder with `checkGmailAuth()` from provider. Add to `Promise.all()` alongside existing checks.

### Step 7: Context command integration

**`src/commands/context.ts`** — inside the per-contact channel loop, add email block after SMS:
```typescript
if (channels.has("email")) {
  const emailAddr = typeof contact.email === "string" ? contact.email : null;
  if (emailAddr) {
    try {
      const messages = await readEmailHistory({ address: emailAddr, limit: 10 });
      channelMessages.email = messages;
    } catch { /* skip */ }
  }
}
```

### Step 8: Update docs

- **`CLAUDE.md`**: add email commands to CLI description, add `src/providers/gmail.ts` and `src/commands/email/*.ts` to key files table
- **`SKILL.md`**: add email send/history usage, post-email workflow

## Files Summary

| File | Action | Purpose |
|---|---|---|
| `package.json` | modify | add `googleapis`, `nodemailer`, `@types/nodemailer` |
| `src/config.ts` | modify | add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` |
| `src/providers/gmail.ts` | **create** | Gmail API client: auth, send, history, health |
| `src/commands/email/send.ts` | **create** | `outreach email send` |
| `src/commands/email/history.ts` | **create** | `outreach email history` |
| `src/cli.ts` | modify | register email subcommand group |
| `src/commands/health.ts` | modify | replace email placeholder with real check |
| `src/commands/context.ts` | modify | add email channel to recent_messages |
| `CLAUDE.md` | modify | update CLI description, key files table |
| `SKILL.md` | modify | add email commands documentation |

## Verification

1. `npm run build` — clean compile after each step
2. `outreach health` — email section shows auth status
3. `outreach email history --address <known-address>` — verify read path (no side effects)
4. `outreach email history --thread-id <id-from-step-3>` — verify full thread retrieval with bodies
5. `outreach email send --to <test> --subject "Test" --body "Hello" --campaign-id test --contact-id test` — verify send + campaign logging
6. Send a reply: `outreach email send --to <addr> --subject "Re: ..." --body "..." --reply-to-id <msgId> --campaign-id test --contact-id test` — verify threading + reply-all recipients
7. `outreach context --campaign-id <id-with-email-events> --contact-id <id>` — verify `recent_messages.email` populated
