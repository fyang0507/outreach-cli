# Outreach CLI — Engineering Design Document

## 1. Problem

AI agents today can reason, plan, and coordinate — but they cannot reach the real world. They cannot place a phone call, send an SMS, or email a business on a user's behalf. This CLI closes that gap.

The first and hardest channel is **voice calls**. Unlike text channels, calls demand real-time performance, navigation of automated phone systems, and handling of modern call screening. Getting calls right forces the right architectural decisions for everything else.

### 1.1 Why agents, not humans

This CLI is a tool for AI agents, not a human-facing app. An orchestrator agent receives a task ("get three plumbing quotes"), decomposes it, and spins up sub-agents. Each sub-agent uses this CLI to execute outreach — one call, one SMS, one email — and reports back. The orchestrator synthesizes results.

This means:
- Inputs can be structured and verbose (agents produce JSON naturally)
- Outputs must be compact and machine-readable (agents have context limits)
- The interface must be stable, explicit, and predictable (agents cannot guess)
- No interactive prompts, spinners, or human-oriented formatting

### 1.2 Who owns the intelligence

The sub-agent (e.g. Claude) **is** the brain on every call. The CLI provides hands and ears — telephony, speech-to-text, text-to-speech — but makes zero decisions about what to say, when to hang up, or how to navigate a menu. All reasoning lives in the agent.

This separation is deliberate. It means:
- The conversation logic is as capable as the underlying LLM
- There is no vendor-locked "call agent" to work around
- Voice cloning, persona, and behavior are controlled at the agent layer
- The CLI stays simple and testable

---

## 2. Real-world constraints

### 2.1 Caller ID

Calls from unknown or unverified numbers are ignored, flagged as spam, or silently dropped by carriers. The CLI **must** send calls from a verified number that the user controls. This is not optional — it is a prerequisite for any call reaching a human.

Implementation:
- The CLI requires a `--from` number on every call (or a configured default)
- That number must be registered and verified with the telephony provider
- STIR/SHAKEN attestation (carrier anti-spam framework) should be configured for the number
- Ideally, the user ports their own number or obtains a number with proper CNAM registration (caller name database) so the recipient sees a real name

### 2.2 Call screening

iOS 18+ Live Voicemail and Google Pixel Call Screen intercept calls **before** the human sees them. The recipient's phone answers, plays a screening prompt ("Who is this? State your purpose."), and shows the caller's response as a live transcript. The human then decides whether to pick up.

This means:
- Many calls will never reach a human directly — they hit a screening layer first
- The agent must recognize it is being screened (detect phrases like "state your purpose", "this call is being screened")
- The agent must deliver a concise, natural, trustworthy identification
- The screening transcript is what the human reads to decide pickup — it must sound like a real person, not a bot
- This is a strong argument for voice cloning: the user's name + the user's voice maximizes pickup rate

### 2.3 Automated phone systems (IVR)

Business calls frequently connect to interactive voice response systems before a human:
- "Press 1 for English"
- "For scheduling, press 3"
- Recorded business-hours messages
- Hold music and queue announcements

The agent must:
- Distinguish IVR from a human greeting
- Navigate menus via DTMF tones or spoken responses
- Wait through recordings and detect when interaction resumes
- Recognize dead ends (closed, full voicemail, infinite hold)

### 2.4 Latency

The round-trip for each conversational turn:

```
Other party speaks
  → audio stream to STT (partial/streaming)
  → transcript returned to agent via CLI
  → agent reasons and decides response
  → agent calls `say` via CLI
  → text to TTS (streaming)
  → audio stream to other party
```

Each step adds latency. In prototyping, end-to-end delays of ~5 seconds were observed. Normal human conversation tolerates ~500ms–1s pauses. Beyond 2 seconds, it feels broken.

