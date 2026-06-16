# Plan: Contact-operator feature + Discord channel

**Goal:** Let a headless agent reach the operator (you) two ways:
1. **Synchronous / blocking / urgent** — voice call via the *already-built* `outreach call place --call-operator`. Only needs a skill rule.
2. **Async status / updates / digests** — new `outreach discord` command group backed by a **Discord bot token** (chosen scope: full capability — list + create channels + post anywhere the bot can see).

The webhook you created (bound to *General*) is **superseded** by the bot token and is not required by this plan. A bot token can post to *General* and any other channel, and can list/create channels — the webhook can do none of the latter. We keep the webhook out of scope (optionally documented as a manual fallback only).

Two worked examples this must satisfy:
- **Blocking approval** (headless agent needs permission to delete a file in personal Drive) → `call place --call-operator`.
- **Weekly reflection digest** (read activity logs, post a digest, choosing an existing channel or creating one) → `discord channels list` → `discord post --channel <existing>` *or* `discord channels create --name weekly-reflections` then post.

---

## Background: how the codebase is shaped (so the implementation matches)

- **Commands** live in `src/commands/<group>/<verb>.ts`, each exporting `register<Verb>Command(parent)`. Registered in `src/cli.ts` by creating a `program.command("<group>")` and passing it to the registrars (mirror the `sms`/`email` blocks).
- **Providers** (I/O + API logic, no commander) live in `src/providers/*.ts` (`messages.ts`, `gmail.ts`). Commands import provider functions.
- **Output** is JSON-only: `outputJson(data)` / `outputError(code, message)` from `src/output.ts`. Exit with codes from `src/exitCodes.ts` (`SUCCESS=0`, `INPUT_ERROR=1`, `INFRA_ERROR=2`, `OPERATION_FAILED=3`, `TIMEOUT=4`).
- **Secrets** are read in `src/config.ts` into the `outreachConfig` object from `.env`. Document new keys in `.env.example`. (Behavioral/runtime config lives in `config.yaml` via `appConfig.ts`; Discord needs only secrets, so `config.ts` is the right home.)
- **Health** (`src/commands/health.ts`) runs per-channel `check*()` functions in `Promise.all` and emits one JSON object. Add a `discord` key.
- Global `fetch` is already used across the codebase (`src/runtime.ts`, `src/commands/call/init.ts`) — no HTTP dependency needed. Node 25, ESM, **imports must use `.js` extensions**.
- `npm run build` = `rm -rf dist && tsc && node scripts/sync-skills.js` (best-effort syncs `skills/outreach/` to the workspace; must still succeed with no workspace).
- Keep the **utility boundary** (CLAUDE.md): no campaign/process state, no reply watchers. `discord post` sends and returns; it does not poll for reactions/replies.

---

## Part 1 — Discord infrastructure (the build)

### 1.1 Config / secrets

`src/config.ts` — add to `OutreachConfig` and `outreachConfig`:
- `DISCORD_BOT_TOKEN: string`
- `DISCORD_GUILD_ID: string` (the server/guild the bot operates in)
- `DISCORD_DEFAULT_CHANNEL: string` — optional, defaults to `"General"` in code if empty. Used when `discord post` is called without `--channel`.

`.env.example` — add a documented block:
```
# Discord bot for async operator updates. Create an application + bot at
# https://discord.com/developers, copy the bot token, and invite the bot to your
# server with scopes=bot and permissions: View Channels, Send Messages, Manage Channels.
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=000000000000000000
# Optional: channel name/id used when `discord post` omits --channel (defaults to "General")
DISCORD_DEFAULT_CHANNEL=General
```

> **One-time manual setup you must do** (document in skill/README, not code): create the Discord application, add a bot, enable no privileged intents (not needed for REST), generate an OAuth2 invite URL with `scope=bot` + permissions `View Channels (1024)`, `Send Messages (2048)`, `Manage Channels (16)`, invite it to the server, then grab `DISCORD_BOT_TOKEN` and the server's `DISCORD_GUILD_ID` (right-click server → Copy Server ID; requires Developer Mode).

### 1.2 Provider: `src/providers/discord.ts`

Pure REST against `https://discord.com/api/v10`, auth header `Authorization: Bot <DISCORD_BOT_TOKEN>`. No SDK, just `fetch`. Functions:

