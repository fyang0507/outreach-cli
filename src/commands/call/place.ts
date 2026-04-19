import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outreachConfig } from "../../config.js";
import { resolveContactAddress } from "../../contacts.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";
import { validateOnce } from "../../once.js";

interface PlaceOptions {
  to?: string;
  from?: string;
  campaignId?: string;
  contactId?: string;
  objective?: string;
  persona?: string;
  hangupWhen?: string;
  maxDuration?: string;
  once?: boolean;
}

export function registerPlaceCommand(parent: Command): void {
  parent
    .command("place")
    .description("Place an outbound call")
    .option("--to <number>", "Destination phone number (resolved from contact if omitted; required with --once)")
    .option("--from <number>", "Caller ID phone number")
    .option("--campaign-id <id>", "Campaign ID — auto-logs attempt to campaign JSONL (required unless --once)")
    .option("--contact-id <id>", "Contact ID — used for address resolution and campaign tracking (required unless --once)")
    .requiredOption("--objective <text>", "What this call should accomplish")
    .option("--persona <text>", "Who the AI agent is and how it should behave")
    .option("--hangup-when <text>", "Condition for ending the call")
    .option("--max-duration <seconds>", "Max call duration in seconds (default: from config, 300s)")
    .option("--once", "Fire-and-forget adhoc call — no campaign event. Transcript still written. Requires --to.")
    .action(async (opts: PlaceOptions) => {
      const mode = validateOnce("call", opts);

      if (mode === "campaign" && (!opts.campaignId || !opts.contactId)) {
        outputError(
          INPUT_ERROR,
          "Missing required --campaign-id and/or --contact-id. Either pass both to log this call against a campaign, or pass --once (with --to) to place adhoc.",
        );
        process.exit(INPUT_ERROR);
        return;
      }

      // Resolve destination phone
      let to: string;
      if (opts.to) {
        to = opts.to;
      } else {
        try {
          to = await resolveContactAddress(opts.contactId!, "call");
        } catch (err) {
          outputError(INPUT_ERROR, (err as Error).message);
          process.exit(INPUT_ERROR);
          return;
        }
      }

      const from = opts.from || outreachConfig.OUTREACH_DEFAULT_FROM;
      if (!from) {
        outputError(INPUT_ERROR, "No --from number provided and OUTREACH_DEFAULT_FROM is not set");
        process.exit(INPUT_ERROR);
        return;
      }

      try {
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      let maxDuration: number | undefined;
      if (opts.maxDuration) {
        maxDuration = parseInt(opts.maxDuration, 10);
        if (isNaN(maxDuration) || maxDuration <= 0) {
          outputError(INPUT_ERROR, "--max-duration must be a positive integer (seconds)");
          process.exit(INPUT_ERROR);
          return;
        }
      }

      try {
        const result = await sendToDaemon("call.place", {
          to,
          from,
          campaignId: mode === "once" ? undefined : opts.campaignId,
          contactId: mode === "once" ? undefined : opts.contactId,
          objective: opts.objective,
          persona: opts.persona,
          hangupWhen: opts.hangupWhen,
          maxDuration: maxDuration,
        });

        const res = result as { error?: string; message?: string };
        if (res.error) {
          outputError(INFRA_ERROR, res.message ?? res.error);
          process.exit(INFRA_ERROR);
          return;
        }

        outputJson(mode === "once" ? { ...(result as object), mode: "once" } : result);
        process.exit(SUCCESS);
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