This is an optimization problem, not an architecture problem. Mitigations include:
- Streaming STT (return partial transcripts as speech happens)
- Streaming TTS (start speaking before full text is generated)
- Fast LLM inference (smaller models for simple turns, or speculative generation)
- Filler strategies (the agent can emit "mm-hmm" or "one moment" to buy time)
- Endpoint detection (know when the other party is done speaking, don't wait for silence timeout)

The CLI should expose enough control for the agent to implement these strategies.

---

## 3. CLI interface

### 3.1 Command structure

```
outreach <channel> <action> [flags]
```

All commands return a single JSON object to stdout. Errors return JSON to stderr with an error code. No decorative output ever.

### 3.2 Call commands

#### `outreach call place`

Establish a new call.

```
outreach call place \
  --to "+15551234567" \
  --from "+15559876543"
```

Returns:
```json
{"id": "call_a1b2c3", "status": "ringing"}
```

The CLI dials the number and begins the audio pipeline (STT/TTS). It does not say anything — the agent decides when and what to speak.

#### `outreach call listen`

Get what the other party has said.

```
outreach call listen --id call_a1b2c3
```

Returns the transcript since the last listen call (or since call start):
```json
{
  "id": "call_a1b2c3",
  "status": "in_progress",
  "transcript": [
    {"speaker": "remote", "text": "Thank you for calling ABC Plumbing. For English, press 1. Para español, oprima 2.", "ts": 1200}
  ],
  "silence_ms": 0
}
```

Flags:
- `--wait` — block until new speech is detected (with timeout). Without this, returns immediately with whatever is available.
- `--timeout <ms>` — max time to wait (default: 30000)

The `silence_ms` field tells the agent how long the other side has been quiet — useful for detecting when someone is done speaking vs. mid-sentence.

#### `outreach call say`

Speak a message via TTS.

```
outreach call say --id call_a1b2c3 \
  --message "Hi, this is Fredy. I'm calling to get a quote for a kitchen sink repair."
```

Returns:
```json
{"id": "call_a1b2c3", "status": "in_progress", "spoke": true, "duration_ms": 3200}
```

Flags:
- `--voice <voice_id>` — override default TTS voice (enables voice cloning)
- `--interrupt` — stop any currently playing audio before speaking

#### `outreach call dtmf`

Send keypad tones.

```
outreach call dtmf --id call_a1b2c3 --keys "1"
```

Returns:
```json
{"id": "call_a1b2c3", "status": "in_progress", "sent": "1"}
```

#### `outreach call status`

Poll the current state of a call.

```
outreach call status --id call_a1b2c3
```

Returns:
```json
{
  "id": "call_a1b2c3",
  "status": "in_progress",
  "phase": "answered",
  "duration_sec": 47,
  "from": "+15559876543",
  "to": "+15551234567"
}
```

Status values: `ringing`, `in_progress`, `ended`
Phase values: `connecting`, `ringing`, `answered`, `hungup`, `failed`, `no_answer`, `busy`

#### `outreach call hangup`

End a call.

```
outreach call hangup --id call_a1b2c3
```

Returns:
```json
{"id": "call_a1b2c3", "status": "ended", "duration_sec": 94}
```

### 3.3 Future: SMS commands

```
outreach sms send --to "+15551234567" --from "+15559876543" --body "Following up on our call"
outreach sms status --id <msg_id>
outreach sms replies --id <msg_id>          # check for replies
outreach sms reply --id <msg_id> --body "..." # reply in thread
```

SMS is conversational too, but asynchronous — the agent polls for replies rather than streaming.

### 3.4 Future: Email commands

```
outreach email send --to "info@plumber.com" --from "fredy@..." --subject "Quote request" --body "..."
outreach email status --id <email_id>
outreach email replies --id <email_id>
```

### 3.5 Global flags

| Flag | Purpose |
|---|---|
| `--config <path>` | Path to config file (default: `~/.outreach/config.json`) |
| `--profile <name>` | Named config profile (for multiple users/numbers) |

### 3.6 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Invalid input (bad flags, missing required args) |
| 2 | Infrastructure error (provider unreachable, auth failure) |
| 3 | Operation failed (call rejected, number unreachable) |
| 4 | Timeout |

---

## 4. Architecture

### 4.0 V1 architecture decision

**Decision: Twilio ConversationRelay as V1 one-stop solution.**

After evaluating vendor options, we chose to start with Twilio's ConversationRelay, which handles STT and TTS internally and exposes a text-in/text-out WebSocket to our server. Rationale:

- **Simplicity**: no audio pipeline to build. The CLI daemon receives text transcripts and sends text responses. Twilio handles all speech processing.
- **Existing account**: Twilio account already provisioned with verified caller ID.
- **BYO LLM**: ConversationRelay is explicitly designed for bring-your-own-LLM. It handles the speech layer; the agent handles reasoning.
- **Voice cloning path**: ElevenLabs is a supported TTS provider in ConversationRelay. Custom cloned voice IDs can be passed per-call, enabling the voice cloning roadmap without leaving the Twilio ecosystem.
- **Acceptable tradeoffs**: ~1.5–3s end-to-end latency (vs. ~0.8–1.2s with raw Media Streams). Good enough for V1 validation. If latency proves unacceptable, V2 switches to raw Media Streams + direct Deepgram/Cartesia — same CLI interface, different daemon internals.

**Lock-in assessment**: moderate. ConversationRelay's WebSocket protocol is Twilio-proprietary (~15-20% of code is transport-layer). LLM logic, CLI interface, and session logs are fully portable. Phone numbers can be ported away (1-4 weeks, FCC-protected). SignalWire SWML `ai` verb and LiveKit/Pipecat are viable V2 migration paths.

### 4.1 System overview (V1 — ConversationRelay)

```
┌──────────────────────────────────────┐
│         Orchestrator Agent           │
│  (decomposes task, assigns sub-agents)│
└──────────────┬───────────────────────┘
               │  delegates
┌──────────────▼───────────────────────┐
│           Sub-Agent (LLM)            │
│  (owns all reasoning, uses CLI)      │
│                                      │
│  loop:                               │
│    transcript = `outreach call listen`│
│    think about what to say           │
│    `outreach call say --message ...` │
└──────────────┬───────────────────────┘
               │  CLI invocations
┌──────────────▼───────────────────────┐
│          Outreach CLI                │
│  ┌─────────────────────────────┐     │
│  │  Call Session Manager       │     │
│  │  - lifecycle (place/hangup) │     │
│  │  - transcript buffer        │     │
│  │  - session state            │     │
│  └──────────────┬──────────────┘     │
│  ┌──────────────▼──────────────┐     │
│  │  Daemon (WebSocket server)  │     │
│  │  - receives text from Twilio│     │
│  │  - sends text to Twilio     │     │
│  │  - NO audio processing      │     │
│  └──────────────┬──────────────┘     │
│  ┌──────────────▼──────────────┐     │
│  │  Twilio ConversationRelay   │     │
│  │  - STT (Deepgram/Google)    │     │
│  │  - TTS (ElevenLabs/Polly)   │     │
│  │  - DTMF, barge-in, etc.    │     │
│  └─────────────────────────────┘     │
└──────────────────────────────────────┘
```

### 4.2 Call session lifecycle

When `outreach call place` is invoked:

1. CLI starts the daemon (if not already running) — a local HTTP/WebSocket server
2. Daemon must be publicly reachable for Twilio webhooks (ngrok or similar in dev, deployed server in prod)
3. CLI initiates an outbound call via Twilio REST API, with TwiML pointing to the daemon's webhook URL
4. Twilio answers, connects ConversationRelay, and opens a text WebSocket to the daemon
5. Daemon receives transcribed speech as text events, buffers them per call
6. CLI returns the call ID to the agent

Each CLI command (`listen`, `say`, `dtmf`, `hangup`) communicates with the daemon over a local Unix socket.

### 4.3 Daemon model

**Implicit daemon.** `call place` starts a background daemon if one isn't running. Subsequent commands talk to it over a Unix socket. The daemon dies when all calls end (or after idle timeout).

The daemon manages:
- A public-facing WebSocket endpoint for Twilio ConversationRelay connections
- Transcript buffer per active call (text events from Twilio)
- Outbound text queue per call (agent responses to be spoken by Twilio TTS)
- Call state tracking

### 4.4 ConversationRelay text protocol

Twilio sends text events to the daemon WebSocket:

```jsonc
// Incoming: caller's speech transcribed to text
{"type": "prompt", "voicePrompt": "Hi, I'd like to get a quote for a sink repair"}

// Incoming: DTMF detected
{"type": "dtmf", "digit": "1"}

// Incoming: call setup metadata
{"type": "setup", "callSid": "CA...", "from": "+15551234567", ...}

// Incoming: interruption (caller spoke while TTS playing)
{"type": "interrupt"}
```

Daemon sends text responses back:

```jsonc
// Outgoing: text for Twilio to speak via TTS
{"type": "text", "token": "Hi, this is Fredy. I'm calling about a sink repair.", "last": true}
```

The daemon translates between this Twilio-specific protocol and the CLI's internal API. The CLI commands (`listen`, `say`) never see Twilio's protocol directly.

### 4.5 Webhook and tunnel requirements

ConversationRelay requires Twilio to connect a WebSocket to the daemon. This means the daemon must be reachable from the internet:

- **Development**: ngrok or Twilio's dev tunnels to expose the local daemon
- **Production**: deployed on a server with a public URL, or behind a reverse proxy

The daemon's public URL is configured via `OUTREACH_WEBHOOK_URL` env var or auto-discovered via ngrok.

### 4.6 Configuration

All configuration via environment variables (`.env` file):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
OUTREACH_DEFAULT_FROM=+15551234567        # verified Twilio number
OUTREACH_PERSONAL_CALLER_ID=+15557654321  # user's real number (optional, for display)
OUTREACH_WEBHOOK_URL=https://...          # daemon's public URL (or auto via ngrok)
```

Per-call overrides via CLI flags (`--from`, `--voice`, `--tts-provider`, `--stt-provider`).

---

## 5. Agent interaction patterns

### 5.1 Simple call (human picks up)

```
agent: outreach call place --to "+15551234567"
cli:   {"id": "call_1", "status": "ringing"}

agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "Hello?"}], "status": "in_progress"}

