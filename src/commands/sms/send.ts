import { Command } from "commander";
import {
  sendIMessage,
  normalizePhone,
  pickService,
} from "../../providers/messages.js";
import { resolveContactAddress } from "../../contacts.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";
import { registerReplyWatch, type WatchResult } from "../../watch.js";
import { validateOnce } from "../../once.js";

function withSmsHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("not allowed") || lower.includes("not permitted"))
    return `${msg}. Grant Accessibility access to your terminal app in System Settings → Privacy & Security.`;
  if (lower.includes("text message forwarding"))
    return `${msg}`;
  if (lower.includes("not delivered") || lower.includes("error code"))
    return `${msg}. The message reached Messages.app but delivery failed — the number may not accept this service. Try a different channel or ask_human.`;
  if (lower.includes("delivery status unknown"))
    return `${msg}. Messages.app may still be retrying — check the Messages app UI directly, or retry after confirming.`;
  return `${msg}. Check that Messages.app is signed in. Run 'outreach health' to check SMS readiness.`;
}

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an iMessage and log campaign attempt")
    .option("--to <number>", "Recipient phone number (resolved from contact if omitted; required with --once)")
    .requiredOption("--body <text>", "Message body")
    .option("--campaign-id <id>", "Campaign ID for tracking (required unless --once)")
    .option("--contact-id <id>", "Contact ID for tracking (required unless --once)")
    .option("--fire-and-forget", "Skip reply watcher registration")
    .option("--once", "Fire-and-forget adhoc send — no campaign state, no watcher. Requires --to.")
    .action(
      async (opts: {
        to?: string;
        body: string;
        campaignId?: string;
        contactId?: string;
        fireAndForget?: boolean;
        once?: boolean;
      }) => {
        const mode = validateOnce("sms", opts);

        if (mode === "campaign" && (!opts.campaignId || !opts.contactId)) {
          outputError(
            INPUT_ERROR,
            "Missing required --campaign-id and/or --contact-id. Either pass both to log this send against a campaign, or pass --once (with --to) to send adhoc.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Resolve destination phone
        let normalized: string;
        if (opts.to) {
          normalized = normalizePhone(opts.to);
        } else {
          try {
            normalized = await resolveContactAddress(opts.contactId!, "sms");
          } catch (err) {
            outputError(INPUT_ERROR, (err as Error).message);
            process.exit(INPUT_ERROR);
            return;
          }
        }

        // Pick service from history; fall back to iMessage on any lookup error.
        let service: "iMessage" | "SMS";
        try {
          service = pickService(normalized);
        } catch {
          service = "iMessage";
        }

        let sendResult;
        try {
          sendResult = sendIMessage(normalized, opts.body, { service });
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            withSmsHint(`Failed to send message: ${(err as Error).message}`),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        if (sendResult.status === "failed") {
          const codeStr = sendResult.error_code !== undefined
            ? ` (error code ${sendResult.error_code})`
            : "";
          outputError(
            OPERATION_FAILED,
            withSmsHint(
              `Message not delivered${codeStr} over ${sendResult.service}`,
            ),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        if (sendResult.status === "timeout") {
          outputError(
            OPERATION_FAILED,
            withSmsHint(
              `Delivery status unknown after 90s over ${sendResult.service}`,
            ),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        if (mode === "campaign") {
          await appendCampaignEvent(opts.campaignId!, {
            ts: isoNow(),
            contact_id: opts.contactId!,
            type: "attempt",
            channel: "sms",
            result: "sent",
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
              channel: "sms",
            });
            if (watchResult.schedule_id) {
              await appendCampaignEvent(opts.campaignId!, {
                ts: isoNow(),
                contact_id: opts.contactId!,
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

        let watch: WatchResult | { status: "skipped"; reason?: string } | null;
        if (mode === "once") {
          watch = { status: "skipped", reason: "once" };
        } else if (opts.fireAndForget) {
          watch = null;
        } else {
          watch = watchResult ?? { status: "skipped" };
        }

        outputJson({
          to: normalized,
          status: "sent",
          service: sendResult.service,
          watch,
        });
        process.exit(SUCCESS);
      },
    );
}
