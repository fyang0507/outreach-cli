import { Command } from "commander";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveDataRepo, type ResolutionSource } from "../dataRepo.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../exitCodes.js";

type Resolution = ResolutionSource | "flag";

interface StackIssue {
  message: string;
  fix: string;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function cliRepoRoot(): string {
  // setup.ts lives at src/commands/setup.ts → dist/commands/setup.js.
  // In both layouts, the repo root is the grandparent of the file's dir.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..", "..");
}

function readCliVersion(): string {
  const pkgPath = join(cliRepoRoot(), "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
    throw new Error(`package.json at ${pkgPath} is missing a version string`);
  }
  return pkg.version;
}

function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: dir,
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

interface WorkspaceUpsertResult {
  status: "created" | "existing" | "updated";
  hasSundial: boolean;
  hasRelay: boolean;
}

/**
 * Read-modify-write <data_repo>/.agents/workspace.yaml. Preserves any existing
 * top-level keys and tools.* entries from other tools (sundial, relay, etc.).
 * Only touches tools.outreach.version.
 */
function upsertWorkspaceYaml(
  dataRepo: string,
  outreachVersion: string,
): WorkspaceUpsertResult {
  const agentsDir = join(dataRepo, ".agents");
  const workspacePath = join(agentsDir, "workspace.yaml");
  mkdirSync(agentsDir, { recursive: true });

  let existed = false;
  let doc: Record<string, unknown> = {};

  if (existsSync(workspacePath)) {
    existed = true;
    const raw = readFileSync(workspacePath, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }

  if (doc.version == null) {
    doc.version = 1;
  }

  let tools: Record<string, unknown>;
  if (
    doc.tools &&
    typeof doc.tools === "object" &&
    !Array.isArray(doc.tools)
  ) {
    tools = doc.tools as Record<string, unknown>;
  } else {
    tools = {};
    doc.tools = tools;
  }

  const priorOutreach = tools.outreach;
  let outreachEntry: Record<string, unknown>;
  if (
    priorOutreach &&
    typeof priorOutreach === "object" &&
    !Array.isArray(priorOutreach)
  ) {
    outreachEntry = priorOutreach as Record<string, unknown>;
  } else {
    outreachEntry = {};
  }
  const priorVersion = outreachEntry.version;
  outreachEntry.version = outreachVersion;
  tools.outreach = outreachEntry;

  const hasSundial =
    tools.sundial !== undefined &&
    tools.sundial !== null &&
    !(typeof tools.sundial === "object" &&
      tools.sundial !== null &&
      Array.isArray(tools.sundial) === false &&
      Object.keys(tools.sundial as Record<string, unknown>).length === 0);

  const hasRelay =
    tools.relay !== undefined &&
    tools.relay !== null &&
    !(typeof tools.relay === "object" &&
      tools.relay !== null &&
      Array.isArray(tools.relay) === false &&
      Object.keys(tools.relay as Record<string, unknown>).length === 0);

  const serialized = stringifyYaml(doc);
  writeFileSync(workspacePath, serialized, "utf-8");

  let status: "created" | "existing" | "updated";
  if (!existed) {
    status = "created";
  } else if (priorVersion === outreachVersion) {
    status = "existing";
  } else {
    status = "updated";
  }

  return { status, hasSundial, hasRelay };
}

/**
 * Scaffold outreach/config.yaml by copying the repo's dev example template and
 * stripping the DEV-ONLY BLOCK (which contains data_repo_path + its rationale).
 * Does not overwrite an existing config.yaml.
 */
function scaffoldConfig(dataRepo: string): "created" | "existing" {
  const configPath = join(dataRepo, "outreach", "config.yaml");
  if (existsSync(configPath)) {
    return "existing";
  }

  const templatePath = join(cliRepoRoot(), "outreach.config.dev.yaml.example");
  if (!existsSync(templatePath)) {
    throw new Error(
      `outreach.config.dev.yaml.example not found at ${templatePath}`,
    );
  }
  const template = readFileSync(templatePath, "utf-8");
  const lines = template.split("\n");
  const filtered: string[] = [];
  let inDevBlock = false;
  const DEV_START = /^#\s*-+\s*DEV-ONLY BLOCK\s*-+/;
  const DEV_END = /^#\s*-+\s*END DEV-ONLY BLOCK\s*-+/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inDevBlock && DEV_START.test(line)) {
      inDevBlock = true;
      continue;
    }
    if (inDevBlock) {
      if (DEV_END.test(line)) {
        inDevBlock = false;
        // Consume one trailing blank line for tidy spacing.
        if (lines[i + 1] === "") i += 1;
      }
      continue;
    }
    filtered.push(line);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, filtered.join("\n"), "utf-8");
  return "created";
}

