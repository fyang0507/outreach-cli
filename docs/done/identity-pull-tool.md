# Identity pull tool for callback agents (#54)

## Summary

Give headless callback agents (SMS/email reply handlers, ask-human resumes) access to user identity — but via a **tool-gated pull** rather than prompt injection. The user curates a flat structured map under `identity` in config; the agent reads it on demand through a new `outreach whoami` command. Every field retrieval is an explicit CLI call with an audit trail, and the agent only pulls what the current task requires.

Two design principles the user committed to:

1. **The config file itself is the gate.** Anything the user writes under `identity` is by definition "comfortable to share with agents the CLI spawns." Nothing tiered, labelled, or policy-scoped — the act of adding the key is the consent.
2. **Comfort ≠ passive injection.** The agent must ask per field, per invocation. No wholesale dump into the system instruction.

**Single source of truth.** `identity` is one flat map. No parallel `bio`/`profile` split. The voice agent assembles its system instruction *from* this map at call start (formatted into a labelled block); headless agents query the *same* map via `whoami`. Two readers, one schema — adding a field makes it discoverable by both paths automatically. Voice keeps the push model (latency) but reads the same structured fields the text agents pull from.

## Design decisions (locked)

1. **Flat `identity` map, no nesting.** One namespace for user identity. `user_name` stays required and reserved (push-injected into voice and callback prompts as today). Every other key is freeform string, user-curated, and pull-only. An optional `other` key is a free-text catch-all for context that doesn't fit a specific field.
2. **One source of truth — voice formats from the same map.** The voice agent's system instruction is rebuilt at call start from `identity` (markdown-list block under "About ${userName}:"). No separate `bio` field. Adding a key to `identity` automatically lets both voice (push, formatted at call start) and text agents (pull, via `whoami`) use it. Voice stays push for latency reasons; the mechanism below the surface is unified.
3. **One new top-level command: `outreach whoami`.** No subgroup. Identity is user-level metadata, channel-agnostic. Same tier as `health`, `context`, `reply-check`, `ask-human`.
4. **`{user_name}` is the one push exception for callback prompts.** Injected into the callback prompt template by default. It's the minimum viable identity (the agent can't introduce itself without it), zero-sensitivity, and matches voice's existing behavior. Everything else is pull.
5. **Comma-separated `--field` with a reflection threshold.** One flag, one list: `outreach whoami --field first_name,address,email_signature`. Repeating the flag (`--field a --field b`) is rejected with a clear error pointing to comma-separated syntax — avoids Commander v14's "last wins" silent overwrite. If the request covers **>80% of pullable fields** (and the agent asked for ≥3), the CLI refuses and exits with an `excessive_pull` error telling the agent to reflect on whether it actually needs that breadth. The agent can re-run with `--force` to bypass. This is a nudge, not a ceiling — the whole point is to make wholesale pulls a deliberate act rather than a reflex. The `≥3` floor prevents noise when the identity map is tiny (asking for the only 1–2 fields that exist isn't "excessive"). **`user_name` is excluded from the denominator** — it's already push-injected into the callback prompt, so counting it would inflate "available" and make `--field everything-else` routinely trip 100%. Field names must not contain commas — trivial constraint for snake_case identifier keys.
6. **No per-field sensitivity tags, no approval flow, no encryption.** The user's framing rejects gradient privacy — either a field is in config (shareable) or it isn't. Per-call approval is incompatible with headless callback agents (no human in the loop by definition).
7. **Audit is campaign-scoped — default callback path passes `--campaign-id`.** When the agent passes `--campaign-id`, `whoami` appends an `identity_access` event to the campaign JSONL. The default `callback_prompt` tells the agent to include `--campaign-id {campaign_id}` on every `whoami` call, so callback-driven pulls are always audited. Ad-hoc invocations from outside a campaign (operator debugging, `--once`-style use) are transient (exit code + stdout only). No new JSONL file introduced. Audit events record `forced: true` when the threshold was bypassed, so the reflection-skip is discoverable in the log. The honest framing in `SKILL.md`: audit is *campaign-observable*, not a background security control — agents are expected to opt in by passing `--campaign-id`.
8. **"Pulled" means audited, not protected.** Once a field value lands in the agent's context window, it can echo into an SMS draft, log file, or future tool call. The gate is "did the agent have reason to ask," not exfiltration resistance. Document this honestly in the agent skill doc — this is acceptable for a single-user CLI where the user wrote the config themselves.

