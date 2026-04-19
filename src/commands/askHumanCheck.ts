import { Command } from "commander";
import { loadAppConfig } from "../appConfig.js";
import {
  findLatestHumanQuestion,
  hasNewHumanInputSince,
} from "../logs/sessionLog.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";

// Exit codes follow reply-check's scheduler-facing scheme:
// 0 = fire callback (human_input arrived or timeout elapsed)
// 1 = keep polling
// 2 = infra error

export function registerAskHumanCheckCommand(program: Command): void {
  program
    .command("ask-human-check", { hidden: true })
    .description(
      "[internal] Sundial poll trigger — exits 0 on new human_input or elapsed timeout",
    )
    .requiredOption("--campaign-id <id>", "Campaign ID")
    .requiredOption(
      "--contact-id <id>",
      "Contact ID (accepts sentinel __campaign__ for campaign-level)",
    )
    .action(
      async (opts: { campaignId: string; contactId: string }) => {
        try {
          const config = await loadAppConfig();
          if (!config.watch || !config.watch.enabled) {
            outputError(
              INFRA_ERROR,
              "watch is disabled — ask-human-check requires an enabled watch config.",
            );
            process.exit(INFRA_ERROR);
            return;
          }

          const isSentinel = opts.contactId === "__campaign__";
          const question = await findLatestHumanQuestion(
            opts.campaignId,
            isSentinel ? undefined : opts.contactId,
          );
          if (!question) {
            outputJson({ fired: false, reason: "no_human_question" });
            process.exit(INPUT_ERROR);
            return;
          }

          const arrived = await hasNewHumanInputSince(
            opts.campaignId,
            question.ts,
          );
          if (arrived) {
            outputJson({ fired: true, reason: "human_input" });
            process.exit(SUCCESS);
            return;
          }

          const elapsedHours =
            (Date.now() - new Date(question.ts).getTime()) / 3_600_000;
          if (elapsedHours > config.watch.default_timeout_hours) {
            outputJson({ fired: true, reason: "timeout" });
            process.exit(SUCCESS);
            return;
          }

          outputJson({ fired: false });
          process.exit(INPUT_ERROR);
        } catch (err) {
          outputError(
            INFRA_ERROR,
            `ask-human-check failed: ${(err as Error).message}`,
          );
          process.exit(INFRA_ERROR);
        }
      },
    );
}
