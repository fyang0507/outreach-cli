import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outreachConfig } from "../../config.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface PlaceOptions {
  to: string;
  from?: string;
  objective?: string;
  persona?: string;
  hangupWhen?: string;
  maxDuration?: string;
  amd?: boolean;
  waitForUser?: boolean;
  experimentalLocalVad?: boolean;
}

export function registerPlaceCommand(parent: Command): void {
  parent
    .command("place")
    .description("Place an outbound call")
    .requiredOption("--to <number>", "Destination phone number")
    .option("--from <number>", "Caller ID phone number")
    .requiredOption("--objective <text>", "What this call should accomplish")
    .option("--persona <text>", "Who the AI agent is and how it should behave")
    .option("--hangup-when <text>", "Condition for ending the call")
    .option("--max-duration <seconds>", "Max call duration in seconds (default: from config, 600s)")
    .option("--no-amd", "Disable Twilio answering-machine detection for lowest-latency experiments")
    .option("--wait-for-user", "Do not proactively greet; wait for remote speech before responding")
    .option("--experimental-local-vad", "Use experimental bridge-side endpointing for wait-for-user tests")
    .action(async (opts: PlaceOptions) => {
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
          to: opts.to,
          from,
          objective: opts.objective,
          persona: opts.persona,
          hangupWhen: opts.hangupWhen,
          maxDuration: maxDuration,
          amd: opts.amd,
          waitForUserBeforeGreeting: opts.waitForUser,
          experimentalLocalVad: opts.experimentalLocalVad,
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
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
