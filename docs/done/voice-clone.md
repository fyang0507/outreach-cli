# Voice Clone

## Problem

The voice agent uses Gemini's prebuilt voices (Aoede, Puck, etc.). These sound good but generic — callers hear an obvious AI voice. For outreach where the agent represents a specific person (e.g., "Fred's assistant"), the voice should sound like Fred, or at least like a consistent branded persona.

## Current state

`outreach.config.yaml` has `speech.voice_name: "Aoede"` — one of 8 prebuilt Gemini voices. No custom voice support.

## Options

### Option A: Gemini custom voice (if/when available)

Google has custom voice capabilities in Cloud TTS. If Gemini Live API adds custom voice support, this would be the simplest path — same API, just a different voice config.

**Status**: Not available in Gemini Live API as of 2025-05. Monitor for updates.

### Option B: External TTS with Gemini reasoning

Decouple TTS from Gemini:
1. Gemini Live handles STT + reasoning (text output mode, no built-in TTS)
2. External TTS service (ElevenLabs, PlayHT, Cartesia) converts Gemini's text responses to cloned voice audio
3. Bridge sends the cloned audio to Twilio instead of Gemini's native audio

**Pros:**
- Best voice quality and clone fidelity (ElevenLabs is best-in-class)
- Available now
- Voice provider is swappable

**Cons:**
- Adds latency: Gemini text output → TTS API → audio. Estimated +200-500ms per turn.
- Loses Gemini's native audio features (prosody, emotion, interruption handling)
- More complex bridge: need to buffer Gemini text, stream to TTS, handle interruptions manually
- Two billing meters (Gemini + TTS provider)

### Option C: Full external pipeline (non-Gemini)

Replace Gemini Live entirely with a pipeline:
- STT: Deepgram / AssemblyAI
- Reasoning: Any LLM (Claude, GPT, Gemini text)
- TTS: ElevenLabs / PlayHT with cloned voice

This was evaluated and rejected in V2 planning (see `docs/done/v2-options-comparison.md`) due to latency and complexity. Voice cloning doesn't change that calculus — the latency penalty of 3 hops remains.

### Option D: Fine-tuned / style-transferred voice

Some TTS providers offer voice "styles" or "blending" — mix a reference voice with a preset to get something closer without full cloning. Lower fidelity but simpler.

## Recommendation

**Wait for Gemini custom voice support (Option A), experiment with Option B as a fallback.**

Reasoning:
- V2's key advantage is low latency from the single-hop voice-native model. Option B trades that away.
- Voice cloning is a nice-to-have, not a blocker for the current use case (assistant calling on behalf of user).
- If a customer-facing deployment needs brand voice, Option B is viable — the +200-500ms is noticeable but not deal-breaking for outbound calls.

## If we proceed with Option B

### Voice cloning setup

1. User uploads voice samples to TTS provider (ElevenLabs: 1-30 min of clean audio)
2. Provider returns a `voice_id`
3. Add to config:

```yaml
voice_agent:
  tts:
    provider: "elevenlabs"          # or "playht", "cartesia"
    voice_id: "abc123"              # cloned voice ID from provider
    api_key_env: "ELEVENLABS_API_KEY"
```

### Bridge changes

- `mediaStreamsBridge.ts`: intercept Gemini text output, route to TTS API instead of forwarding Gemini audio
- New `src/audio/externalTts.ts`: streaming TTS client (ElevenLabs has WebSocket streaming API — important for low latency)
- Handle interruptions: when user speaks, cancel in-flight TTS audio
- Gemini session config: switch to text-only output mode (if supported) to avoid paying for unused Gemini audio

### Latency budget

| Component | Current (Gemini native) | With external TTS |
|---|---|---|
| STT | ~0ms (Gemini native) | ~0ms (Gemini native) |
| Reasoning | ~300-500ms | ~300-500ms |
| TTS | ~0ms (Gemini native) | ~200-500ms (ElevenLabs streaming) |
| **Total** | **~300-500ms** | **~500-1000ms** |

1s is still better than V1's 2.4s, but noticeably less natural than the current 0.5s.

## Open questions

### Q1: Does Gemini Live support text-only output mode?

If Gemini still generates audio even when we don't use it, we're paying for wasted audio tokens. Need to check if there's a config to suppress audio output.

### Q2: ElevenLabs streaming latency in practice

The 200-500ms estimate is from their docs. Need to benchmark with actual cloned voice + streaming WebSocket to get real numbers.

### Q3: Interruption handling with external TTS

Gemini natively handles interruptions (user speaks → model stops). With external TTS, we need to:
- Detect user speech (VAD)
- Cancel in-flight TTS audio
- Signal Gemini that user interrupted
- This is non-trivial and error-prone

## Dependencies

- None blocking. This is independent of the other 6 issues.
- If pursued, would touch `mediaStreamsBridge.ts` and `outreach.config.yaml` — coordinate with cost guardrails (issue #2) if in-flight simultaneously.
