# Outreach CLI

Agent-native CLI for real-world outreach — phone calls today, SMS and email next. Designed for AI agents, not humans. An orchestrator agent uses this CLI to place calls, monitor transcripts, and manage call lifecycle.

Calls are powered by **Gemini Live API** (voice-native model) + **Twilio** (telephony). The voice agent handles IVR navigation, call screening, and conversation autonomously — no human-in-the-loop during calls.

## Setup

Requires Node.js 20+ and npm.

```bash
git clone https://github.com/fyang0507/outreach-cli.git
cd outreach-cli
npm install
npm run build
npm link        # makes `outreach` available globally
```

### Configuration

Copy the example env file and fill in your secrets:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID` | [Twilio Console](https://console.twilio.com/) |
| `TWILIO_AUTH_TOKEN` | Twilio Console > Account > Auth Token |
| `OUTREACH_DEFAULT_FROM` | Your personal phone number (must be [verified in Twilio](https://console.twilio.com/us1/develop/phone-numbers/manage/verified)) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |

Voice agent behavior (model, voice, VAD, thinking level) is configured in `outreach.config.yaml` — see `docs/done/tuning-reference.md` for all parameters.

### Verify

```bash
outreach --version
outreach --help
```

## Usage

```bash
outreach init                              # start tunnel + daemon

outreach call place \
  --to "+15551234567" \
  --objective "Schedule a haircut for Thursday afternoon" \
  --persona "You are Fred's personal assistant" \
  --welcome-greeting "Hi, I'm calling to schedule an appointment" \
  --hangup-when "Appointment is confirmed or no availability"

outreach call listen --id <callId> --wait  # stream transcript
outreach call status --id <callId>         # check call state
outreach call hangup --id <callId>         # end call early

outreach teardown                          # stop tunnel + daemon
```

For agent integration details, see `SKILL.md`.

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

The CLI produces raw data (session logs, transcripts). An external **data repo** stores structured outreach data — contacts, campaigns, and the raw artifacts — synced across devices via git.

```
<data-repo>/outreach/
  contacts/        # one JSON file per contact (mutable, progressively enriched)
  campaigns/       # one JSONL file per campaign (append-only event log)
  sessions/        # session event logs
  transcripts/     # call transcripts
```

The data repo path is configured in `outreach.config.yaml` (`data_repo_path`). The orchestrator agent manages this data directly — the CLI's only integration point is `--campaign` on `call place`, which auto-logs call attempts to the campaign JSONL.

See `docs/plan/memory-layer.md` for the full data model design, including contact schema, campaign event types (attempt/outcome/decision), and channel-specific schemas for future SMS/email support.

## Project structure

```
src/
  cli.ts                         # CLI entrypoint
  config.ts                      # .env secrets loader
  appConfig.ts                   # outreach.config.yaml loader
  runtime.ts                     # ~/.outreach/runtime.json state
  commands/
    init.ts                      # outreach init
    teardown.ts                  # outreach teardown
    runtimeStatus.ts             # outreach status
    call/{place,listen,status,hangup}.ts
    log/{append,read}.ts
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
    sessionLog.ts                # JSONL session/transcript helpers
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

Daemon logs go to stdout/stderr of the process started by `outreach init`. Transcripts are saved to `~/.outreach/transcripts/`.

## Docs

| Path | Description |
|---|---|
| `CLAUDE.md` | AI agent codebase guide |
| `SKILL.md` | Agent onboarding — how to use the CLI |
| `docs/design.md` | Engineering design document |
| `docs/done/tuning-reference.md` | Gemini config parameter reference |
| `docs/plan/memory-layer.md` | Memory/data layer design — schemas and data repo structure |
