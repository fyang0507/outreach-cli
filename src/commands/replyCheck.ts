import { Command } from "commander";
import { findLatestOutboundAttempt } from "../logs/sessionLog.js";
import { resolveContactAddress } from "../contacts.js";
import { readMessageHistory } from "../providers/messages.js";
import {
  getGmailClient,
  getSelfEmail,
  readEmailHistory,
} from "../providers/gmail.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";

// Exit codes for sundial poll trigger semantics:
// 0 = reply found (sundial fires callback)
// 1 = no reply yet (sundial retries)
// 2 = infra error (bad config, missing contact, provider failure)
// Note: this intentionally diverges from the CLI's usual exit-code scheme
// because reply-check is a scheduler-facing poll trigger, not a user command.

async function checkSmsReply(
  campaignId: string,
  contactId: string,
): Promise<void> {
  const attempt = await findLatestOutboundAttempt(
    campaignId,
    contactId,
    "sms",
  );
  if (!attempt) {
    outputJson({ replied: false, reason: "no_outbound_attempt" });
    process.exit(INPUT_ERROR);
    return;
  }

  let phone: string;
  try {
    phone = await resolveContactAddress(contactId, "sms");
  } catch (err) {
    outputError(INFRA_ERROR, (err as Error).message);
    process.exit(INFRA_ERROR);
    return;
  }

  const messages = readMessageHistory(phone, {
    since: attempt.ts,
    limit: 50,
  });

  const replies = messages.filter((m) => !m.is_from_me);

  if (replies.length > 0) {
    outputJson({
      replied: true,
      channel: "sms",
      contact_id: contactId,
      campaign_id: campaignId,
      reply_count: replies.length,
    });
    process.exit(SUCCESS);
  } else {
    outputJson({ replied: false });
    process.exit(INPUT_ERROR);
  }
}

async function checkEmailReply(
  campaignId: string,
  contactId: string,
): Promise<void> {
  const attempt = await findLatestOutboundAttempt(
    campaignId,
    contactId,
    "email",
  );
  if (!attempt) {
    outputJson({ replied: false, reason: "no_outbound_attempt" });
    process.exit(INPUT_ERROR);
    return;
  }

  let gmail;
  let selfEmail: string;
  try {
    gmail = await getGmailClient();
    selfEmail = await getSelfEmail(gmail);
  } catch (err) {
    outputError(INFRA_ERROR, `Gmail auth failed: ${(err as Error).message}`);
    process.exit(INFRA_ERROR);
    return;
  }

  // Prefer thread_id from the attempt; fall back to address-based lookup
  let messages;
  if (attempt.thread_id) {
    messages = await readEmailHistory({ threadId: attempt.thread_id });
  } else {
    let address: string;
    try {
      address = await resolveContactAddress(contactId, "email");
    } catch (err) {
      outputError(INFRA_ERROR, (err as Error).message);
      process.exit(INFRA_ERROR);
      return;
    }
    messages = await readEmailHistory({ address });
  }

  const watermark = new Date(attempt.ts);
  const replies = messages.filter((msg) => {
    const msgDate = new Date(msg.date);
    return (
      msgDate > watermark &&
      !msg.from.toLowerCase().includes(selfEmail.toLowerCase())
    );
  });

  if (replies.length > 0) {
    outputJson({
      replied: true,
      channel: "email",
      contact_id: contactId,
      campaign_id: campaignId,
      reply_count: replies.length,
    });
    process.exit(SUCCESS);
  } else {
    outputJson({ replied: false });
    process.exit(INPUT_ERROR);
  }
}

export function registerReplyCheckCommand(program: Command): void {
  program
    .command("reply-check")
    .description(
      "Check if a contact has replied since the last outbound message (sundial poll trigger)",
    )
    .requiredOption("--campaign-id <id>", "Campaign ID")
    .requiredOption("--contact-id <id>", "Contact ID")
    .requiredOption(
      "--channel <channel>",
      'Channel to check: "sms" or "email"',
    )
    .action(
      async (opts: {
        campaignId: string;
        contactId: string;
        channel: string;
      }) => {
        if (opts.channel !== "sms" && opts.channel !== "email") {
          outputError(
            INFRA_ERROR,
            `Invalid channel "${opts.channel}". Must be "sms" or "email".`,
          );
          process.exit(INFRA_ERROR);
          return;
        }

        try {
          if (opts.channel === "sms") {
            await checkSmsReply(opts.campaignId, opts.contactId);
          } else {
            await checkEmailReply(opts.campaignId, opts.contactId);
          }
        } catch (err) {
          outputError(
            INFRA_ERROR,
            `reply-check failed: ${(err as Error).message}`,
          );
          process.exit(INFRA_ERROR);
        }
      },
    );
}
