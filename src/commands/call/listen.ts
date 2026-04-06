import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface ListenOptions {
  id: string;
  wait: boolean;
  timeout: string;
}

export function registerListenCommand(parent: Command): void {
  parent
    .command("listen")
    .description("Get transcript of what the other party has said")
    .requiredOption("--id <callId>", "Call ID")
    .option("--wait", "Block until new speech is detected", false)
    .option("--timeout <ms>", "Max time to wait in ms", "30000")
    .action(async (opts: ListenOptions) => {
      try {
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      try {
        const timeoutMs = parseInt(opts.timeout, 10);
        const ipcTimeout = opts.wait ? timeoutMs + 5000 : undefined;
        const result = await sendToDaemon("call.listen", {
          id: opts.id,
          wait: opts.wait,
          timeout: timeoutMs,
        }, ipcTimeout);

        const res = result as { error?: string; message?: string };
        if (res.error) {
          const code = res.error === "session_not_found" ? INPUT_ERROR : INFRA_ERROR;
          outputError(code, res.message ?? res.error);
          process.exit(code);
          return;
        }

        outputJson(result);
        process.exit(SUCCESS);
      } catch (err) {
        outputError(INFRA_ERROR, `IPC error: ${(err as Error).message}`);
        process.exit(INFRA_ERROR);
      }
    });
}
