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
          const status = (err as { code?: number }).code;
          const msg = (err as Error).message;
          if (status === 401 || msg.includes("invalid_grant")) {
            outputError(INFRA_ERROR, "Gmail token expired or revoked. Run 'outreach health' to check, then re-authorize if needed.");
          } else if (status === 403) {
            outputError(INFRA_ERROR, "Gmail access denied. Re-authorize to grant Gmail read access.");
          } else {
            outputError(INFRA_ERROR, `Failed to search emails: ${msg}. Run 'outreach health' to check email channel readiness.`);
          }
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