## Config shape change

**`src/appConfig.ts` — `IdentityConfig`:**

```ts
// Sealed interface — no index signature leaking into the rest of the codebase.
// Freeform user keys land in `extraFields`, populated at load time from the
// parsed YAML after stripping `user_name` and nulls.
export interface IdentityConfig {
  user_name: string;
  extraFields: Record<string, string>;
}
```

Validation + load shape:
- `user_name` required, must be a non-empty string.
- Every other top-level key under `identity` in the YAML must be a string, `null`, or absent. Non-string, non-null values reject at load time with a fail-fast error naming the offending key.
- No nested objects anywhere under `identity`. Flat map only. Nesting rejects at load.
- At load time: parse `identity`, pluck `user_name`, walk remaining keys, drop any with `null`/empty-string values, coerce the rest into `extraFields`. Downstream code (`whoami`, voice system instruction) reads exclusively from `extraFields` + `user_name`; they never probe for arbitrary unknown keys on the config object. This keeps TS strict and makes "what's available" a single well-defined source.
- Keys are free-form (user picks them). No enforced schema — document recommended keys in `SKILL.md`.
- `bio` under `identity` is a removed key. If present in a loaded config, reject with a migration hint: *"`identity.bio` is no longer supported. Split structured fields out as top-level keys under `identity` (first_name, legal_name, address, phone, email), and put any free-text remainder under `identity.other`."*

**`outreach.config.example.yaml`:**

```yaml
identity:
  # Required — reserved, always injected into voice and callback prompts as {user_name}.
  user_name: "Your Name"

  # Everything below is optional and pull-only. Agents read these via
  # `outreach whoami --field <key>,<key>`; the voice agent formats them into
  # its system instruction at call start. Anything you put here is deemed
  # shareable with agents the CLI spawns — the gate is the config file itself,
  # not per-field labels.
  #
  # Suggested keys (add only what you're comfortable sharing):
  first_name: null         # natural sign-off in SMS ("— Fred")
  full_name: null          # formal email closings
  legal_name: null         # forms, identity verification
  address: null            # "where are you based?" / postal
  phone: null              # call-back number to share
  email: null              # contact email to share
  email_signature: null    # multi-line block for outbound emails (use YAML '|' for multiline)
  # other: null            # free-text catch-all for context that doesn't fit a specific key
```

