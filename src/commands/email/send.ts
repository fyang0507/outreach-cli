import { Command } from "commander";
import { sendEmail } from "../../providers/gmail.js";
import { resolveContactAddress } from "../../contacts.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";

function withEmailHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("invalid_grant") || lower.includes("401"))
    return `${msg}. Gmail token may be expired. Run 'outreach health' to check, then re-authorize if needed.`;
  if (lower.includes("recipient") || lower.includes("address"))
    return `${msg}. Check the --to address or contact email field.`;
  return `${msg}. Run 'outreach health' to check email channel readiness.`;
}

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an email via Gmail and log campaign attempt")
    .option("--to <address>", "Recipient email address (resolved from contact if omitted)")
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
        to?: string;
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
        // Resolve destination email
        let to: string;
        if (opts.to) {
          to = opts.to;
        } else {
          try {
            to = await resolveContactAddress(opts.contactId, "email");
          } catch (err) {
            outputError(INPUT_ERROR, (err as Error).message);
            process.exit(INPUT_ERROR);
            return;
          }
        }

        let result;
        try {
          result = await sendEmail({
            to,
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
            withEmailHint(`Failed to send email: ${(err as Error).message}`),
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
