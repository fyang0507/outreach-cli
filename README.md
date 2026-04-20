# Outreach CLI

Omnichannel outreach CLI for AI agents — voice calls, SMS, email, and calendar through a unified interface. An orchestrator agent delegates tasks to sub-agents, each using this CLI to reach contacts, gather context across channels, and track campaign progress.

Four channels, one contact model:

| Channel | Provider | How it works |
|---|---|---|
| **Call** | Twilio + Gemini Live API | Voice-native model handles STT, reasoning, and TTS autonomously with sub-1s latency |
| **SMS** | iMessage (AppleScript + Messages DB) | Fire-and-forget send, local message history via `better-sqlite3` |
| **Email** | Gmail API (OAuth2 + nodemailer) | Send with threading/reply-all/attachments, search, thread-grouped history |
| **Calendar** | Google Calendar API (OAuth2) | Add/remove events, shared auth with Gmail |

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
| Gmail + Calendar | OAuth 2.0 Client ID and Secret | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — create an OAuth 2.0 Client ID (Desktop app type), enable the Gmail API and Google Calendar API |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/fyang0507/outreach-cli.git
cd outreach-cli
npm install
npm run build          # compiles TS, chmod +x dist/cli.js, syncs skills/ → data repo
npm link               # makes `outreach` available globally
```

`npm run build` sets `dist/cli.js` executable as part of its post-build hook. If `outreach <cmd>` ever fails with `permission denied: .../outreach`, the source tree is likely on a filesystem that doesn't preserve the exec bit (Google Drive FUSE, some network mounts); re-run `npm run build` or `chmod +x dist/cli.js` after each rebuild. `which outreach` follows the `npm link` symlink, so the failure shows up at execution, not resolution.

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

The real app config lives at `<data_repo>/outreach/config.yaml`. You have two ways to get there:

**Recommended — `outreach setup` scaffolds it for you:**

```bash
outreach setup --data-repo ~/path/to/your-data-repo
```

This creates `<data_repo>/.agents/workspace.yaml` (the shared stack marker), scaffolds `outreach/{config.yaml,campaigns,contacts,transcripts}/` from the template, syncs the agent skills, and runs a full-stack readiness check. Then edit the generated `<data_repo>/outreach/config.yaml` to set your identity and any Gemini tuning.

**Dev — copy the local escape hatch:**

```bash
cp outreach.config.dev.yaml.example outreach.config.dev.yaml
# edit outreach.config.dev.yaml and set data_repo_path
```

The dev file is gitignored and only load-bearing for `data_repo_path` — it points a dev checkout at a data repo so `npm run dev` works before you've run `outreach setup`. Everything else (identity, Gemini, watch) comes from `<data_repo>/outreach/config.yaml` once that exists.

At minimum, `<data_repo>/outreach/config.yaml` needs:

```yaml
identity:
  user_name: "Your Name"                    # who the agent represents (used across all channels)
  # Optional pullable fields — agents fetch these via `outreach whoami --field <name>`
  # first_name: "Fred"
  # email_signature: "— Fred"
  # address: "..."
  # other: "free-text context that doesn't fit a specific key"
```

The rest (Gemini model/voice/VAD for calls, default persona, thinking level) ships with sensible defaults. See `docs/done/tuning-reference.md` for call tuning parameters. SMS and email require no additional configuration beyond the secrets in `.env`.

#### Data repo resolution

The CLI locates the data repo via (1) `OUTREACH_DATA_REPO` env var, (2) `outreach.config.dev.yaml` next to the CLI (dev sticky — wins over walk-up), (3) walk-up from cwd for `.agents/workspace.yaml`. The dev file beats walk-up by design so a developer `cd`-ing into a real data repo doesn't silently run a dev binary against prod data.

### 3b. Full-stack daemons

Outreach composes with two sibling CLIs that share the same data repo: [sundial](https://github.com/fyang0507/sundial) (polling + watchers — powers `reply-check` and reply auto-watch) and [relay](https://github.com/fyang0507/relay) (human-in-the-loop reply integration — powers `ask-human`). Each tool registers itself under `tools.<name>` in `<data_repo>/.agents/workspace.yaml`. Outreach is the top of the stack — `outreach setup`'s readiness check verifies that sundial and relay are installed, registered, and responding.

```bash
# One-time per data repo — each tool registers itself in .agents/workspace.yaml and syncs skills
outreach setup --data-repo ~/my-data
sundial setup  --data-repo ~/my-data     # see sundial repo for exact flags
relay setup    --data-repo ~/my-data     # see relay repo for exact flags

