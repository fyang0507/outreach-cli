import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface StatusOptions {
  id: string;
}

export function registerStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Get the current state of a call")
    .requiredOption("--id <callId>", "Call ID")
    .action(async (opts: StatusOptions) => {
      try {
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      try {
        const result = await sendToDaemon("call.status", {
          id: opts.id,
        });

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
