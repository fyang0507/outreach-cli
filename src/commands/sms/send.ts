import { Command } from "commander";
import { sendIMessage, normalizePhone } from "../../providers/messages.js";
import { resolveContactAddress } from "../../contacts.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";
import { registerReplyWatch, type WatchResult } from "../../watch.js";

function withSmsHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("not allowed") || lower.includes("not permitted"))
    return `${msg}. Grant Accessibility access to your terminal app in System Settings → Privacy & Security.`;
  return `${msg}. Check that Messages.app is signed in. Run 'outreach health' to check SMS readiness.`;
}

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an iMessage and log campaign attempt")
    .option("--to <number>", "Recipient phone number (resolved from contact if omitted)")
    .requiredOption("--body <text>", "Message body")
    .requiredOption("--campaign-id <id>", "Campaign ID for tracking")
    .requiredOption("--contact-id <id>", "Contact ID for tracking")
    .option("--fire-and-forget", "Skip reply watcher registration")
    .action(
      async (opts: {
        to?: string;
        body: string;
        campaignId: string;
        contactId: string;
        fireAndForget?: boolean;
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
            withSmsHint(`Failed to send iMessage: ${(err as Error).message}`),
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
          await_reply: !opts.fireAndForget,
        });

        // Register reply watcher (never blocks send)
        let watchResult: WatchResult | null = null;
        if (!opts.fireAndForget) {
          try {
            watchResult = await registerReplyWatch({
              campaignId: opts.campaignId,
              contactId: opts.contactId,
              channel: "sms",
            });
            if (watchResult.schedule_id) {
              await appendCampaignEvent(opts.campaignId, {
                ts: isoNow(),
                contact_id: opts.contactId,
                type: "watch",
                channel: "sms",
                watch_schedule_id: watchResult.schedule_id,
                watch_status: watchResult.status,
              });
            }
          } catch {
            watchResult = { status: "failed", error: "sundial unavailable" };
          }
        }

        outputJson({
          to: normalized,
          status: "sent",
          watch: opts.fireAndForget
            ? null
            : (watchResult ?? { status: "skipped" }),
        });
        process.exit(SUCCESS);
      },
    );
}
