# V2 Architecture Options

## Context

V1 is live and verified using Twilio ConversationRelay. The end-to-end latency is ~1.5-3s per conversational turn, which is noticeable and unnatural. This doc captures the V2 options for reducing latency.

## Latency breakdown (V1)

```
ConversationRelay STT:     ~300-500ms
WebSocket to daemon:       ~50-100ms
IPC + LLM inference + IPC: ~500-1000ms  (Haiku)
ConversationRelay TTS:     ~300-500ms
Relay orchestration tax:   ~200-500ms
                           ──────────
Total:                     ~1.5-3.0s
```

## Option A: Raw Media Streams + Direct STT/TTS

Replace ConversationRelay with Twilio Media Streams (raw audio WebSocket) and wire STT/TTS directly.

**Architecture:**
```
Phone audio (mulaw/8kHz) ←→ Twilio Media Streams (WebSocket)
  ↕
Daemon manages raw audio
  ↕
Deepgram Nova-2 (streaming STT, ~100-300ms)
  ↕
CLI sub-agent (Haiku, ~500ms)
  ↕
Cartesia Sonic (streaming TTS, ~90-130ms TTFB)
```

**Expected latency:** ~0.8-1.2s per turn

**Pros:**
- Sub-agent (Claude/Haiku) remains the brain — full control over every word
- Voice cloning works (ElevenLabs/Cartesia support custom voices)
- Provider-swappable (Deepgram, Cartesia, ElevenLabs all behind interfaces)
- CLI commands (listen/say/dtmf) work the same way

**Cons:**
- Daemon must handle raw audio: codec conversion, streaming buffers, silence detection
- Three vendor accounts (Twilio + Deepgram + Cartesia/ElevenLabs)
- More code, more failure modes
- Still limited by LLM inference time (~500ms floor with Haiku)

**Cost:** ~$0.05/min (Twilio $0.014 + Deepgram $0.004 + Cartesia $0.04)

## Option B: Voice-Native Model (Gemini Live API) — PREFERRED

Replace the entire STT→LLM→TTS pipeline with a single audio-native model. After evaluation, **Gemini Live API is the preferred choice** over OpenAI Realtime due to cost and existing account.

**Architecture:**
```
Phone audio (mulaw/8kHz) ←→ Twilio Media Streams (WebSocket)
  ↕
Daemon transcodes audio (mulaw 8kHz ↔ PCM 16kHz)
  ↕
Gemini Live API (gemini-3.1-flash-live-preview)
  - receives PCM 16kHz audio
  - processes natively (no separate STT/TTS)
  - returns PCM 24kHz audio + text transcript
```

**Expected latency:** ~0.5-1.0s per turn (0.3-0.8s model + ~100-200ms transcoding bridge)

**Pros:**
- Dramatically lower latency (2-3x better than Option A)
- Only 2 hops (audio in → model → audio out) plus thin transcoding layer
- Text transcripts built in (both input and output)
- Text system prompt controls persona/task — the orchestrator still delegates via text
- **5-7x cheaper than OpenAI Realtime** (~$0.04-0.08/min vs ~$0.30/min)
- User already has Google API account provisioned
- Official Google sample repo for Twilio Media Streams integration exists
- Function calling supported during live audio sessions
- Barge-in/interruption handled natively by the model (continuous audio awareness)
- 70+ language support

