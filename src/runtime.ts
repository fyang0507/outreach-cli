import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RuntimeState {
  daemon_pid: number;
  daemon_port: number;
  ngrok_pid?: number;
  webhook_url: string;
  started_at: string; // ISO timestamp
}

const OUTREACH_DIR = join(homedir(), ".outreach");
const RUNTIME_FILE = join(OUTREACH_DIR, "runtime.json");

export async function writeRuntime(state: RuntimeState): Promise<void> {
  await mkdir(OUTREACH_DIR, { recursive: true });
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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function requireRuntime(): Promise<RuntimeState> {
  const state = await readRuntime();
  if (!state) {
    throw new Error("Run 'outreach init' first");
  }
  if (!isProcessRunning(state.daemon_pid)) {
    throw new Error("Run 'outreach init' first");
  }
  return state;
}
