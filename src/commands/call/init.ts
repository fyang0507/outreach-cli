import { Command } from "commander";
import { fork, spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { missingRequiredCallEnv } from "../../config.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";
import { sendToDaemon } from "../../daemon/ipc.js";
// Type-only: importing the preflight module itself would pull the Twilio and
// Gemini SDKs into every CLI invocation.
import type { PreflightReport } from "../../daemon/preflight.js";
import {
  readRuntime,
  writeRuntime,
  daemonLogPath,
  openDaemonLog,
  deleteRuntime,
  checkDaemonHealth,
  isProcessRunning,
  isOurProcess,
  getPortOwner,
  killAndWait,
  acquireInitLock,
  releaseInitLock,
} from "../../runtime.js";
import type { RuntimeState } from "../../runtime.js";

const DEFAULT_PORT = 3001;
const NGROK_API_PORT = 4040;
const NGROK_POLL_TIMEOUT_MS = 10_000;
const NGROK_POLL_INTERVAL_MS = 300;
const DAEMON_HEALTH_TIMEOUT_MS = 5_000;
// The preflight makes Twilio, Gemini and tunnel round trips inside the daemon;
// the 10s IPC default is too tight for that. The daemon bounds the whole run well
// inside this, so a timeout here really does mean the daemon stopped answering.
const PREFLIGHT_IPC_TIMEOUT_MS = 30_000;

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
  throw new Error(`Daemon not responding on port ${port} after ${timeoutMs / 1000}s. Check daemon logs or try 'outreach call teardown' then 'outreach call init'.`);
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

/**
 * ngrok reports the forwarded address as "http://localhost:3001" or
 * "localhost:3001" (and, on older builds, a bare port). Substring matching on
 * the port digits accepts "localhost:13001" for port 3001 — a tunnel pointing at
 * someone else's process — so compare the parsed port exactly.
 */
function tunnelPort(addr: string): number | null {
  const trimmed = addr.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (url.port) return parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
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
    if (tunnelPort(tunnelAddr) === daemonPort) {
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

// ---- Preflight (executed inside the daemon) ----

/**
 * The daemon validates its own env, config, credentials and tunnel: the CLI
 * process cannot observe the daemon's env snapshot or resolved config, and on the
 * reuse path there is no fork whose state it could assume.
 */
async function runPreflightOverIpc(): Promise<PreflightReport> {
  try {
    const result = (await sendToDaemon("daemon.preflight", {}, PREFLIGHT_IPC_TIMEOUT_MS)) as
      PreflightReport & { error?: string; message?: string };
    if (result.error) throw new Error(`daemon rejected the preflight request: ${result.message ?? result.error}`);
    if (!Array.isArray(result.checks)) throw new Error("daemon returned an unexpected preflight response");
    return result;
  } catch (err) {
    // Report the transport failure as a failed check so the caller has one shape to read.
    return {
      ok: false,
      checks: [{
        name: "daemon_ipc",
        ok: false,
        status: "fail",
        detail: (err as Error).message,
        hint: "The daemon answers HTTP but not the preflight — an older daemon may still be running. Run 'outreach call teardown' then 'outreach call init'.",
      }],
    };
  }
}

function preflightSummary(report: PreflightReport): string {
  const failed = report.checks.filter((check) => check.status === "fail");
  if (failed.length === 0) return "Preflight failed";
  const detail = failed.map((check) => `${check.name}: ${check.detail ?? "failed"}`).join("; ");
  return `Preflight failed (${failed.length} check${failed.length === 1 ? "" : "s"}) — ${detail}`;
}

/** E3: only ever kill what THIS init started — never a reused ngrok or daemon. */
async function cleanupStartedProcesses(daemonPid?: number, ngrokPid?: number): Promise<void> {
  if (daemonPid && isProcessRunning(daemonPid)) {
    await killAndWait(daemonPid, 2000);
  }
  if (ngrokPid && isProcessRunning(ngrokPid)) {
    await killAndWait(ngrokPid, 2000);
  }
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

interface InitOptions {
  tunnel: string;
  webhookUrl?: string;
  skipPreflight?: boolean;
}

export function registerInitCommand(parent: Command): void {
  parent
    .command("init")
    .description("Start tunnel and daemon for voice calls")
    .option("--tunnel <type>", "Tunnel type: ngrok or manual", "ngrok")
    .option("--webhook-url <url>", "Webhook URL (required for --tunnel manual)")
    .option("--skip-preflight", "Skip setup validation (not recommended)")
    .action(async (opts: InitOptions) => {
      // E7: Acquire init lock to prevent double init
      const lockAcquired = await acquireInitLock();
      if (!lockAcquired) {
        outputError(INFRA_ERROR, "Another init is already in progress");
        process.exit(INFRA_ERROR);
      }

      // doInit returns its exit code instead of exiting: process.exit() inside it
      // would skip the release below and leave the lockfile behind on every run.
      let code = SUCCESS;
      try {
        code = await doInit(opts);
      } finally {
        await releaseInitLock();
      }
      process.exit(code);
    });
}

async function doInit(opts: InitOptions): Promise<number> {
  // 1. Cheap local gate, before anything is spawned: a misconfigured .env should
  //    fail in milliseconds, not after ngrok and the daemon are up.
  const missingEnv = missingRequiredCallEnv();
  if (missingEnv.length > 0) {
    outputError(
      INPUT_ERROR,
      `Missing required variables in .env: ${missingEnv.join(", ")}`,
      { missing_env: missingEnv },
    );
    return INPUT_ERROR;
  }

  // 2. E2: Check if already initialized — use health check, not just PID
  const existing = await readRuntime();
  if (existing) {
    const { valid, webhookUrl } = await validateExistingRuntime(existing);
    if (valid) {
      // A healthy daemon is not a ready one: the tunnel may have been re-issued
      // under it, or its config/credentials may have gone bad since it started.
      // The daemon reports activeCalls, so the Gemini probe self-skips mid-call.
      const report = opts.skipPreflight ? undefined : await runPreflightOverIpc();
      if (report && !report.ok) {
        outputError(INFRA_ERROR, preflightSummary(report), { preflight: report });
        return INFRA_ERROR;
      }
      outputJson({
        status: "ready",
        webhook_url: webhookUrl,
        daemon_pid: existing.daemon_pid,
        message: "Already initialized",
        ...(report ? { preflight: report } : {}),
      });
      return SUCCESS;
    }
    // Stale runtime — clean up before re-init
    await cleanupStaleRuntime(existing);
  }

  const port = getPort();
  let webhookUrl: string;
  let ngrokPid: number | undefined;
  // Only a tunnel this init spawned may be torn down on failure.
  let ngrokStartedByUs = false;

  // 3. Start tunnel
  if (opts.tunnel === "manual") {
    if (!opts.webhookUrl) {
      outputError(INPUT_ERROR, "--webhook-url is required when using --tunnel manual");
      return INPUT_ERROR;
    }
    // A trailing slash would make the daemon build '<url>//call-status/<id>', which
    // Express 404s — silently dropping every Twilio callback.
    webhookUrl = opts.webhookUrl.replace(/\/$/, "");
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
        return INFRA_ERROR;
      }

      // E3: Wrap ngrok spawn in try block — clean up on failure
      try {
        const ngrokChild = spawn("ngrok", ["http", String(port)], {
          detached: true,
          stdio: "ignore",
        });
        ngrokChild.unref();
        ngrokPid = ngrokChild.pid;
        ngrokStartedByUs = true;

        // E5: Poll for ngrok URL instead of fixed sleep
        webhookUrl = await pollNgrokUrl(NGROK_POLL_TIMEOUT_MS);
      } catch (err) {
        // E3: Kill ngrok if it was spawned but something failed
        await cleanupStartedProcesses(undefined, ngrokPid);
        outputError(INFRA_ERROR, `Failed to start ngrok: ${(err as Error).message}`);
        return INFRA_ERROR;
      }
    }
  } else {
    outputError(INPUT_ERROR, `Unknown tunnel type: ${opts.tunnel}. Use 'ngrok' or 'manual'`);
    return INPUT_ERROR;
  }

  // Set webhook URL in environment so daemon picks it up
  process.env.OUTREACH_WEBHOOK_URL = webhookUrl;

  // 4. Start daemon — wrapped in E3 try/finally for ngrok cleanup
  let daemonPid: number | undefined;
  let daemonLogFd: number | undefined;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const serverPath = join(thisDir, "..", "..", "daemon", "server.js");

    // stdio 1/2 to the log rather than "ignore": a call that goes wrong is
    // diagnosed from the daemon's own output, and discarding it means the evidence
    // is gone by the time anyone asks. "ipc" is required for fork().
    daemonLogFd = openDaemonLog();
    const child = fork(serverPath, [], {
      detached: true,
      stdio: ["ignore", daemonLogFd, daemonLogFd, "ipc"],
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
    // The daemon holds its own descriptor now; this one would leak for the life of
    // the CLI process otherwise.
    closeSync(daemonLogFd);
    daemonLogFd = undefined;
  } catch (err) {
    if (daemonLogFd !== undefined) closeSync(daemonLogFd);
    // E3: Clean up the daemon and ngrok this init started
    await cleanupStartedProcesses(daemonPid, ngrokStartedByUs ? ngrokPid : undefined);
    outputError(INFRA_ERROR, `Daemon failed to start: ${(err as Error).message}`);
    return INFRA_ERROR;
  }

  // 6. Preflight — run inside the daemon, so it validates (and warms) the exact
  //    process, env, config and credentials the call will use.
  let preflight: PreflightReport | undefined;
  if (!opts.skipPreflight) {
    preflight = await runPreflightOverIpc();
    if (!preflight.ok) {
      // Leave nothing half-started behind, and no runtime.json claiming ready.
      await cleanupStartedProcesses(daemonPid, ngrokStartedByUs ? ngrokPid : undefined);
      outputError(INFRA_ERROR, preflightSummary(preflight), { preflight });
      return INFRA_ERROR;
    }
  }

  // 7. Write runtime.json
  const state: RuntimeState = {
    daemon_pid: daemonPid,
    daemon_port: port,
    webhook_url: webhookUrl,
    started_at: new Date().toISOString(),
    daemon_log: daemonLogPath(),
  };
  if (ngrokPid !== undefined) {
    state.ngrok_pid = ngrokPid;
  }

  await writeRuntime(state);

  // 8. Output
  outputJson({
    status: "ready",
    webhook_url: webhookUrl,
    daemon_pid: daemonPid,
    daemon_log: daemonLogPath(),
    ...(preflight ? { preflight } : {}),
  });
  return SUCCESS;
}