agent: outreach call say --id call_1 --message "Hi, this is Fredy. I'm calling about getting a quote for a sink repair."
cli:   {"spoke": true, "duration_ms": 2800}

agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "Sure, what kind of sink is it?"}]}

... (conversation continues) ...

agent: outreach call say --id call_1 --message "Great, thanks for your time. Goodbye."
agent: outreach call hangup --id call_1
cli:   {"status": "ended", "duration_sec": 120}
```

### 5.2 Call with IVR navigation

```
agent: outreach call place --to "+15551234567"
agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "Thank you for calling ABC Plumbing. For English press 1. Para español oprima 2."}]}

agent: (recognizes IVR, decides to press 1)
agent: outreach call dtmf --id call_1 --keys "1"

agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "For scheduling press 1. For billing press 2. For all other inquiries press 3."}]}

agent: outreach call dtmf --id call_1 --keys "1"

agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "Please hold for the next available representative."}]}

agent: outreach call listen --id call_1 --wait --timeout 60000
cli:   {"transcript": [{"speaker": "remote", "text": "Hi this is Sarah, how can I help you?"}]}

agent: outreach call say --id call_1 --message "Hi Sarah, this is Fredy..."
```

### 5.3 Call hitting iOS call screening

```
agent: outreach call place --to "+15551234567"
agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "The person you're calling is using a screening service. Please state your name and reason for calling."}]}

