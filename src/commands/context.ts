import { Command } from "commander";
import { readCampaignEvents, readContact } from "../logs/sessionLog.js";
import { readMessageHistory, normalizePhone } from "../providers/messages.js";
import { readEmailThreads } from "../providers/gmail.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";
import type { Contact } from "../contacts.js";

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
        const sinceCutoffMs =
          Number.isFinite(sinceDays) && sinceDays > 0
            ? Date.now() - sinceDays * 86_400_000
            : null;

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

        // 2. Filter events: --contact-id narrows to a single person; --since
        // drops events older than the window. Header is always returned in
        // full (separate field), so campaign objective/contacts are never lost.
        let events = allEvents;
        if (opts.contactId) {
          events = events.filter(
            (e) =>
              !("contact_id" in e) || e.contact_id === opts.contactId,
          );
        }
        if (sinceCutoffMs !== null) {
          events = events.filter((e) => {
            const ts = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
            return Number.isFinite(ts) ? ts >= sinceCutoffMs : true;
          });
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
          // Read contact to get phone/email
          let contact: Contact;
          try {
            contact = await readContact(cid);
          } catch {
            continue; // contact file not found, skip
          }

          // Prefer sms_phone for SMS history, fall back to phone
          const smsPhone = contact.sms_phone ?? contact.phone ?? null;

          // Detect channels from events for this contact
          const channels = new Set<string>();
          for (const e of events) {
            if (e.contact_id === cid && typeof e.channel === "string") {
              channels.add(e.channel);
            }
          }

          const channelMessages: Record<string, unknown> = {};

          if (channels.has("sms") && smsPhone) {
            try {
              const messages = readMessageHistory(normalizePhone(smsPhone), {
                limit: 10,
                sinceDays,
              });
              channelMessages.sms = messages;
            } catch {
              // DB not accessible, skip
            }
          }

          if (channels.has("email")) {
            // Extract tracked thread_ids from campaign events
            const emailThreadIds = new Set<string>();
            for (const e of events) {
              if (
                e.contact_id === cid &&
                e.channel === "email" &&
                typeof e.thread_id === "string"
              ) {
                emailThreadIds.add(e.thread_id);
              }
            }

            try {
              const threadIds = [...emailThreadIds];
              if (threadIds.length > 0) {
                channelMessages.email_threads = await readEmailThreads({
                  threadIds,
                  sinceDays,
                });
              } else {
                const emailAddr = contact.email ?? null;
                if (emailAddr) {
                  channelMessages.email_threads = await readEmailThreads({
                    address: emailAddr,
                    limit: 10,
                    sinceDays,
                  });
                }
              }
            } catch {
              // Gmail not accessible, skip
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
