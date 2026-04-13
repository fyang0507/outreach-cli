import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outreachConfig } from "../../config.js";
import { resolveContactAddress } from "../../contacts.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface PlaceOptions {
  to?: string;
  from?: string;
  campaignId: string;
  contactId: string;
  objective?: string;
  persona?: string;
  hangupWhen?: string;
  maxDuration?: string;
}

export function registerPlaceCommand(parent: Command): void {
  parent
    .command("place")
    .description("Place an outbound call")
    .option("--to <number>", "Destination phone number (resolved from contact if omitted)")
    .option("--from <number>", "Caller ID phone number")
    .requiredOption("--campaign-id <id>", "Campaign ID — auto-logs attempt to campaign JSONL")
    .requiredOption("--contact-id <id>", "Contact ID — used for address resolution and campaign tracking")
    .requiredOption("--objective <text>", "What this call should accomplish")
    .option("--persona <text>", "Who the AI agent is and how it should behave")
    .option("--hangup-when <text>", "Condition for ending the call")
    .option("--max-duration <seconds>", "Max call duration in seconds (default: from config, 300s)")
    .action(async (opts: PlaceOptions) => {
      // Resolve destination phone
      let to: string;
      if (opts.to) {
        to = opts.to;
      } else {
        try {
          to = await resolveContactAddress(opts.contactId, "call");
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

      try {
        const result = await sendToDaemon("call.place", {
          to,
          from,
          campaignId: opts.campaignId,
          contactId: opts.contactId,
          objective: opts.objective,
          persona: opts.persona,
          hangupWhen: opts.hangupWhen,
          maxDuration: opts.maxDuration ? parseInt(opts.maxDuration, 10) : undefined,
        });

        const res = result as { error?: string; message?: string };
        if (res.error) {
          outputError(INFRA_ERROR, res.message ?? res.error);
          process.exit(INFRA_ERROR);
          return;
        }

        outputJson(result);
        process.exit(SUCCESS);
      } catch (err) {
        outputError(INFRA_ERROR, `IPC error: ${(err as Error).message}`);
        process.exit(INFRA_ERROR);
      }
    });
}
