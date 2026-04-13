import { Command } from "commander";
import { readEmailHistory } from "../../providers/gmail.js";
import { resolveContactAddress } from "../../contacts.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

export function registerHistoryCommand(parent: Command): void {
  parent
    .command("history")
    .description("Read email history by contact, address, or thread")
    .option("--address <email>", "Email address to search")
    .option("--thread-id <id>", "Gmail thread ID for full thread view")
    .option("--contact-id <id>", "Contact ID (resolves email from contact record)")
    .option("--limit <n>", "Max messages to return", "20")
    .action(
      async (opts: {
        address?: string;
        threadId?: string;
        contactId?: string;
        limit: string;
      }) => {
        if (!opts.address && !opts.threadId && !opts.contactId) {
          outputError(INPUT_ERROR, "Either --address, --thread-id, or --contact-id is required");
          process.exit(INPUT_ERROR);
          return;
        }

        // Resolve email address from contact if needed
        let address = opts.address;
        if (!address && !opts.threadId && opts.contactId) {
          try {
            address = await resolveContactAddress(opts.contactId, "email");
          } catch (err) {
            outputError(INPUT_ERROR, (err as Error).message);
            process.exit(INPUT_ERROR);
            return;
          }
        }

        const limit = parseInt(opts.limit, 10);

        let messages;
        try {
          messages = await readEmailHistory({
            address,
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
          address: address ?? null,
          thread_id: opts.threadId ?? null,
          messages,
        });
        process.exit(SUCCESS);
      },
    );
}
