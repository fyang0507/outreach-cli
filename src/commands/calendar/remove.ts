import { Command } from "commander";
import { removeCalendarEvent } from "../../providers/gcalendar.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";
import { validateOnce } from "../../once.js";

function withCalendarHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("invalid_grant") || lower.includes("401"))
    return `${msg}. Token may be expired. Run 'outreach health' to check, then re-authorize if needed.`;
  if (lower.includes("not found") || lower.includes("404"))
    return `${msg}. Event may have already been removed. Check the --event-id.`;
  return `${msg}. Run 'outreach health' to check calendar readiness.`;
}

export function registerRemoveCommand(parent: Command): void {
  parent
    .command("remove")
    .description("Remove a Google Calendar event and log campaign attempt")
    .requiredOption("--event-id <id>", "Google Calendar event ID")
    .option("--campaign-id <id>", "Campaign ID for tracking (required unless --once)")
    .option("--contact-id <id>", "Contact ID for tracking (required unless --once)")
    .option("--once", "Fire-and-forget adhoc event removal — no campaign event.")
    .action(
      async (opts: {
        eventId: string;
        campaignId?: string;
        contactId?: string;
        once?: boolean;
      }) => {
        const mode = validateOnce("calendar-remove", opts);

        if (mode === "campaign" && (!opts.campaignId || !opts.contactId)) {
          outputError(
            INPUT_ERROR,
            "Missing required --campaign-id and/or --contact-id. Either pass both to log this removal against a campaign, or pass --once to remove adhoc.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        let result;
        try {
          result = await removeCalendarEvent(opts.eventId);
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            withCalendarHint(`Failed to remove calendar event: ${(err as Error).message}`),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        if (mode === "campaign") {
          await appendCampaignEvent(opts.campaignId!, {
            ts: isoNow(),
            contact_id: opts.contactId!,
            type: "attempt",
            channel: "calendar",
            result: "removed",
            event_id: result.event_id,
          });
        }

        outputJson({
          event_id: result.event_id,
          status: "removed",
          ...(mode === "once" && { mode: "once" }),
        });
        process.exit(SUCCESS);
      },
    );
}
