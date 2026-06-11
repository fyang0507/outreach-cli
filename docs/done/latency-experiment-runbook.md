# Pickup Latency Experiment Runbook

> **Archived / historical.** This runbook documents the original latency experiment.
> The `latency-test` command and the `--no-amd` / `--experimental-local-vad` flags it
> relied on were removed in the production cleanup (calls now always enable AMD and use
> Gemini automatic VAD). For production latency analysis, place a normal call and run
> `outreach call latency --latest`. The commands below are kept only for historical record.

Use this runbook to measure the pickup-to-audible-greeting delay after the Media Streams + Gemini Live latency work.

## Goal

Measure whether a human who answers the call hears the agent greeting within roughly human-feeling latency, instead of the earlier 5-8 second delay after "hello."

## Current Latency Levers

- Gemini Live is pre-connected before the Twilio call is placed.
- After Twilio accepts the outbound call, Gemini is asked to pre-generate a brief greeting while the phone is ringing.
- Pre-generated greeting audio is buffered and flushed after a short post-stream delay so the callee has a moment to bring the phone to their ear.
- Gemini VAD is tuned in the active data config with `END_SENSITIVITY_HIGH` and `silence_duration_ms: 500`.
- `--no-amd` disables Twilio answering-machine detection for clean human-answer latency tests.
- `--wait-for-user` is experimental for UX testing. The production default remains proactive greeting because server-side VAD can still feel slow.
- `--experimental-local-vad` disables Gemini automatic VAD and lets the bridge send `activityStart` / `activityEnd` using local audio thresholds.

## Test Command

```bash
outreach call init

outreach call place \
  --to "<your phone number>" \
  --objective "Greet me briefly, then end the call." \
  --max-duration 30 \
  --no-amd
```

Answer the phone normally. Say "hello" once. Do not speak over the greeting. Let the call end or hang it up after the greeting.

Then run:

```bash
outreach call latency --id <callId>
```

If you just need the newest saved transcript, run:

```bash
outreach call latency --latest
```

For a repeatable one-command test, use:

```bash
outreach call latency-test --to "<your phone number>"
```

For an experimental wait-for-user turn-taking test, use:

```bash
outreach call place \
  --to "<your phone number>" \
  --objective "Run a short turn-taking latency test." \
  --max-duration 60 \
  --no-amd \
  --wait-for-user \
  --experimental-local-vad
```

To verify settings without placing a call:

```bash
outreach call latency-test --dry-run --to "<your phone number>"
```

This places a real short `--no-amd` call, waits for it to end, then prints the same latency summary.
For clean measurement, the daemon automatically hangs up the `latency-test` call after the first outbound agent turn drains through Twilio playback. Use `--hold-after-greeting <seconds>` if you need the call to stay open slightly longer after the first greeting audio starts.

## Primary Metric

Use:

```text
pickup_to_audible_greeting_ms
```

This prefers `summary.answer_to_first_outbound_audio_played_ms`, which uses Twilio's media `mark` callback. If that is missing, it falls back to `summary.answer_to_first_outbound_audio_ms`.

If Twilio does not provide the `call_answered` callback, use `stream_start_to_audible_greeting_ms` as the operational fallback. It measures from Twilio Media Streams start to first audible outbound audio, not from the phone-answer callback.

Also check:

```text
assessment.status
```

`pass` means the pickup-to-greeting delay is at or below the 1000ms target. `borderline` means it improved from the old 5-8s range but can still feel delayed. `fail` means the latency is still above the target range.

For wait-for-user calls, use:

```text
user_speech_to_audible_response_ms
```

With `--experimental-local-vad`, this prefers the first detected remote activity end to first audible agent response. Without local VAD, it falls back to rougher activity/transcript timing and may not isolate endpointing delay cleanly.

## Diagnostic Fields

- `summary.twilio_call_create_ms`: time for Twilio to accept the outbound call request.
- `summary.gemini_preconnected_before_call`: true means Gemini Live was warmed before Twilio dialing began.
- `summary.gemini_preconnect_ms`: time spent warming Gemini before placing the Twilio call.
- `summary.pre_generated_greeting_requested`: true means Gemini was asked to prepare the greeting during ringing.
- `summary.pre_generated_greeting_audio_chunks`: greater than zero means Gemini produced greeting audio during ringing.
- `summary.pre_generated_greeting_ended_before_stream`: true means the pre-generation session ended before Twilio opened the media stream.
- `summary.pre_generated_greeting_ready_before_stream`: true means audio was ready before Twilio opened the media stream.
- `summary.pre_generated_greeting_request_to_first_generated_audio_ms`: Gemini greeting generation latency.
- `summary.answer_to_stream_ms`: Twilio answer callback to media stream start.
- `summary.stream_to_first_outbound_audio_played_ms`: media stream start to Twilio reporting first outbound audio playback.
- `summary.first_remote_audio_activity_end_to_first_outbound_audio_played_ms`: local VAD endpoint to audible agent response.
- `summary.first_remote_audio_activity_to_first_outbound_audio_played_ms`: first detected inbound audio activity to audible agent response.
- `summary.last_remote_audio_activity_to_first_outbound_audio_played_ms`: last detected inbound audio activity before response to audible agent response; this is the closest proxy for perceived post-speech wait.
- `assessment.likely_bottleneck`: best-effort label for the segment most likely to explain a slow result.
- `missing_latency_milestones`: explains why older or partial transcripts cannot compute the pickup metric.

## Interpreting Results

If `pickup_to_audible_greeting_ms` is below about 1000ms, the pickup experience should feel much more natural.

If `assessment.status` is `borderline`, compare `assessment.likely_bottleneck` with the diagnostic fields before changing prompts or VAD. The path is improved, but not fully solved.

If `pre_generated_greeting_requested` is false, check Gemini preconnect before Twilio call placement.

If `gemini_preconnect_ms` is high, pickup latency may still be improved, but the user waits longer before their phone starts ringing. Decide whether that tradeoff is acceptable for the workflow.

If `pre_generated_greeting_requested` is true but `pre_generated_greeting_audio_chunks` is zero, the greeting was not ready during ringing. Check Gemini pre-generation timing and the pre-generation prompt.

If `pre_generated_greeting_ready_before_stream` is true but `pickup_to_audible_greeting_ms` is still high, the remaining latency is likely in Twilio stream setup/playback or PSTN path.

If `answer_to_stream_ms` dominates, the delay is before this daemon can send audio.

If `stream_to_first_outbound_audio_played_ms` dominates, inspect media send/mark behavior and Twilio playback buffering.

For wait-for-user conversation tests, prefer `user_speech_to_audible_response_ms` over `first_response_delay_ms`. The latter starts from Gemini's transcript callback and can hide VAD/endpointing delay that the human actually feels.

## Hangup Playback

The bridge defers `end_call` until Twilio confirms the active outbound turn has played via a media `mark`. If Twilio never returns the final mark, the daemon force-hangs up after a 7s drain timeout and records `hangup_timeout`.