agent: (recognizes call screening)
agent: outreach call say --id call_1 --message "Hi, this is Fredy Gonzalez. I'm calling about the daycare appointment we discussed last week. Would love to confirm the time."

agent: outreach call listen --id call_1 --wait --timeout 15000
cli:   {"transcript": [{"speaker": "remote", "text": "Hey Fredy! Let me pick up. One sec."}]}
       # (human saw the transcript, decided to answer)

agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "Hi Fredy, thanks for calling back!"}]}

agent: outreach call say --id call_1 --message "Hey! Yeah, just wanted to confirm Thursday still works."
```

### 5.4 Voicemail

```
agent: outreach call listen --id call_1 --wait
cli:   {"transcript": [{"speaker": "remote", "text": "You've reached ABC Plumbing. We can't take your call right now. Leave a message after the beep."}]}

agent: (recognizes voicemail, decides to leave message)
agent: outreach call listen --id call_1 --wait --timeout 10000
cli:   {"transcript": [], "silence_ms": 3000}
       # (beep passed, now silence — time to talk)

agent: outreach call say --id call_1 --message "Hi, this is Fredy. I'm looking for a quote on a kitchen sink repair. Could you call me back at 555-987-6543? Thanks."
agent: outreach call hangup --id call_1
```

---

## 6. Technology choices

### 6.1 Vendor evaluation

The full vendor evaluation is preserved below for reference. **For V1, we are using Twilio as a one-stop solution** (see Section 4.0). The tables below inform future migration decisions.

<details>
<summary>Telephony provider comparison (reference for V2+)</summary>

| Provider | Bidir WebSocket | STIR/SHAKEN | US outbound $/min | Node SDK | Notes |
|---|---|---|---|---|---|
| **Telnyx** | Yes (native) | Full, free on ported numbers | ~$0.007 | Good (v2) | Best price-to-feature ratio. TeXML compatible with Twilio TwiML. |
| **Twilio** | Yes (Media Streams) | A-attestation on verified numbers | ~$0.014 | Excellent | Industry standard. Most docs and community examples. |
| **SignalWire** | Yes (RELAY SDK) | Supported | ~$0.01 | Good | Low-level media control. SWML `ai` verb is closest ConversationRelay equivalent. |
| **Vonage** | Yes (NCCO WebSocket action) | On US numbers | ~$0.014 | Decent | Stale docs post-rebrand. |
| **Plivo** | **No** | Supported | ~$0.009 | Good | No bidirectional WebSocket streams. **Disqualified.** |
| **Bandwidth** | Partial (SIPREC) | Full (Tier 1 carrier) | ~$0.01 | Basic | Enterprise-focused. |

</details>

<details>
<summary>STT/TTS provider comparison (reference for V2+)</summary>

**STT:**

| Provider | Streaming | Latency | Phone audio (8kHz) | $/min | SDK |
|---|---|---|---|---|---|
| **Deepgram Nova-2** | Yes (WebSocket) | ~100–300ms interim | Excellent (native mulaw/8kHz) | $0.0043 | Excellent |
| **AssemblyAI** | Yes (WebSocket) | ~300–500ms interim | Good (PCM 8kHz) | $0.005 | Good |
| **Google Cloud STT** | Yes (gRPC) | ~300–500ms interim | Good (telephony models) | $0.006 | Mature, verbose |
| **OpenAI Whisper (Groq)** | No (fast batch) | ~200–800ms batch | Good (expects 16kHz) | $0.006 | Thin |
| **Azure Speech** | Yes (WebSocket) | ~200–400ms interim | Good | $0.005 | Mature, heavy |

**TTS:**

| Provider | Streaming | TTFB | Voice cloning | Naturalness | $/min | SDK |
|---|---|---|---|---|---|---|
| **Cartesia Sonic** | Yes (WebSocket) | ~90–130ms | Yes (short samples) | Very good | ~$0.04 | Newer, improving |
| **ElevenLabs** | Yes (WebSocket + HTTP) | ~300–500ms | Yes (instant + pro) | Excellent | ~$0.18 | Good |
| **OpenAI TTS** | Yes (HTTP chunked) | ~300–600ms | No | Good | ~$0.09 | Simple |
| **PlayHT** | Yes (gRPC + HTTP) | ~200–400ms | Yes | Very good | ~$0.05 | Decent |
| **LMNT** | Yes (WebSocket) | ~100–200ms | Yes | Good | ~$0.04 | Lightweight |
| **Azure Speech** | Yes (WebSocket) | ~200–300ms | Yes (requires approval) | Good | ~$0.016 | Complex |

</details>

#### V1 decision: Twilio (one-stop)

| Component | V1 choice | Provided by | Notes |
|---|---|---|---|
| Telephony | Twilio Voice | Twilio | Existing account, verified caller ID |
| STT | Deepgram (via ConversationRelay) | Twilio | Default STT provider in ConversationRelay |
| TTS | ElevenLabs (via ConversationRelay) | Twilio | Default TTS provider; supports custom voice IDs for cloning |
| Integrated layer | ConversationRelay | Twilio | Text WebSocket — handles STT/TTS/barge-in/DTMF internally |

**Pricing**: ~$0.07/min ConversationRelay (STT+TTS) + ~$0.014/min Twilio Voice = **~$0.084/min total**.

#### V2 migration path (if latency or cost requires it)

Switch ConversationRelay → raw Twilio Media Streams + direct Deepgram STT + Cartesia TTS. Or migrate telephony to Telnyx (~$0.007/min). The CLI interface does not change — only daemon internals.

### 6.2 Language choice

| Factor | TypeScript/Node | Python | Go | Rust |
|---|---|---|---|---|
| Twilio SDK | Excellent, first-class | Good | Good | None |
| WebSocket handling | `ws` — battle-tested | `websockets` — solid | `gorilla/websocket` | `tokio-tungstenite` |
| CLI frameworks | Commander, oclif | Click, Typer | Cobra | clap |
| Distribution | `bun build --compile` or npm global | pip/pipx (needs Python) | Single static binary | Single binary |
| Concurrency | Event loop + async/await | asyncio (GIL friction) | Goroutines | Tokio |

**Decision: TypeScript.** Twilio's Node SDK is first-class. The async event-loop model fits WebSocket-based daemon architecture naturally. `bun build --compile` produces a single binary for distribution. CLI frameworks like Commander handle subcommands well.

### 6.3 Summary

| Component | Choice | Rationale |
|---|---|---|
| Language | TypeScript | First-class Twilio SDK, natural async model, single-binary distribution |
| CLI framework | Commander.js | Lightweight, subcommand routing, widely used |
| Telephony + STT + TTS | Twilio ConversationRelay | One-stop V1: text WebSocket, no audio pipeline needed |
| STT (within CR) | Deepgram | Default in ConversationRelay, best phone-audio accuracy |
| TTS (within CR) | ElevenLabs | Default in ConversationRelay, supports custom cloned voice IDs |
| Daemon IPC | Unix domain socket | Fast, local-only, no port conflicts |
| Packaging | `bun build --compile` or `npm install -g` | Native-feeling `outreach` command |

---

## 7. Scope and sequencing

### V1 (current build) — Twilio ConversationRelay

#### Ticket 1: Project scaffold
- TypeScript project setup (tsconfig, package.json, build)
- CLI entrypoint with Commander.js (`outreach <channel> <action>`)
- Config loading from `.env` (dotenv)
- JSON-only output formatter
- Exit code conventions
- `outreach --version`, `outreach --help`

#### Ticket 2: Daemon — core server
- HTTP + WebSocket server (Express/Fastify + ws)
- Implicit lifecycle: auto-start on first `call place`, auto-stop on idle
- Unix domain socket for CLI ↔ daemon IPC
- Health check endpoint
- PID file management (detect stale daemons)
- Tunnel setup for Twilio webhook reachability (ngrok integration or manual URL config)

#### Ticket 3: `outreach call place`
- Twilio REST API: create outbound call with TwiML pointing to daemon webhook
- Daemon webhook handler: return TwiML with `<Connect><ConversationRelay>` configuration
- Accept ConversationRelay WebSocket connection from Twilio
- Handle `setup` event, store call session in memory
- Return call ID and status to CLI
- `--from` flag (defaults to OUTREACH_DEFAULT_FROM)
- `--to` flag (required)
- Auto-write `call.started` event to session log

#### Ticket 4: `outreach call listen`
- Buffer `prompt` events (transcribed speech) from ConversationRelay WebSocket
- Return buffered transcript since last `listen` call
- `--wait` flag: block until new speech arrives (long-poll against daemon)
- `--timeout` flag: max wait time
- Track `silence_ms` (time since last speech event)
- Return structured JSON: `{id, status, transcript[], silence_ms}`

#### Ticket 5: `outreach call say`
- Accept `--message` text from CLI
- Send `{"type": "text", "token": "...", "last": true}` to ConversationRelay WebSocket
- Return confirmation with status
- `--voice` flag for per-call voice override
- `--interrupt` flag (clear any pending TTS before speaking)

#### Ticket 6: `outreach call dtmf` + `outreach call status` + `outreach call hangup`
- `dtmf`: send DTMF event via ConversationRelay WebSocket. `--keys` flag.
- `status`: return current call state (ringing/in_progress/ended), duration, from/to
- `hangup`: terminate the call via Twilio REST API, clean up session, return final status

#### Ticket 7: Session log system
- `~/.outreach/sessions/` directory management
- JSONL append helper (`outreach log append --campaign <id> --event <json>`)
- `outreach log read --campaign <id>` — dump log for orchestrator consumption
- Auto-write `call.started` on place, provide structure for agent to write `call.ended`
- Full transcript storage in `~/.outreach/transcripts/<call_id>.jsonl`

#### Ticket 8: End-to-end verification
- Place a real call to a test number using the CLI
- Verify: daemon starts, call connects, ConversationRelay WebSocket opens
- Verify: `listen` returns transcribed speech from the other party
- Verify: `say` causes speech to be heard on the other end
- Verify: `dtmf` sends tones
- Verify: `hangup` cleanly terminates
- Verify: session log captures call.started event
- Measure and document end-to-end latency (speak → hear response)

### V2 — Robustness and latency
- Call state machine with failure modes (busy, no_answer, failed)
- Concurrent call support (multiple active sessions)
- Silence detection tuning
- Latency measurement and optimization (evaluate switching to raw Media Streams)
- Error recovery (daemon crash → auto-hangup, stale session cleanup)

### V3 — SMS and email
- `outreach sms send` / `status` / `replies` / `reply`
- `outreach email send` / `status` / `replies`

### V4 — Voice cloning and persona
- ElevenLabs custom voice ID passthrough via ConversationRelay
- Voice configuration per profile

---

## 8. State management and session logs

### 8.1 Problem

When a sub-agent finishes a call, its outcome must be durable and accessible — to the orchestrator, to other sub-agents, and to future retry attempts. A call that reaches voicemail at 4:55 PM should not be retried at 4:56 PM. A call that gets a quote should feed that data back for comparison. A call that hears "we're closed, open at 8 AM" should inform the retry schedule.

This state cannot live only in agent memory. It must be written to the file system so that:
- The orchestrator can read outcomes from all sub-agents
- A new sub-agent can pick up context from a prior attempt
- The user can inspect what happened after the fact
- No state is lost if an agent process crashes

### 8.2 Design principle: file-system-native

Following current agent design principles, all state is file-based:
- One JSONL file per outreach campaign (a set of related outreach attempts)
- Each line is an immutable event — append-only, never edited
- Agents read the log to understand context, append to it to record outcomes
- The orchestrator creates the log; sub-agents append to it

This keeps the system simple, inspectable (human-readable with `cat`), and compatible with any agent framework.

### 8.3 Log location

```
~/.outreach/sessions/
  └── <campaign_id>.jsonl
