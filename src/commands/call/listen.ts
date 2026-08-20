import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface ListenOptions {
  id: string;
  since?: string;
}

export function registerListenCommand(parent: Command): void {
  parent
    .command("listen")
    .description("Get transcript of what the other party has said")
    .requiredOption("--id <callId>", "Call ID")
    .option(
      "--since <seq>",
      "Only return entries at or after this sequence number (a previous response's next_since); omit for the full transcript",
    )
    .action(async (opts: ListenOptions) => {
      try {
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      let since: number | undefined;
      if (opts.since !== undefined) {
        since = Number(opts.since);
        if (!Number.isInteger(since) || since < 0) {
          outputError(INPUT_ERROR, "--since must be a non-negative integer");
          process.exit(INPUT_ERROR);
          return;
        }
      }

      try {
        const result = await sendToDaemon("call.listen", {
          id: opts.id,
          ...(since !== undefined ? { since } : {}),
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
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