The current `outreach.config.yaml` has a `bio` containing legal name / address / phone / email. **The user migrates manually** (plan doesn't mutate live config): split the `bio` string into structured keys (`legal_name`, `address`, `phone`, `email`) and delete the `bio` field. Anything that genuinely doesn't fit a key goes under `other`.

## New command: `outreach whoami`

**File:** `src/commands/whoami.ts` (new).

**Flags:**

| Flag | Use | Notes |
|---|---|---|
| `--list` | Enumerate available keys | Returns `{ fields: [...] }`, no values. Always includes `"user_name"`, plus every non-null `identity.*` key. Schema only — zero leakage. |
| `--field <a,b,c>` | Retrieve one or more field values | Comma-separated list, one flag. Mutually exclusive with `--list`. Returns `{ fields: { name: value, ... } }`. Unknown keys produce an error (exit `1`) naming all unknown keys at once. Subject to the reflection threshold (see below). |
| `--force` | Bypass the reflection threshold | Only meaningful with `--field`. Re-run after an `excessive_pull` refusal. Recorded in the audit event as `forced: true`. |
| *(no flag)* | Default — return user_name | Equivalent to `--field user_name`. The most common agent question is "who am I representing?" — answer it in one call. |
| `--campaign-id <id>` | Optional audit context | When present, append `identity_access` event to the campaign JSONL. |

Parsing: Commander custom parser `(v) => v.split(',').map(s => s.trim()).filter(Boolean)`. Whitespace around commas is tolerated (`--field "a, b, c"` works). Empty result after parsing (e.g. `--field ,,`) rejects with an input error. Duplicate `--field` flags (`--field a --field b`) reject with a clear error pointing at comma-separated syntax — do not silently last-wins-overwrite, which is Commander v14's default for non-variadic string options.

**Read-time null filter.** `--list` returns keys from the already-load-filtered `extraFields` plus `user_name`. There's no runtime re-scan for nulls — the config loader strips them once; everything downstream trusts that shape. This matters because `loadAppConfig` caches the parsed object, and re-filtering on every `whoami` call would be pointless work against an already-clean map.

**Reflection threshold.** Computed against `extraFields.size` — i.e. every pullable identity key excluding `user_name`. The refusal fires when **both**:

- `requested / extraFields.size > 0.80` (strict, not ≥; `user_name` in the request isn't counted either — it's not in `extraFields`), AND
- `requested >= 3` (suppresses noise when the identity map is tiny).

Formula is simple enough to state in one `SKILL.md` line. Agents hitting the refusal have three responses: drop unused fields and retry, restart with `--list` to re-check what's actually needed, or pass `--force` if they've genuinely thought through it.

**Output shapes:**

```json
// outreach whoami
{ "user_name": "Fred" }

// outreach whoami --list
// (user_name first, then extraFields keys; extraFields omits any null-valued keys in the YAML)
{ "fields": ["user_name", "first_name", "email_signature", "address", "phone", "legal_name"] }

// outreach whoami --field first_name
{ "fields": { "first_name": "Fred" } }

// outreach whoami --field first_name,email_signature --campaign-id 2026-04-15-dental
{ "fields": { "first_name": "Fred", "email_signature": "— Fred\nOutreach CLI" }, "audited": true }

// outreach whoami --field first_name,address,phone,email_signature,legal_name
// (extraFields has 5 keys — user_name excluded from denominator; requested 5 → 100%)
// stderr: {
//   "error": "excessive_pull",
//   "message": "Requested 5 of 5 pullable identity fields (100%). Reflect on whether the immediate task actually needs all of these — each value you pull lands in your context and risks echoing into later drafts. Prefer fetching just what you'll use in the next reply. If you've thought it through and genuinely need all of them, re-run the same command with --force.",
//   "requested": 5,
//   "available": 5
// }
// exit 1 (INPUT_ERROR)

// outreach whoami --field ... --force
// returns normally, audit event records forced: true

// outreach whoami --field unknown,another_unknown
// stderr: { "error": "not_found", "message": "Unknown identity fields: unknown, another_unknown. Run `outreach whoami --list` to see available keys." }
// exit 1 (INPUT_ERROR)
```

The error checks resolve in order: unknown-field check first (keeps the refusal honest — a typo-laden over-pull should say "typo," not "reflect"), then the threshold. On any error, no data is returned — the agent must retry.

**Lookup:** single flat namespace. `identity[<name>]` for any requested name; `null`/missing keys are treated as "not available" (404-style error). `user_name` is queryable like any other key even though it's also push-injected elsewhere.

**Audit event shape (when `--campaign-id` passed):**

```json
{"ts":"2026-04-19T14:00:00Z","type":"identity_access","fields":["first_name","email_signature"],"forced":false,"contact_id":null}
```

Always record the list of fields (not individual events per field) — one invocation = one audit line. `forced` is `true` only when the `--force` flag bypassed the threshold; otherwise `false`. Use `contact_id: null` by default; do not accept `--contact-id` in this PR. Adds a flag without a clear use case today. Can be threaded later if needed.

## Voice agent — system instruction assembly

**`src/audio/systemInstruction.ts` — Layer 2 (identity block)** rewrites to read from the already-filtered `extraFields` map (no ad-hoc null checks in this file). Current code:

```ts
let identityBlock = `## Identity\nYou are an AI phone assistant calling on behalf of ${userName}. ...`;
if (params.identity.bio) {
  identityBlock += `\nAbout ${userName}: ${params.identity.bio}`;
}
```

New code (conceptual):

```ts
let identityBlock = `## Identity\nYou are an AI phone assistant calling on behalf of ${userName}. Always identify yourself as '${userName}'s assistant' when asked. Never pretend to be human.`;

// extraFields is already null-filtered at config load; iterate directly.
// The "other" key, if present, is pulled out and rendered as a free-text
// paragraph — it's the designated prose-escape for context that doesn't
// map to a specific key.
const { other, ...rest } = params.identity.extraFields;
const listItems = Object.entries(rest).map(([k, v]) => `- ${humanizeKey(k)}: ${v}`);

if (listItems.length > 0) {
  identityBlock += `\n\nAbout ${userName}:\n${listItems.join("\n")}`;
}
if (other) {
  identityBlock += `\n\nAdditional context about ${userName}: ${other}`;
}
```

**`humanizeKey` — exact transform:** split on `_`, capitalize the first resulting word, lowercase the rest. No acronym handling, no index-suffix logic, no cleverness. `email_signature → "Email signature"`, `home_address_2 → "Home address 2"`, `ssn_last_4 → "Ssn last 4"`. If a user wants nicer rendering they pick nicer keys. One line, no bikeshed.

Rationale for the markdown-list format: the LLM parses labelled key-value pairs more reliably than a comma-jumbled prose blob, and the list survives a user adding new keys without prompt engineering. Multi-line values (e.g. an `email_signature` written with YAML `|`) render inline — acceptable; the LLM handles embedded newlines. `other` exists precisely for the users who want to write prose alongside structured fields ("I'm a homeowner on Montross Ave who prefers evening calls"); it's not a hidden escape but a documented one.

No other voice-agent changes. `SystemInstructionParams.identity` typing narrows to the new sealed `IdentityConfig`.

## Callback prompt template changes

**`outreach.config.yaml` / `outreach.config.example.yaml`:**

Add two template variables to the vocabulary resolved in `src/commands/callbackDispatch.ts :: resolvePrompt`:

- `{user_name}` — from `config.identity.user_name`.
- `{identity_hint}` — a **full sentence** that varies based on whether any pullable fields exist. Resolved at dispatch time so the agent sees the schema in its first prompt and can skip `whoami --list` entirely — one fewer Node process invocation per callback, and a cleaner audit line (single `--field` call instead of `--list` then `--field`). Rendering a full sentence (not a raw list interpolated into a sentence) avoids the empty-state trap where "Available fields: ." reads broken and wastes tokens telling the agent to pull nothing.

`{identity_hint}` rendering (in `resolvePrompt`):

```ts
const keys = Object.keys(identityFields);              // identityFields === extraFields
const identityHint = keys.length > 0
  ? `Available identity fields you can pull for richer context: ${keys.join(", ")}. When you need one, call \`outreach whoami --field <name> --campaign-id ${campaignId}\` — pull only what the next reply requires.`
  : `No extra identity fields are configured; fall back to \`outreach ask-human\` if you need more context beyond the user's name.`;
```

Update the three example prompts:

- `callback_prompt` (rewrite):
  > "Reply detected from {contact_name} on {channel} for campaign {campaign_id} (you are acting on behalf of {user_name}). You are running headless with no human in the loop — do NOT ask for confirmation, just act. Read the conversation, then take the appropriate next action. {identity_hint} Run: outreach {channel} history --contact-id {contact_id}"

- `callback_prompt_human_input` and `callback_prompt_human_input_timeout`: add the `{user_name}` interpolation and the same `{identity_hint}` at the end.

`resolvePrompt()` change (`src/commands/callbackDispatch.ts` L41-47): add `userName` and `identityFields` params (latter is `Record<string, string>` — the full `extraFields` map, keys used to build `identity_hint`). Wire them in at the call site (L195-201) from `config.identity.user_name` and `config.identity.extraFields`.

## Skills doc updates

Source of truth is `skills/outreach/` — `npm run build` syncs to the agent workspace.

**`skills/outreach/SKILL.md`** — new section in Part 2 — CLI reference, placed after `outreach context` and before `outreach ask-human`:

> ## `outreach whoami`
>
> Retrieve user identity fields on demand. Use this when composing a reply or answer that needs to reference the user naturally — name, signature, address, phone — rather than assuming a default or asking the operator.
>
> ```bash
> outreach whoami                                                 # → { "user_name": "Fred" }
> outreach whoami --list                                          # → { "fields": [...] }   (keys only)
> outreach whoami --field first_name                              # → { "fields": { "first_name": "..." } }
> outreach whoami --field first_name,email_signature              # comma-separated for multiple
> outreach whoami --field ... --campaign-id X                     # records audit event
> ```
>
> **When to pull.** Pull only what the immediate reply requires. A short SMS ack usually needs nothing beyond `{user_name}` (already in your prompt). A formal email closing may warrant `email_signature`. A "where are you based?" question warrants `address`. Do not pull fields "just in case" — each pull puts the value in your context and risks it echoing into later drafts.
>
> **Reflection threshold.** `--field` accepts a comma-separated list. If your request covers **more than 80%** of pullable fields (`user_name` excluded from the count on both sides) and you asked for at least 3, the CLI refuses with `excessive_pull` and exits non-zero. Treat the refusal as a prompt to reconsider: drop what you won't actually reference in the next reply. If you've thought it through and genuinely need the breadth, re-run with `--force`. The `--force` use is recorded in the audit event — it's not hidden.
>
> **What's not in `--list`.** Keys the operator chose not to share. If a reply genuinely requires info that isn't available, fall back to `outreach ask-human` rather than guessing.
>
> **Privacy model.** Fields in `--list` are deemed shareable with agents by the operator (they put them there). Pass `--campaign-id` when you're acting inside a campaign (the default callback prompt does this) so the pull is observable in the campaign log; without it, the call is transient and leaves no audit trace. The tool surfaces what was pulled, not isolation — once a value is in your context it may be referenced anywhere. Stay minimal.

**`skills/outreach/sms.md` / `email.md`** — under reply-composition guidance, add a one-liner:

> When signing off or referencing the user, use `outreach whoami --field <name>` (e.g. `first_name`, `email_signature`). See `SKILL.md § outreach whoami`.

**`skills/outreach/call.md`** — no change. Voice agent does not call `whoami`.

## Files touched

| Path | Change |
|---|---|
| `src/commands/whoami.ts` | **new** — command implementation |
| `src/cli.ts` | register `whoami` alongside other top-level commands (L31-36 block) |
| `src/appConfig.ts` | rewrite `IdentityConfig` to a flat map (required `user_name`, index signature for freeform keys); remove `bio`; validate (non-string values reject, nested objects reject, empty `user_name` rejects) |
| `src/audio/systemInstruction.ts` | rewrite Layer 2 identity block to format flat `identity` map into a markdown list; special-case `other` as trailing free-text paragraph; add `humanizeKey` helper |
| `src/commands/callbackDispatch.ts` | extend `resolvePrompt` with `{user_name}`; thread `config.identity.user_name` through call site |
| `src/logs/sessionLog.ts` | no change — `appendCampaignEvent` already accepts arbitrary JSON objects |
| `outreach.config.example.yaml` | replace `bio` with flat identity key suggestions; update the three `callback_prompt*` examples to include `{user_name}` and the whoami hint |
| `relay.config.example.yaml` | add `identity_access: silent` under `tiers` — the pull is a procedural audit record, reviewable in the forum topic but not notification-worthy (same tier as `attempt`, `watch`, `callback_run`). Forcing a phone buzz per field pull would train the operator to mute, defeating the audit. A forced-bypass (`forced: true`) still shows up in the same topic for post-hoc review — if forced pulls warrant elevated attention later, promote them via a separate event type, not by up-tiering `identity_access` wholesale. |
| `skills/outreach/SKILL.md` | new `outreach whoami` reference section in Part 2 |
| `skills/outreach/sms.md` | one-liner in reply-composition guidance |
| `skills/outreach/email.md` | same |

No changes to: daemon, providers, contacts, runtime, health, context, reply-check, ask-human, ask-human-check, call commands, calendar commands.

**User-owned file (not in the PR):** `outreach.config.yaml`. User migrates their own `bio` blob into flat structured keys (and `other` for any prose remainder).

## Risks and edge cases

1. **Agent doesn't know to call `whoami`.** The `SKILL.md` doc is the only teacher. If the agent composes a reply signing off as "Assistant" because it never pulled `first_name`, the outreach quality regresses. Mitigation: explicit one-liner in `sms.md` / `email.md` reply-composition sections plus the hint in the callback prompt itself. Watch in live testing; escalate to always-injecting `{user_name}` + `{first_name}` if agents consistently miss it.
2. **Agent over-pulls "to be safe."** The >80% reflection threshold is the primary mitigation — a wholesale pull gets refused on the first attempt, and the agent must either narrow or pass `--force`. Partial over-pulling (e.g. requesting 3 of 6 fields when 1 would do) is *not* caught by the threshold; only the `SKILL.md` "pull only what the immediate reply requires" guidance and periodic callback-log review catch that. Acceptable gap — the threshold handles the obvious failure mode, finer tuning is a v2 concern.
3. **Key naming drift.** User writes `firstName`, agent expects `first_name`. Mitigation: `whoami --list` is the discovery mechanism — agent reads what exists, doesn't guess. Document recommended snake_case keys in `SKILL.md` but don't enforce.
4. **Empty identity.** User fills in only `user_name`. `whoami --list` returns `["user_name"]`. Agents fall back to `ask-human` for richer context. Acceptable — the user explicitly chose not to share. Voice agent's "About ${userName}:" block is omitted when there are no other fields.
5. **Callback prompt variable migration.** Adding `{user_name}` to the example prompts means users who migrated to `outreach.config.yaml` before this PR still work (unknown vars interpolate as empty string today via `String.prototype.replace`). No breaking change, but new users need to know `{user_name}` exists — covered by updated example.
6. **Audit log pollution.** If an agent calls `whoami` ten times per callback, the campaign JSONL gets chatty. Mitigation: `--campaign-id` is optional; the SKILL doc doesn't tell the agent to pass it. Only the CLI owner (future feature) would surface it intentionally. For v1, agents won't pass `--campaign-id` by default — audit remains opt-in.
7. **Latency.** Each `whoami` call is a full Node process (~200-400ms). Fine for SMS/email callbacks (async, human-scale response times). Would be unacceptable for voice — voice stays push, by design.
8. **Value rendering in templates.** Multi-line values (e.g. `email_signature`) are returned as-is in JSON (`\n`-escaped). Agent's reply-composition tool (email send body) must accept multi-line strings — already does. Voice agent renders them inline in the markdown list — the LLM handles embedded newlines fine.
9. **`bio` removal is a breaking config change.** Users who have `identity.bio` in their live `outreach.config.yaml` need to migrate before this merges. Add a validation error naming the removed key with a one-line migration hint ("split into structured fields under `identity`, or move prose into `identity.other`"). Fail fast at startup rather than silently dropping the value.
10. **Voice prompt length growth.** A flat identity map with many keys produces a longer system instruction than the old free-text `bio`. Gemini Live's context window handles this fine, but an identity map with 15+ fields would bloat every call's instruction. Acceptable — the user self-limits by deciding what to add.
11. **`{identity_hint}` staleness during a long callback.** The hint is resolved at dispatch time. A callback agent may run for minutes; if the user edits `outreach.config.yaml` mid-flight and renames a key, the agent's `--field` call with the old key hits `not_found`. Survivable — the error message points at `--list` for re-discovery — but the agent pays one extra Node process invocation to resync. Not a blocker; just means the optimization of skipping `--list` assumes config stability across a single callback invocation, which is nearly always true.
12. **"Promotion recipe" cost for future reserved keys.** Adding another top-level reserved identity field (e.g. `display_name`, `pronouns`) requires widening `IdentityConfig`, a loader pluck, a `systemInstruction` render tweak, and a `resolvePrompt` wiring. Four sites. The seal is worth its cost (strict TS, no leaky index signature), but leave a one-line comment near `extraFields` in `appConfig.ts` listing these four sites so the next person promoting a field sees the recipe.

## Non-goals

- No per-field sensitivity labels, redaction proxies, or egress checks (Presidio-style). Rejected as over-engineered for single-user CLI per the user's framing.
- No approval flow (user confirms each pull). Incompatible with headless callback — the point of the callback is no human in the loop.
- No switch to pull for the voice agent. Latency budget forbids it; voice session is user-initiated and scoped.
- No variable threshold per field type, no per-channel tuning. One rule (>80% + ≥3 minimum), applied uniformly.
- No `whoami` output shaped for human display. Agent-native JSON only, same convention as the rest of the CLI.
- No encryption of profile values at rest in `outreach.config.yaml`. The user already accepts that their config file on disk is their threat surface.
- No `--contact-id` on `whoami`. Can be added later if a clear use case appears.

## Acceptance checks

Manual verification before merge:

```bash
# Build + wire
npm run build

# Basic reads
outreach whoami                                                 # → {"user_name":"Fred"}
outreach whoami --list                                          # → {"fields":["user_name", ...]}
outreach whoami --field first_name                              # → {"fields":{"first_name":"Fred"}}
outreach whoami --field first_name,email_signature              # comma-separated multi-field

# Unknown field fails cleanly (lists all unknown keys)
outreach whoami --field unknown,another                         # exit 1, message names both

# Mutual exclusion + duplicate-flag rejection
outreach whoami --list --field first_name                       # exit 1, clear error
outreach whoami --field first_name --field address              # exit 1, "use comma-separated"

# Reflection threshold — denominator is extraFields.size (user_name excluded)
# Set identity to user_name + 5 extra keys (a,b,c,d,e,f). extraFields.size = 5.
outreach whoami --field a,b,c,d                                 # 4/5 = 80% → exactly-80, NOT triggered
outreach whoami --field a,b,c,d,e                               # 5/5 = 100% → excessive_pull, exit 1
outreach whoami --field a,b,c,d,e --force                       # bypasses, exit 0

# user_name doesn't count toward requested OR available
outreach whoami --field user_name,a,b                           # 2/5 = 40% → allowed (user_name stripped from request count)

# Threshold floor — tiny identity should NOT trigger
# (set extraFields to 2 keys; request both)
outreach whoami --field a,b                                     # 2 requested, below 3-floor → allowed

# Config migration breakage surfaces at load
# (leave identity.bio in config) → `outreach health` exits non-zero with migration hint
# (set identity.nested: { foo: bar }) → rejects with "nested objects not allowed"
# (set identity.some_key: 42) → rejects with "value for 'some_key' must be a string"

# Voice agent system instruction renders flat map
# Place a call and inspect the generated system instruction (via daemon stderr or a logging hook);
# "About Fred:" section should contain a markdown list of every non-null extraFields key,
# and a trailing "Additional context..." paragraph if `identity.other` is set.

# Empty extraFields — callback prompt renders the fallback sentence
# (set identity to just { user_name }; trigger a watched reply callback)
# The spawned agent's prompt should contain the "No extra identity fields are configured..." sentence,
# NOT the "Available identity fields: ." broken-empty form.

# Mid-flight config rename — graceful degradation
# (trigger a callback; while it's running, rename a key in outreach.config.yaml;
#  have the agent call `outreach whoami --field <old_name>`) → not_found error naming `--list`

# Audit event written when --campaign-id present
outreach whoami --field first_name --campaign-id 2026-04-19-test
tail -n 1 "$DATA_REPO/outreach/campaigns/2026-04-19-test.jsonl" | jq .
# → identity_access event, fields: ["first_name"], forced: false

# Forced bypass recorded as forced: true in audit
outreach whoami --field a,b,c,d,e --force --campaign-id 2026-04-19-test
tail -n 1 "$DATA_REPO/outreach/campaigns/2026-04-19-test.jsonl" | jq .forced    # → true

# Config validation
# - Temporarily set identity.profile to a non-object (e.g. "foo") → outreach health fails at load
# - Temporarily set identity.profile.user_name to "X" → outreach health fails at load with reserved-key message

# Callback prompt resolution
# - Place a watched SMS send, trigger a reply, confirm the spawned agent's prompt contains the user_name and the whoami hint (check the callback log file)
```

Live-fire test: run the auto-watch test scenario with a reply that asks "who are you?" — confirm the callback agent calls `outreach whoami --list` (or `--field first_name`) and signs the reply naturally rather than with a placeholder.
