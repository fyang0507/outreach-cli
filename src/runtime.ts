import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export interface RuntimeState {
  daemon_pid: number;
  daemon_port: number;
  ngrok_pid?: number;
  webhook_url: string;
  started_at: string; // ISO timestamp
}

const OUTREACH_DIR = join(homedir(), ".outreach");
const RUNTIME_FILE = join(OUTREACH_DIR, "runtime.json");
const LOCK_FILE = join(OUTREACH_DIR, "init.lock");

// ---- Shared process utilities (consolidated from init.ts, teardown.ts, lifecycle.ts) ----

/**
 * Check if a process with the given PID exists (signal 0).
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a PID belongs to an outreach-related process (node or ngrok).
 * Returns false if the PID is dead or belongs to an unrelated process.
 */
export function isOurProcess(pid: number, expectedName: "node" | "ngrok"): boolean {
  if (!isProcessRunning(pid)) return false;

  try {
    // Use ps to get the command name for this PID
    const output = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim();
    // ps returns the command basename, e.g. "node", "ngrok"
    // On macOS, node might show as "node" or the full path basename
    const lowerOutput = output.toLowerCase();
    return lowerOutput.includes(expectedName);
  } catch {
    // ps failed — process likely dead
    return false;
  }
}

/**
 * Health-check the daemon by fetching its /health endpoint.
 */
export async function checkDaemonHealth(port: number): Promise<{ healthy: boolean; calls: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) {
      const data = (await res.json()) as { status: string; calls: number };
      return { healthy: true, calls: data.calls };
    }
  } catch {
    // not reachable
  }
  return { healthy: false, calls: 0 };
}

/**
 * Check if a TCP port is in use. Returns the PID of the owning process, or null.
 */
export function getPortOwner(port: number): number | null {
  try {
    // lsof to find process listening on port
    const output = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 3000 }).trim();
    if (output) {
      const pid = parseInt(output.split("\n")[0], 10);
      return Number.isNaN(pid) ? null : pid;
    }
  } catch {
    // lsof returns non-zero when no process found
  }
  return null;
}

/**
 * Kill a process and wait for it to exit, escalating to SIGKILL if needed.
 */
export async function killAndWait(pid: number, timeoutMs: number): Promise<void> {
  if (!isProcessRunning(pid)) return;

  process.kill(pid, "SIGTERM");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Force kill if still alive
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

// ---- Runtime file management ----

export async function ensureOutreachDir(): Promise<void> {
  await mkdir(OUTREACH_DIR, { recursive: true });
}

export async function writeRuntime(state: RuntimeState): Promise<void> {
  await ensureOutreachDir();
  await writeFile(RUNTIME_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export async function readRuntime(): Promise<RuntimeState | null> {
  try {
    const content = await readFile(RUNTIME_FILE, "utf-8");
    return JSON.parse(content) as RuntimeState;
  } catch {
    return null;
  }
}

export async function deleteRuntime(): Promise<void> {
  try {
    await unlink(RUNTIME_FILE);
  } catch {
    // ignore if not exists
  }
}

/**
 * Read runtime and verify the daemon is actually healthy (not just PID alive).
 * Throws if not initialized or daemon is unhealthy.
 */
export async function requireRuntime(): Promise<RuntimeState> {
  const state = await readRuntime();
  if (!state) {
    throw new Error("Run 'outreach call init' first");
  }
  const { healthy } = await checkDaemonHealth(state.daemon_port);
  if (!healthy) {
    throw new Error("Daemon is not healthy. Run 'outreach call init' to reinitialize.");
  }
  return state;
}

// ---- Lockfile for E7: double init prevention ----

export async function acquireInitLock(): Promise<boolean> {
  await ensureOutreachDir();
  try {
    // Write lockfile with our PID, using wx flag (exclusive create — fails if file exists)
    await writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // File already exists — check if the locking process is still alive
    try {
      const content = await readFile(LOCK_FILE, "utf-8");
      const lockPid = parseInt(content.trim(), 10);
      if (!Number.isNaN(lockPid) && isProcessRunning(lockPid) && lockPid !== process.pid) {
        // Another init is genuinely running
        return false;
      }
      // Stale lock — reclaim it
      await writeFile(LOCK_FILE, String(process.pid), "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}

export async function releaseInitLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE);
  } catch {
    // ignore
  }
}
