import { outputError } from "./output.js";
import { INPUT_ERROR } from "./exitCodes.js";

export type OnceChannel = "sms" | "email" | "call" | "calendar-add" | "calendar-remove";

export interface OnceInput {
  once?: boolean;
  campaignId?: string;
  contactId?: string;
  to?: string;
  fireAndForget?: boolean;
}

/**
 * Validate --once against its mutually-exclusive siblings and the channel's
 * minimum destination. Exits on misuse. Returns the operating mode — callers
 * branch on it for campaign state writes.
 */
export function validateOnce(
  channel: OnceChannel,
  opts: OnceInput,
): "once" | "campaign" {
  if (!opts.once) return "campaign";

  if (opts.campaignId) {
    outputError(
      INPUT_ERROR,
      "--campaign-id is not allowed with --once. --once means 'no campaign tracking'. " +
        "Remove --campaign-id (and --contact-id) to send adhoc, or remove --once to log this send against the campaign.",
    );
    process.exit(INPUT_ERROR);
  }

  if (opts.contactId) {
    outputError(
      INPUT_ERROR,
      "--contact-id is not allowed with --once. --once skips contact lookup. " +
        "Remove --contact-id and pass --to directly, or remove --once to resolve the address from the contact record.",
    );
    process.exit(INPUT_ERROR);
  }

  if (opts.fireAndForget) {
    outputError(
      INPUT_ERROR,
      "--fire-and-forget is redundant with --once (which already skips the reply watcher). Remove --fire-and-forget.",
    );
    process.exit(INPUT_ERROR);
  }

  switch (channel) {
    case "sms":
    case "call":
      if (!opts.to) {
        outputError(
          INPUT_ERROR,
          "--once requires --to <number>. --once skips contact lookup, so the destination must be explicit. " +
            "Example: --once --to +15551234567. (Or remove --once and pass --campaign-id + --contact-id to resolve from a contact.)",
        );
        process.exit(INPUT_ERROR);
      }
      break;
    case "email":
      if (!opts.to) {
        outputError(
          INPUT_ERROR,
          "--once requires --to <address>. --once skips contact lookup, so the destination must be explicit. " +
            "Example: --once --to someone@example.com. (Or remove --once and pass --campaign-id + --contact-id to resolve from a contact.)",
        );
        process.exit(INPUT_ERROR);
      }
      break;
    case "calendar-add":
    case "calendar-remove":
      break;
  }

  return "once";
}
