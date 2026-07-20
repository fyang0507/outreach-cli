# SMS Channel

Use this note for Messages.app behavior, not command syntax.

## Service Choice

Do not choose between iMessage and SMS unless the user explicitly asks for a specific service. Omit `--service` for normal sends.

The CLI auto-resolves transport from Messages history: recent inbound iMessage wins; otherwise it preserves the most recent successful outbound or inbound service; unknown recipients default to SMS. Use `--service iMessage` or `--service SMS` only to honor an explicit user instruction.

## Send Semantics

Send uses Messages.app through AppleScript and checks the local Messages database before returning. SMS `status: "sent"` means the phone relay accepted the message; iMessage `status: "delivered"` reflects the Messages delivery flag. Neither proves that the recipient read it.

If an iMessage attempt fails, the CLI briefly watches for Messages.app's automatic SMS fallback. A successful fallback returns `status: "sent"` with `service: "SMS"`, preventing an unnecessary duplicate retry.

If send fails with an SMS-service error, Text Message Forwarding may be disabled on the paired iPhone. If it fails with an AppleScript permission error, the terminal or Codex app may need Accessibility access.

## History Semantics

History reads the local macOS Messages database for the phone number. It may include attachments as MIME types and tapback reactions, but it depends on local sync and Full Disk Access.

Use history to confirm local conversation context or check for later replies. Do not treat missing history as proof the recipient never replied if this Mac may not have synced.

## Follow-Up

This CLI does not watch for replies. Schedule an external check when reply timing matters.
