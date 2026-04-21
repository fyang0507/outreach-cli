# --once flag for adhoc outreach sends

## Summary

Add a `--once` flag to the five outbound commands (`sms send`, `email send`, `call place`, `calendar add`, `calendar remove`) so agents and humans can fire one-off sends without first creating a campaign header + contact record. Under `--once` the CLI skips campaign JSONL logging, reply-watcher registration, and contact-based address resolution — leaving a pure fire-and-forget call to the underlying channel.

Primary use cases:

1. **Unit/smoke tests** for a channel after a credential rotation or config change.
2. **Demos** — the shortest possible "did this work?" command.
3. **Ad-hoc notifications** not tied to an outreach campaign (rare, but legitimate).

`--once` removes **campaign coupling**. It does **not** remove `data_repo_path` dependency — call transcripts and Gmail/Calendar OAuth tokens still land there. The "no filesystem state" story is limited to campaigns/contacts, not the full data repo.

## Design decisions (locked)

1. **Flag, not subcommand.** `--once` is a boolean option on existing commands. No `outreach once …` group.
2. **State policy under `--once`:**
   - `sms send`, `email send`, `calendar add`, `calendar remove` → no campaign JSONL event, no watcher.
   - `call place` → still writes per-call transcript at `<data>/outreach/transcripts/<call_id>.jsonl` (the daemon needs it for `call listen`/`status`/`hangup`). Campaign JSONL append is skipped.
3. **Address resolution disabled.** Each channel requires its natural destination payload:
   - `sms send`, `email send`, `call place`: `--to` is required under `--once`.
   - `calendar add`: `--summary` + `--start` + `--end` (already required). No `--to` exists.
   - `calendar remove`: `--event-id` (already required). No `--to` exists.
4. **Mutual exclusion.** `--once` is incompatible with `--campaign-id`, `--contact-id`, and `--fire-and-forget`. Each produces a distinct self-healing error.
5. **Self-healing errors.** Every misuse message tells the agent both *what rule was broken* and *which of two fixes to apply* (drop `--once` or drop the conflicting flag).

## Validation helper (`src/once.ts`)

New file. Pure function — no file I/O, no provider calls. Writes error + exits on misuse (matches the existing `outputError` + `process.exit(INPUT_ERROR)` pattern used throughout `src/commands/`).

```ts
// src/once.ts
import { outputError } from "./output.js";
import { INPUT_ERROR } from "./exitCodes.js";

export type OnceChannel = "sms" | "email" | "call" | "calendar-add" | "calendar-remove";

export interface OnceInput {
  once?: boolean;
  campaignId?: string;
  contactId?: string;
  to?: string;               // sms/email/call only
  fireAndForget?: boolean;   // sms/email only
}

/**
 * Validate the --once flag against its mutually-exclusive siblings and the
 * channel's minimum required destination. Exits on misuse.
 *
 * Returns "once" | "campaign" — the caller uses this to branch on state writes.
 * The caller is still responsible for enforcing campaign-mode required IDs
 * (one extra line, shown in the per-command section).
 */
export function validateOnce(
  channel: OnceChannel,
  opts: OnceInput,
): "once" | "campaign" {
  if (!opts.once) return "campaign";

  if (opts.campaignId) {
    outputError(
      INPUT_ERROR,
      "--campaign-id is not allowed with --once. --once means 'no campaign tracking'. " +
      "Remove --campaign-id (and --contact-id) to send adhoc, or remove --once to log this send against the campaign.",
    );
    process.exit(INPUT_ERROR);
  }

  if (opts.contactId) {
    outputError(
      INPUT_ERROR,
      "--contact-id is not allowed with --once. --once skips contact lookup. " +
      "Remove --contact-id and pass --to directly, or remove --once to resolve the address from the contact record.",
    );
    process.exit(INPUT_ERROR);
  }

  if (opts.fireAndForget) {
    outputError(
      INPUT_ERROR,
      "--fire-and-forget is redundant with --once (which already skips the reply watcher). Remove --fire-and-forget.",
    );
    process.exit(INPUT_ERROR);
  }

  switch (channel) {
    case "sms":
    case "call":
      if (!opts.to) {
        outputError(
          INPUT_ERROR,
          "--once requires --to <number>. --once skips contact lookup, so the destination must be explicit. " +
          "Example: --once --to +15551234567. (Or remove --once and pass --campaign-id + --contact-id to resolve from a contact.)",
        );
        process.exit(INPUT_ERROR);
      }
      break;
    case "email":
      if (!opts.to) {
        outputError(
          INPUT_ERROR,
          "--once requires --to <address>. --once skips contact lookup, so the destination must be explicit. " +
          "Example: --once --to someone@example.com. (Or remove --once and pass --campaign-id + --contact-id to resolve from a contact.)",
        );
        process.exit(INPUT_ERROR);
      }
      break;
    case "calendar-add":
    case "calendar-remove":
      // Commander's requiredOption already enforces --summary/--start/--end
      // (add) and --event-id (remove). No further check needed.
      break;
  }

  return "once";
}
```

