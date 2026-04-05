import { Command } from "commander";
import { fork } from "node:child_process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { outreachConfig } from "../config.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";
import { readRuntime, writeRuntime } from "../runtime.js";
import type { RuntimeState } from "../runtime.js";

const DEFAULT_PORT = 3001;

function getPort(): number {
  return parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

async function fetchNgrokUrl(): Promise<string> {
  const res = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!res.ok) {
    throw new Error(`ngrok API returned ${res.status}`);
  }
  const data = (await res.json()) as {
    tunnels: Array<{ public_url: string; proto: string }>;
  };
  const httpsTunnel = data.tunnels.find((t) => t.proto === "https");
  if (!httpsTunnel) {
    throw new Error("No HTTPS tunnel found from ngrok");
  }
  return httpsTunnel.public_url;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize outreach: start tunnel and daemon")
    .option("--tunnel <type>", "Tunnel type: ngrok or manual", "ngrok")
    .option("--webhook-url <url>", "Webhook URL (required for --tunnel manual)")
    .action(async (opts: { tunnel: string; webhookUrl?: string }) => {
      // 1. Check if already initialized
      const existing = await readRuntime();
      if (existing && isProcessRunning(existing.daemon_pid)) {
        outputJson({
          status: "ready",
          webhook_url: existing.webhook_url,
          daemon_pid: existing.daemon_pid,
          message: "Already initialized",
        });
        process.exit(SUCCESS);
        return;
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
        try {
          const ngrokChild = spawn("ngrok", ["http", String(port)], {
            detached: true,
            stdio: "ignore",
          });
          ngrokChild.unref();
          ngrokPid = ngrokChild.pid;

          // Wait for ngrok to be ready
          await new Promise((r) => setTimeout(r, 3000));
          webhookUrl = await fetchNgrokUrl();
        } catch (err) {
          outputError(INFRA_ERROR, `Failed to start ngrok: ${(err as Error).message}`);
          process.exit(INFRA_ERROR);
          return;
        }
      } else {
        outputError(INPUT_ERROR, `Unknown tunnel type: ${opts.tunnel}. Use 'ngrok' or 'manual'`);
        process.exit(INPUT_ERROR);
        return;
      }

      // Set webhook URL in environment so daemon picks it up
      process.env.OUTREACH_WEBHOOK_URL = webhookUrl;

      // 4. Start daemon
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

      const daemonPid = child.pid;
      if (!daemonPid) {
        outputError(INFRA_ERROR, "Failed to fork daemon process");
        process.exit(INFRA_ERROR);
        return;
      }

      // 5. Wait for daemon health
      try {
        await waitForHealth(port, 5000);
      } catch (err) {
        outputError(INFRA_ERROR, `Daemon failed health check: ${(err as Error).message}`);
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
      });
      process.exit(SUCCESS);
    });
}
