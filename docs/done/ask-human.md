# `outreach ask-human` — agent-initiated human-in-the-loop

Issue: #68
Status: Design. Follow-up to #67 (relay integration, now landed — see `docs/plan/relay-integration.md`).

## Context

Today the agent can *record* off-horizon information as `human_input` but has no way to *ask* and pause. This adds a two-part mechanism so an agent can block on an operator answer:

1. `outreach ask-human` — writes a `human_question` event (relay mirrors it to Telegram at `notify` tier) and registers a sundial watch, then exits.
2. Sundial polls the campaign JSONL for new `human_input` entries; when one lands (from any producer — relay-inbound Telegram reply, agent-authored live-chat entry, future surface), sundial fires `callback-dispatch` which resumes the last agent session with a prompt tailored to "human answered your question; continue."

Producer-agnostic by design: outreach only knows about JSONL events, not relay or Telegram. Relay handles the observer side; outreach handles the wait side.

## Design decisions

### 1. Timeout fires callback (team-lead rec: confirmed with mechanism tweak)

When `default_timeout_hours` elapse without a `human_input` arrival, the callback fires anyway with a `--timeout` flag so the agent can proceed on best judgment rather than stall silently.

**Mechanism.** Sundial's `--timeout` flag is a hard lifetime cap — when it expires, the schedule ends without firing `--command`. We don't want silent stalls. So we move timeout detection **into the trigger**:

- `outreach ask-human-check` reads the latest `human_question` ts from the JSONL.
- It exits 0 if (a) any `human_input` with ts > that exists (reply arrived), OR (b) `(now - latest_question_ts) > default_timeout_hours` (elapsed). Otherwise exit 1.
- Sundial's `--timeout` is set to `default_timeout_hours * 2` as an outer safety bound — the trigger normally fires first.
- `callback-dispatch` re-reads the JSONL at fire time. If a `human_input` exists past the baseline → normal prompt; if not → timeout prompt.

Rationale for this variant over pure team-lead (b): existing SMS/email reply watches *don't* actually handle timeout today (schedule expires silently — see `src/watch.ts:54`), so there's no precedent to copy. Moving timeout into the trigger keeps all the logic in outreach (no sundial changes) and stays within the stateless-trigger pattern.

### 2. Multiple concurrent asks — shared schedule, refresh-on-write (team-lead rec: confirmed)

Schedule name: `outreach-<sanitized campaign_id>-ask-human` — no contact_id in name. Stacking semantics:

- Every `ask-human` call appends a fresh `human_question` event and calls `sundial add poll ... --refresh --name <above>`.
- Trigger re-derives baseline each poll from *latest* `human_question` (same pattern as `reply-check` re-derives from latest `attempt` — `src/commands/replyCheck.ts:24`). No baseline ts stored on the schedule.
- When `human_input` lands, trigger exits 0, callback fires, agent sees all outstanding questions in JSONL on resume and answers in one pass.

**Known race (accepted, non-goal to fix in v1).** If reply arrives between the last poll and the next `ask-human` --refresh call, and its ts falls between question N-1 and N, the refreshed baseline=ts(N) would skip it. The reply-check flow has the same race (reply between last poll and next `send`). Agents can catch missed replies by scanning `human_input` on resume per the SKILL doc.

### 3. Trigger semantics — stateless re-derivation from JSONL (propose alternative to team-lead)

Team-lead recommended passing baseline ts via sundial args. I propose **matching the existing reply-check pattern**: the trigger looks up the latest `human_question` from the JSONL at every poll; no ts in args. Benefits:

- No clock-skew / ISO-ts-in-shell-args risk.
- `--refresh` works without re-computing args client-side.
- Symmetric with `replyCheck.ts`'s use of `findLatestOutboundAttempt`.

New helper: `findLatestHumanQuestion(campaignId, contactId?)` in `src/logs/sessionLog.ts` — mirrors `findLatestOutboundAttempt` (`src/logs/sessionLog.ts:175`), returns `{ts, campaign_id, contact_id?}` or null. When called from the trigger, `contactId` is left unset so any campaign-level `human_question` is caught.

Existence check for new `human_input`: iterate campaign events, return any with `type === "human_input"` and `ts > baseline.ts`. No channel filter; any producer's `human_input` counts (this is the whole point of the unification in #67).