# Per-session daemons (run in background)
sundial daemon &                         # polling watchers
relay init &                             # human-reply listener
outreach call init                       # only when placing voice calls

# Per-source (agent-driven — register relay watches on specific JSONL dirs)
relay add --config <path-to-relay-config>
```

See the sundial and relay repos for their install and run instructions. If `outreach setup`'s readiness check fails, it prints a numbered remediation list pointing at the missing piece.

### 4. Verify

```bash
outreach --version
outreach health    # checks data repo + readiness of all channels (call, sms, email, calendar)
```

`health` validates the data repo exists, creates the directory structure if needed, and reports per-channel readiness. The `data_repo` block in the output includes the resolved `config_path` and the resolution source (`env` / `dev` / `walk-up`) — useful for confirming you're pointing at the right repo. Fix any errors it reports before proceeding.

### 5. Google first-time auth

The first time you use a Gmail or Calendar command, the CLI triggers an interactive OAuth flow — it opens a browser for Google sign-in, spins up a local callback server on port 8089, and exchanges the authorization code for tokens. The token is stored at `<data_repo_path>/outreach/gmail-token.json` and auto-refreshes on subsequent runs. It syncs across machines via git along with the rest of the data repo.

The token covers both Gmail and Calendar scopes. If you previously authorized Gmail only, delete the token file and re-run any Google-backed command to re-authorize with the full scope set.

## Usage

### Cross-channel commands

```bash
outreach health                            # check data repo + readiness of all channels
outreach context --campaign-id "2026-04-15-dental"                    # full campaign briefing
outreach context --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" --since 30  # focused
outreach whoami --field first_name,email_signature  # pull configured identity fields on demand
```

`health` validates config and reports per-channel readiness. `context` assembles a JIT briefing — campaign events + recent SMS threads + email threads for the relevant contacts. `whoami` lets headless callback agents pull identity fields (name, signature, address) without blanket prompt injection — see `skills/outreach/SKILL.md § outreach whoami`.

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

# --- Calendar ---
outreach calendar add \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" \
  --summary "Dental cleaning" \
  --start "2026-04-22T14:00:00" --end "2026-04-22T15:00:00"

outreach calendar remove \
  --campaign-id "2026-04-15-dental" --contact-id "c_a1b2c3" \
  --event-id "abc123xyz"
```

#### Adhoc sends (`--once`)

For smoke-tests, demos, or one-off notifications outside any campaign, pass `--once` instead of `--campaign-id`/`--contact-id`. No JSONL event is written and no reply watcher is registered. Mutually exclusive with `--campaign-id`, `--contact-id`, and `--fire-and-forget`; requires `--to` for sms/email/call.

```bash
outreach sms send --once --to +15551234567 --body "ping"
outreach email send --once --to test@example.com --subject "ping" --body "ping"
outreach call place --once --to +15551234567 --objective "Say hello and hang up" --max-duration 300
outreach calendar add --once --summary "test" --start 2099-01-01T10:00:00 --end 2099-01-01T11:00:00
outreach calendar remove --once --event-id abc123xyz
```

Do not use `--once` as a workaround for missing campaign state — use it only when you genuinely don't want the send tracked.

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

For agent integration details — campaign workflows, data model, post-action patterns — see `skills/outreach/SKILL.md`. Channel-specific references: `skills/outreach/call.md`, `skills/outreach/sms.md`, `skills/outreach/email.md`, `skills/outreach/calendar.md`. These skill files are the source of truth — `npm run build` copies them to `<data_repo>/.agents/skills/outreach/` so the agent workspace always has docs matching the CLI version.

