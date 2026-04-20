import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

export type ResolutionSource = "env" | "dev" | "walkup";

export interface ResolvedDataRepo {
  path: string;
  source: ResolutionSource;
}

export interface DevConfigLocation {
  path: string;
  dataRepoPath: string | null;
}

const WORKSPACE_MARKER = join(".agents", "workspace.yaml");
const DEV_CONFIG_FILENAME = "outreach.config.dev.yaml";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function cliRepoRoot(): string {
  // src/dataRepo.ts → repo root is two levels up.
  // dist/dataRepo.js → dist lives directly under repo root, one level up.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const baseName = thisDir.split("/").pop();
  return baseName === "dist" ? resolve(thisDir, "..") : resolve(thisDir, "..");
}

/**
 * Locate outreach.config.dev.yaml next to the CLI binary, if present.
 * Returns the path and the data_repo_path value it declares (or null if the
 * file parses but doesn't declare one).
 */
export function locateDevConfig(): DevConfigLocation | null {
  const path = join(cliRepoRoot(), DEV_CONFIG_FILENAME);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf-8"));
  } catch {
    return { path, dataRepoPath: null };
  }

  if (!parsed || typeof parsed !== "object") {
    return { path, dataRepoPath: null };
  }

  const raw = (parsed as Record<string, unknown>).data_repo_path;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { path, dataRepoPath: null };
  }

  return { path, dataRepoPath: expandHome(raw) };
}

function findWorkspaceMarker(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the outreach data repo path.
 *
 * Order:
 *   1. OUTREACH_DATA_REPO env var.
 *   2. outreach.config.dev.yaml next to the CLI binary (sticky: wins over walk-up).
 *   3. Walk up from cwd for .agents/workspace.yaml.
 *
 * Throws with an actionable remediation message on miss.
 */
export function resolveDataRepo(cwd: string = process.cwd()): ResolvedDataRepo {
  const envVal = process.env.OUTREACH_DATA_REPO;
  if (envVal && envVal.trim() !== "") {
    return { path: expandHome(envVal.trim()), source: "env" };
  }

  const dev = locateDevConfig();
  if (dev && dev.dataRepoPath) {
    return { path: dev.dataRepoPath, source: "dev" };
  }

  const walk = findWorkspaceMarker(cwd);
  if (walk) {
    return { path: walk, source: "walkup" };
  }

  throw new Error(
    [
      "Could not resolve outreach data repo.",
      "Tried (in order):",
      "  1. OUTREACH_DATA_REPO env var — unset",
      `  2. ${DEV_CONFIG_FILENAME} next to the CLI — not found or missing data_repo_path`,
      `  3. Walk-up from cwd for ${WORKSPACE_MARKER} — no marker found`,
      "",
      "Fix one of:",
      "  • Run `outreach setup --data-repo <path>` to scaffold a data repo.",
      "  • Set OUTREACH_DATA_REPO=/path/to/data/repo for ad-hoc invocations.",
    ].join("\n"),
  );
}
