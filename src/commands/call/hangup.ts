import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
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
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
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
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
