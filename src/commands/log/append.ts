import { Command } from "commander";
import { appendEvent } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR } from "../../exitCodes.js";

export function registerAppendCommand(parent: Command): void {
  parent
    .command("append")
    .description("Append an event to a campaign session log")
    .requiredOption("--campaign <id>", "Campaign ID")
    .requiredOption("--event <json>", "Event data as JSON string")
    .action(async (opts: { campaign: string; event: string }) => {
      let parsed: object;
      try {
        parsed = JSON.parse(opts.event) as object;
      } catch {
        outputError(INPUT_ERROR, "Invalid JSON in --event flag");
        process.exit(INPUT_ERROR);
        return;
      }

      await appendEvent(opts.campaign, parsed);
      outputJson({ appended: true, campaign: opts.campaign });
      process.exit(SUCCESS);
    });
}
