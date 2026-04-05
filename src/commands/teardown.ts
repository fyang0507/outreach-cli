import { Command } from "commander";
import { unlink } from "node:fs/promises";
import { readRuntime, deleteRuntime } from "../runtime.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INFRA_ERROR, OPERATION_FAILED } from "../exitCodes.js";

const PID_FILE = "/tmp/outreach-daemon.pid";
const SOCKET_PATH = "/tmp/outreach-daemon.sock";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killAndWait(pid: number, timeoutMs: number): Promise<void> {
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

async function checkActiveCalls(port: number): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) {
      const data = (await res.json()) as { calls: number };
      return data.calls;
    }
  } catch {
    // daemon not responding
  }
  return 0;
}

async function cleanupFiles(): Promise<void> {
  for (const file of [PID_FILE, SOCKET_PATH]) {
    try {
      await unlink(file);
    } catch {
      // ignore
    }
  }
  await deleteRuntime();
}

export function registerTeardownCommand(program: Command): void {
  program
    .command("teardown")
    .description("Stop daemon, tunnel, and clean up")
    .option("--force", "Force teardown even with active calls", false)
    .action(async (opts: { force: boolean }) => {
      const state = await readRuntime();
      if (!state) {
        outputError(INFRA_ERROR, "Not initialized");
        process.exit(INFRA_ERROR);
        return;
      }

      // Check for active calls
      if (!opts.force) {
        const activeCalls = await checkActiveCalls(state.daemon_port);
        if (activeCalls > 0) {
          outputError(
            OPERATION_FAILED,
            `${activeCalls} active call(s). Use --force to teardown anyway.`,
          );
          process.exit(OPERATION_FAILED);
          return;
        }
      }

      // Stop daemon
      try {
        await killAndWait(state.daemon_pid, 3000);
      } catch {
        // best effort
      }

      // Stop ngrok
      if (state.ngrok_pid !== undefined) {
        try {
          await killAndWait(state.ngrok_pid, 3000);
        } catch {
          // best effort
        }
      }

      // Clean up files
      await cleanupFiles();

      outputJson({ status: "stopped" });
      process.exit(SUCCESS);
    });
}