```

The campaign ID is provided by the orchestrator when delegating. If no campaign context exists, the CLI auto-generates one per call.

### 8.4 Event schema (to be finalized)

Each line in the JSONL file is a single event. Core event types:

```jsonc
// Call initiated
{
  "event": "call.started",
  "call_id": "call_a1b2c3",
  "campaign_id": "plumbing_quotes_20260405",
  "ts": "2026-04-05T14:30:00Z",
  "to": "+15551234567",
  "from": "+15559876543",
  "target": {"name": "ABC Plumbing", "type": "business"},
  "objective": "Get a quote for kitchen sink repair"
}

// Call ended — the critical event for orchestrator consumption
{
  "event": "call.ended",
  "call_id": "call_a1b2c3",
  "campaign_id": "plumbing_quotes_20260405",
  "ts": "2026-04-05T14:32:14Z",
  "duration_sec": 94,
  "outcome": "quote_received",
  "result": {
    "quote": "$180 diagnostic visit",
    "availability": "Thursday or Friday",
    "contact": "Sarah, scheduling dept"
  },
  "reached_human": true,
  "transcript_summary": "Spoke with Sarah. Quote is $180 for diagnostic visit. Available Thursday or Friday afternoon.",
  "full_transcript_ref": "~/.outreach/transcripts/call_a1b2c3.jsonl"
}

