# Config relocation + `outreach setup`

Relocate `outreach.config.yaml` out of the CLI source tree into the data repo, introduce a shared `.agents/workspace.yaml` marker for the outreach/sundial/relay stack, and add an `outreach setup` command that scaffolds the repo and validates the full stack is ready.

Tracks GitHub issue #72.

## Why

Today `loadAppConfig()` reads `<cli-install-dir>/../outreach.config.yaml`. The orchestrator lives in the data repo and shouldn't have to reach back into the CLI source tree to edit config, and it blocks shipping the CLI as an installable package (identity YAML would end up inside `node_modules`).

## End state

- `<data_repo>/outreach/config.yaml` — the real config. Mirrors the existing `outreach/{campaigns,contacts,transcripts}/` namespace.
- `<cli-repo>/outreach.config.dev.yaml` — dev-local escape hatch. Has `data_repo_path` (the only self-reference that makes sense in a dev pointer). Gitignored. Ship `.example` template.
- `<data_repo>/.agents/workspace.yaml` — shared marker across tools. Walk-up target used to find the data repo when neither env var nor dev config is present.
  ```yaml
  version: 1
  tools:
    outreach:
      version: 2.2.0
  ```

## Resolution order (`resolveDataRepo()`)

Same helper used by the CLI loader and the build-time skills sync:

1. `OUTREACH_DATA_REPO` env var — highest priority; escape hatch for CI and ad-hoc invocations.
2. `outreach.config.dev.yaml` next to the CLI binary — dev mode is sticky (wins regardless of cwd).
3. Walk up from `cwd` looking for `.agents/workspace.yaml`. That parent is the data repo.
4. Error with remediation pointing at `outreach setup` and `OUTREACH_DATA_REPO`.

**Why dev beats walk-up**: a developer who `cd`'d into a real data repo to poke around would otherwise silently invoke their dev binary against prod data. Env var is the explicit override when you want that.

## `outreach setup`

```
outreach setup [--data-repo <path>] [--skip-stack-check]
```

1. Resolve `data_repo` (flag > env > `.dev.yaml` > walk-up).
2. Create `.agents/workspace.yaml` if missing; upsert `tools.outreach.version` to match `package.json`.
3. Scaffold `outreach/{config.yaml (from template),campaigns,contacts,transcripts}` if missing.
4. Sync skills into `<data_repo>/.agents/skills/outreach/`.
5. Stack readiness (unless `--skip-stack-check`):
   - `which sundial`, `which relay`.
   - `workspace.yaml` has `tools.sundial`.
   - sundial daemon health ping, relay daemon health ping.
6. Print `PASS` or numbered remediation list.

Idempotent on the marker; composes cleanly with a future `sundial setup`.

## Work split

**Foundation (orchestrator):**
- This plan doc.
- `src/dataRepo.ts` with `resolveDataRepo()` and `locateDevConfig()`.
- Rename `outreach.config.yaml` → `outreach.config.dev.yaml` and `outreach.config.example.yaml` → `outreach.config.dev.yaml.example`. Verify `.gitignore`.

**Agent A — Wiring:**
- Refactor `src/appConfig.ts` to load `<dataRepo>/outreach/config.yaml` using `resolveDataRepo()`, with `.dev.yaml` fallback reading `data_repo_path` from the dev file itself. Expose resolved config path.
- Refactor `scripts/sync-skills.js` to import `resolveDataRepo` from `dist/`.
- Update `outreach health` `data_repo` block to include `config_path`.
- Actionable error messages naming `outreach setup` + `OUTREACH_DATA_REPO`.

**Agent B — Setup command:**
- `src/commands/setup.ts` + registration in `src/cli.ts`.
- Workspace marker read/write helpers (inline; no need for a separate module yet).
- Scaffold + skills sync (reuse the logic path from `scripts/sync-skills.js` as needed).
- Stack readiness: subprocess calls + HTTP health pings (sundial and relay port conventions documented in their repos).

**Agent C — Docs:**
- `CLAUDE.md` config + key files sections.
- `skills/outreach/SKILL.md` — env var override, data repo layout, daemon lifecycle.
- `README.md` — three-tool onboarding section (outreach setup / sundial setup / daemons).

## Out of scope

- `.env` layering — stays dev-only.
- Relay verb rename (`relay init` → `relay daemon`).
- Sundial side — tracked in fyang0507/sundial.
