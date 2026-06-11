# Call Channel

Use this note for voice-agent behavior, not command syntax.

## Agent Model

Calls run through a voice agent. It handles IVR navigation, conversation, and hangup from the initial objective, persona, configured identity, and optional hangup condition. The objective still drives the call; `steer` only nudges within it, so put everything the agent needs up front rather than relying on mid-call correction.

## Before Calling

Do not place a call until the objective contains the facts the voice agent will need. For scheduling, include availability and constraints. For service inquiries, include relevant item/property details. For sensitive or account-based calls, include only information the user has explicitly provided.

Use `--persona` for call-specific style or domain context, not identity. Identity is loaded from config and the agent already discloses itself as an AI assistant when appropriate.

Use `--hangup-when` when success or failure has a crisp stopping condition, such as "the appointment is confirmed or they have no availability this week."

## Monitoring Judgment

`listen` returns only new transcript entries since the previous listen for that call. Poll at human pace and stop when status is `"ended"`.

Use the final transcript and summary as evidence for whether the objective was achieved. Treat ringing, voicemail, no-answer, and ambiguous partial information as distinct outcomes rather than assuming success.

Hang up only when the call is clearly off track, no longer needed, or the user asks you to stop it.

## Steering a Live Call

`steer` injects text into the running session, pairing with `listen` (read transcript → decide → steer). It only works once the call is answered; before that it fails with `bridge_not_ready`.

Steering is not real-time. The call keeps moving while you read the transcript, decide, and send — by the time a steer lands, the conversation has already drifted past the moment you wrote it for. Steer the *direction* of the call, not a specific line in it.

- `--mode nudge` (default): a hint on the realtime channel. The agent folds it into its own voice on its next turn, adapting it to wherever the conversation has moved — use for "they mentioned budget, pivot to pricing" or "start wrapping up." This drift tolerance is why nudge is the default.
- `--mode say`: a forced turn spoken closer to verbatim. Because it ignores the drift, a `say` line can land out of sync with what was just said — reserve it for extreme cases where an exact line must be delivered regardless of context, like "Thanks, I'll follow up by email" while wrapping up.

Steer sparingly and at human pace; a stream of nudges fights the agent rather than guiding it.
