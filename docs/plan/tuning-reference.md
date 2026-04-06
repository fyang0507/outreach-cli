# Tuning Reference — Gemini Live Voice Call Parameters

This doc covers all tunable parameters that affect voice call quality, latency, and naturalness. Use it as a reference for iterating on the call experience.

## Config architecture

Two config sources, no overlap:

| Source | What it holds | How it's set |
|---|---|---|
| `.env` → `src/config.ts` | Secrets: Twilio creds, API keys, phone numbers, webhook URL | Per-environment, gitignored |
| `outreach.config.json` → `src/appConfig.ts` | All behavior: Gemini model/voice/VAD/thinking, system prompt template | Checked in, shared across environments |

If `outreach.config.json` is missing or any required field is absent, the CLI fails immediately with a clear error.

## 1. CLI flags (per-call, passed by orchestrator)

These override or supplement the config for a specific call.

| Flag | Required | What it controls |
|---|---|---|
| `--to <number>` | Yes | Destination phone number |
| `--from <number>` | No | Caller ID (defaults to `OUTREACH_DEFAULT_FROM` from .env) |
| `--objective <text>` | No | What this call should accomplish |
| `--persona <text>` | No | Overrides `voice_agent.system_prompt_template.persona` from config |
| `--hangup-when <text>` | No | Condition for the model to invoke `end_call` tool |
| `--welcome-greeting <text>` | No | First thing Gemini says when call connects |
| `--campaign <id>` | No | Campaign ID for session log grouping |

**Tuning tips:**
- `--persona`: shorter, more specific produces more natural behavior. "You are Fredy's assistant, calling to schedule a plumber" > "You are a helpful AI assistant..."
- `--welcome-greeting`: keep it under 15 words. Long greetings sound robotic and delay the conversation. Critical for getting past call screening.
- `--hangup-when`: be specific. "After getting the quote amount and availability" > "When done"
- `--objective`: include context the model needs. "Get a quote for kitchen sink repair. Budget is under $300. Prefer weekend appointments."

## 2. System instruction composition

File: `src/audio/systemInstruction.ts`
Config: `outreach.config.json` → `voice_agent.system_prompt_template`

The system instruction sent to Gemini is composed from **CLI flags (dynamic, per-call)** + **config template (static, shared)**:

```
## Who you are
{--persona flag, or config persona if not provided}

## Your objective                          ← only if --objective provided
{--objective flag}

## Opening line                            ← only if --welcome-greeting provided
When the call connects, start by saying: "{--welcome-greeting}"

## When to end the call specifically       ← only if --hangup-when provided
{--hangup-when flag}

## Phone navigation (IVR)                  ← always, from config
{config.voice_agent.system_prompt_template.ivr_instructions}

## Call screening                          ← always, from config
{config.voice_agent.system_prompt_template.call_screening_instructions}

## Ending the call                         ← always, from config
{config.voice_agent.system_prompt_template.ending_instructions}

## Conversation style                      ← always, from config
{config.voice_agent.system_prompt_template.conversation_style}
```

**Key areas to iterate on:**
- **`conversation_style`**: currently generic. Make it specific per use case (professional vs casual).
- **`ivr_instructions`**: may need examples for complex phone trees.
- **`call_screening_instructions`**: tune for how to get past iOS Live Voicemail / Pixel Call Screen.
- **Filler words**: add to conversation_style: "use natural filler words like 'um', 'let me think' to fill pauses."
- **Pacing**: add: "pause briefly between sentences for natural cadence."

## 3. Voice selection

Config: `outreach.config.json` → `gemini.speech.voice_name` (required)

| Voice name | Character |
|---|---|
| `Aoede` | Warm, friendly female |
| `Puck` | Energetic, youthful |
| `Charon` | Deep, authoritative male |
| `Kore` | Clear, professional female |
| `Fenrir` | Strong, confident male |
| `Leda` | Soft, gentle female |
| `Orus` | Calm, measured male |
| `Zephyr` | Bright, upbeat |

**Voice cloning**: Gemini supports `replicatedVoiceConfig` — pass a 24kHz WAV voice sample. Not yet wired into the CLI or config. This is the path to "sound like me." Config would be `gemini.speech.replicated_voice_sample_path`.

## 4. VAD (Voice Activity Detection) — turn-taking speed

Config: `outreach.config.json` → `gemini.vad`

**Most impactful parameters for natural conversation feel.**

| Config field | API parameter | Type | Default | Effect |
|---|---|---|---|---|
| `start_of_speech_sensitivity` | `startOfSpeechSensitivity` | `"START_SENSITIVITY_LOW"` / `"START_SENSITIVITY_HIGH"` | API default (LOW) | HIGH = detects speech onset faster (more false triggers from noise) |
| `end_of_speech_sensitivity` | `endOfSpeechSensitivity` | `"END_SENSITIVITY_LOW"` / `"END_SENSITIVITY_HIGH"` | API default (LOW) | HIGH = model responds sooner after silence (may cut off mid-sentence pauses) |
| `prefix_padding_ms` | `prefixPaddingMs` | number \| null | API default | Min ms of speech before start-of-speech fires. Lower = more responsive. |
| `silence_duration_ms` | `silenceDurationMs` | number \| null | API default | Min ms of silence before end-of-speech fires. **Key latency knob.** |

