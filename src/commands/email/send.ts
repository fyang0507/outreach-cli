import { Command } from "commander";
import { sendEmail } from "../../providers/gmail.js";
import { resolveContactAddress } from "../../contacts.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";
import { registerReplyWatch, type WatchResult } from "../../watch.js";
import { validateOnce } from "../../once.js";

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
    .option("--to <address>", "Recipient email address (resolved from contact if omitted; required with --once)")
    .requiredOption("--subject <text>", "Email subject")
    .requiredOption("--body <text>", "Email body (plain text)")
    .option("--campaign-id <id>", "Campaign ID for tracking (required unless --once)")
    .option("--contact-id <id>", "Contact ID for tracking (required unless --once)")
    .option("--cc <addresses>", "CC recipients (comma-separated)")
    .option("--bcc <addresses>", "BCC recipients (comma-separated)")
    .option("--reply-to-id <id>", "Gmail message ID to reply to (enables threading)")
    .option("--no-reply-all", "Reply to sender only (default is reply-all when --reply-to-id is set)")
    .option("--attach <paths...>", "File paths to attach")
    .option("--fire-and-forget", "Skip reply watcher registration")
    .option("--once", "Fire-and-forget adhoc send — no campaign state, no watcher. Requires --to.")
    .action(
      async (opts: {
        to?: string;
        subject: string;
        body: string;
        campaignId?: string;
        contactId?: string;
        cc?: string;
        bcc?: string;
        replyToId?: string;
        replyAll: boolean;
        attach?: string[];
        fireAndForget?: boolean;
        once?: boolean;
      }) => {
        const mode = validateOnce("email", opts);

        if (mode === "campaign" && (!opts.campaignId || !opts.contactId)) {
          outputError(
            INPUT_ERROR,
            "Missing required --campaign-id and/or --contact-id. Either pass both to log this send against a campaign, or pass --once (with --to) to send adhoc.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Resolve destination email
        let to: string;
        if (opts.to) {
          to = opts.to;
        } else {
          try {
            to = await resolveContactAddress(opts.contactId!, "email");
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

        if (mode === "campaign") {
          await appendCampaignEvent(opts.campaignId!, {
            ts: isoNow(),
            contact_id: opts.contactId!,
            type: "attempt",
            channel: "email",
            result: "sent",
            message_id: result.messageId,
            thread_id: result.threadId,
            await_reply: !opts.fireAndForget,
          });
        }

        // Register reply watcher (never blocks send)
        let watchResult: WatchResult | null = null;
        if (mode === "campaign" && !opts.fireAndForget) {
          try {
            watchResult = await registerReplyWatch({
              campaignId: opts.campaignId!,
              contactId: opts.contactId!,
              channel: "email",
            });
            if (watchResult.schedule_id) {
              await appendCampaignEvent(opts.campaignId!, {
                ts: isoNow(),
                contact_id: opts.contactId!,
                type: "watch",
                channel: "email",
                watch_schedule_id: watchResult.schedule_id,
                watch_status: watchResult.status,
              });
            }
          } catch {
            watchResult = { status: "failed", error: "sundial unavailable" };
          }
        }

        let watch: WatchResult | { status: "skipped"; reason?: string } | null;
        if (mode === "once") {
          watch = { status: "skipped", reason: "once" };
        } else if (opts.fireAndForget) {
          watch = null;
        } else {
          watch = watchResult ?? { status: "skipped" };
        }

        outputJson({
          to: result.to,
          cc: result.cc,
          subject: result.subject,
          message_id: result.messageId,
          thread_id: result.threadId,
          status: "sent",
          watch,
        });
        process.exit(SUCCESS);
      },
    );
}