- `interface DiscordChannel { id: string; name: string; type: number; parent_id: string | null; }`
- `listChannels(): Promise<DiscordChannel[]>` — `GET /guilds/{guild}/channels`. Filter to text channels (`type === 0`) for `channels list` output, but keep categories (`type === 4`) available for `--category` resolution.
- `resolveChannel(nameOrId: string): Promise<DiscordChannel>` — if input is all digits treat as id and find by id; else case-insensitive match by `name` (Discord stores text-channel names lowercased/hyphenated, so normalize "General" → match `general`). Throw a clear error listing available channel names if no match / ambiguous match.
- `createChannel(name: string, opts?: { topic?: string; categoryId?: string }): Promise<DiscordChannel>` — `POST /guilds/{guild}/channels` body `{ name, type: 0, topic?, parent_id? }`.
- `postMessage(channelId: string, content: string): Promise<{ id: string }[]>` — `POST /channels/{id}/messages` body `{ content }`. **Discord caps `content` at 2000 chars** — split long bodies into ordered ≤1900-char chunks (prefer splitting on newline boundaries) and post sequentially; return the array of created message ids. This is what makes the weekly-digest example robust.
- `checkDiscordAuth(): Promise<Record<string, unknown>>` — for health. If token/guild missing → `{ ok: false, hint: "Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env" }`. Else `GET /guilds/{guild}` (or `/users/@me`) and report `{ ok, guild_name, bot_user }`; map `401` → bad token hint, `403`/`404` → "bot not in guild or missing View Channels" hint.

**Error mapping helper** (one place): non-2xx → throw `Error` with `status` + Discord's JSON `message`. Handle `429` specially: read `retry_after` and surface "rate limited, retry after Ns" (do not auto-retry in v1 — keep it simple and JSON-honest).

### 1.3 Commands: `src/commands/discord/*.ts`

Group registered in `cli.ts` as `const discord = program.command("discord").description("Discord operator updates")`.

- **`post.ts`** → `registerPostCommand`
  - `--body <text>` (required), `--channel <id|name>` (optional; default `DISCORD_DEFAULT_CHANNEL` || `"General"`).
  - Resolve channel → `postMessage`. Output `{ channel: { id, name }, messages: [<ids>], chunks: <n> }`. Errors → `outputError(OPERATION_FAILED, hint)`.
- **`channels.ts`** → `registerChannelsCommand` with two subcommands (a nested `channels` group like `call`):
  - `channels list` → `{ channels: [{ id, name, type }] }`.
  - `channels create --name <name> [--topic <text>] [--category <id|name>]` → resolve category if given, `createChannel`, output `{ channel: { id, name } }`. Guard: if a text channel with that name already exists, return it with `existed: true` rather than creating a duplicate (call `listChannels` first).

Keep `--body`/`--name` single-quoted in docs (shell `$`/backtick/`!` expansion — same note as SKILL.md).

### 1.4 Wire-up

- `src/cli.ts`: import the three registrars, add the `discord` group block after `email`.
- `src/commands/health.ts`: add `checkDiscord()` (= `checkDiscordAuth`) to the `Promise.all` and the output object key `discord`.

---

## Part 2 — Skill content (the enablement)

### 2.1 `skills/outreach/operator.md` (currently a stub)

