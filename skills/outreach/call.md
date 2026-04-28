# Call channel

Voice calls via Twilio + Gemini Live. The voice agent handles calls autonomously — STT, reasoning, and TTS in a single voice-native model with sub-1s latency.

## Call prerequisites

Before placing calls, the call channel must be initialized:

```bash
outreach call init     # starts tunnel + daemon (required once per session)
```

When done with calls:

```bash
outreach call teardown # stop daemon + tunnel, clean up
```

Note: `call teardown` stops call infrastructure only. You may still need to process transcripts and update campaign outcomes afterward — do that before syncing the data repo.

## Voice agent behavior layers

The voice agent's behavior is assembled from three independent layers. Each owns a distinct concern — do not duplicate or contradict across layers.

| Layer | What it controls | Set where | Changes per call? |
|---|---|---|---|
| Phone mechanics | IVR/DTMF navigation, call screening, `end_call` rules, partial info handling | Built-in (static prompt) | No |
| Identity | Who: user name, AI disclosure | `outreach.config.yaml` → `identity.user_name` | No |
| Persona | How: tone, formality, domain-specific behavior | `--persona` flag on `call place` | Yes |

**Phone mechanics** are built into the voice agent. It already knows how to navigate IVR menus, handle call screening, decide when to hang up, and accept partial information gracefully. You do not need to instruct the voice agent on any of these.

**Identity** is configured once in `outreach.config.yaml`. The voice agent always identifies itself as "[user_name]'s assistant" and never pretends to be human. You do not need to include identity information in `--persona`.

**Persona** is per-call behavioral guidance passed via `--persona`. Use it **only** for call-specific adjustments: "Be formal, this is a medical office" or "Speak in Spanish if the receptionist prefers." Do **not** include identity info or phone mechanics because they are already built in already.

If `--persona` is omitted, the default from `outreach.config.yaml` → `voice_agent.default_persona` is used.

## Pre-call information gathering

Before placing a call, ask the user for information the voice agent will need to complete the objective. The agent cannot ask the user mid-call, so anything it doesn't know will either be left blank or cause the call to fail.

**Scheduling calls** (dentist, haircut, doctor, etc.):
- User's availability — specific dates/times or a range ("this week, mornings only")
- Any preferences (specific provider, location, service type)

**Medical/insurance-related calls**:
- Insurance provider and member ID
- Whether open to out-of-network providers
- Patient name and date of birth if required

**Service inquiries** (quotes, repairs, etc.):
- Relevant details about the item/property (make, model, dimensions)
- Budget range if applicable

Embed gathered information into `--objective` so the voice agent can use it during the call. Don't place the call until you have enough context for the agent to succeed.

## Placing a call

```bash
outreach call place \
  --campaign-id "2026-04-15-dental-cleaning" \
  --contact-id "c_a1b2c3" \
  --objective "Schedule a haircut appointment. Available Thursday or Friday afternoon after 2pm." \
  --persona "Be conversational and flexible on timing" \
  --hangup-when "The appointment is confirmed or they say no availability"
```

**Required**: `--campaign-id`, `--contact-id`, `--objective`
**Recommended**: `--persona`, `--hangup-when`
**Optional**: `--to <number>` — override the phone number resolved from the contact record. `--max-duration <seconds>` — override the default 300s max call duration.

The destination phone number is resolved from the contact's `phone` field. Pass `--to` only to override (e.g., try a different number than what's on file).

Returns JSON: `{ "id": "<callId>", "status": "ringing" }`

**Ad-hoc test (`--once`):** `outreach call place --once --to +15551234567 --objective "Say hello and hang up" --300` — no campaign event. Output includes `"mode": "once"`. Use only for smoke-tests or demos; real outreach belongs in a campaign. Mutually exclusive with `--campaign-id` and `--contact-id`. Note: `--once` still writes the per-call transcript at `$DATA_REPO/outreach/transcripts/<call_id>.jsonl` — the daemon needs it for `call listen`/`status`/`hangup`. There is no campaign JSONL event linking to it, so these transcripts are not discoverable via `outreach context`.

The voice agent handles the entire call — IVR navigation, conversation, and hangup — based on the objective and persona you provide. You can't to send messages during the call.

## Monitoring a call

`listen` is the primary monitoring command. It returns the call's current status and any new transcript entries since your last listen. Transcripts are batched at the turn level.

```bash
outreach call listen --id <callId>
```

Returns:
```json
{
  "id": "<callId>",
  "status": "ringing" | "in_progress" | "ended",
  "transcript": [{"speaker": "remote", "text": "...", "ts": 1234567890}],
  "silence_ms": 5000
}
```

When you want to monitor the call continuously, call `listen` in a loop until `status` is `"ended"`. Each call returns only new entries since the last listen, so you build up the full conversation incrementally without duplicates.
However, if you only want to read transcript after the call ends, `call status` is available for lightweight metadata checks (call status, duration, from/to).

**Pace your polls.** `listen` is incremental — back-to-back calls almost always return an empty `transcript` because there hasn't been a new turn yet. Always pair each `listen` with an explicit wait so the transcript has time to accumulate. A 30s-2min sleep between polls is a reasonable default for human-paced phone conversations.

The voice agent is fire-and-forget: once `call place` is issued, there is no way to inject new instructions during the call. You are monitoring, not steering. To force-end a call early: `outreach call hangup --id <callId>`.

## Concurrent calls

The daemon supports multiple simultaneous calls. Each `call place` creates an independent session with its own call ID, transcript buffer, and lifecycle. You can place, monitor, and hang up calls independently.

## Call-specific notes

- The CLI reports `status: "ended"` for both live conversations and voicemail — distinguish them by reviewing the transcript content.
- Transcripts are available via `outreach call listen --id <callId>` or directly from `$DATA_REPO/outreach/transcripts/<callId>.jsonl`.
- For voicemail, consider retrying during business hours. For no-answer with no voicemail, retry later.
