# Tuning Reference — Gemini Live Voice Call Parameters

Calls use `gemini-3.8-live`. Start with the [configuration example](../../outreach.config.dev.yaml.example), change one parameter at a time, and measure the result with `outreach call latency`. The [call internals](call-internals.md) explain greeting delivery, interruption handling, and playback drain.

## Configuration sources

| Source | Contents |
|---|---|
| `.env` → `src/config.ts` | Provider secrets and caller phone numbers |
| `<data_repo>/outreach/config.yaml` → `src/appConfig.ts` | Identity, model, voice, generation, VAD, turn-taking, transcription, default persona, and call duration |

The active configuration is cached for the daemon's lifetime. Finish active calls before applying changes with `outreach call teardown` followed by `outreach call init`. Preflight validates the new session.

## Per-call controls

| Flag | Effect |
|---|---|
| `--to <number>` or `--call-operator` | Choose the destination |
| `--objective <text>` | Required call objective |
| `--persona <text>` | Override `voice_agent.default_persona` |
| `--hangup-when <text>` | Give a specific condition for `end_call` |
| `--max-duration <seconds>` | Override the configured hard duration limit |
| `--wait-for-user` | Wait for the callee to speak before responding |
| `--from-twilio` | Display the Twilio number as caller ID |

Default calls prepare a greeting during ringing. Calls use Twilio answering-machine detection and Gemini automatic VAD.

## System instruction

`src/audio/systemInstruction.ts` assembles phone mechanics from `prompts/voice-agent.md`, operator identity, current date and time, behavioral guidance, the objective, and the optional hangup condition.

Use a concise persona and an objective containing the facts the agent needs. Give a concrete hangup condition, such as “after getting the quote amount and availability.” The static prompt requires a farewell and the `end_call` tool in the same response so the call can close after the farewell plays.

## Voice and language

Set `gemini.speech.voice_name` to a prebuilt voice, such as `Aoede`, `Puck`, `Charon`, `Kore`, `Fenrir`, `Leda`, `Orus`, or `Zephyr`. Audition voices using representative phone audio.

Keep `gemini.speech.language_code: null` for native audio's automatic language selection. Both input and output transcription are enabled. Leave `gemini.transcription.input_language_codes` and `gemini.transcription.output_language_codes` at `null` for automatic language detection; these fields accept language-code arrays as transcription hints.

## VAD and interruptions

VAD settings live under `gemini.vad`. The example leaves each value at `null`, using the API default.

| Config field | Effect |
|---|---|
| `start_of_speech_sensitivity` | `START_SENSITIVITY_HIGH` detects speech onset more readily; `START_SENSITIVITY_LOW` is less sensitive to noise |
| `end_of_speech_sensitivity` | `END_SENSITIVITY_HIGH` detects the end of speech more readily; `END_SENSITIVITY_LOW` tolerates longer pauses |
| `prefix_padding_ms` | Detected-speech duration required before committing start-of-speech; shorter values increase sensitivity |
| `silence_duration_ms` | Silence required before the end of speech is detected |

Shorter silence thresholds can reduce response delay but cut off natural pauses. Measure interruption frequency and response delay together on representative calls.

`gemini.turn_taking.activity_handling: START_OF_ACTIVITY_INTERRUPTS` lets callee speech interrupt model output. `NO_INTERRUPTION` allows model output to continue. The bridge clears queued playback on an interruption and tracks how much of the greeting was delivered.

## Generation settings

Voice output uses the model's default temperature. Settings under `gemini.generation` use the API default when `null`:

| Config field | Effect |
|---|---|
| `top_p` | Nucleus sampling threshold |
| `top_k` | Top-k sampling limit |
| `max_output_tokens` | Maximum tokens per response |

Evaluate changes against the actual objective and tool reliability. A sampling adjustment alone does not establish factual accuracy or reliable hangup behavior.

## Tools and steering

The CLI declares both call-control tools with `BLOCKING` behavior. Gemini waits for their responses while the bridge controls the telephone action.

| Tool | Action |
|---|---|
| `send_dtmf(digits)` | Send keypad tones through Twilio; the media stream reconnects afterward |
| `end_call(reason)` | Hang up after queued farewell audio drains |

`call steer --mode nudge` sends interleaved realtime text. `--mode say` sends an explicit completed user turn, interrupting active generation. Gemini 3.8 Live has proactive audio enabled and can stay silent on irrelevant input. See Google's [model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live) and [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

## Verification

Use `tests/integration/gemini-live-smoke.mjs` for a bounded direct Gemini session with synthetic prompts and simulated tool responses. It verifies generated audio, output transcription, completed turns, and both call-control tools. Actual telephone tests are needed to evaluate pickup, barge-in, DTMF stream replacement, and farewell playback drain.
