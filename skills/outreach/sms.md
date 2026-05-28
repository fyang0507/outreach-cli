# SMS Channel

Use this note for Messages.app behavior, not command syntax.

## Service Choice

Do not choose between iMessage and SMS unless the user explicitly asks for a specific service. Omit `--service` for normal sends.

The system auto-resolves the transport and prefers iMessage. Use `--service iMessage` or `--service SMS` only to honor an explicit user instruction.

## Send Semantics

Send uses Messages.app through AppleScript and returns after Messages accepts the message for sending. A JSON `status: "submitted"` means the local app accepted the send, not that the recipient read it or that carrier/iMessage delivery is proven.

If send fails with an SMS-service error, Text Message Forwarding may be disabled on the paired iPhone. If it fails with an AppleScript permission error, the terminal or Codex app may need Accessibility access.

## History Semantics

History reads the local macOS Messages database for the phone number. It may include attachments as MIME types and tapback reactions, but it depends on local sync and Full Disk Access.

Use history to confirm local conversation context or check for later replies. Do not treat missing history as proof the recipient never replied if this Mac may not have synced.

## Follow-Up

This CLI does not watch for replies. Schedule an external check when reply timing matters.
