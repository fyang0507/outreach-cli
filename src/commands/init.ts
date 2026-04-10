import { Command } from "commander";
import { execSync, fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAppConfig } from "../appConfig.js";
import { ensureDataDirs } from "../logs/sessionLog.js";
import { outreachConfig } from "../config.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";
import {
  readRuntime,
  writeRuntime,
  deleteRuntime,
  checkDaemonHealth,
  isProcessRunning,
  isOurProcess,
  getPortOwner,
  killAndWait,
  acquireInitLock,
  releaseInitLock,
} from "../runtime.js";
import type { RuntimeState } from "../runtime.js";

const DEFAULT_PORT = 3001;
const NGROK_API_PORT = 4040;
const NGROK_POLL_TIMEOUT_MS = 10_000;
const NGROK_POLL_INTERVAL_MS = 300;
const DAEMON_HEALTH_TIMEOUT_MS = 5_000;

function getPort(): number {
  return parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
}

// ---- Daemon health polling ----

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Daemon failed to start within timeout");
}

// ---- E5: ngrok URL polling with backoff (replaces fixed sleep) ----

async function fetchNgrokUrl(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${NGROK_API_PORT}/api/tunnels`);
  if (!res.ok) {
    throw new Error(`ngrok API returned ${res.status}`);
  }
  const data = (await res.json()) as {
    tunnels: Array<{ public_url: string; proto: string; config?: { addr?: string } }>;
  };
  const httpsTunnel = data.tunnels.find((t) => t.proto === "https");
  if (!httpsTunnel) {
    throw new Error("No HTTPS tunnel found from ngrok");
  }
  return httpsTunnel.public_url;
}

async function pollNgrokUrl(timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      return await fetchNgrokUrl();
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((r) => setTimeout(r, NGROK_POLL_INTERVAL_MS));
  }
  throw new Error(
    `ngrok not ready after ${timeoutMs / 1000}s: ${lastError?.message ?? "unknown error"}`,
  );
}

// ---- E1: Check for existing ngrok on port 4040 ----

async function validateExistingNgrok(daemonPort: number): Promise<string | null> {
  // Check if port 4040 is in use (existing ngrok)
  const owner = getPortOwner(NGROK_API_PORT);
  if (!owner) return null; // no existing ngrok

  // Port 4040 is in use — check if it has a tunnel pointing to our daemon port
  try {
    const res = await fetch(`http://127.0.0.1:${NGROK_API_PORT}/api/tunnels`);
    if (!res.ok) {
      // Something on 4040 but not ngrok API — kill it
      await killAndWait(owner, 2000);
      return null;
    }
    const data = (await res.json()) as {
      tunnels: Array<{ public_url: string; proto: string; config?: { addr?: string } }>;
    };
    const httpsTunnel = data.tunnels.find((t) => t.proto === "https");
    if (!httpsTunnel) {
      // ngrok running but no HTTPS tunnel — kill and restart
      await killAndWait(owner, 2000);
      return null;
    }

    // Check if tunnel points to our daemon port
    const tunnelAddr = httpsTunnel.config?.addr ?? "";
    if (tunnelAddr.includes(String(daemonPort))) {
      // Reuse existing tunnel
      return httpsTunnel.public_url;
    }

    // Tunnel points to wrong port — kill existing ngrok
    await killAndWait(owner, 2000);
    return null;
  } catch {
    // Can't reach ngrok API — kill whatever is on 4040
    try {
      await killAndWait(owner, 2000);
    } catch {
      // best effort
    }
    return null;
  }
}

// ---- E2: Validate existing runtime via health check ----

async function validateExistingRuntime(
  existing: RuntimeState,
): Promise<{ valid: boolean; webhookUrl?: string }> {
  // Don't just check PID — health-check the daemon
  const { healthy } = await checkDaemonHealth(existing.daemon_port);
  if (!healthy) {
    return { valid: false };
  }
  return { valid: true, webhookUrl: existing.webhook_url };
}

async function cleanupStaleRuntime(existing: RuntimeState): Promise<void> {
  // Kill stale processes if they're actually ours
  if (existing.daemon_pid && isOurProcess(existing.daemon_pid, "node")) {
    await killAndWait(existing.daemon_pid, 2000);
  }
  if (existing.ngrok_pid && isOurProcess(existing.ngrok_pid, "ngrok")) {
    await killAndWait(existing.ngrok_pid, 2000);
  }
  await deleteRuntime();
}

// ---- Data repo validation ----

async function validateDataRepo(): Promise<string> {
  const config = await loadAppConfig();
  const repoPath = config.data_repo_path;

  if (!existsSync(repoPath)) {
    throw new Error(
      `Data repo not found at ${repoPath}. Create it or update data_repo_path in outreach.config.yaml`,
    );
  }

  try {
    execSync("git rev-parse --git-dir", { cwd: repoPath, stdio: "pipe", timeout: 3000 });
  } catch {
    throw new Error(`${repoPath} is not a git repository`);
  }

  // Fetch and check if behind remote
  try {
    execSync("git fetch origin --quiet", { cwd: repoPath, stdio: "pipe", timeout: 10_000 });
    const behind = execSync("git rev-list HEAD..@{u} --count", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 3000,
    }).trim();
    if (behind !== "0") {
      throw new Error(
        `Data repo at ${repoPath} is ${behind} commit(s) behind remote. Run: cd ${repoPath} && git pull`,
      );
    }
  } catch (err) {
    if ((err as Error).message.includes("behind remote")) throw err;
    // No remote, no upstream, or network issue — skip sync check
  }

  // Ensure data repo directory structure exists
  await ensureDataDirs();

  return repoPath;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize outreach: start tunnel and daemon")
    .option("--tunnel <type>", "Tunnel type: ngrok or manual", "ngrok")
    .option("--webhook-url <url>", "Webhook URL (required for --tunnel manual)")
    .action(async (opts: { tunnel: string; webhookUrl?: string }) => {
      // E7: Acquire init lock to prevent double init
      const lockAcquired = await acquireInitLock();
      if (!lockAcquired) {
        outputError(INFRA_ERROR, "Another init is already in progress");
        process.exit(INFRA_ERROR);
        return;
      }

      try {
        await doInit(opts);
      } finally {
        await releaseInitLock();
      }
    });
}

