# Tuning Reference — Gemini Live Voice Call Parameters

This doc covers all tunable parameters that affect voice call quality, latency, and naturalness. Use it as a reference for iterating on the call experience.

## 1. CLI flags (orchestrator-controlled, per-call)

These are passed via `outreach call place` and become part of the system instruction or Gemini config.

| Flag | Current default | What it controls |
|---|---|---|
| `--persona <text>` | "helpful phone assistant" | Who the AI is. Affects tone, vocabulary, formality. |
| `--objective <text>` | none | What the call should accomplish. Drives conversation direction. |
| `--hangup-when <text>` | "objective met or conversation concluded" | When to invoke `end_call` tool. |
| `--welcome-greeting <text>` | none | First thing Gemini says when call connects. Critical for call screening. |
| `--backend <backend>` | "gemini-live" | Switch between V1 (conversation-relay) and V2 (gemini-live). |

**Tuning tips:**
- `--persona`: shorter, more specific personas produce more natural behavior. "You are Fredy's assistant, calling to schedule a plumber" > "You are a helpful AI assistant..."
- `--welcome-greeting`: keep it under 15 words. Long greetings sound robotic and delay the conversation.
- `--hangup-when`: be specific. "After getting the quote amount and availability" > "When done"
- `--objective`: include context the model needs. "Get a quote for kitchen sink repair. Budget is under $300. Prefer weekend appointments."

## 2. Voice selection

Set via `GEMINI_VOICE` env var or future `--voice` flag.

| Voice name | Character |
|---|---|
| `Aoede` | Default. Warm, friendly female. |
| `Puck` | Energetic, youthful. |
| `Charon` | Deep, authoritative male. |
| `Kore` | Clear, professional female. |
| `Fenrir` | Strong, confident male. |
| `Leda` | Soft, gentle female. |
| `Orus` | Calm, measured male. |
| `Zephyr` | Bright, upbeat. |

**Voice cloning**: Gemini supports `replicatedVoiceConfig` — pass a 24kHz WAV voice sample to clone. Not yet wired into the CLI. This is the path to "sound like me."

Config location: `speechConfig.voiceConfig.replicatedVoiceConfig.voiceSampleAudio`

## 3. VAD (Voice Activity Detection) — turn-taking speed

These control how quickly Gemini detects that someone started/stopped speaking. **Most impactful for natural feel.**

Config location: `realtimeInputConfig.automaticActivityDetection`

| Parameter | Type | Default | Effect |
|---|---|---|---|
| `startOfSpeechSensitivity` | `START_SENSITIVITY_LOW` / `HIGH` | LOW | HIGH = detects speech onset faster (but more false triggers from background noise) |
| `endOfSpeechSensitivity` | `END_SENSITIVITY_LOW` / `HIGH` | LOW | HIGH = model responds sooner after silence (but may cut off mid-sentence pauses) |
| `prefixPaddingMs` | number | unspecified | Min milliseconds of speech before start-of-speech fires. Lower = more responsive. |
| `silenceDurationMs` | number | unspecified | Min milliseconds of silence before end-of-speech fires. **Key latency knob.** |

**Tuning tips:**
- Lower `silenceDurationMs` (e.g., 300-500ms) = faster response but may interrupt natural pauses
- Higher `silenceDurationMs` (e.g., 800-1200ms) = tolerates "um..." and thinking pauses but feels slower
- For business calls: `endOfSpeechSensitivity: HIGH` + `silenceDurationMs: 500` is a good starting point
- For casual calls: `endOfSpeechSensitivity: LOW` + `silenceDurationMs: 800` to avoid cutting people off

**Not yet wired into CLI.** Currently using defaults. To add: expose as `--vad-sensitivity` and `--silence-timeout` flags, or env vars.

## 4. Barge-in / interruption handling

Config location: `realtimeInputConfig.activityHandling`

| Value | Effect |
|---|---|
| `START_OF_ACTIVITY_INTERRUPTS` | (default) User speech interrupts model output. Natural for conversation. |
| `NO_INTERRUPTION` | Model plays response to completion. Use for announcements/greetings. |

