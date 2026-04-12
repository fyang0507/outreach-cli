import { Command } from "commander";
import { readCampaignEvents, readContact } from "../logs/sessionLog.js";
import { readMessageHistory, normalizePhone } from "../providers/messages.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";

export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description("Assemble cross-channel context for a campaign")
    .requiredOption("--campaign-id <id>", "Campaign ID")
    .option("--contact-id <id>", "Filter to a specific contact")
    .option("--since <days>", "Days of message history to include", "7")
    .action(
      async (opts: {
        campaignId: string;
        contactId?: string;
        since: string;
      }) => {
        const sinceDays = parseInt(opts.since, 10);

        // 1. Read campaign
        let header: Record<string, unknown>;
        let allEvents: Record<string, unknown>[];
        try {
          ({ header, events: allEvents } = await readCampaignEvents(
            opts.campaignId,
          ));
        } catch (err) {
          const msg = (err as Error).message;
          const code = msg.includes("ENOENT") ? INPUT_ERROR : INFRA_ERROR;
          outputError(code, `Failed to read campaign: ${msg}`);
          process.exit(code);
          return;
        }

        // 2. Filter events if --contact-id
        let events = allEvents;
        if (opts.contactId) {
          events = allEvents.filter(
            (e) =>
              !("contact_id" in e) || e.contact_id === opts.contactId,
          );
        }

        // 3. Determine contacts to include
        let contactIds: string[];
        if (opts.contactId) {
          contactIds = [opts.contactId];
        } else {
          const contacts = header.contacts;
          contactIds = Array.isArray(contacts)
            ? (contacts as string[])
            : [];
        }

        // 4. For each contact, gather recent messages per channel
        const recentMessages: Record<
          string,
          Record<string, unknown>
        > = {};

        for (const cid of contactIds) {
          // Read contact to get phone
          let contact: Record<string, unknown>;
          try {
            contact = await readContact(cid);
          } catch {
            continue; // contact file not found, skip
          }

          const phone =
            typeof contact.phone === "string" ? contact.phone : null;

          // Detect channels from events for this contact
          const channels = new Set<string>();
          for (const e of events) {
            if (e.contact_id === cid && typeof e.channel === "string") {
              channels.add(e.channel);
            }
          }

          const channelMessages: Record<string, unknown> = {};

          if (channels.has("sms") && phone) {
            try {
              const messages = readMessageHistory(normalizePhone(phone), {
                limit: 10,
                sinceDays,
              });
              channelMessages.sms = messages;
            } catch {
              // DB not accessible, skip
            }
          }

          if (Object.keys(channelMessages).length > 0) {
            recentMessages[cid] = channelMessages;
          }
        }

        outputJson({
          campaign: header,
          events,
          recent_messages: recentMessages,
        });
        process.exit(SUCCESS);
      },
    );
}