async function doInit(opts: { tunnel: string; webhookUrl?: string }): Promise<void> {
  // 0. Validate data repo before starting any infrastructure
  let dataRepoPath: string;
  try {
    dataRepoPath = await validateDataRepo();
  } catch (err) {
    outputError(INPUT_ERROR, (err as Error).message);
    process.exit(INPUT_ERROR);
    return;
  }

  // 1. E2: Check if already initialized — use health check, not just PID
  const existing = await readRuntime();
  if (existing) {
    const { valid, webhookUrl } = await validateExistingRuntime(existing);
    if (valid) {
      outputJson({
        status: "ready",
        webhook_url: webhookUrl,
        daemon_pid: existing.daemon_pid,
        data_repo_path: dataRepoPath,
        message: "Already initialized",
      });
      process.exit(SUCCESS);
      return;
    }
    // Stale runtime — clean up before re-init
    await cleanupStaleRuntime(existing);
  }

  // 2. Validate Twilio creds
  if (!outreachConfig.TWILIO_ACCOUNT_SID || !outreachConfig.TWILIO_AUTH_TOKEN) {
    outputError(INPUT_ERROR, "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env");
    process.exit(INPUT_ERROR);
    return;
  }

  const port = getPort();
  let webhookUrl: string;
  let ngrokPid: number | undefined;

  // 3. Start tunnel
  if (opts.tunnel === "manual") {
    if (!opts.webhookUrl) {
      outputError(INPUT_ERROR, "--webhook-url is required when using --tunnel manual");
      process.exit(INPUT_ERROR);
      return;
    }
    webhookUrl = opts.webhookUrl;
  } else if (opts.tunnel === "ngrok") {
    // E1: Check for existing ngrok first
    const existingUrl = await validateExistingNgrok(port);
    if (existingUrl) {
      webhookUrl = existingUrl;
      // Find the existing ngrok PID for runtime tracking
      ngrokPid = getPortOwner(NGROK_API_PORT) ?? undefined;
    } else {
      // E4: Check if daemon port is already in use before starting ngrok
      const portOwner = getPortOwner(port);
      if (portOwner) {
        outputError(
          INFRA_ERROR,
          `Port ${port} is already in use by PID ${portOwner}. ` +
            `Kill it with 'kill ${portOwner}' or use a different PORT.`,
        );
        process.exit(INFRA_ERROR);
        return;
      }

      // E3: Wrap ngrok spawn in try block — clean up on failure
      try {
        const ngrokChild = spawn("ngrok", ["http", String(port)], {
          detached: true,
          stdio: "ignore",
        });
        ngrokChild.unref();
        ngrokPid = ngrokChild.pid;

        // E5: Poll for ngrok URL instead of fixed sleep
        webhookUrl = await pollNgrokUrl(NGROK_POLL_TIMEOUT_MS);
      } catch (err) {
        // E3: Kill ngrok if it was spawned but something failed
        if (ngrokPid && isProcessRunning(ngrokPid)) {
          await killAndWait(ngrokPid, 2000);
        }
        outputError(INFRA_ERROR, `Failed to start ngrok: ${(err as Error).message}`);
        process.exit(INFRA_ERROR);
        return;
      }
    }
  } else {
    outputError(INPUT_ERROR, `Unknown tunnel type: ${opts.tunnel}. Use 'ngrok' or 'manual'`);
    process.exit(INPUT_ERROR);
    return;
  }

  // Set webhook URL in environment so daemon picks it up
  process.env.OUTREACH_WEBHOOK_URL = webhookUrl;

  // 4. Start daemon — wrapped in E3 try/finally for ngrok cleanup
  let daemonPid: number | undefined;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const serverPath = join(thisDir, "..", "daemon", "server.js");

    const child = fork(serverPath, [], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OUTREACH_WEBHOOK_URL: webhookUrl,
        PORT: String(port),
      },
    });
    child.unref();

    daemonPid = child.pid;
    if (!daemonPid) {
      throw new Error("Failed to fork daemon process — no PID returned");
    }

    // 5. Wait for daemon health
    await waitForHealth(port, DAEMON_HEALTH_TIMEOUT_MS);
  } catch (err) {
    // E3: Clean up ngrok if daemon failed to start
    if (ngrokPid && isProcessRunning(ngrokPid)) {
      await killAndWait(ngrokPid, 2000);
    }
    // Also clean up daemon if it was partially started
    if (daemonPid && isProcessRunning(daemonPid)) {
      await killAndWait(daemonPid, 2000);
    }
    outputError(INFRA_ERROR, `Daemon failed to start: ${(err as Error).message}`);
    process.exit(INFRA_ERROR);
    return;
  }

  // 6. Write runtime.json
  const state: RuntimeState = {
    daemon_pid: daemonPid,
    daemon_port: port,
    webhook_url: webhookUrl,
    started_at: new Date().toISOString(),
  };
  if (ngrokPid !== undefined) {
    state.ngrok_pid = ngrokPid;
  }

  await writeRuntime(state);

  // 7. Output
  outputJson({
    status: "ready",
    webhook_url: webhookUrl,
    daemon_pid: daemonPid,
    data_repo_path: dataRepoPath,
  });
  process.exit(SUCCESS);
}
