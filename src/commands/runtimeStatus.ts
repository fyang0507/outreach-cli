import { Command } from "commander";
import { readRuntime } from "../runtime.js";
import { outreachConfig } from "../config.js";
import { outputJson } from "../output.js";
import { SUCCESS } from "../exitCodes.js";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function checkDaemonHealth(port: number): Promise<{ running: boolean; active_calls: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) {
      const data = (await res.json()) as { calls: number };
      return { running: true, active_calls: data.calls };
    }
  } catch {
    // not reachable
  }
  return { running: false, active_calls: 0 };
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show runtime status of daemon, tunnel, and config")
    .action(async () => {
      const state = await readRuntime();

      if (!state) {
        outputJson({
          daemon: { running: false },
          tunnel: { running: false },
          twilio: {
            configured: !!(outreachConfig.TWILIO_ACCOUNT_SID && outreachConfig.TWILIO_AUTH_TOKEN),
            from: outreachConfig.OUTREACH_DEFAULT_FROM || null,
          },
        });
        process.exit(SUCCESS);
        return;
      }

      const daemonAlive = isProcessRunning(state.daemon_pid);
      const health = daemonAlive
        ? await checkDaemonHealth(state.daemon_port)
        : { running: false, active_calls: 0 };

      const ngrokRunning = state.ngrok_pid !== undefined
        ? isProcessRunning(state.ngrok_pid)
        : false;

      outputJson({
        daemon: {
          running: health.running,
          pid: state.daemon_pid,
          port: state.daemon_port,
          active_calls: health.active_calls,
        },
        tunnel: {
          running: ngrokRunning,
          url: state.webhook_url,
        },
        twilio: {
          configured: !!(outreachConfig.TWILIO_ACCOUNT_SID && outreachConfig.TWILIO_AUTH_TOKEN),
          from: outreachConfig.OUTREACH_DEFAULT_FROM || null,
        },
      });
      process.exit(SUCCESS);
    });
}
