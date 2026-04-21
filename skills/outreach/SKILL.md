---
name: outreach
description: Omnichannel outreach AND campaign record management — send via call, SMS, email, or calendar (Google Calendar), and maintain the campaign JSONL (attempts, outcomes, decisions, amendments, human_input). Use for any outreach send OR any campaign state update — including logging an off-horizon reply, resolving an outcome, or amending a decision without any new send.
---

This skill is a catalog. Load only the doc matching your task — each sub-doc is self-contained.

## Task routing

**→ [once.md](./once.md) — One-off send (utility mode).** Smoke test, demo, or one-shot notification. No campaign, no contact record, no follow-up tracking, no reply watcher. Uses `--once` on any send command.

**→ [campaign.md](./campaign.md) — Campaign management (full SOP).** Anything tied to a named outreach goal, including:
- Campaign-coupled sends (with `--campaign-id` + `--contact-id`), AND
- **Record-only updates** with no new send — logging that the vendor called back, recording an off-channel reply, appending an `outcome` / `decision` / `amendment` after new information lands.

If your task is "update the campaign record for X" or "mark Y resolved" — **you are in campaign, even with no send.** The record IS the work.

## Per-channel references

Flag details and output shapes for each channel — load only the one you need:

- [call.md](./call.md) — voice calls (Twilio + Gemini Live)
- [sms.md](./sms.md) — SMS (iMessage)
- [email.md](./email.md) — email (Gmail)
- [calendar.md](./calendar.md) — calendar events (Google Calendar)

## Prerequisites

Always start a session with `outreach health`. Use its `data_repo.path` as `$DATA_REPO` for any direct file reads; `config_path` in the same block tells you which config file was resolved.

**Data repo resolution.** You normally run from inside the data repo, so the CLI locates it by walking up from cwd looking for `.agents/workspace.yaml`. For one-off invocations against a different repo, export `OUTREACH_DATA_REPO=/path` for that command (or session). If health errors with no data repo found, the operator needs to run `outreach setup` — flag it and stop.

**Daemon lifecycle (campaign path).** Outreach composes with two sibling daemons: **sundial** (powers `reply-check`, `ask-human`, and auto-watchers) and **relay** (delivers human-in-the-loop traffic for `ask-human` — the agent writes a `human_question`, relay ships it to a messaging platform, the human replies, relay appends a `human_input` entry, and sundial fires the callback). Without relay, `ask-human` just times out. These daemons are operator-managed and persist across sessions — `outreach setup` runs a readiness check at install time (any sundial or relay gap is a hard failure) and surfaces any gaps. If watcher behavior seems off mid-session, re-running `outreach setup --skip-stack-check` is cheap and idempotent. The one-off path ([once.md](./once.md)) does not require these daemons.