All are `null` by default in config, meaning "use Gemini API default."

**Tuning tips:**
- Lower `silence_duration_ms` (300-500ms) = faster response but may interrupt natural pauses
- Higher `silence_duration_ms` (800-1200ms) = tolerates "um..." and thinking pauses but feels slower
- For business calls: `end_of_speech_sensitivity: "END_SENSITIVITY_HIGH"` + `silence_duration_ms: 500`
- For casual calls: `end_of_speech_sensitivity: "END_SENSITIVITY_LOW"` + `silence_duration_ms: 800`

## 5. Barge-in / interruption handling

Config: `outreach.config.json` → `gemini.turn_taking.activity_handling` (required)

| Value | Effect |
|---|---|
| `"START_OF_ACTIVITY_INTERRUPTS"` | (recommended) User speech interrupts model output. Natural for conversation. |
| `"NO_INTERRUPTION"` | Model plays response to completion. Use for announcements/greetings only. |

## 6. Thinking config — reasoning depth

Config: `outreach.config.json` → `gemini.thinking`

| Config field | Type | Default | Effect |
|---|---|---|---|
| `thinking_level` | `"minimal"` / `"low"` / `"medium"` / `"high"` | `"minimal"` (required) | Reasoning depth. Higher = smarter but slower. |
| `include_thoughts` | boolean | `false` | Return thought tokens in response (for debugging only). |

**Supported on `gemini-3.1-flash-live-preview`** — this model uses `thinkingLevel`, not `thinkingBudget`.

**Tradeoff:** Higher thinking = better reasoning (complex IVR navigation, multi-step objectives, nuanced conversations) but adds latency to each response. For most calls, `minimal` is correct. For complex calls (negotiation, multi-option comparison), try `medium` or `high`.

## 7. Temperature and sampling

Config: `outreach.config.json` → `gemini.generation`

| Config field | Type | Default | Effect |
|---|---|---|---|
| `temperature` | number \| null | API default (~1.0) | Higher = more creative/varied, lower = more deterministic. Range (0.0, 2.0]. |
| `top_p` | number \| null | API default (~0.95) | Nucleus sampling. Lower = more focused responses. |
| `top_k` | number \| null | API default (~40) | Top-k sampling. Lower = more conservative word choices. |
| `max_output_tokens` | number \| null | API default | Max tokens per response. |

All are `null` by default, meaning "use API default."

**Tuning tips:**
- For professional/business calls: `temperature: 0.7`, `top_p: 0.85` — focused, predictable
- For casual/friendly calls: `temperature: 1.0`, `top_p: 0.95` — more natural variation
- Never go above 1.5 for phone calls — responses become incoherent

## 8. Language and transcription

Config: `outreach.config.json` → `gemini.speech.language_code` and `gemini.transcription`

| Config field | Type | Default | Effect |
|---|---|---|---|
| `speech.language_code` | string \| null | null (auto) | BCP-47 code for TTS output language (e.g., "en-US", "es-ES") |
| `transcription.input_language_codes` | string[] \| null | null (auto) | Hint for input transcription language |
| `transcription.output_language_codes` | string[] \| null | null (auto) | Hint for output transcription language |

**When `null` (default):** Gemini auto-detects language. For multilingual calls, it transcribes in whatever language is spoken — no forced single-language constraint. This is the correct default for most use cases.

**When to set explicitly:** If you know the call will be in a specific language and want to improve transcription accuracy, set the language codes. For multilingual calls, leave as `null`.

## 9. Features not available on `gemini-3.1-flash-live-preview`

These exist in the Gemini Live API but are **removed in the 3.1 model**:

- **Proactive audio** (`proactivity.proactiveAudio`) — model speaks without user prompt / stays silent on irrelevant input. Not available.
- **Affective dialog** (`enableAffectiveDialog`) — emotion detection and response adaptation. Not available.
- **Async function calling** — only synchronous function calling is supported.

May return in future model versions.

## 10. Function calling tools (built-in)

The CLI registers two tools with Gemini that the model can invoke during calls:

| Tool | When Gemini uses it | What happens |
|---|---|---|
| `send_dtmf(digits)` | IVR menu navigation ("press 1 for...") | Daemon sends DTMF via Twilio REST API |
| `end_call(reason)` | Objective met or conversation over | Daemon hangs up via Twilio REST API |

These are hardcoded in `src/audio/geminiLive.ts`. To add more tools (e.g., `lookup_info`, `transfer_call`), add to the `DEFAULT_TOOLS` array.

## Priority tuning order

For immediate UX improvement, iterate in this order:

1. **System instruction** (`outreach.config.json` → `voice_agent`) — biggest naturalness impact, easiest to change
2. **VAD parameters** (`gemini.vad`) — biggest latency impact for turn-taking speed
3. **Voice selection** (`gemini.speech.voice_name`) — personality/brand fit
4. **Thinking level** (`gemini.thinking.thinking_level`) — for complex call scenarios
5. **Temperature** (`gemini.generation.temperature`) — response variety/predictability
