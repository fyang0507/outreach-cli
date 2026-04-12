import { Command } from "commander";
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "../appConfig.js";
import { ensureDataDirs } from "../logs/sessionLog.js";
import { readRuntime, checkDaemonHealth, isProcessRunning } from "../runtime.js";
import { outputJson } from "../output.js";
import { SUCCESS } from "../exitCodes.js";

// ---- Data repo checks ----

async function checkDataRepo(): Promise<Record<string, unknown>> {
  let config;
  try {
    config = await loadAppConfig();
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      hint: "Fix outreach.config.yaml — see the error above",
    };
  }

  const repoPath = config.data_repo_path;

  if (!existsSync(repoPath)) {
    return {
      ok: false,
      path: repoPath,
      hint: `Data repo not found at ${repoPath}. Create it or update data_repo_path in outreach.config.yaml`,
    };
  }

  try {
    execSync("git rev-parse --git-dir", { cwd: repoPath, stdio: "pipe", timeout: 3000 });
  } catch {
    return {
      ok: false,
      path: repoPath,
      hint: `${repoPath} is not a git repository`,
    };
  }

  // Check sync with remote
  let synced: boolean | null = null;
  try {
    execSync("git fetch origin --quiet", { cwd: repoPath, stdio: "pipe", timeout: 10_000 });
    const behind = execSync("git rev-list HEAD..@{u} --count", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 3000,
    }).trim();
    synced = behind === "0";
  } catch {
    // No remote, no upstream, or network issue — sync unknown
    synced = null;
  }

  if (synced === false) {
    return {
      ok: false,
      path: repoPath,
      synced: false,
      hint: `Data repo is behind remote. Run: cd ${repoPath} && git pull`,
    };
  }

  // Ensure directory structure exists
  await ensureDataDirs();

  return { ok: true, path: repoPath, synced };
}

// ---- Call channel checks ----

async function checkCall(): Promise<Record<string, unknown>> {
  const state = await readRuntime();

  if (!state) {
    return {
      ok: false,
      daemon: "stopped",
      tunnel: null,
      hint: "Run 'outreach call init' to start the daemon and tunnel",
    };
  }

  const daemonAlive = isProcessRunning(state.daemon_pid);
  const health = daemonAlive
    ? await checkDaemonHealth(state.daemon_port)
    : { healthy: false, calls: 0 };

  if (!health.healthy) {
    return {
      ok: false,
      daemon: "stopped",
      tunnel: null,
      hint: "Daemon is not healthy. Run 'outreach call init' to reinitialize",
    };
  }

  const ngrokRunning = state.ngrok_pid !== undefined
    ? isProcessRunning(state.ngrok_pid)
    : false;

  const tunnelUrl = ngrokRunning ? state.webhook_url : state.webhook_url;

  return {
    ok: true,
    daemon: "running",
    tunnel: tunnelUrl,
    active_calls: health.calls,
  };
}

// ---- SMS channel checks ----

async function checkSms(): Promise<Record<string, unknown>> {
  const messagesDb = join(homedir(), "Library", "Messages", "chat.db");

  let dbAccessible = false;
  try {
    await access(messagesDb, constants.R_OK);
    dbAccessible = true;
  } catch {
    // not accessible
  }

  if (!dbAccessible) {
    return {
      ok: false,
      messages_db: "not_found",
      hint: `iMessage database not accessible at ${messagesDb}`,
    };
  }

  // Check osascript availability
  let osascriptAvailable = false;
  try {
    execSync("which osascript", { stdio: "pipe", timeout: 2000 });
    osascriptAvailable = true;
  } catch {
    // not available
  }

  if (!osascriptAvailable) {
    return {
      ok: false,
      messages_db: "accessible",
      hint: "osascript not found — required for sending iMessages",
    };
  }

  return { ok: true, messages_db: "accessible" };
}

// ---- Health command ----

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description("Check readiness of all channels")
    .action(async () => {
      const [dataRepo, call, sms] = await Promise.all([
        checkDataRepo(),
        checkCall(),
        checkSms(),
      ]);

      outputJson({
        data_repo: dataRepo,
        call,
        sms,
        email: { ok: false, error: "not configured", hint: "Email channel is not yet implemented" },
      });
      process.exit(SUCCESS);
    });
}
