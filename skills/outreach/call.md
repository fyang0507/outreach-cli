# Call Channel

Use this note for voice-agent behavior, not command syntax.

## Agent Model

Calls run through a voice agent. It handles IVR navigation, conversation, and hangup from the initial objective, persona, configured identity, and optional hangup condition. You cannot inject new instructions once the call is placed.

## Before Calling

Do not place a call until the objective contains the facts the voice agent will need. For scheduling, include availability and constraints. For service inquiries, include relevant item/property details. For sensitive or account-based calls, include only information the user has explicitly provided.

Use `--persona` for call-specific style or domain context, not identity. Identity is loaded from config and the agent already discloses itself as an AI assistant when appropriate.

Use `--hangup-when` when success or failure has a crisp stopping condition, such as "the appointment is confirmed or they have no availability this week."

## Monitoring Judgment

`listen` returns only new transcript entries since the previous listen for that call. Poll at human pace and stop when status is `"ended"`.

Use the final transcript and summary as evidence for whether the objective was achieved. Treat ringing, voicemail, no-answer, and ambiguous partial information as distinct outcomes rather than assuming success.

Hang up only when the call is clearly off track, no longer needed, or the user asks you to stop it.
