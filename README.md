# Outreach CLI

Omnichannel outreach CLI for AI agents — voice calls, SMS, and email through a unified interface. An orchestrator agent delegates tasks to sub-agents, each using this CLI to reach contacts, gather context across channels, and track campaign progress.

Three channels, one contact model:

| Channel | Provider | How it works |
|---|---|---|
| **Call** | Twilio + Gemini Live API | Voice-native model handles STT, reasoning, and TTS autonomously with sub-1s latency |
| **SMS** | iMessage (AppleScript + Messages DB) | Fire-and-forget send, local message history via `better-sqlite3` |
| **Email** | Gmail API (OAuth2 + nodemailer) | Send with threading/reply-all/attachments, search, thread-grouped history |

All channels share the same `--campaign-id` + `--contact-id` pattern — the CLI resolves the right address (phone, sms_phone, or email) from the contact record. `outreach context` assembles a cross-channel briefing from campaign events + recent SMS and email threads.

## Prerequisites

- **Node.js 20+** and npm
- **macOS** (required for iMessage)
- **Full Disk Access** for the terminal app (System Settings > Privacy & Security > Full Disk Access) — needed to read the Messages database
- **ngrok** ([install](https://ngrok.com/download)) — required for voice calls (tunnels Twilio webhooks to your local machine)
- **External data repo** — a git repo for storing contacts, campaigns, and transcripts (see [Data layer](#data-layer))

### Accounts and credentials

| Service | What you need | Where to get it |
|---|---|---|
| Twilio | Account SID, Auth Token, verified phone number | [Twilio Console](https://console.twilio.com/) — verify your personal number under [Verified Caller IDs](https://console.twilio.com/us1/develop/phone-numbers/manage/verified) |
| Google AI | Generative AI API key | [Google AI Studio](https://aistudio.google.com/apikey) |
| Gmail | OAuth 2.0 Client ID and Secret | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — create an OAuth 2.0 Client ID (Desktop app type), enable the Gmail API |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/fyang0507/outreach-cli.git
cd outreach-cli
npm install
npm run build          # compiles TS + syncs skills/ → data repo
npm link               # makes `outreach` available globally
```

### 2. Configure secrets

```bash
cp .env.example .env
```

Fill in `.env` with your credentials:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
OUTREACH_DEFAULT_FROM=+15551234567          # your verified Twilio number

GOOGLE_GENERATIVE_AI_API_KEY=your_key       # Gemini Live API
GMAIL_CLIENT_ID=your_client_id              # Gmail OAuth
GMAIL_CLIENT_SECRET=your_client_secret
```

Twilio also supports API key auth (`TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`) — see `.env.example` for details. The Auth Token is still needed for webhook signature verification.

### 3. Configure application behavior

```bash
cp outreach.config.example.yaml outreach.config.yaml
```

At minimum, set these two fields:

```yaml
data_repo_path: ~/path/to/your-data-repo   # where contacts, campaigns, transcripts live
identity:
  user_name: "Your Name"                    # who the agent represents (used across all channels)
```

The rest (Gemini model/voice/VAD for calls, default persona, thinking level) ships with sensible defaults. See `docs/done/tuning-reference.md` for call tuning parameters. SMS and email require no additional configuration beyond the secrets in `.env`.

### 4. Verify

```bash
outreach --version
outreach health    # checks data repo + readiness of all channels (call, sms, email)
```

`health` validates the data repo exists, creates the directory structure if needed, and reports per-channel readiness. Fix any errors it reports before proceeding.

### 5. Gmail first-time auth

The first time you use an email command, the CLI triggers an interactive OAuth flow — it opens a browser for Google sign-in, spins up a local callback server on port 8089, and exchanges the authorization code for tokens. The token is stored at `<data_repo_path>/outreach/gmail-token.json` and auto-refreshes on subsequent runs. It syncs across machines via git along with the rest of the data repo.

## Usage

### Cross-channel commands

```bash
outreach health                            # check data repo + readiness of all channels
outreach context --campaign-id "2026-04-15-dental"                    # full campaign briefing
outreach context --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" --since 30  # focused
```

`health` validates config and reports per-channel readiness. `context` assembles a JIT briefing — campaign events + recent SMS threads + email threads for the relevant contacts.

### Sending across channels

All send commands share `--campaign-id` + `--contact-id`. The CLI resolves the channel-appropriate address from the contact record. `--to` is an optional override.

```bash
# --- Call (requires call init first) ---
outreach call place \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" \
  --objective "Schedule appointment" \
  --persona "Be conversational and flexible on timing" \
  --hangup-when "Appointment confirmed or no availability"

# --- SMS ---
outreach sms send \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" \
  --body "Hi, following up on scheduling."

# --- Email ---
outreach email send \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" \
  --subject "Following up" --body "Hi, wanted to follow up on scheduling."
```

### Reading history across channels

```bash
outreach sms history --contact-id "c_a1b2c3" --limit 20
outreach email history --contact-id "c_a1b2c3" --limit 20
outreach email history --thread-id "18f1a2b3c4d5e6f7"    # full thread with bodies
outreach email search --query "from:dentist subject:scheduling"
outreach call listen --id <callId>                         # get call transcript
outreach call status --id <callId>                         # check call state
```

### Call lifecycle

Calls require a daemon + ngrok tunnel. SMS and email are stateless — no setup needed.

```bash
outreach call init                         # start tunnel + daemon (once per session)
# ... place calls, monitor, etc.
outreach call teardown                     # clean up when done
```

Multiple calls can run concurrently — each `call place` creates an independent session.

For agent integration details — campaign workflows, data model, post-action patterns — see `skills/SKILL.md`. Channel-specific references: `skills/call.md`, `skills/sms.md`, `skills/email.md`. These skill files are the source of truth — `npm run build` copies them to `<data_repo>/.agents/skills/` so the agent workspace always has docs matching the CLI version.

## Data layer

The CLI produces raw data (transcripts, campaign attempt entries). An external **data repo** stores structured outreach data — contacts, campaigns, and transcripts — synced across devices via git.

```
<data-repo>/outreach/
  contacts/        # one JSON file per contact (mutable, progressively enriched)
  campaigns/       # one JSONL file per campaign (append-only event log)
  transcripts/     # call transcripts (auto-saved by CLI)
```

The data repo path is configured in `outreach.config.yaml` (`data_repo_path`). The orchestrator agent manages this data directly — the CLI does not wrap file I/O. See `skills/SKILL.md` for schemas and conventions.

## Design philosophy

The CLI wraps **infrastructure complexity** — Twilio telephony, Gemini Live voice sessions, ngrok tunneling, iMessage DB access, Gmail OAuth — behind simple commands. It deliberately does not wrap operations that agents can do natively with bash.

**What the CLI handles:**
- `outreach call/sms/email` — channel integrations (Twilio + Gemini, iMessage, Gmail)
- `outreach context` — cross-channel JIT briefing from campaign data + recent messages
- `outreach health` — omnichannel readiness check
- `outreach call init/teardown` — call infrastructure lifecycle

**What the CLI leaves to the agent:**
- Contact management (JSON files, manipulated via `jq`/`grep`)
- Campaign tracking (JSONL files, appended via `echo`)
- Data sync (git push/pull)
- Outcome extraction from transcripts and message threads (LLM reasoning)

## Architecture

```
                              ┌─ Daemon (call only) ─ Twilio Media Streams <-> Audio Bridge <-> Gemini Live
Orchestrator Agent -> CLI  ───┼─ iMessage provider (AppleScript + Messages DB)
                              ├─ Gmail provider (OAuth2 + Gmail API)
                              └─ [not covered in outreach CLI] Data I/O (campaigns, contacts, transcripts)
```

Each channel has its own provider. Calls are the most complex — they require a background daemon that bridges Twilio's media streams to Gemini Live with real-time audio transcoding. SMS and email are direct (no daemon, no background process).

| Layer | Path | Role |
|---|---|---|
| **Shared** | | |
| CLI | `src/cli.ts` | Commander.js entrypoint, wires all commands |
| Data I/O | `src/logs/sessionLog.ts` | JSONL helpers for campaigns, contacts, transcripts |
| Context | `src/commands/context.ts` | Cross-channel briefing assembly |
| **Call** | | |
| Daemon | `src/daemon/server.ts` | Background Express + WebSocket server on port 3001 |
| Audio bridge | `src/daemon/mediaStreamsBridge.ts` | Twilio (mulaw 8kHz) <-> Gemini (PCM 16kHz) transcoding |
| Gemini client | `src/audio/geminiLive.ts` | `@google/genai` SDK wrapper for Gemini Live API |
| IPC | `src/daemon/ipc.ts` | CLI <-> daemon over Unix socket |
| **SMS** | | |
| Messages | `src/providers/messages.ts` | iMessage DB reader (`better-sqlite3`) + AppleScript sender |
| **Email** | | |
| Gmail | `src/providers/gmail.ts` | Gmail API client (OAuth2, send, history, search) |

## Project structure

```
src/
  cli.ts                         # CLI entrypoint
  contacts.ts                    # Contact interface + address resolution
  config.ts                      # .env secrets loader
  appConfig.ts                   # outreach.config.yaml loader
  runtime.ts                     # ~/.outreach/runtime.json state
  output.ts                      # JSON output helpers
  exitCodes.ts                   # Exit code constants (0-4)
  commands/
    health.ts                    # outreach health
    context.ts                   # outreach context
    call/{init,teardown,place,listen,status,hangup}.ts
    sms/{send,history}.ts
    email/{send,history,search}.ts
  providers/
    messages.ts                  # iMessage DB reader + AppleScript sender
    gmail.ts                     # Gmail API client
  daemon/
    server.ts                    # HTTP + WS server, IPC handler
    mediaStreamsBridge.ts        # Twilio <-> Gemini audio bridge
    sessions.ts                  # In-memory session store
    lifecycle.ts                 # Daemon process management
    ipc.ts                       # IPC client
  audio/
    geminiLive.ts                # Gemini Live API client
    transcode.ts                 # mulaw <-> PCM codec + resampling
    systemInstruction.ts         # System prompt builder
  logs/
    sessionLog.ts                # JSONL file helpers
scripts/
  sync-skills.js                 # Build hook — syncs skills/ → <data_repo>/.agents/skills/
skills/
  SKILL.md                       # Agent onboarding — campaign framework + data model
  call.md                        # Agent reference — call channel
  sms.md                         # Agent reference — SMS channel
  email.md                       # Agent reference — email channel
prompts/
  voice-agent.md                 # Static voice agent instructions (phone mechanics)
```

## Development

```bash
npm run build                    # compile TypeScript -> dist/ + sync skills/ → data repo
```

SMS and email commands work immediately after build — no daemon needed. For call development, start the call infrastructure first:

```bash
outreach call init               # start ngrok + daemon
# make changes, rebuild, test calls
outreach call teardown           # clean up when done
```

Daemon logs go to stdout/stderr of the background process. Transcripts are saved to `<data_repo_path>/outreach/transcripts/`.

All CLI output is JSON via `outputJson()` / `outputError()`. Exit codes: 0=success, 1=input error, 2=infra error, 3=operation failed, 4=timeout.

## Docs

| Path | Description |
|---|---|
| `CLAUDE.md` | AI agent codebase guide |
| `skills/SKILL.md` | Agent onboarding — campaign framework + data model |
| `skills/call.md` | Agent reference — call channel |
| `skills/sms.md` | Agent reference — SMS channel |
| `skills/email.md` | Agent reference — email channel |
| `docs/done/design.md` | Initial engineering design document |
| `docs/done/tuning-reference.md` | Gemini config parameter reference |
| `docs/done/memory-layer.md` | Data layer design — schemas and data repo structure |
| `docs/done/email-channel.md` | Email channel implementation design |
| `docs/done/sms-context.md` | SMS + cross-channel context design |
| `docs/done/thread-grouped-email-context.md` | Thread-grouped email context design |
| `docs/done/call-cost-guardrails.md` | Call duration and cost guardrails |
| `docs/done/lifecycle-commands.md` | Init/teardown/status design |
| `docs/done/v2-architecture-options.md` | V2 architecture options analysis |
| `docs/done/integration-test-ivr.md` | IVR integration test plan |
