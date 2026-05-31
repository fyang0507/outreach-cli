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
    .option(
      "--verbose",
      "Include full message bodies in --address mode (default: snippets only)",
    )
    .option(
      "--format <format>",
      "Output detail: 'full' is an alias for --verbose",
    )
    .action(
      async (opts: {
        address?: string;
        threadId?: string;
        limit: string;
        verbose?: boolean;
        format?: string;
      }) => {
        if (!opts.address && !opts.threadId) {
          outputError(INPUT_ERROR, "Either --address or --thread-id is required");
          process.exit(INPUT_ERROR);
          return;
        }

        const limit = parseInt(opts.limit, 10);
        const verbose = opts.verbose === true || opts.format === "full";

        let messages;
        try {
          messages = await readEmailHistory({
            address: opts.address,
            threadId: opts.threadId,
            limit,
            includeBody: verbose,
          });
        } catch (err) {
          const status = (err as { code?: number }).code;
          const msg = (err as Error).message;
          if (status === 401 || msg.includes("invalid_grant")) {
            outputError(INFRA_ERROR, "Gmail token expired or revoked. Run 'outreach health' to check, then re-authorize if needed.");
          } else if (status === 403) {
            outputError(INFRA_ERROR, "Gmail access denied. Re-authorize to grant Gmail read access.");
          } else {
            outputError(INFRA_ERROR, `Failed to read email history: ${msg}. Run 'outreach health' to check email channel readiness.`);
          }
          process.exit(INFRA_ERROR);
          return;
        }

        // Truncation only applies to address mode (thread mode returns a whole
        // thread, uncapped by --limit).
        const truncated = !opts.threadId && messages.length === limit;

        const payload: {
          address: string | null;
          thread_id: string | null;
          truncated: boolean;
          note?: string;
          hint?: string;
          messages: typeof messages;
        } = {
          address: opts.address ?? null,
          thread_id: opts.threadId ?? null,
          truncated,
          messages,
        };

        if (truncated) {
          payload.note = `showing ${messages.length} most recent; raise --limit or narrow with after:/before:`;
        }

        // Address mode without --verbose omits bodies; advertise the flag.
        if (opts.address && !opts.threadId && !verbose) {
          payload.hint = "bodies omitted; pass --verbose for full text";
        }

        outputJson(payload);
        process.exit(SUCCESS);
      },
    );
}