## Data layer

The CLI produces raw data (transcripts, campaign attempt entries). An external **data repo** stores structured outreach data — contacts, campaigns, and transcripts — synced across devices via git.

```
<data-repo>/outreach/
  contacts/        # one JSON file per contact (mutable, progressively enriched)
  campaigns/       # one JSONL file per campaign (append-only event log)
  transcripts/     # call transcripts (auto-saved by CLI)
```

The data repo is located via `OUTREACH_DATA_REPO`, `outreach.config.dev.yaml` (dev), or walk-up from cwd for `.agents/workspace.yaml` (see §3 above). The orchestrator agent manages this data directly — the CLI does not wrap file I/O. See `skills/outreach/SKILL.md` for schemas and conventions.

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
                              ├─ Google Calendar provider (OAuth2 + Calendar API)
                              └─ [not covered in outreach CLI] Data I/O (campaigns, contacts, transcripts)
```

Each channel has its own provider. Calls are the most complex — they require a background daemon that bridges Twilio's media streams to Gemini Live with real-time audio transcoding. SMS, email, and calendar are direct (no daemon, no background process).

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
| Gmail | `src/providers/gmail.ts` | Gmail API client (send, history, search) |
| **Calendar** | | |
| Google Calendar | `src/providers/gcalendar.ts` | Calendar API client (add, remove) |
| **Shared Google Auth** | | |
| Google Auth | `src/providers/googleAuth.ts` | Shared OAuth2 (Gmail + Calendar scopes, token management) |

## Project structure

```
src/
  cli.ts                         # CLI entrypoint
  contacts.ts                    # Contact interface + address resolution
  config.ts                      # .env secrets loader
  dataRepo.ts                    # resolveDataRepo() — env > dev sticky > walk-up
  appConfig.ts                   # loads <data_repo>/outreach/config.yaml (dev fallback: outreach.config.dev.yaml)
  runtime.ts                     # ~/.outreach/runtime.json state
  output.ts                      # JSON output helpers
  exitCodes.ts                   # Exit code constants (0-4)
  commands/
    setup.ts                     # outreach setup (scaffold data repo + stack readiness)
    health.ts                    # outreach health
    context.ts                   # outreach context
    whoami.ts                    # outreach whoami (identity pull for callback agents)
    call/{init,teardown,place,listen,status,hangup}.ts
    sms/{send,history}.ts
    email/{send,history,search}.ts
    calendar/{add,remove}.ts
  providers/
    messages.ts                  # iMessage DB reader + AppleScript sender
    googleAuth.ts                # Shared Google OAuth2 (Gmail + Calendar)
    gmail.ts                     # Gmail API client
    gcalendar.ts                 # Google Calendar API client
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
  sync-skills.js                 # Build hook — syncs skills/outreach/ → <data_repo>/.agents/skills/outreach/
skills/
  outreach/
    SKILL.md                     # Agent onboarding — campaign framework + data model
    call.md                      # Agent reference — call channel
    sms.md                       # Agent reference — SMS channel
    email.md                     # Agent reference — email channel
    calendar.md                  # Agent reference — calendar channel
prompts/
  voice-agent.md                 # Static voice agent instructions (phone mechanics)
```

## Development

```bash
npm run build                    # compile TypeScript -> dist/ + sync skills/ → data repo
```

SMS, email, and calendar commands work immediately after build — no daemon needed. For call development, start the call infrastructure first:

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
| `skills/outreach/SKILL.md` | Agent onboarding — campaign framework + data model |
| `skills/outreach/call.md` | Agent reference — call channel |
| `skills/outreach/sms.md` | Agent reference — SMS channel |
| `skills/outreach/email.md` | Agent reference — email channel |
| `skills/outreach/calendar.md` | Agent reference — calendar channel |
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
