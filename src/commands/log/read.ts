import { Command } from "commander";
import { readLog } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR } from "../../exitCodes.js";

export function registerReadCommand(parent: Command): void {
  parent
    .command("read")
    .description("Read events from a campaign session log")
    .requiredOption("--campaign <id>", "Campaign ID")
    .option("--last", "Return only the most recent event")
    .action(async (opts: { campaign: string; last?: boolean }) => {
      const events = await readLog(opts.campaign);

      if (opts.last) {
        if (events.length === 0) {
          outputError(INPUT_ERROR, `No events found for campaign "${opts.campaign}"`);
          process.exit(INPUT_ERROR);
          return;
        }
        outputJson(events[events.length - 1]);
      } else {
        outputJson(events);
      }
      process.exit(SUCCESS);
    });
}
