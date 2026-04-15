import { Command } from "commander";
import { removeCalendarEvent } from "../../providers/gcalendar.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, OPERATION_FAILED } from "../../exitCodes.js";

export function registerRemoveCommand(parent: Command): void {
  parent
    .command("remove")
    .description("Remove a Google Calendar event and log campaign attempt")
    .requiredOption("--event-id <id>", "Google Calendar event ID")
    .requiredOption("--campaign-id <id>", "Campaign ID for tracking")
    .requiredOption("--contact-id <id>", "Contact ID for tracking")
    .action(
      async (opts: {
        eventId: string;
        campaignId: string;
        contactId: string;
      }) => {
        let result;
        try {
          result = await removeCalendarEvent(opts.eventId);
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            `Failed to remove calendar event: ${(err as Error).message}`,
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        await appendCampaignEvent(opts.campaignId, {
          ts: isoNow(),
          contact_id: opts.contactId,
          type: "attempt",
          channel: "calendar",
          result: "removed",
          event_id: result.event_id,
        });

        outputJson({
          event_id: result.event_id,
          status: "removed",
        });
        process.exit(SUCCESS);
      },
    );
}
