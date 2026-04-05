import { Command } from "commander";
import { ensureDaemon } from "../../daemon/lifecycle.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR, OPERATION_FAILED } from "../../exitCodes.js";

interface HangupOptions {
  id: string;
}

export function registerHangupCommand(parent: Command): void {
  parent
    .command("hangup")
    .description("End a call")
    .requiredOption("--id <callId>", "Call ID")
    .action(async (opts: HangupOptions) => {
      try {
        await ensureDaemon();
      } catch (err) {
        outputError(INFRA_ERROR, `Failed to start daemon: ${(err as Error).message}`);
        process.exit(INFRA_ERROR);
        return;
      }

      try {
        const result = await sendToDaemon("call.hangup", {
          id: opts.id,
        });

        const res = result as { error?: string; message?: string };
        if (res.error) {
          const code = res.error === "session_not_found" ? INPUT_ERROR
            : res.error === "call_not_active" ? OPERATION_FAILED
            : INFRA_ERROR;
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