**Cons:**
- No native mulaw/g711 — requires transcoding middleware (mulaw 8kHz ↔ PCM 16kHz). Adds ~1-3ms per chunk (negligible).
- Gemini Flash is the brain, not Claude — model lock-in for on-call reasoning
- No voice cloning (limited to Gemini's built-in voices) — conflicts with "sound like me" goal
- Less fine-grained control (model decides what to say autonomously)
- Sub-agent can't intervene mid-call (fire-and-forget with system prompt)

**Cost:** ~$0.04-0.08/min (audio I/O pricing)

**Transcoding bridge (daemon):**
```
Inbound:  Twilio mulaw 8kHz → decode to PCM 16-bit → resample 8kHz→16kHz → base64 → Gemini WS
Outbound: Gemini PCM 24kHz → resample 24kHz→8kHz → encode to mulaw → base64 → Twilio WS
```
This is a thin layer (~50 lines of code) using Node.js buffers. Google's sample repo demonstrates the pattern.

**Gemini Live API setup message:**
```json
{
  "setup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": {
        "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Aoede" } }
      }
    },
    "systemInstruction": {
      "parts": [{ "text": "You are Fredy's assistant. Be friendly and concise..." }]
    }
  }
}
```

**Alternative voice-native models (evaluated, not chosen):**
- OpenAI Realtime API (GPT-4o): native mulaw, ~0.3-0.5s latency, but ~$0.30/min (5-7x more expensive)
- Hume EVI 2: purpose-built voice AI with emotion, has Twilio support, ~500ms latency
- Ultravox: open-weight, self-hostable, supports Twilio Media Streams

## Option C: Hybrid (both backends)

Support both options behind a CLI flag:

```
outreach call place --to "..." --backend realtime   # GPT-4o Realtime (fast, autonomous)
outreach call place --to "..." --backend pipeline    # STT→LLM→TTS (controlled, cloneable)
```

Use Realtime for latency-critical calls to humans, Pipeline for calls requiring voice cloning or fine control.

## Comparison

| Factor | V1 (current) | A: Raw Pipeline | B: Gemini Live | C: Hybrid |
|---|---|---|---|---|
| Latency | ~1.5-3s | ~0.8-1.2s | ~0.5-1.0s | Best of both |
| Cost/min | ~$0.08 | ~$0.05 | ~$0.04-0.08 | Varies |
| Brain | Claude/Haiku | Claude/Haiku | Gemini Flash | Either |
| Voice cloning | Via ElevenLabs | Via ElevenLabs/Cartesia | No | Pipeline only |
| Control | Full (agent per turn) | Full (agent per turn) | System prompt only | Either |
| Complexity | Low | Medium | Low-Medium (transcoding) | High |
| CLI changes | None | Internal only | New `--objective` flow | Both |
| Account | Twilio | Twilio+Deepgram+Cartesia | Twilio+Google (both exist) | All |

## CLI interface changes for Option B

When using voice-native backend, the interaction model changes. The sub-agent no longer loops listen/say — instead it delegates a complete call:

```
outreach call place \
  --to "+15551234567" \
  --backend gemini-live \
  --objective "Get a plumbing quote for kitchen sink repair" \
  --persona "You are Fredy's assistant. Be friendly and concise." \
  --hangup-when "You have the quote and availability info"

# Call runs autonomously — Gemini handles the conversation

outreach call wait --id call_xxx --timeout 300000
# Blocks until call ends, returns result

outreach call result --id call_xxx
# Returns: {transcript, outcome, structured_data, duration_sec}
```

New commands needed:
- `call wait` — block until call completes (for sub-agent simplicity)
- `call result` — get post-call transcript + structured data

## Decision status

**Leaning Option B (Gemini Live).** V1 latency confirmed unnatural in live testing. Gemini Live is preferred over OpenAI Realtime due to:
- 5-7x cheaper (~$0.04-0.08/min vs ~$0.30/min)
- User already has Google API account
- Comparable latency (~0.5-1.0s vs ~0.3-0.5s)
- Official Twilio integration sample exists

Remaining questions:
1. Does Gemini Flash reasoning quality hold up for complex call scenarios (IVR navigation, screening)?
2. Transcoding bridge reliability and latency in practice
3. Whether the "sound like me" goal requires voice cloning (would need Option A or C eventually)

## Recommendation

Start with Option B (Gemini Live) for the latency and cost improvement. The transcoding bridge is lightweight (~50 lines) and Google's sample repo provides a reference implementation. If voice cloning becomes critical, add Option A as a second backend, leading to Option C (hybrid).
