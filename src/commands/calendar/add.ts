import { Command } from "commander";
import { addCalendarEvent } from "../../providers/gcalendar.js";
import { appendCampaignEvent, isoNow } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";
import { validateOnce } from "../../once.js";

function withCalendarHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("invalid_grant") || lower.includes("401"))
    return `${msg}. Token may be expired. Run 'outreach health' to check, then re-authorize if needed.`;
  if (lower.includes("not found"))
    return `${msg}. Check that the calendar exists and is accessible.`;
  return `${msg}. Run 'outreach health' to check calendar readiness.`;
}

export function registerAddCommand(parent: Command): void {
  parent
    .command("add")
    .description("Add a Google Calendar event and log campaign attempt")
    .requiredOption("--summary <text>", "Event title")
    .requiredOption("--start <datetime>", "Start time (ISO 8601, e.g. 2026-04-22T14:00:00)")
    .requiredOption("--end <datetime>", "End time (ISO 8601, e.g. 2026-04-22T15:00:00)")
    .option("--campaign-id <id>", "Campaign ID for tracking (required unless --once)")
    .option("--contact-id <id>", "Contact ID for tracking (required unless --once)")
    .option("--description <text>", "Event description")
    .option("--location <text>", "Event location")
    .option("--attendees <emails...>", "Attendee email addresses")
    .option("--once", "Fire-and-forget adhoc event creation — no campaign event.")
    .action(
      async (opts: {
        summary: string;
        start: string;
        end: string;
        campaignId?: string;
        contactId?: string;
        description?: string;
        location?: string;
        attendees?: string[];
        once?: boolean;
      }) => {
        const mode = validateOnce("calendar-add", opts);

        if (mode === "campaign" && (!opts.campaignId || !opts.contactId)) {
          outputError(
            INPUT_ERROR,
            "Missing required --campaign-id and/or --contact-id. Either pass both to log this event against a campaign, or pass --once to create adhoc.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Validate dates
        const startDate = new Date(opts.start);
        const endDate = new Date(opts.end);

        if (isNaN(startDate.getTime())) {
          outputError(INPUT_ERROR, `Invalid start datetime: ${opts.start}. Expected ISO 8601, e.g. 2026-04-22T14:00:00`);
          process.exit(INPUT_ERROR);
          return;
        }
        if (isNaN(endDate.getTime())) {
          outputError(INPUT_ERROR, `Invalid end datetime: ${opts.end}. Expected ISO 8601, e.g. 2026-04-22T15:00:00`);
          process.exit(INPUT_ERROR);
          return;
        }
        if (endDate <= startDate) {
          outputError(INPUT_ERROR, "End time must be after start time");
          process.exit(INPUT_ERROR);
          return;
        }

        let result;
        try {
          result = await addCalendarEvent({
            summary: opts.summary,
            start: opts.start,
            end: opts.end,
            description: opts.description,
            location: opts.location,
            attendees: opts.attendees,
          });
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            withCalendarHint(`Failed to add calendar event: ${(err as Error).message}`),
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
            result: "created",
            event_id: result.event_id,
            summary: result.summary,
            start: result.start,
            end: result.end,
          });
        }

        outputJson({
          event_id: result.event_id,
          html_link: result.html_link,
          summary: result.summary,
          start: result.start,
          end: result.end,
          status: "created",
          ...(mode === "once" && { mode: "once" }),
        });
        process.exit(SUCCESS);
      },
    );
}
