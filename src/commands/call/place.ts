import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outreachConfig } from "../../config.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface PlaceOptions {
  to?: string;
  objective?: string;
  persona?: string;
  hangupWhen?: string;
  maxDuration?: string;
  waitForUser?: boolean;
  fromTwilio?: boolean;
  callOperator?: boolean;
}

export function registerPlaceCommand(parent: Command): void {
  parent
    .command("place")
    .description("Place an outbound call")
    .option("--to <number>", "Destination phone number (omit when using --call-operator)")
    .requiredOption("--objective <text>", "What this call should accomplish")
    .option("--persona <text>", "Who the AI agent is and how it should behave")
    .option("--hangup-when <text>", "Condition for ending the call")
    .option("--max-duration <seconds>", "Max call duration in seconds (default: from config, 600s)")
    .option("--wait-for-user", "Do not proactively greet; wait for the callee to speak first")
    .option("--from-twilio","Show the Twilio number (TWILIO_DEFAULT_FROM_NUMBER) as caller ID instead of the operator's personal number (PERSONAL_CALLER_ID)")
    .option("--call-operator", "Call the operator you're acting for (their PERSONAL_CALLER_ID), dialed from the Twilio number — e.g. to escalate something urgent that needs their input")
    .action(async (opts: PlaceOptions) => {
      // --call-operator calls the operator's own number, dialed from the Twilio number
      // (a caller ID can't equal the destination, so it can't be PERSONAL_CALLER_ID).
      // --from-twilio just swaps the displayed caller ID to the Twilio number for any destination.
      const useTwilioFrom = opts.callOperator || opts.fromTwilio;
      const from = useTwilioFrom ? outreachConfig.TWILIO_DEFAULT_FROM_NUMBER : outreachConfig.PERSONAL_CALLER_ID;
      if (!from) {
        const missingVar = useTwilioFrom ? "TWILIO_DEFAULT_FROM_NUMBER" : "PERSONAL_CALLER_ID";
        outputError(INPUT_ERROR, `${missingVar} is not set in .env`);
        process.exit(INPUT_ERROR);
        return;
      }

      const to = opts.to || (opts.callOperator ? outreachConfig.PERSONAL_CALLER_ID : undefined);
      if (!to) {
        const message = opts.callOperator
          ? "--call-operator requires PERSONAL_CALLER_ID to be set (the operator's number to call)"
          : "--to is required (or use --call-operator to call the operator you're acting for)";
        outputError(INPUT_ERROR, message);
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
          objective: opts.objective,
          persona: opts.persona,
          hangupWhen: opts.hangupWhen,
          maxDuration: maxDuration,
          waitForUserBeforeGreeting: opts.waitForUser,
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