Write the operator-contact note. Structure:
- **When to reach the operator at all**: headless / non-interactive mode where no live session can answer. (In an interactive session, just ask the user directly — don't call/post.)
- **Mode choice — the decision rule** (the core content):
  - **Blocking & time-sensitive → voice call.** Use `outreach call place --call-operator --objective '<what you need decided>'` when you cannot proceed without a human decision *and* it's urgent (e.g. approval to delete a file in personal Drive). Write the objective so the voice agent can state the ask and capture a yes/no. Cross-link `call.md` for objective-writing.
  - **Informational / non-blocking → Discord.** Use `outreach discord post` for status, progress, and digests where you do **not** need an answer before continuing (e.g. weekly reflection digest).
  - One-line heuristic: *"Do I need an answer before my next step? Yes+urgent → call. No → Discord."*
- **Channel selection for Discord** (covers example #2): run `outreach discord channels list` first; post to an existing topical channel if one fits, otherwise `outreach discord channels create --name <topic>` then `post --channel <name>`. Default to `General` when no specific channel is warranted.
- **Boundary reminder**: `discord post` is fire-and-forget — it does not watch for replies/reactions. If you need a response, that's the call path, not Discord. (Consistent with the [[feedback_infra_failure_handling]] guidance: on infra failure, log and move on — don't invent hidden commands.)

### 2.2 `skills/outreach/SKILL.md`

- The `operator.md` link is already added (uncommitted). Extend its label to hint at the mode split, e.g. "operator contact — call vs. Discord decision rule".
- Add to the **Command Surface** block:
  ```bash
  outreach discord post --body <text> [--channel <id|name>]
  outreach discord channels list
  outreach discord channels create --name <name> [--topic <text>] [--category <id|name>]
  ```
- The existing `--call-operator` paragraph already documents the call path; leave it.

### 2.3 README / CLAUDE.md touch-ups

- `CLAUDE.md` "Current Commands" + "Key Files" table: add the `discord` command line and `src/providers/discord.ts`.
- `README.md` (if it enumerates commands/env): add the Discord command group and the manual bot-setup steps.

---

## Part 3 — Verification plan

### 3.1 Build + static (no network)
```bash
npm install
npm run build                     # tsc clean + sync-skills succeeds with no workspace
node dist/cli.js --help           # shows `discord` group
node dist/cli.js discord --help
node dist/cli.js discord post --help
node dist/cli.js discord channels --help
node dist/cli.js discord channels create --help
```
Pass = all help screens render, no missing-option crashes.

### 3.2 Health (token-aware, both states)
```bash
node dist/cli.js health           # with DISCORD_* unset -> discord.ok=false + setup hint
# then set DISCORD_BOT_TOKEN + DISCORD_GUILD_ID in .env
node dist/cli.js health           # -> discord.ok=true, guild_name populated
```
Also verify a deliberately bad token → `ok:false` with the 401 hint (not an unhandled throw).

### 3.3 Live Discord (requires bot invited to the server)
```bash
node dist/cli.js discord channels list                         # General appears
node dist/cli.js discord post --body 'outreach test: hello from CLI'   # lands in General
node dist/cli.js discord channels create --name outreach-test  # created (or existed:true on rerun)
node dist/cli.js discord post --channel outreach-test --body 'second channel test'
# Long-body chunking:
node dist/cli.js discord post --body "$(python3 -c 'print("x"*4500)')"  # -> chunks:3, 3 message ids
```
Confirm visually in the Discord client: messages present, in the right channels, long body split in order. Then clean up the test channel manually (or via API).

### 3.4 Call path (already built — verify the rule, not the code)
```bash
node dist/cli.js call place --help        # --call-operator present
```
Optional end-to-end (costs a real call): `outreach call init` then `outreach call place --call-operator --objective 'test: confirm you can hear me, then say goodbye'` and confirm your phone rings from the Twilio number.

### 3.5 Skill review
- Re-read `operator.md` as if you were a headless agent: is the call-vs-Discord rule unambiguous for both worked examples? Walk both examples through it.
- Confirm `npm run build` synced the updated skills to the workspace (or no-op'd cleanly).

---

## Build order (suggested for next session)
1. `config.ts` + `.env.example` (config first; everything reads it).
2. `providers/discord.ts` (+ exercise functions via a scratch `node -e` before wiring commands).
3. `commands/discord/post.ts`, `commands/discord/channels.ts`; wire `cli.ts`.
4. `health.ts` `checkDiscord`.
5. Verify 3.1–3.3.
6. `operator.md` + `SKILL.md` + `CLAUDE.md`/`README.md`; verify 3.4–3.5.
7. Commit on a feature branch; PR.

## Risks / decisions already made
- **Bot token over webhook** — chosen for true channel list/create (webhook can't). Webhook left as undocumented manual fallback.
- **No reply/reaction watching** — preserves the utility boundary; the call path covers "need an answer."
- **2000-char limit** — handled by client-side chunking, not truncation, so digests post in full.
- **Rate limits (429)** — surfaced as JSON errors in v1, no auto-retry. Revisit only if it bites in practice.
