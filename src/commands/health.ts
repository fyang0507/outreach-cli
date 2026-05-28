import { Command } from "commander";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "../appConfig.js";
import { readRuntime, checkDaemonHealth, isProcessRunning } from "../runtime.js";
import { checkGmailAuth } from "../providers/gmail.js";
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
      hint: "Set OUTREACH_DATA_REPO, create outreach.config.dev.yaml with data_repo_path, or run from a workspace containing .agents/workspace.yaml.",
    };
  }

  const repoPath = config.data_repo_path;
  const configPath = config.config_path;
  const resolution = config.config_source;

  if (!existsSync(repoPath)) {
    return {
      ok: false,
      path: repoPath,
      config_path: configPath,
      resolution,
      hint: `Data repo not found at ${repoPath}. Create it outside the CLI or point OUTREACH_DATA_REPO at an existing workspace.`,
    };
  }

  return { ok: true, path: repoPath, config_path: configPath, resolution };
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

  let dbExists = false;
  try {
    await access(messagesDb, constants.R_OK);
    dbExists = true;
  } catch {
    // not accessible
  }

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
      send: { ok: false, hint: "osascript not found — required for Messages.app sends" },
      history: { ok: false, messages_db: dbExists ? "present" : "not_found" },
    };
  }

  let history: Record<string, unknown>;
  if (!dbExists) {
    history = {
      ok: false,
      messages_db: "not_found",
      hint: `Messages database not accessible at ${messagesDb}`,
    };
  } else {
    try {
      const db = new Database(messagesDb, { readonly: true });
      db.prepare("SELECT 1").get();
      db.close();
      history = { ok: true, messages_db: "accessible" };
    } catch (err) {
      history = {
        ok: false,
        messages_db: "authorization_denied",
        hint: `Messages database exists but cannot be opened: ${(err as Error).message}. Grant Full Disk Access to the terminal/Codex app for sms history.`,
      };
    }
  }

  return {
    ok: osascriptAvailable,
    send: { ok: true, service_default: "iMessage" },
    history,
  };
}

// ---- Health command ----

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description("Check readiness of all channels")
    .action(async () => {
      const [dataRepo, call, sms, email] = await Promise.all([
        checkDataRepo(),
        checkCall(),
        checkSms(),
        checkGmailAuth(),
      ]);

      outputJson({
        data_repo: dataRepo,
        call,
        sms,
        email,
      });
      process.exit(SUCCESS);
    });
}
