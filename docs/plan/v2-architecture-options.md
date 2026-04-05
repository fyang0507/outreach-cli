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

## Option B: Voice-Native Model (OpenAI Realtime API)

Replace the entire STT→LLM→TTS pipeline with a single audio-native model.

**Architecture:**
```
Phone audio (mulaw/8kHz) ←→ Twilio Media Streams (WebSocket)
  ↕
Daemon bridges audio to OpenAI Realtime API (WebSocket)
  ↕
GPT-4o processes audio natively, outputs audio + text transcript
```

**Expected latency:** ~0.3-0.5s per turn

**Pros:**
- Dramatically lower latency (2-3x better than Option A)
- Only 2 hops (audio in → model → audio out) vs 6
- Text transcripts built in (dual modality output)
- Text system prompt controls persona/task — the orchestrator still delegates via text
- Native mulaw/g711 support — no codec conversion needed
- Official Twilio Media Streams integration examples exist
- Simplest daemon code — just a WebSocket bridge, no audio processing

**Cons:**
- GPT-4o is the brain, not Claude — model lock-in for on-call reasoning
- No voice cloning (limited to OpenAI's built-in voices) — conflicts with "sound like me" goal
- Less fine-grained control (model decides what to say autonomously)
- Most expensive option (~$0.30/min)
- Sub-agent can't intervene mid-call (fire-and-forget with system prompt)

**Cost:** ~$0.30/min (audio I/O pricing)

**Other voice-native models:**
- Gemini Live API: cheaper (~$0.02-0.04/min) but no native mulaw, no official Twilio path
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

| Factor | V1 (current) | A: Raw Pipeline | B: Voice-Native | C: Hybrid |
|---|---|---|---|---|
| Latency | ~1.5-3s | ~0.8-1.2s | ~0.3-0.5s | Best of both |
| Cost/min | ~$0.08 | ~$0.05 | ~$0.30 | Varies |
| Brain | Claude/Haiku | Claude/Haiku | GPT-4o | Either |
| Voice cloning | Via ElevenLabs | Via ElevenLabs/Cartesia | No | Pipeline only |
| Control | Full (agent per turn) | Full (agent per turn) | System prompt only | Either |
| Complexity | Low | Medium | Low | High |
| CLI changes | None | Internal only | New `--objective` flow | Both |

## CLI interface changes for Option B

When using voice-native backend, the interaction model changes. The sub-agent no longer loops listen/say — instead it delegates a complete call:

```
outreach call place \
  --to "+15551234567" \
  --backend realtime \
  --objective "Get a plumbing quote for kitchen sink repair" \
  --persona "You are Fredy's assistant. Be friendly and concise." \
  --hangup-when "You have the quote and availability info"

# Call runs autonomously — GPT-4o handles the conversation

outreach call wait --id call_xxx --timeout 300000
# Blocks until call ends, returns result

outreach call result --id call_xxx
# Returns: {transcript, outcome, structured_data, duration_sec}
```

New commands needed:
- `call wait` — block until call completes (for sub-agent simplicity)
- `call result` — get post-call transcript + structured data

## Decision status

**Not yet decided.** Pending:
1. User testing feedback on whether V1 latency is usable for real outreach tasks
2. Priority assessment: latency vs voice cloning vs cost
3. Whether the "sound like me" goal requires voice cloning (rules out Option B alone)

## Recommendation

Start with Option B (voice-native) for the latency improvement — it's the simplest to build and the biggest UX leap. Add Option A later for voice cloning use cases. This naturally leads to Option C (hybrid) over time.
