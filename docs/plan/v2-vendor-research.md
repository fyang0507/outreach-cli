# V2 Vendor Research Summary

Research conducted 2026-04-05. Prices and capabilities may have changed.

## Telephony Providers

| Provider | Bidir WebSocket | STIR/SHAKEN | US outbound $/min | Node SDK | Notes |
|---|---|---|---|---|---|
| **Telnyx** | Yes (native) | Full, free on ported | ~$0.007 | Good (v2) | Best price, TeXML compat |
| **Twilio** | Yes (Media Streams) | A-attestation | ~$0.014 | Excellent | V1 choice. Most docs. |
| **SignalWire** | Yes (RELAY SDK) | Supported | ~$0.01 | Good | SWML `ai` verb similar to ConversationRelay |
| **Vonage** | Yes (NCCO WebSocket) | On US numbers | ~$0.014 | Decent | Stale docs |
| **Plivo** | **No bidir WS** | Supported | ~$0.009 | Good | Disqualified |
| **Bandwidth** | Partial (SIPREC) | Full (Tier 1) | ~$0.01 | Basic | Enterprise-focused |

**V1 decision:** Twilio (existing account, ConversationRelay).
**V2 recommendation:** Twilio Media Streams (already integrated), or Telnyx for cost savings.

## STT Providers

| Provider | Streaming | Latency | Phone audio (8kHz) | $/min | SDK |
|---|---|---|---|---|---|
| **Deepgram Nova-2** | Yes (WebSocket) | ~100-300ms | Excellent (native mulaw) | $0.0043 | Excellent |
| **AssemblyAI** | Yes (WebSocket) | ~300-500ms | Good (PCM 8kHz) | $0.005 | Good |
| **Google Cloud STT** | Yes (gRPC) | ~300-500ms | Good (telephony models) | $0.006 | Mature |
| **OpenAI Whisper (Groq)** | No (fast batch) | ~200-800ms | Good (16kHz) | $0.006 | Thin |
| **Azure Speech** | Yes (WebSocket) | ~200-400ms | Good | $0.005 | Heavy |

**Recommendation:** Deepgram Nova-2 (lowest latency, native phone codec, cheapest).

## TTS Providers

| Provider | Streaming | TTFB | Voice cloning | Naturalness | $/min | SDK |
|---|---|---|---|---|---|---|
| **Cartesia Sonic** | Yes (WS) | ~90-130ms | Yes | Very good | ~$0.04 | Newer |
| **ElevenLabs** | Yes (WS+HTTP) | ~300-500ms | Yes (best) | Excellent | ~$0.18 | Good |
| **OpenAI TTS** | Yes (HTTP) | ~300-600ms | No | Good | ~$0.09 | Simple |
| **PlayHT** | Yes (gRPC+HTTP) | ~200-400ms | Yes | Very good | ~$0.05 | Decent |
| **LMNT** | Yes (WS) | ~100-200ms | Yes | Good | ~$0.04 | Light |
| **Azure Speech** | Yes (WS) | ~200-300ms | Yes (approval req) | Good | ~$0.016 | Complex |

**Recommendation:** Cartesia Sonic (lowest TTFB) for real-time, ElevenLabs for voice cloning.

## Voice-Native Models

| Model | Protocol | Latency | Mulaw/g711 | Text control | Transcripts | $/min |
|---|---|---|---|---|---|---|
| **OpenAI Realtime (GPT-4o)** | WebSocket | ~300-500ms | Yes (native) | Yes (system prompt) | Yes (dual modality) | ~$0.30 |
| **Gemini Live** | WebSocket | ~300-600ms | No (needs transcoding) | Yes | Yes | ~$0.02-0.04 |
| **Hume EVI 2** | WebSocket | ~500ms | Yes | Yes | Yes | TBD |
| **Ultravox** | API/self-host | ~500-800ms | Yes | Yes | Yes | Varies |

**Recommendation:** OpenAI Realtime API for telephony (native mulaw, official Twilio examples, lowest latency).

## Optimal latency pipeline (Option A)

Deepgram Nova-2 + Haiku + Cartesia Sonic = ~200-400ms audio processing + ~500ms LLM = **~0.8-1.2s total**

## Optimal latency (Option B)

OpenAI Realtime API = **~0.3-0.5s total** (single hop, audio-native)
