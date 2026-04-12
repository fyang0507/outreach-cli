import { Command } from "commander";
import { sendEmail } from "../../providers/gmail.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, OPERATION_FAILED } from "../../exitCodes.js";

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an email via Gmail and log campaign attempt")
    .requiredOption("--to <address>", "Recipient email address")
    .requiredOption("--subject <text>", "Email subject")
    .requiredOption("--body <text>", "Email body (plain text)")
    .requiredOption("--campaign-id <id>", "Campaign ID for tracking")
    .requiredOption("--contact-id <id>", "Contact ID for tracking")
    .option("--cc <addresses>", "CC recipients (comma-separated)")
    .option("--bcc <addresses>", "BCC recipients (comma-separated)")
    .option("--reply-to-id <id>", "Gmail message ID to reply to (enables threading)")
    .option("--no-reply-all", "Reply to sender only (default is reply-all when --reply-to-id is set)")
    .option("--attach <paths...>", "File paths to attach")
    .action(
      async (opts: {
        to: string;
        subject: string;
        body: string;
        campaignId: string;
        contactId: string;
        cc?: string;
        bcc?: string;
        replyToId?: string;
        replyAll: boolean;
        attach?: string[];
      }) => {
        let result;
        try {
          result = await sendEmail({
            to: opts.to,
            subject: opts.subject,
            body: opts.body,
            cc: opts.cc,
            bcc: opts.bcc,
            replyToId: opts.replyToId,
            replyAll: opts.replyAll,
            attachments: opts.attach,
          });
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            `Failed to send email: ${(err as Error).message}`,
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        await appendCampaignEvent(opts.campaignId, {
          ts: isoNow(),
          contact_id: opts.contactId,
          type: "attempt",
          channel: "email",
          result: "sent",
          message_id: result.messageId,
          thread_id: result.threadId,
        });

        outputJson({
          to: result.to,
          cc: result.cc,
          subject: result.subject,
          message_id: result.messageId,
          thread_id: result.threadId,
          status: "sent",
        });
        process.exit(SUCCESS);
      },
    );
}
