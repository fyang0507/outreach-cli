import { Command } from "commander";
import { readEmailHistory } from "../../providers/gmail.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

export function registerHistoryCommand(parent: Command): void {
  parent
    .command("history")
    .description("Read email history by address or thread")
    .option("--address <email>", "Email address to search")
    .option("--thread-id <id>", "Gmail thread ID for full thread view")
    .option("--limit <n>", "Max messages to return", "20")
    .action(
      async (opts: {
        address?: string;
        threadId?: string;
        limit: string;
      }) => {
        if (!opts.address && !opts.threadId) {
          outputError(INPUT_ERROR, "Either --address or --thread-id is required");
          process.exit(INPUT_ERROR);
          return;
        }

        const limit = parseInt(opts.limit, 10);

        let messages;
        try {
          messages = await readEmailHistory({
            address: opts.address,
            threadId: opts.threadId,
            limit,
          });
        } catch (err) {
          const msg = (err as Error).message;
          const hint = msg.includes("invalid_grant")
            ? "Gmail token expired. Delete gmail-token.json from data repo and re-authorize"
            : msg;
          outputError(INFRA_ERROR, hint);
          process.exit(INFRA_ERROR);
          return;
        }

        outputJson({
          address: opts.address ?? null,
          thread_id: opts.threadId ?? null,
          messages,
        });
        process.exit(SUCCESS);
      },
    );
}