### Error matrix

| Misuse | Message |
|---|---|
| `--once --campaign-id X` | `--campaign-id is not allowed with --once. …` |
| `--once --contact-id Y` | `--contact-id is not allowed with --once. …` |
| `--once --fire-and-forget` (sms/email) | `--fire-and-forget is redundant with --once …` |
| `--once` without `--to` (sms/email/call) | `--once requires --to <number\|address>. …` |
| No `--once`, no `--campaign-id`/`--contact-id` | Classic-path guard (in each command): `Missing required --campaign-id and/or --contact-id. Either pass both to log this send against a campaign, or pass --once (with --to) to send adhoc.` |

## Commander wiring — demote `requiredOption` to `option`

Commander 14's `requiredOption` is enforced at parse time, before the action handler runs. There's no built-in conditional-required. The clean fix:

1. Demote `--campaign-id` and `--contact-id` from `.requiredOption(...)` to `.option(...)` on all five commands.
2. In the action handler:
   - Call `validateOnce(channel, opts)` first. Returns `"once"` or `"campaign"`, exits on `--once` misuse.
   - Add a classic-path guard: `if (mode === "campaign" && (!opts.campaignId || !opts.contactId)) { outputError(INPUT_ERROR, "Missing required --campaign-id and/or --contact-id. …"); process.exit(INPUT_ERROR); }`.

The guard is three lines repeated in all five commands. Extracting it into `once.ts` is possible but overkill — the channel-specific message wording is identical, and inline is easier to audit.

## Per-command changes

For each command: (a) option demotions, (b) `validateOnce` call site, (c) state writes skipped under `--once`, (d) output JSON shape. Line numbers are approximate (current as of `feat/ask-human` branch).

### `sms send` — `src/commands/sms/send.ts`

- **Options:**
  - L22 `requiredOption("--campaign-id ...")` → `option("--campaign-id <id>", "Campaign ID for tracking (required unless --once)")`.
  - L23 `requiredOption("--contact-id ...")` → `option("--contact-id <id>", "Contact ID for tracking (required unless --once)")`.
  - Add `.option("--once", "Fire-and-forget adhoc send — no campaign state, no watcher. Requires --to.")`.
  - Update `--to` description (L20): "Recipient phone number (resolved from contact if omitted; required with --once)".
- **`opts` type (L27-32):** widen `campaignId` / `contactId` to optional; add `once?: boolean`.
- **Action handler:**
  - At the top: `const mode = validateOnce("sms", opts);` then the classic-path guard.
  - The existing `if (opts.to) { normalizePhone(opts.to) } else { resolveContactAddress(...) }` branch is unchanged — under `--once` the else branch is unreachable because `validateOnce` already guaranteed `opts.to`.
- **Skipped under `--once`:**
  - `appendCampaignEvent(...)` block at L58-65 → wrap in `if (mode === "campaign") { ... }`.
  - Reply-watcher block at L68-89 → guard becomes `if (mode === "campaign" && !opts.fireAndForget) { ... }`.
