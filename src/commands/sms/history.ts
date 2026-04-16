import { Command } from "commander";
import { readMessageHistory, normalizePhone } from "../../providers/messages.js";
import { resolveContactAddress } from "../../contacts.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

export function registerHistoryCommand(parent: Command): void {
  parent
    .command("history")
    .description("Read iMessage thread by contact or phone number")
    .option("--phone <number>", "Phone number (E.164 or raw digits)")
    .option("--contact-id <id>", "Contact ID (resolves phone from contact record)")
    .option("--limit <n>", "Max messages to return", "20")
    .action(async (opts: { phone?: string; contactId?: string; limit: string }) => {
      if (!opts.phone && !opts.contactId) {
        outputError(INPUT_ERROR, "Either --phone or --contact-id is required");
        process.exit(INPUT_ERROR);
        return;
      }

      let normalized: string;
      if (opts.phone) {
        normalized = normalizePhone(opts.phone);
      } else {
        try {
          normalized = await resolveContactAddress(opts.contactId!, "sms");
        } catch (err) {
          outputError(INPUT_ERROR, (err as Error).message);
          process.exit(INPUT_ERROR);
          return;
        }
      }

      const limit = parseInt(opts.limit, 10);

      let messages;
      try {
        messages = readMessageHistory(normalized, { limit });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("SQLITE_CANTOPEN") || msg.includes("unable to open")) {
          outputError(INFRA_ERROR, "iMessage database not accessible. Grant Full Disk Access to your terminal app in System Settings → Privacy & Security.");
        } else {
          outputError(INFRA_ERROR, `Failed to read SMS history: ${msg}. Run 'outreach health' to check SMS readiness.`);
        }
        process.exit(INFRA_ERROR);
        return;
      }

      outputJson({ phone: normalized, messages });
      process.exit(SUCCESS);
    });
}