// Call ended — failure case
{
  "event": "call.ended",
  "call_id": "call_d4e5f6",
  "campaign_id": "plumbing_quotes_20260405",
  "ts": "2026-04-05T14:35:00Z",
  "duration_sec": 12,
  "outcome": "closed",
  "result": {
    "reason": "Business hours recording: open Mon-Fri 8AM-5PM",
    "retry_hint": "after 2026-04-06T08:00:00-07:00"
  },
  "reached_human": false
}

// Call ended — voicemail
{
  "event": "call.ended",
  "call_id": "call_g7h8i9",
  "campaign_id": "plumbing_quotes_20260405",
  "ts": "2026-04-05T14:36:30Z",
  "duration_sec": 25,
  "outcome": "voicemail_left",
  "result": {
    "message_left": "Requested callback for sink repair quote"
  },
  "reached_human": false,
  "retry_hint": "wait for callback or retry in 4 hours"
}
```

### 8.5 Outcome taxonomy

Standardized outcome codes that the orchestrator can switch on:

| Outcome | Meaning |
|---|---|
| `quote_received` | Got the information requested |
| `appointment_set` | Scheduled something |
| `info_gathered` | Partial or general information obtained |
| `callback_requested` | The other party will call back |
| `voicemail_left` | Left a voicemail message |
| `voicemail_skipped` | Reached voicemail, chose not to leave message |
| `closed` | Business closed / outside hours |
| `no_answer` | No one picked up, no voicemail |
| `busy` | Line busy |
| `wrong_number` | Number is incorrect or disconnected |
| `rejected` | Call explicitly rejected |
| `failed` | Technical failure (provider error, etc.) |
| `screening_failed` | Hit call screening, was not picked up |
| `ivr_dead_end` | Got stuck in automated menu |

### 8.6 Who writes what

- **The CLI** writes `call.started` automatically when `call place` succeeds.
- **The sub-agent** writes `call.ended` after hanging up, because only the agent knows the semantic outcome (did it get a quote? was the info useful?). The CLI provides a helper: `outreach log append --campaign <id> --event <json>`.
- **The orchestrator** reads the full log to synthesize results and decide retries.

### 8.7 Retry context

When a sub-agent is assigned a retry, the orchestrator passes the campaign ID. The sub-agent reads the log to understand:
- What happened on prior attempts
- When the last attempt was
- Any retry hints (business hours, callback expectations)
- What the target's phone system looks like (IVR structure from prior transcript)

This avoids the sub-agent calling at the wrong time or re-navigating a menu blindly when prior attempts already mapped it.

### 8.8 Schema finalization — deferred

The exact schema will be finalized during Phase 1 implementation. The principles above are locked:
- JSONL, append-only, file-system-based
- Orchestrator-readable outcome codes
- Retry hints embedded in events
- Full transcripts stored separately, referenced by path

---

## 9. Resolved questions

1. **Streaming listen vs. polling.** **Decision: `--wait` polling for V1, with `--stream` as a future optimization.** Polling (one CLI call per turn) is simpler and sufficient for V1. Streaming (newline-delimited JSON) would reduce latency but adds dev overhead. If latency proves problematic, add `--stream` mode in V2 — it's additive, not a redesign.

2. **Daemon lifecycle on agent crash.** **Decision: pulse-check timeout.** The daemon tracks `lastActivityTime` per call (updated on every `listen`, `say`, `dtmf` IPC call). If no IPC activity on a call for 30 seconds, the daemon auto-hangs-up that call. This is a pulse check, not a total-duration timeout — the agent just needs to keep interacting. If all calls are cleaned up and no new activity for 5 minutes, the daemon shuts itself down.

3. **Concurrent calls.** **Decision: deferred to V2 testing.** Architecture supports it (session store is per-call, WebSocket connections are per-call). No special work needed now. Will load-test when it matters.

4. **Provider fallback.** **Decision: Twilio only, no automatic fallback.** No backup provider in the CLI. If a call fails, the CLI reports the failure. Retry decisions are made by the orchestrator agent, not the CLI. This keeps the CLI simple and the retry logic where it belongs — in the agent.

5. **Call recording.** **Decision: text-only in V1.** ConversationRelay passes back text, not audio. Full transcript is already stored in `~/.outreach/transcripts/<callId>.jsonl`. Audio recording is not available through ConversationRelay without additional Twilio configuration. V1 is purely text-based. Audio recording can be explored in V2 if needed (via Twilio's `record` attribute or a parallel recording leg).

6. **Interruption handling.** **Decision: automatic barge-in, matching natural conversation.** ConversationRelay's `interruptible="true"` setting means Twilio automatically stops TTS playback when the remote party speaks. This matches how natural conversation works (people interrupt each other). The CLI does not need to manage this — it's handled at the Twilio layer. This is the same design principle behind OpenAI voice mode and Gemini live mode: optimize for natural human conversational patterns, not robotic turn-taking.
