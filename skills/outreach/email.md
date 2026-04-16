# Email channel

Email via Gmail API (OAuth2 auth, nodemailer MailComposer for send).

## Sending an email

```bash
outreach email send \
  --subject "Following up on our conversation" \
  --body "Hi, I wanted to follow up on scheduling." \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3"
```

**Required**: `--subject`, `--body`, `--campaign-id`, `--contact-id`
**Optional**: `--to <address>` — override the email address resolved from the contact record. `--cc <addresses>`, `--bcc <addresses>`, `--reply-to-id <gmail-message-id>` (enables threading), `--no-reply-all` (reply to sender only; default is reply-all when replying), `--attach <path...>` (file attachments)

The destination email is resolved from the contact's `email` field. Pass `--to` only to override.

The CLI sends via Gmail API (OAuth2), then auto-appends an `attempt` entry with `channel: "email"`, `message_id`, and `thread_id` to the campaign JSONL.

Returns: `{ "to": "...", "subject": "...", "message_id": "...", "thread_id": "...", "status": "sent" }`

**Replying to a thread**: pass `--reply-to-id` with the Gmail message ID from a previous send or history lookup. The CLI auto-resolves threading headers (`In-Reply-To`, `References`), sets `Re:` subject prefix, and reply-all recipients (original sender → To, original To+Cc minus self → Cc). Use `--no-reply-all` to reply to sender only. Explicit `--to`/`--cc` override auto-resolved recipients.

## First-time auth

If no Gmail token exists in the data repo (`<data_repo_path>/outreach/gmail-token.json`), the CLI triggers an interactive OAuth flow — opens the browser, spins up a local callback server on port 8089, and exchanges the code for tokens. Subsequent runs reuse the stored token (auto-refreshed). The token syncs across machines via git along with the rest of the data repo.

## Reading email history

```bash
# By contact — resolves email from contact record
outreach email history --contact-id "c_a1b2c3" --limit 20

# By email address
outreach email history --address "recipient@example.com" --limit 20

# By thread ID
outreach email history --thread-id "18f1a2b3c4d5e6f7"
```

One of `--contact-id`, `--address`, or `--thread-id` is required. All modes return full messages with body text. Contact and address modes return recent messages involving that email address in chronological order. Thread mode returns the full thread. Empty results return `{ address, thread_id, messages: [] }`.

## Searching for emails

```bash
outreach email search --query "<gmail search query>" --limit 5
```

**Required**: `--query` — standard Gmail search syntax.
**Optional**: `--limit <n>` (default 10) — max messages to fetch before grouping by thread.

Returns thread-grouped results with metadata and snippets (no body). Use `email history --thread-id` to drill into a specific thread for full content.

**When to use search vs history**: Search is for discovering threads when you don't have an identifier — e.g., the user mentions an inbound email but you have no contact ID, address, or thread ID. Once you have the `thread_id` from search results, use `email history --thread-id` for full content.

## Auto-watch for replies

By default, `email send` registers a sundial poll trigger that monitors for inbound replies and fires a callback when one arrives. This is automatic — no extra flags needed.

- **`--fire-and-forget`**: Skip watcher registration. Use when no reply is expected (e.g., one-way notifications).
- **Dedup**: Sending again to the same contact on the same campaign reuses the existing watcher. The watermark advances to the latest send — earlier unreplied messages don't trigger the callback.
- **Manual check**: `outreach reply-check --campaign-id X --contact-id Y --channel email` — returns `{ replied: true/false }`. Exit 0 = reply found, exit 1 = no reply. Designed as a sundial poll trigger but can be run manually.
- **Reply detection**: Any non-self message in the thread after the watermark counts — including CC'd recipients, auto-replies, etc. The agent reads the full thread in the callback and decides what's actionable.
- **Output**: The `watch` field in send output shows watcher status: `created`, `reactivated`, `updated`, `skipped` (no watch config), `failed` (sundial unavailable), or `null` (fire-and-forget).

## Email-specific notes

Email is asynchronous — the send and reply happen in different agent sessions. Use `outreach context` to gather reply context in a follow-up session — it returns email history grouped by thread (`email_threads`), with each thread containing its full message list. To reply to a thread, use `--reply-to-id` with a message ID from the target thread. Use `email history` only when context is insufficient (e.g., need a specific thread or address not tied to a campaign).

### Inbound thread discovery

When the user reports receiving an email that isn't already tracked in campaign events:

1. Run `outreach email search --query "<relevant terms>"` to find the thread
2. Confirm the correct thread with the user
3. Record a `human_input` event with `channel: "email"` and `thread_id`:
   ```json
   {"ts":"...","type":"human_input","contact_id":"c_a1b2c3","channel":"email","thread_id":"18f...","content":"Received reply confirming availability"}
   ```
4. Future `outreach context` calls will discover and fetch this thread automatically
