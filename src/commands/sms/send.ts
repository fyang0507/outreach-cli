import { Command } from "commander";
import { sendIMessage, normalizePhone } from "../../providers/messages.js";
import { resolveContactAddress } from "../../contacts.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an iMessage and log campaign attempt")
    .option("--to <number>", "Recipient phone number (resolved from contact if omitted)")
    .requiredOption("--body <text>", "Message body")
    .requiredOption("--campaign-id <id>", "Campaign ID for tracking")
    .requiredOption("--contact-id <id>", "Contact ID for tracking")
    .action(
      async (opts: {
        to?: string;
        body: string;
        campaignId: string;
        contactId: string;
      }) => {
        // Resolve destination phone
        let normalized: string;
        if (opts.to) {
          normalized = normalizePhone(opts.to);
        } else {
          try {
            normalized = await resolveContactAddress(opts.contactId, "sms");
          } catch (err) {
            outputError(INPUT_ERROR, (err as Error).message);
            process.exit(INPUT_ERROR);
            return;
          }
        }

        try {
          sendIMessage(normalized, opts.body);
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            `Failed to send iMessage: ${(err as Error).message}`,
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        await appendCampaignEvent(opts.campaignId, {
          ts: isoNow(),
          contact_id: opts.contactId,
          type: "attempt",
          channel: "sms",
          result: "sent",
        });

        outputJson({ to: normalized, status: "sent" });
        process.exit(SUCCESS);
      },
    );
}
