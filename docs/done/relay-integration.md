# Relay integration — outreach side

Relay (github.com/fyang0507/relay) is an **optional** observability daemon that
mirrors campaign JSONL to Telegram and writes human replies back. Outreach
functions fully without it — only the human-in-the-loop observability channel
is lost when relay is absent.

The outreach→relay boundary is unidirectional: outreach writes JSONL, relay
watches it. Outreach does not import relay, does not run `relay add`, and does
not host relay's integration template.

## Where to look

- Setup instructions and the canonical outreach-source `relay.config.yaml`
  template live in the relay repo — see
  [fyang0507/relay](https://github.com/fyang0507/relay) (`SKILL.md` and
  `examples/`).
- Stack-readiness behavior (how `outreach setup` surfaces relay gaps as WARN,
  not FAIL) lives in the `outreach setup` command — see `src/commands/setup.ts`.
- Agent-facing docs on `human_input` semantics (relay-authored vs. agent-
  authored entries, `content ?? text` normalization) live in
  `skills/outreach/SKILL.md`.
