---
name: outreach
description: Utility interface for outbound calls, SMS/iMessage, Gmail, and per-channel history/search. Campaign/process management is out of scope for this repo.
---

Use `outreach` when an agent already has the recipient and the message or call objective. Run `outreach health` first when channel readiness is unknown.

## Channel References

Load a channel note only when channel behavior matters, not just to copy command syntax:

- [call.md](./call.md) - voice-agent constraints, objective writing, and monitoring judgment
- [sms.md](./sms.md) - iMessage-first behavior, send semantics, and Messages history caveats
- [email.md](./email.md) - Gmail reply threading, search-vs-history choice, and auth caveats

## Boundary

`outreach` does not manage workflow state or automatic follow-up. If follow-up matters after a send, schedule it outside this CLI.

## Command Surface

```bash
outreach health

outreach call init
outreach call place --to <number> --objective <text> [--from <number>] [--persona <text>] [--hangup-when <text>] [--max-duration <seconds>]
outreach call listen --id <callId>
outreach call status --id <callId>
outreach call hangup --id <callId>
outreach call teardown

outreach sms send --to <number> --body <text> [--service iMessage|SMS]
outreach sms history --phone <number> [--limit <n>]

outreach email send --subject <text> --body <text> (--to <address> | --reply-to-id <messageId>) [--cc <addresses>] [--bcc <addresses>] [--no-reply-all] [--attach <paths...>]
outreach email history (--address <email> | --thread-id <threadId>) [--limit <n>]
outreach email search --query <gmail-query> [--limit <n>]
```

All output is JSON. Single-quote objectives, bodies, subjects, and Gmail queries so the shell does not expand `$`, backticks, or `!`.
