import { Command } from "commander";
import { readMessageHistory, normalizePhone } from "../../providers/messages.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INFRA_ERROR } from "../../exitCodes.js";

export function registerHistoryCommand(parent: Command): void {
  parent
    .command("history")
    .description("Read iMessage thread for a phone number")
    .requiredOption("--phone <number>", "Phone number (E.164 or raw digits)")
    .option("--limit <n>", "Max messages to return", "20")
    .action(async (opts: { phone: string; limit: string }) => {
      const normalized = normalizePhone(opts.phone);
      const limit = parseInt(opts.limit, 10);

      let messages;
      try {
        messages = readMessageHistory(normalized, { limit });
      } catch (err) {
        const msg = (err as Error).message;
        const hint = msg.includes("SQLITE_CANTOPEN") || msg.includes("unable to open")
          ? "Grant Full Disk Access to your terminal app in System Settings → Privacy & Security"
          : msg;
        outputError(INFRA_ERROR, hint);
        process.exit(INFRA_ERROR);
        return;
      }

      outputJson({ phone: normalized, messages });
      process.exit(SUCCESS);
    });
}