**Current setting:** default (interrupts enabled). This is correct for phone calls.

## 5. Thinking config — reasoning depth

Config location: `thinkingConfig`

| Parameter | Type | Notes |
|---|---|---|
| `thinkingBudget` | number | Token budget for thinking. 0 = disabled, -1 = automatic. |
| `thinkingLevel` | enum | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH` |
| `includeThoughts` | boolean | Return thought tokens (for debugging). |

**Only works with thinking-capable models** (e.g., `gemini-2.5-flash`). Will error on `gemini-3.1-flash-live-preview` if not supported.

**Tradeoff:** Higher thinking = better reasoning (useful for complex IVR navigation, multi-step objectives) but adds latency. For simple calls, `MINIMAL` or disabled. For complex calls (negotiation, multi-option comparison), `MEDIUM` or `HIGH`.

**Not yet wired into CLI.** To add: `--thinking-level` flag.

## 6. Temperature and sampling

Config location: `config` (top-level on LiveConnectConfig)

| Parameter | Type | Default | Effect |
|---|---|---|---|
| `temperature` | number | ~1.0 | Higher = more creative/varied, lower = more deterministic. Range (0.0, 2.0]. |
| `topP` | number | ~0.95 | Nucleus sampling. Lower = more focused responses. |
| `topK` | number | ~40 | Top-k sampling. Lower = more conservative word choices. |

**Tuning tips:**
- For professional/business calls: `temperature: 0.7`, `topP: 0.85` — focused, predictable
- For casual/friendly calls: `temperature: 1.0`, `topP: 0.95` — more natural variation
- Never go above 1.5 for phone calls — responses become incoherent

**Not yet wired into CLI.** To add: `--temperature` flag.

## 7. Proactive audio

Config location: `proactivity.proactiveAudio`

| Value | Effect |
|---|---|
| `true` | Model can speak without being prompted, and can choose to stay silent if user speech is irrelevant. |
| `false` | (default) Model responds to every user turn. |

**Use case:** Enable for calls where the agent should drive the conversation (e.g., cold outreach). Disable for calls where the agent should mostly listen and respond (e.g., gathering info).

**Not yet wired into CLI.** To add: `--proactive` flag.

## 8. Affective dialog

Config location: `enableAffectiveDialog`

| Value | Effect |
|---|---|
| `true` | Model detects user emotions and adapts tone/responses. |
| `false` | (default) No emotion awareness. |

**Use case:** Enable for sensitive calls (complaints, follow-ups). May improve naturalness for casual calls.

**Not yet wired into CLI.** To add: `--affective` flag.

## 9. Language

| Parameter | Location | Notes |
|---|---|---|
| `speechConfig.languageCode` | Speech config | TTS output language (BCP-47, e.g., "en-US", "es-ES") |
| `inputAudioTranscription.languageCodes` | Transcription config | Hint for transcription language |
| `outputAudioTranscription.languageCodes` | Transcription config | Hint for output transcription |

**Not yet wired into CLI.** To add: `--language` flag.

## 10. System instruction (prompt engineering)

File: `src/audio/systemInstruction.ts`

The system instruction is the most impactful tuning lever. Current template sections:
- Who you are (persona)
- Your objective
- Opening line (welcome greeting)
- When to end the call
- Phone navigation (IVR)
- Ending the call (tool usage)
- Conversation style

**Key areas to iterate on:**
- **Conversation style section**: currently generic. Can be made specific per use case.
- **IVR handling**: may need examples for complex phone trees.
- **Call screening response**: add explicit guidance for "state your name and reason" scenarios.
- **Filler words**: instruct model to use "um", "let me think" to fill natural pauses.
- **Pacing**: instruct model to pause between sentences for natural cadence.

## Priority tuning order

For immediate UX improvement:
1. **VAD parameters** (silenceDurationMs, endOfSpeechSensitivity) — biggest latency impact
2. **System instruction** (persona, conversation style) — biggest naturalness impact
3. **Voice selection** — personality/brand fit
4. **Temperature** — response variety
5. **Thinking config** — for complex calls only
6. **Proactive audio** — for agent-driven calls
