# Outreach CLI

Agent-native CLI for real-world outreach — phone calls, SMS (iMessage), and email (Gmail). Designed for AI agents, not humans. An orchestrator agent uses this CLI to place calls, send messages, send emails, assemble cross-channel context, and manage lifecycle.

Calls are powered by **Gemini Live API** (voice-native model) + **Twilio** (telephony). The voice agent handles IVR navigation, call screening, and conversation autonomously. SMS is sent via iMessage (AppleScript) with message history read from the local Messages database (`better-sqlite3`, readonly). Email is sent via **Gmail API** (OAuth2) with native thread reconstruction, reply-all, and attachment support via `nodemailer` MailComposer.

## Setup

Requires Node.js 20+, npm, and macOS (for iMessage support). The terminal app needs **Full Disk Access** (System Settings > Privacy & Security) to read the Messages database.

```bash
git clone https://github.com/fyang0507/outreach-cli.git
cd outreach-cli
npm install
npm run build
npm link        # makes `outreach` available globally
```

### Configuration

Two config files, both have example templates:

```bash
cp .env.example .env
cp outreach.config.example.yaml outreach.config.yaml
```

**`.env`** — secrets and infrastructure:

| Variable | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID` | [Twilio Console](https://console.twilio.com/) |
| `TWILIO_AUTH_TOKEN` | Twilio Console > Account > Auth Token |
| `OUTREACH_DEFAULT_FROM` | Your personal phone number (must be [verified in Twilio](https://console.twilio.com/us1/develop/phone-numbers/manage/verified)) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `GMAIL_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — OAuth 2.0 Client ID |
| `GMAIL_CLIENT_SECRET` | Google Cloud Console — OAuth 2.0 Client Secret |

**`outreach.config.yaml`** — application behavior:

| Field | Purpose |
|---|---|
| `data_repo_path` | Path to external data repo (sessions, transcripts, contacts, campaigns) |
| `identity.user_name` | Who the voice agent represents |
| `voice_agent.default_persona` | Default persona when `--persona` is omitted |
| `gemini.*` | Model, voice, VAD, thinking level — see `docs/done/tuning-reference.md` |

### Verify

```bash
outreach --version
outreach --help
```

## Usage

All send commands use `--contact-id` to resolve the destination address from the contact record. `--to` is an optional override. `--campaign-id` and `--contact-id` are required on every send command.

```bash
outreach health                            # check all channels

# --- Calls ---
outreach call init                         # start tunnel + daemon
outreach call place \
  --campaign-id "2026-04-15-dental" \
  --contact-id "c_a1b2c3" \
  --objective "Schedule a haircut for Thursday afternoon" \
  --persona "Be conversational and flexible on timing" \
  --hangup-when "Appointment is confirmed or no availability"
outreach call listen --id <callId>         # get transcript
outreach call status --id <callId>         # check call state
outreach call hangup --id <callId>         # end call early
outreach call teardown                     # stop tunnel + daemon

# --- SMS (iMessage) ---
outreach sms send --body "Following up" \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3"
outreach sms history --contact-id "c_a1b2c3" --limit 20

# --- Email (Gmail) ---
outreach email send \
  --subject "Following up" --body "Hi, just checking in." \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3"
outreach email history --contact-id "c_a1b2c3" --limit 20
outreach email history --thread-id "18f1a2b3c4d5e6f7"  # full thread with bodies

# --- Cross-channel context ---
outreach context --campaign-id "2026-04-15-dental"
outreach context --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" --since 30
```

Multiple calls can run concurrently — each `call place` creates an independent session. SMS and email are stateless (no daemon needed). Email requires a one-time OAuth2 authorization (browser-based, token stored in the data repo at `<data_repo_path>/outreach/gmail-token.json` and syncs across machines via git). See `skill/SKILL.md` for workflow patterns.

For agent integration details, see `skill/SKILL.md`.

## Design philosophy

The CLI wraps **infrastructure complexity** — Twilio telephony, Gemini Live voice sessions, ngrok tunneling, media stream bridging — behind simple commands. It deliberately does not wrap operations that agents can do natively with bash.

**What the CLI handles:**
- `outreach call/sms/email` — service integrations (Twilio, Gemini, ngrok)
- `outreach init/teardown/status` — lifecycle management for the above

**What the CLI leaves to the agent:**
- Contact management (JSON files, manipulated via `jq`/`grep`)
- Campaign tracking (JSONL files, appended via `echo`)
- Data sync (git push/pull)
- Outcome extraction from transcripts (LLM reasoning)

This separation keeps the CLI focused and avoids building a worse `jq`.

## Data layer

The CLI produces raw data (transcripts, campaign attempt entries). An external **data repo** stores structured outreach data — contacts, campaigns, and transcripts — synced across devices via git.

```
<data-repo>/outreach/
  contacts/        # one JSON file per contact (mutable, progressively enriched)
  campaigns/       # one JSONL file per campaign (append-only event log)
  transcripts/     # call transcripts
```

The data repo path is configured in `outreach.config.yaml` (`data_repo_path`). The orchestrator agent manages this data directly — all send commands (`call place`, `sms send`, `email send`) require `--campaign-id` and `--contact-id`, and auto-log attempt entries to the campaign JSONL.

## Project structure

```
src/
  cli.ts                         # CLI entrypoint
  contacts.ts                    # Contact interface + address resolution
  config.ts                      # .env secrets loader
  appConfig.ts                   # outreach.config.yaml loader
  runtime.ts                     # ~/.outreach/runtime.json state
  commands/
    health.ts                    # outreach health
    context.ts                   # outreach context (cross-channel briefing)
    call/{init,teardown,place,listen,status,hangup}.ts
    sms/{send,history}.ts        # SMS commands
    email/{send,history}.ts      # Email commands
  providers/
    messages.ts                  # iMessage DB reader + AppleScript sender
    gmail.ts                     # Gmail API client (OAuth2, send, history)
  daemon/
    server.ts                    # HTTP + WS server, IPC handler
    mediaStreamsBridge.ts        # Twilio Media Streams <-> Gemini Live bridge
    sessions.ts                  # In-memory session store
    lifecycle.ts                 # Daemon process management
    ipc.ts                       # IPC client
  audio/
    geminiLive.ts                # Gemini Live API client
    transcode.ts                 # mulaw <-> PCM codec + resampling
    systemInstruction.ts         # System prompt builder
  logs/
    sessionLog.ts                # JSONL session/transcript/contact helpers
prompts/
  voice-agent.md                 # Static voice agent instructions
outreach.config.yaml             # Gemini tuning parameters
```

## Development

```bash
npm run build     # compile TypeScript -> dist/
outreach init     # start services (requires ngrok installed)
# make changes, rebuild, test
outreach teardown
```

Daemon logs go to stdout/stderr of the process started by `outreach init`. Transcripts are saved to the data repo (`<data_repo_path>/outreach/transcripts/`).

## Docs

| Path | Description |
|---|---|
| `CLAUDE.md` | AI agent codebase guide |
| `skill/SKILL.md` | Agent onboarding — how to use the CLI |
| `docs/design.md` | Engineering design document |
| `docs/done/tuning-reference.md` | Gemini config parameter reference |
| `docs/plan/memory-layer.md` | Memory/data layer design — schemas and data repo structure |
| `docs/plan/sms-context.md` | SMS channel + cross-channel context implementation plan |