### 4. Channel name — `human_input` (team-lead rec: confirmed)

The sundial watch + callback key off the channel name `human_input` throughout. Consistent with SMS/email — named after the *reply* channel the callback is waiting for, not the send channel. Threading updates:

- `replyCheck.ts`: whitelist `sms | email` (current behavior unchanged, but the hidden subcommand stays SMS/email-only — ask-human uses a separate trigger).
- `callbackDispatch.ts`: widen the whitelist to `sms | email | human_input`.

Reasoning for *separate trigger* (not overloading `reply-check`): semantics diverge. `reply-check` needs a provider round-trip (iMessage DB query, Gmail API call) keyed to an *attempt*; `ask-human-check` is purely a JSONL scan keyed to a *question*. Cramming both into one subcommand muddies the shape. New hidden subcommand: `outreach ask-human-check`.

### 5. Separate prompt template — `watch.callback_prompt_human_input` + `_timeout` (team-lead rec: confirmed, with timeout variant)

Two new config fields:

- `watch.callback_prompt_human_input` — fired when human_input arrived. Agent's job on resume: read outstanding questions, ingest the answer(s), update outcomes/decisions.
- `watch.callback_prompt_human_input_timeout` — fired on timeout. Agent's job on resume: acknowledge no answer came, proceed on best judgment, record an `amendment` or `decision` if applicable.

Both support the existing template variables plus a new `{question}` (latest `human_question.question` text) to anchor the agent.

`watch.callback_prompt` stays the channel-neutral SMS/email template (backwards-compatible).

### 6. `--contact-id` optional on `ask-human` (new decision)

Issue spec says `--contact-id` is optional (campaign-level questions allowed). This cascades into session-resume semantics for `callback-dispatch` because today `findLatestCallbackRun` requires a contact_id (`src/logs/sessionLog.ts:226`).

Resolution: ask-human accepts optional `--contact-id`. When absent, the `human_question` event omits `contact_id`, the sundial schedule uses `__campaign__` as a sentinel contact id in its args, and `callback-dispatch` for `channel=human_input` resumes on `(campaignId, channel=human_input)` alone — new helper `findLatestHumanInputCallbackRun(campaignId)` skips the contact filter. Session chain is campaign-scoped for ask-human, which is semantically correct (the agent that asked is the one that should hear the answer, across contacts).

## File-by-file change list

Precise references; no prose explanation of already-obvious patterns.

### New files

