import { Command } from "commander";
import { unlink } from "node:fs/promises";
import {
  readRuntime,
  deleteRuntime,
  isOurProcess,
  killAndWait,
  checkDaemonHealth,
} from "../runtime.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, OPERATION_FAILED } from "../exitCodes.js";

const PID_FILE = "/tmp/outreach-daemon.pid";
const SOCKET_PATH = "/tmp/outreach-daemon.sock";

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
        outputJson({ status: "stopped" });
        process.exit(SUCCESS);
        return;
      }

      // Check for active calls
      if (!opts.force) {
        const { calls } = await checkDaemonHealth(state.daemon_port);
        if (calls > 0) {
          outputError(
            OPERATION_FAILED,
            `${calls} active call(s). Use --force to teardown anyway.`,
          );
          process.exit(OPERATION_FAILED);
          return;
        }
      }

      // E6: Stop daemon — verify PID is actually our node process before killing
      try {
        if (isOurProcess(state.daemon_pid, "node")) {
          await killAndWait(state.daemon_pid, 3000);
        } else {
          // PID is dead or recycled to a non-node process — skip kill, just clean up
        }
      } catch {
        // best effort
      }

      // E6: Stop ngrok — verify PID is actually ngrok before killing
      if (state.ngrok_pid !== undefined) {
        try {
          if (isOurProcess(state.ngrok_pid, "ngrok")) {
            await killAndWait(state.ngrok_pid, 3000);
          } else {
            // PID is dead or recycled — skip kill
          }
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