function scaffoldDirs(dataRepo: string): string[] {
  const dirs = ["campaigns", "contacts", "transcripts"];
  for (const d of dirs) {
    mkdirSync(join(dataRepo, "outreach", d), { recursive: true });
  }
  return dirs;
}

function syncSkills(dataRepo: string): string {
  const src = join(cliRepoRoot(), "skills", "outreach");
  if (!existsSync(src)) {
    throw new Error(`skills/outreach/ not found at ${src}`);
  }
  const dest = join(dataRepo, ".agents", "skills", "outreach");
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  return dest;
}

function hasOnPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function toolHealthOk(cmd: string): boolean {
  try {
    execSync(`${cmd} health`, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function runStackCheck(
  hasSundialInWorkspace: boolean,
  hasRelayInWorkspace: boolean,
): StackIssue[] {
  const issues: StackIssue[] = [];

  // --- Binaries on PATH ---
  // Sundial is a hard dependency: the agent cannot function without it.
  const sundialOnPath = hasOnPath("sundial");
  if (!sundialOnPath) {
    issues.push({
      message: "sundial not found on PATH",
      fix: "install sundial: https://github.com/fyang0507/sundial#install",
    });
  }

  // Relay is a hard dependency: `outreach ask-human` writes `human_question`
  // events that relay delivers to Telegram, and relay writes the human reply
  // back as `human_input`. Without relay, ask-human just times out.
  const relayOnPath = hasOnPath("relay");
  if (!relayOnPath) {
    issues.push({
      message: "relay not found on PATH",
      fix: "install relay: https://github.com/fyang0507/relay#install",
    });
  }

  // --- Workspace registrations ---
  // Each companion tool has its own `<tool> setup` command that registers
  // `tools.<tool>` in .agents/workspace.yaml. Outreach does not run those —
  // the boundary is unidirectional and we only surface remediation text.
  if (!hasSundialInWorkspace) {
    issues.push({
      message: "workspace.yaml has no tools.sundial entry",
      fix: "run `sundial setup --data-repo <same path>` to register sundial against the same data repo",
    });
  }

  if (!hasRelayInWorkspace) {
    issues.push({
      message: "workspace.yaml has no tools.relay entry",
      fix: "run `relay setup --data-repo <same path>` to register relay against the same data repo",
    });
  }

  // --- Daemon health ---
  if (sundialOnPath && !toolHealthOk("sundial")) {
    issues.push({
      message: "sundial health check failed (daemon may be down)",
      fix: "start the sundial daemon (see sundial docs)",
    });
  }

  if (relayOnPath && !toolHealthOk("relay")) {
    issues.push({
      message: "relay daemon not responding",
      fix: "start relay (`relay init &`), then register: `relay add --config <your-relay-config>`",
    });
  }

  return issues;
}

/**
 * Resolve the data repo for setup:
 *   flag (highest) > OUTREACH_DATA_REPO env > outreach.config.dev.yaml > walk-up.
 * Cases 2-4 delegate to resolveDataRepo(); we only layer the flag on top.
 * Unlike the runtime loader, setup tolerates a non-existent path when the flag
 * is used — it will create the directory.
 */
function resolveForSetup(flagPath?: string): {
  path: string;
  resolution: Resolution;
} {
  if (flagPath && flagPath.trim() !== "") {
    return { path: expandHome(flagPath.trim()), resolution: "flag" };
  }
  const resolved = resolveDataRepo();
  return { path: resolved.path, resolution: resolved.source };
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Scaffold <data_repo>/outreach/, stamp .agents/workspace.yaml, sync skills, and verify the outreach/sundial/relay stack",
    )
    .option(
      "--data-repo <path>",
      "Target data repo path (creates the directory if it doesn't exist)",
    )
    .option("--skip-stack-check", "Skip the sundial/relay readiness check")
    .action(
      async (opts: { dataRepo?: string; skipStackCheck?: boolean }) => {
        let dataRepo: string;
        let resolution: Resolution;
        try {
          const r = resolveForSetup(opts.dataRepo);
          dataRepo = r.path;
          resolution = r.resolution;
        } catch (err) {
          outputError(INPUT_ERROR, (err as Error).message);
          process.exit(INPUT_ERROR);
          return;
        }

        // Create the repo dir when the flag is used against a path that
        // doesn't exist yet. For env/dev/walkup paths we expect the dir to
        // exist already (env/dev can be typos; walkup literally found the
        // marker so the dir is there).
        const createdRepoDir = !existsSync(dataRepo);
        if (createdRepoDir) {
          if (resolution !== "flag") {
            outputError(
              INPUT_ERROR,
              `Data repo path ${dataRepo} does not exist. Re-run with --data-repo <path> to create it.`,
            );
            process.exit(INPUT_ERROR);
            return;
          }
          mkdirSync(dataRepo, { recursive: true });
        }

        const warnings: string[] = [];
        if (!isGitRepo(dataRepo)) {
          warnings.push(
            `${dataRepo} is not a git repository — outreach data should be version-controlled. Run \`git init\` in that directory when you're ready.`,
          );
        }

        let outreachVersion: string;
        try {
          outreachVersion = readCliVersion();
        } catch (err) {
          outputError(INPUT_ERROR, (err as Error).message);
          process.exit(INPUT_ERROR);
          return;
        }

        const { status: workspaceStatus, hasSundial, hasRelay } =
          upsertWorkspaceYaml(dataRepo, outreachVersion);

        const configStatus = scaffoldConfig(dataRepo);
        const dirs = scaffoldDirs(dataRepo);
        const skillsPath = syncSkills(dataRepo);

        // Stack payload:
        //   "skipped" — --skip-stack-check was passed
        //   "ok"      — ran and nothing to report
        //   { ok: false, issues } — one or more hard failures; exits non-zero.
        let stack:
          | "skipped"
          | "ok"
          | {
              ok: false;
              issues: Array<Record<string, unknown>>;
            };
        let hasIssues = false;
        if (opts.skipStackCheck) {
          stack = "skipped";
        } else {
          const issues = runStackCheck(hasSundial, hasRelay);
          if (issues.length === 0) {
            stack = "ok";
          } else {
            hasIssues = true;
            stack = {
              ok: false,
              issues: issues.map((i, idx) => ({
                n: idx + 1,
                message: i.message,
                fix: i.fix,
              })),
            };
          }
        }

        const payload: Record<string, unknown> = {
          data_repo: dataRepo,
          resolution,
          workspace_yaml: workspaceStatus,
          scaffold: {
            config: configStatus,
            dirs,
          },
          skills_synced: skillsPath,
          stack,
        };
        if (warnings.length > 0) {
          payload.warnings = warnings;
        }

        outputJson(payload);

        if (hasIssues) {
          process.exit(OPERATION_FAILED);
          return;
        }
        process.exit(SUCCESS);
      },
    );
}