- **`src/commands/askHuman.ts`** — user-facing command. Shape mirrors `src/commands/sms/send.ts`:
  - Resolve `--contact-id` if provided (validate via `readContact` but don't fail hard — just warn).
  - Append `human_question` event via `appendCampaignEvent` (`src/logs/sessionLog.ts:122`).
  - Call new helper `registerAskHumanWatch({campaignId, contactId?})` (see below).
  - Append `watch` event (same shape as `src/commands/sms/send.ts:77`, `channel: "human_input"`).
  - Emit JSON: `{campaign_id, contact_id?, question_ts, watch: {...}}`.

- **`src/commands/askHumanCheck.ts`** — hidden sundial trigger. Shape mirrors `src/commands/replyCheck.ts`:
  - Required flags: `--campaign-id`, `--contact-id` (accepts sentinel `__campaign__`).
  - Read campaign events; find latest `human_question` (contact-scoped if contact_id is real, else campaign-wide).
  - If found, scan for any `human_input` with `ts > question.ts`: exit 0 (`outputJson({fired:true, reason:"human_input"})`).
  - Else check elapsed: if `(now - question.ts) / 3600000 > default_timeout_hours`: exit 0 (`outputJson({fired:true, reason:"timeout"})`).
  - Else exit 1.
  - Exit codes match `reply-check`: 0=fire, 1=keep polling, 2=infra error.

### Modified files

- **`src/watch.ts`** — add `registerAskHumanWatch(opts: {campaignId; contactId?})`. Copies the body of `registerReplyWatch` (`src/watch.ts:19`) with these changes:
  - Schedule name: `outreach-${sanitize(campaignId)}-ask-human` (no contact_id component).
  - Sentinel: `const contactArg = opts.contactId ?? "__campaign__"`.
  - Trigger: `outreach ask-human-check --campaign-id ${campaignId} --contact-id ${contactArg}`.
  - Callback: `outreach callback-dispatch --campaign-id ${campaignId} --contact-id ${contactArg} --channel human_input`.
  - Sundial `--timeout`: `${default_timeout_hours * 2}h` (outer safety, trigger handles the soft timeout).
  - All other flags (`--once --refresh --detach`) unchanged.

- **`src/logs/sessionLog.ts`** — add two helpers:
  - `findLatestHumanQuestion(campaignId, contactId?)` — same scan pattern as `findLatestOutboundAttempt` (`src/logs/sessionLog.ts:175`), filters `type === "human_question"`. Returns `{ts, campaign_id, contact_id?, question}` or null.
  - `findLatestHumanInputCallbackRun(campaignId)` — sibling to `findLatestCallbackRun` (`src/logs/sessionLog.ts:226`), drops the contactId filter, requires `channel === "human_input"`.
  - Also: add a helper `hasNewHumanInputSince(campaignId, baselineTs)` — boolean for the trigger; can inline if preferred.

- **`src/commands/callbackDispatch.ts`** — extend to handle `channel=human_input`:
  - Widen channel whitelist at line 102 to accept `"human_input"`.
  - When `opts.channel === "human_input"`:
    - Pick prompt template by checking whether a new `human_input` exists past the latest `human_question.ts`:
      - If yes → use `config.watch.callback_prompt_human_input`, log `resumed_reason: "human_input"`.
      - If no → use `config.watch.callback_prompt_human_input_timeout`, log `resumed_reason: "timeout"`.
    - Resolve `{question}` template var from `findLatestHumanQuestion(campaignId).question`.
    - Resume-session lookup: call `findLatestHumanInputCallbackRun(campaignId)` instead of `findLatestCallbackRun` (drops contact filter).
    - Accept sentinel `__campaign__` as contact-id; in the `callback_run` event written at line 198, record `contact_id: null` when sentinel is used so downstream queries don't fabricate a contact.
  - `callback_run` event gains optional field `resumed_reason: "human_input" | "timeout"` when `channel === "human_input"` (nullable for backwards-compat).

- **`src/appConfig.ts`** — extend `WatchConfig` interface (`src/appConfig.ts:51`):
  ```ts
  callback_prompt_human_input?: string;
  callback_prompt_human_input_timeout?: string;
  ```
  Validation: if absent *and* ask-human is invoked, `askHuman.ts` emits INFRA_ERROR. Do NOT hard-fail at config load (keeps backwards compat with configs that predate this feature).

- **`src/cli.ts`** — register the two new commands after the existing hidden registrations (`src/cli.ts:32`):
  ```ts
  registerAskHumanCommand(program);        // user-facing, top-level
  registerAskHumanCheckCommand(program);   // hidden
  ```

- **`outreach.config.example.yaml`** — add under the `watch:` block (after line 104):
  ```yaml
  # Prompt fired when a human_input arrives after an ask-human call.
  # Variables: {contact_id}, {campaign_id}, {channel}, {contact_name}, {question}.
  callback_prompt_human_input: "Human replied to your question on campaign {campaign_id}. Your question: \"{question}\". Read the latest human_input entries (and any other pending human_question entries) in $DATA_REPO/outreach/campaigns/{campaign_id}.jsonl, ingest the answer, and continue the campaign."
  # Prompt fired when default_timeout_hours elapsed without a reply.
  callback_prompt_human_input_timeout: "No answer arrived within the timeout for your question on campaign {campaign_id}. Your question: \"{question}\". Proceed on best judgment; record an amendment or decision if appropriate."
  ```

### Relay config

- **`relay.config.example.yaml`** — add two entries in the `tiers:` map (after `human_input: notify` at line 44):
  ```yaml
  human_question:   notify   # agent-initiated ask; observer sees the question in Telegram
  ```
  No `inbound_types` change — loop prevention already covers only `human_input`. `human_question` is always agent-authored and always mirrors outbound.

### Skill docs

- **`skills/outreach/SKILL.md`** — two edits:

  1. New subsection after `human_input` (around line 113), **"`human_question` — agent asks the human"**:
     ```
     ```json
     {"ts":"2026-04-18T16:00:00Z","type":"human_question","contact_id":"c_a1b2c3","question":"Should I prioritize same-week availability or lowest price?","context":"Two viable options with tradeoffs"}
     ```

     Written by `outreach ask-human`. The CLI registers a sundial watch that polls for new `human_input` entries and resumes your session when one arrives (or when the configured timeout elapses). `contact_id` and `context` are optional. Use when you need operator input and cannot make a well-founded decision from available signal.
     ```

  2. Add a new subsection under "Typical workflow" after Step 2 (around line 195), **"When you're stuck — `ask-human`"**:
     ```
     If a decision requires operator input (genuine ambiguity, not just thoroughness), run:

     outreach ask-human --campaign-id X --question "..." [--contact-id c_...] [--context "..."]

     The command writes a `human_question` event and exits. A future session will resume automatically when the operator answers (via any channel) or the timeout elapses.
     ```

- **`skills/outreach/` — no new per-channel doc.** ask-human is a top-level command like `context` and `reply-check`, not a channel.

### CLAUDE.md

Add one row to the "Key files" table (around `src/commands/replyCheck.ts`):

```
| `src/commands/askHuman.ts` | `outreach ask-human` — write human_question + register watch |
| `src/commands/askHumanCheck.ts` | [internal] sundial trigger — fires on new human_input or timeout |
```

Add one line under the top-level command list at the start of the architecture section: mention `outreach ask-human` alongside `health`, `context`, `reply-check`.

## New CLI command spec

```
outreach ask-human \
  --campaign-id <id>                 # required
  --question <text>                  # required
  [--contact-id <id>]                # optional; contact-scoped question
  [--context <text>]                 # optional; extra framing for observer & agent
```

**Validation:**

- `--campaign-id` required; campaign JSONL need not exist (create is allowed).
- `--question` required, non-empty.
- If `--contact-id` provided, `readContact` is called for validation only; a missing contact does not hard-fail (emits a warn line to stderr). Rationale: consistent with `callback-dispatch`'s tolerance for missing contacts (`src/commands/callbackDispatch.ts:137`).
- If `watch.enabled` is false → exit INPUT_ERROR with message "ask-human requires watch.enabled=true". Rationale: the command's value is the scheduled resume; without the watcher it's just a log line.
- If `watch.callback_prompt_human_input` or `watch.callback_prompt_human_input_timeout` is missing → exit INFRA_ERROR. Both must be configured before this command works.

**Success output** (stdout JSON):
```json
{
  "campaign_id": "2026-04-15-dental",
  "contact_id": "c_a1b2c3",
  "question_ts": "2026-04-18T16:00:00.000Z",
  "watch": {"schedule_id": "…", "status": "active"}
}
```

**Exit codes:** 0 success, 1 input error, 2 infra error. No OPERATION_FAILED path — all side effects are local JSONL + sundial add.

## New event type spec

**`human_question`** — agent-authored, appended by `outreach ask-human`:

```json
{
  "ts": "2026-04-18T16:00:00.000Z",
  "type": "human_question",
  "campaign_id": "2026-04-15-dental",
  "contact_id": "c_a1b2c3",
  "question": "Should I prioritize same-week availability or lowest price?",
  "context": "Two viable options with tradeoffs"
}
```

- `ts`, `type`, `campaign_id`, `question` are required.
- `contact_id`, `context` are optional — omit when campaign-level.
- No `channel` field — this event IS the question, not tied to a reply channel.
- Immutable once written (campaign JSONL is append-only).

Backwards compat: unknown event types are already tolerated by `readCampaignEvents` / the reducer helpers (they filter by `type ===`), so adding this is additive.

## Config schema changes

`outreach.config.yaml` `watch:` block gains two optional string fields:

```yaml
watch:
  # existing fields...
  callback_prompt_human_input: "..."          # new
  callback_prompt_human_input_timeout: "..."  # new
```

Both must be non-empty strings *if ask-human is used*. If absent, ask-human fails with INFRA_ERROR and an explanatory message pointing to `outreach.config.example.yaml`. `appConfig.ts` does not hard-fail on absence at load time.

## Relay config updates

Covered in the File-by-file list above. Single-line tier map addition; no other relay side changes.

## Skill doc updates

Covered in the File-by-file list above. Framing: the agent never learns "relay" or "Telegram" — it learns "ask-human writes a question, some observer will answer via any channel, your session resumes automatically."

## Verification plan

Manual roundtrip, prerequisites: watch enabled, Telegram relay wired per #67 verification stage 2+, test campaign exists.

**Step 1 — happy path (reply arrives).**
1. `outreach ask-human --campaign-id test-campaign --question "Test question?"` — expect JSON with watch.status=active.
2. `jq` the campaign JSONL → verify `human_question` line present.
3. `sundial list` → verify schedule `outreach-test-campaign-ask-human` exists.
4. In Telegram forum topic, observe the question appears at notify tier (relay mirrors it).
5. Reply in Telegram: "option B".
6. Relay appends `human_input` to campaign JSONL within seconds.
7. Wait one poll cycle (`poll_interval_minutes`). Observe `ask-human-check` exit 0 in sundial logs.
8. Observe `callback-dispatch` spawn a Claude session; session reads JSONL, sees question + answer, writes a follow-up `outcome` or `decision`.
9. Verify `callback_run` event in JSONL with `channel: "human_input"`, `resumed_reason: "human_input"`.

**Step 2 — timeout path.**
1. Temporarily set `default_timeout_hours: 0.05` (3 min) in config.
2. `outreach ask-human --campaign-id test-campaign --question "Test timeout?"`.
3. Do not reply.
4. Wait 3 min + one poll cycle. Observe callback fires with `resumed_reason: "timeout"`.
5. Verify agent runs the timeout prompt, writes appropriate amendment/decision.
6. Restore `default_timeout_hours`.

**Step 3 — concurrent asks.**
1. `outreach ask-human ... --question "Q1"`.
2. Wait 10s.
3. `outreach ask-human ... --question "Q2"`.
4. `sundial list` → verify still only one schedule (refreshed, not duplicated).
5. Reply once in Telegram: "answer".
6. Verify callback fires once; agent reads JSONL and sees *both* Q1 and Q2 outstanding plus one `human_input`. Agent's job to pair or acknowledge both.

**Step 4 — campaign-scoped (no contact_id).**
1. `outreach ask-human --campaign-id test-campaign --question "Campaign-level Q"` (no `--contact-id`).
2. Verify JSONL `human_question` has no `contact_id` field.
3. Verify schedule created, trigger fires on any human_input in the campaign regardless of contact.
4. Verify `callback_run` event logged with `contact_id: null`.

**Step 5 — resume chain.**
1. Run Step 1 twice in a row with different questions/replies.
2. Verify the second callback-dispatch resumes the session from the first's `callback_run.new_session_id` via `findLatestHumanInputCallbackRun`.

## Non-goals

- No new channel primitive (calls/sms/email); ask-human is an agent-control primitive.
- No CLI for *listing* outstanding `human_question` entries (agent reads the JSONL).
- No automatic linking between `human_question` and the matching `human_input` reply (agent handles pairing in-prompt).
- No per-question sundial schedules — one shared schedule per campaign, as specified above.
- No rich observer UX (relay mirrors the raw `human_question` line per its normal tier policy; no special formatting).
- No `outreach health` check for "ask-human readiness" beyond the existing watch-enabled check.

## Deferred work

- **Per-contact scoping of the watch.** Today all asks on a campaign share one schedule regardless of contact. If a future use case needs per-contact watch (e.g., question-about-c_a fires only on reply-from-c_a), split the schedule name. Low priority — agents can filter on resume.
- **Concurrent-ask pairing.** If the campaign has multiple outstanding questions and only one reply arrives, the agent is expected to pair them manually. A future `--reply-to-question-ts` flag on `human_input` could make the pairing explicit; not now.
- **`human_question` resolution tracking.** No explicit "answered" status on a `human_question`; the agent reasons about it each time. A future `human_question_resolved` event could close the loop for observability.
- **Escalation** (team-lead option 1c). If timeout fires and still no signal, re-pinging with higher urgency is an agent-policy decision, not a CLI primitive. Defer.
