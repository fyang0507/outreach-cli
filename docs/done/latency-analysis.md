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

## Update — V2 (Gemini Live), 2026-07-22

V1 was superseded by V2b: Gemini Live API (`models/gemini-3.1-flash-live-preview`) direct audio pipeline, no ConversationRelay/Haiku sub-agent hop (see `v2-architecture-options.md`, Option B). Measured on three live mock-interview calls during voice-agent hallucination-fix testing:

| Call | Config (as actually applied) | Turn | Agent latency |
|---|---|---|---|
| `call_c3c1cba90a97` | temp: null (~1.0), thinking: minimal | opening substantive turn | **673ms** |
| `call_dae77efb4c91` | temp: 0.1, thinking: minimal (⚠️ configured "medium", but a code bug in `src/audio/geminiLive.ts` silently skipped sending `thinkingConfig` for "medium" — this call never actually ran elevated reasoning) | "basic information" (config lookup) | **104ms** |
| `call_dae77efb4c91` | " | "what job is he applying for" (deferral) | **192ms** |
| `call_dae77efb4c91` | " | "highlighted skills" (deferral) | **62ms** |
| `call_dae77efb4c91` | " | wrap-up ×2 | **45ms, 18ms** |
| `call_4568ba977d25` | temp: 0.1, thinking: medium (bug fixed and rebuilt first — genuinely applied) | intro | **296ms** |
| `call_4568ba977d25` | " | "specific project" (hallucinated before any steer could land) | **736ms** |
| `call_4568ba977d25` | " | "benefits of the system" | **1617ms** |
| `call_4568ba977d25` | " | closing (barge-in) | **24ms** |

All measured turns land at 18ms-1.6s — the slowest (1617ms, the one call where `thinking_level: medium` was genuinely active) is still well inside the V1 average of 2.4s, but it's also the slowest single turn across all three calls, and the highest-latency configuration did not prevent a hallucination (a fabricated "real time anomaly detection system" personal project, invented before either steer arrived). So the elevated-reasoning attempt bought no observed groundedness benefit while costing the most latency of anything tested — `thinking_level` has since been dropped to `"low"` pending a dedicated, controlled test.

**Conclusion: latency is still not the primary concern for this architecture, but it's no longer a closed question either.** Every turn across all three calls beat V1's ~2.4s average by a wide margin, so the V1 finding that drove the V2 migration ("didn't really feel natural" at 2-3s) clearly doesn't apply here. But the one call that actually exercised heavier reasoning was also the slowest and still hallucinated, so "higher thinking_level trades latency for groundedness" is not supported by this data — if anything the opposite. Future tuning should keep measuring both dimensions together per call rather than assuming a knob free of cost, and treat groundedness as the still-open problem.
