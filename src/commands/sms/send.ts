import { Command } from "commander";
import { sendIMessage, normalizePhone } from "../../providers/messages.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, OPERATION_FAILED } from "../../exitCodes.js";

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an iMessage and log campaign attempt")
    .requiredOption("--to <number>", "Recipient phone number")
    .requiredOption("--body <text>", "Message body")
    .requiredOption("--campaign-id <id>", "Campaign ID for tracking")
    .requiredOption("--contact-id <id>", "Contact ID for tracking")
    .action(
      async (opts: {
        to: string;
        body: string;
        campaignId: string;
        contactId: string;
      }) => {
        const normalized = normalizePhone(opts.to);

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
