# Email Channel

Use this note for Gmail behavior, not command syntax.

## Send Semantics

Email sends through Gmail API as the authenticated account. Output includes `message_id` and `thread_id`; keep those when a later reply or history lookup may matter.

Attachments are file paths passed to Gmail. The CLI does not rewrite or inspect attachment contents.

## Reply Threading

Use `--reply-to-id` with a Gmail message ID when the new message belongs in an existing thread. The CLI derives threading headers and, by default, reply-all recipients.

If replying to the user's own outbound message, the CLI routes the reply to the original recipients instead of mailing the authenticated account. Use `--no-reply-all` when only the sender should receive the reply. Explicit `--to` or `--cc` overrides derived recipients.

## Search vs History

Use `email search` when you need to discover a thread from a Gmail query. Search returns thread-grouped metadata and snippets only.

Use `email history --thread-id` when you already have the thread and need full bodies. Use `email history --address` for recent messages involving one address when a thread ID is not known.

## Auth Caveats

If Gmail auth is expired or scopes are missing, `outreach health` reports the account and token state. Re-authorization is an operator step, not something the skill should work around with another channel unless the user approves.

## Follow-Up

This CLI does not watch for replies. Schedule an external check when reply timing matters.
