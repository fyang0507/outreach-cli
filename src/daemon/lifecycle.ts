import { readFile, unlink } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Re-export requireRuntime for use by call commands
export { requireRuntime } from "../runtime.js";

const PID_FILE = "/tmp/outreach-daemon.pid";
const HEALTH_URL = "http://127.0.0.1:{PORT}/health";
const DEFAULT_PORT = 3001;

function getPort(): number {
  return parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(): Promise<number | null> {
  try {
    const content = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const port = getPort();
  const url = HEALTH_URL.replace("{PORT}", String(port));
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

export async function ensureDaemon(): Promise<void> {
  const pid = await readPid();

  if (pid !== null && (await isProcessRunning(pid))) {
    // Verify health
    try {
      await waitForHealth(2000);
      return; // already running and healthy
    } catch {
      // stale or unhealthy — clean up and restart
    }
  }

  // Clean up stale PID file
  if (pid !== null) {
    try {
      await unlink(PID_FILE);
    } catch {
      // ignore
    }
  }

  // Fork the daemon server
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(thisDir, "server.js");

  const child = fork(serverPath, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for health
  await waitForHealth(5000);
}

export async function stopDaemon(): Promise<void> {
  const pid = await readPid();
  if (pid === null) return;

  if (await isProcessRunning(pid)) {
    process.kill(pid, "SIGTERM");

    // Wait for process to exit
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!(await isProcessRunning(pid))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Clean up PID file
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore
  }
}
