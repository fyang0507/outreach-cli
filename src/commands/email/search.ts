import { Command } from "commander";
import { searchEmails } from "../../providers/gmail.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

export function registerSearchCommand(parent: Command): void {
  parent
    .command("search")
    .description("Search emails by Gmail query, returns thread-grouped results")
    .requiredOption("--query <q>", "Gmail search query (supports from:, to:, subject:, after:, before:, has:attachment, free text)")
    .option("--limit <n>", "Max messages to fetch before grouping", "10")
    .action(
      async (opts: {
        query: string;
        limit: string;
      }) => {
        const limit = parseInt(opts.limit, 10);
        if (isNaN(limit) || limit < 1) {
          outputError(INPUT_ERROR, "--limit must be a positive integer");
          process.exit(INPUT_ERROR);
          return;
        }

        let threads;
        try {
          threads = await searchEmails({ query: opts.query, limit });
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
          query: opts.query,
          threads,
        });
        process.exit(SUCCESS);
      },
    );
}