- **Output JSON under `--once`:**
  ```json
  { "to": "+15551234567", "status": "sent", "watch": { "status": "skipped", "reason": "once" } }
  ```
  Keep the `watch` field (do not drop it) — agents parse `.watch.schedule_id` with jq and a missing field creates ambiguity. `reason: "once"` distinguishes it from the existing no-watch-config `{status: "skipped"}` shape.

### `email send` — `src/commands/email/send.ts`

- **Options:**
  - L25 `requiredOption("--campaign-id ...")` → `option(...)`.
  - L26 `requiredOption("--contact-id ...")` → `option(...)`.
  - Add `.option("--once", "Fire-and-forget adhoc send — no campaign state, no watcher. Requires --to.")`.
  - Update `--to` description (L22).
- **`opts` type (L34-46):** widen; add `once?: boolean`.
- **Action handler:** `validateOnce("email", opts)` at top + classic-path guard.
- **Skipped under `--once`:**
  - `appendCampaignEvent(...)` at L82-91 → wrap in `if (mode === "campaign") { ... }`.
  - Reply-watcher block at L94-115 → `if (mode === "campaign" && !opts.fireAndForget) { ... }`.
- **Output JSON under `--once`:** unchanged shape except `watch: {status: "skipped", reason: "once"}`. `message_id` / `thread_id` remain meaningful (Gmail assigned them even though we're not logging to a campaign).

### `call place` (+ daemon) — `src/commands/call/place.ts`

- **Options:**
  - L26 `requiredOption("--campaign-id ...")` → `option(...)`.
  - L27 `requiredOption("--contact-id ...")` → `option(...)`.
  - Add `.option("--once", "Fire-and-forget adhoc call — no campaign event. Transcript still written. Requires --to.")`.
- **`PlaceOptions` (L9-18):** make `campaignId` / `contactId` optional; add `once?: boolean`.
- **Action handler:** `validateOnce("call", opts)` at top + classic-path guard.
- **IPC params (L73-82):** under `--once`, explicitly pass `undefined` for `campaignId` / `contactId`:
  ```ts
  const result = await sendToDaemon("call.place", {
    to,
    from,
    campaignId: mode === "once" ? undefined : opts.campaignId,
    contactId:  mode === "once" ? undefined : opts.contactId,
    objective: opts.objective,
    persona: opts.persona,
    hangupWhen: opts.hangupWhen,
    maxDuration,
  });
  ```
- **Output JSON under `--once`:** daemon returns `{id, status: "ringing"}`. Splice `mode: "once"` before `outputJson(result)` so agents can grep it.
- **Daemon code (`src/daemon/server.ts`):** no change. Already tolerates missing IDs:
  - `handleCallPlace` defaults both to `undefined` (L383-384).
  - `finalizeCall` (L163-205) already gates campaign append on `if (session.campaignId)` (L193).
  - `writeTranscript` (L190) is unconditional — transcript always lands on disk.
  - `handleCallListen`, `handleCallStatus`, `handleCallHangup` never read `campaignId`/`contactId`.
  - Cost logging, guardrail timers, AMD callback, Twilio status callback, idle shutdown — none are campaign-scoped.

### `calendar add` — `src/commands/calendar/add.ts`

- **Options:**
  - L23 `requiredOption("--campaign-id ...")` → `option(...)`.
  - L24 `requiredOption("--contact-id ...")` → `option(...)`.
  - Add `.option("--once", "Fire-and-forget adhoc event creation — no campaign event.")`.
- **`opts` type (L29-38):** widen; add `once?: boolean`.
- **Action handler:** `validateOnce("calendar-add", opts)` at top + classic-path guard. Date validation unchanged.
- **Skipped under `--once`:** `appendCampaignEvent(...)` at L78-88 → wrap in `if (mode === "campaign") { ... }`.
- **Output JSON under `--once`:** add `mode: "once"`. All other fields (`event_id`, `html_link`, `summary`, `start`, `end`, `status: "created"`) remain — the event really exists on Google Calendar regardless of `--once`.

### `calendar remove` — `src/commands/calendar/remove.ts`

- **Options:**
  - L21 `requiredOption("--campaign-id ...")` → `option(...)`.
  - L22 `requiredOption("--contact-id ...")` → `option(...)`.
  - Add `.option("--once", "Fire-and-forget adhoc event removal — no campaign event.")`.
  - `--event-id` (L20) stays `requiredOption` — required in all modes.
- **`opts` type (L24-28):** widen; add `once?: boolean`.
- **Action handler:** `validateOnce("calendar-remove", opts)` at top + classic-path guard.
- **Skipped under `--once`:** `appendCampaignEvent(...)` at L41-48 → wrap in `if (mode === "campaign") { ... }`.
- **Output JSON under `--once`:** add `mode: "once"`: `{ "event_id": "...", "status": "removed", "mode": "once" }`.

## Skills doc updates

Source of truth is `skills/outreach/` — build step (`scripts/sync-skills.js`) copies it into the agent workspace, so no manual distribution.

- **`skills/outreach/SKILL.md`** — under "Identifier model (send commands)" (~L161-169), append:
  > **Ad-hoc sends (`--once`)** — every send command also accepts `--once` for fire-and-forget adhoc use (unit tests, demos, one-off notifications). Under `--once`: no campaign or contact ID is accepted, no campaign event is written, no reply watcher registered. Pass the destination explicitly (`--to` for sms/email/call; event fields or `--event-id` for calendar). `--once` is mutually exclusive with `--campaign-id`, `--contact-id`, and `--fire-and-forget`. **Do not use `--once` as a workaround for failing to find an existing campaign** — it's for tests and one-offs, not real outreach.

- **`skills/outreach/sms.md`** — after the normal "Sending an SMS" example, add:
  > **Ad-hoc test (`--once`):** `outreach sms send --once --to +15551234567 --body "ping"` — no campaign state, no reply watcher. Use only for smoke-tests or demos; real outreach belongs in a campaign.

- **`skills/outreach/email.md`** — mirror for email, noting that `--reply-to-id`, CC/BCC, and attachments still work.

- **`skills/outreach/call.md`** — mirror, plus an explicit note: *"`--once` still writes the per-call transcript at `$DATA_REPO/outreach/transcripts/<call_id>.jsonl` — the daemon needs it for `call listen`/`status`/`hangup`. There is no campaign JSONL event linking to it, so these transcripts are not discoverable via `outreach context`."*

- **`skills/outreach/calendar.md`** — mirror for both `add` and `remove`. Note that `--once` for calendar just suppresses the campaign JSONL append — the event itself is real on Google Calendar.

After edits, `npm run build` syncs the skills files into the agent workspace.

## Tests

**No automated tests** in this patch. The project has no `jest`/`vitest`/`mocha` setup; only two integration bash scripts under `tests/integration/` that make real Twilio calls. Adding a test framework for this feature alone is scope creep.

If the user wants lightweight validation, a follow-up `tests/integration/once-validation.sh` could assert exit codes and stderr messages for each misuse permutation — the validator exits before touching any network/provider, so it's hermetic. Out of scope for this PR.

## Risks and edge cases

1. **Transcript orphaning.** `call place --once` writes `transcripts/<id>.jsonl` but no campaign event references it. `outreach context` won't surface these. Document in `call.md`; accept as designed.
2. **`watch.ts::registerReplyWatch` robustness.** It concatenates `campaignId`/`contactId` into the sundial schedule name — if ever called with undefined IDs it produces garbage. The call-site guard (`if (mode === "campaign" && !opts.fireAndForget)`) prevents this; a defensive assertion inside `registerReplyWatch` is a worthwhile future hardening but out of scope.
3. **`call place --to` is not phone-normalized today** (unlike `sms send --to` which runs `normalizePhone`). This is a pre-existing inconsistency unrelated to `--once`. Do not change it in this PR.
4. **Commander error message change.** Before: `error: required option '--campaign-id <id>' not specified` (Commander default). After: our classic-path guard message. Strictly more agent-friendly, but any automation greping the old string will break. Flag in commit message.
5. **TypeScript narrowing.** Inside `if (mode === "campaign") { ... }`, `opts.campaignId` and `opts.contactId` are still typed `string | undefined`. The classic-path guard has already proven they exist — use non-null assertions (`opts.campaignId!`) or local consts. Trivial.
6. **`--no-reply-all`** (email) is orthogonal to `--once` — no special-case.
7. **Interleaved campaign + `--once` calls in the daemon.** Each `call place` creates an independent `CallSession` in the daemon's `Map`. Sessions don't share state. Safe.
8. **`--once` does not eliminate `data_repo_path` dependency.** Calls write transcripts there; email/calendar need OAuth tokens at `<data_repo>/outreach/gmail-token.json`. Claim in skills docs: "no campaign coupling," not "no filesystem dependency."

## Non-goals

- No new subcommand group (`outreach once …`).
- No change to `reply-check`, `callback-dispatch`, `context`, `ask-human`, `ask-human-check`.
- No daemon code changes (`src/daemon/server.ts`, `src/daemon/sessions.ts`).
- No change to contact resolution (`src/contacts.ts`) or to `registerReplyWatch`/`registerAskHumanWatch` (`src/watch.ts`).
- No new test framework.
- No fix to the existing `call place --to` normalization inconsistency.
- No `--once` for read-only commands (`sms history`, `email history`, `email search`, `call listen`/`status`/`hangup`) — those don't write campaign state.

## Files touched

| Path | Change |
|---|---|
| `src/once.ts` | **new** — shared validator |
| `src/commands/sms/send.ts` | demote 2 options, add `--once`, validator call, skip campaign append + watcher under `--once`, output shape |
| `src/commands/email/send.ts` | same pattern |
| `src/commands/call/place.ts` | same pattern, plus conditional IPC param |
| `src/commands/calendar/add.ts` | demote 2 options, add `--once`, validator call, skip campaign append |
| `src/commands/calendar/remove.ts` | same as calendar add |
| `skills/outreach/SKILL.md` | one paragraph under "Identifier model" |
| `skills/outreach/sms.md` | one `--once` example |
| `skills/outreach/email.md` | one `--once` example |
| `skills/outreach/call.md` | one `--once` example + transcript-orphan note |
| `skills/outreach/calendar.md` | two `--once` examples |

No changes to: daemon, sessions, watch, contacts, logs, config, runtime, ask-human, reply-check, callback-dispatch, context, health.

## Acceptance checks

Before merging, manually run:

```bash
# Misuse — each should fail with a specific, self-healing message:
outreach sms send --once --campaign-id X --to +1555 --body "test"
outreach sms send --once --contact-id Y --to +1555 --body "test"
outreach sms send --once --to +1555 --body "test" --fire-and-forget
outreach sms send --once --body "test"                      # missing --to
outreach sms send --body "test"                             # missing both campaign + --once
outreach calendar remove --once --campaign-id X --event-id abc

# Success — each should send and emit the expected JSON shape:
outreach sms send --once --to +15551234567 --body "outreach-cli ping"
outreach email send --once --to test@example.com --subject "ping" --body "ping"
outreach calendar add --once --summary "test" --start 2099-01-01T10:00:00 --end 2099-01-01T11:00:00
outreach calendar remove --once --event-id <id-from-above>
outreach call init
outreach call place --once --to +15551234567 --objective "Say hello and hang up" --max-duration 30
outreach call teardown

# Confirm no campaign file was created for any of the above
ls "$DATA_REPO/outreach/campaigns/" | grep -v '^20..'        # should be empty

# Confirm the call transcript DOES exist
ls "$DATA_REPO/outreach/transcripts/" | tail
```
