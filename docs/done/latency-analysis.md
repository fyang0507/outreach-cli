# Latency Analysis — V1 Live Test

## Test Details

- Date: 2026-04-05
- Call ID: call_aa98930a6d0c (Haiku sub-agent test)
- Architecture: Twilio ConversationRelay, Haiku as sub-agent brain
- Target: personal phone with iOS call screening enabled

## Measured Turn Latencies

| Turn | Remote speech | Agent response | Agent latency |
|---|---|---|---|
| 1 (screening → identify) | +0.0s | +4.2s | **4.2s** (first turn, cold) |
| 2 ("Hello?" → respond) | +5.5s | +8.3s | **2.7s** |
| 3 ("doing well" → respond) | +13.9s | +15.8s | **1.9s** |
| 4 ("Good Sunday" → goodbye) | +21.8s | +24.5s | **2.7s** |

Average agent response time: **2.4s** (excluding first turn)

## Latency Budget Breakdown (estimated per turn)

```
ConversationRelay STT processing:    ~300-500ms
CR orchestration overhead:           ~200-500ms
WebSocket delivery to daemon:        ~50-100ms
IPC daemon → CLI:                    ~10-20ms
Haiku inference:                     ~400-600ms
IPC CLI → daemon:                    ~10-20ms
WebSocket daemon → CR:               ~50-100ms
ConversationRelay TTS rendering:     ~300-500ms
                                     ──────────
Total estimated:                     ~1.3-2.3s
```

The measured ~2.4s aligns with this budget. The CLI overhead (IPC round-trips) is negligible (~40ms). The bottleneck is ConversationRelay's STT+TTS+orchestration (~1.0-1.5s) plus LLM inference (~0.5s).

## First Turn Penalty

The first turn (4.2s) was slower because:
1. The welcome greeting already played, but the sub-agent didn't know this
2. The agent re-introduced itself redundantly
3. Potential cold-start effects in ConversationRelay STT/TTS

Fix: inform sub-agent that welcomeGreeting already played.

## Dial-to-First-Audio

- Call placed: t+0.0s
- First remote speech: t+9.4s

This 9.4s includes PSTN routing, phone ringing, call screening activation, and screening prompt playback. Not optimizable at the CLI level.

## Human Perception

User feedback: "didn't really feel natural." At 2-3s response times, the agent sounds hesitant or robotic. Natural conversation expects ~0.5-1.0s response times.

## Target Latencies

| Architecture | Expected latency | Natural? |
|---|---|---|
| V1 (ConversationRelay + Haiku) | ~1.5-3.0s | No |
| V2a (Raw pipeline + Haiku) | ~0.8-1.2s | Borderline |
| V2b (GPT-4o Realtime) | ~0.3-0.5s | Yes |
| Human conversation baseline | ~0.3-0.8s | Yes |
