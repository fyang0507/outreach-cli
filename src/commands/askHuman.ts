import { Command } from "commander";
import { loadAppConfig } from "../appConfig.js";
import {
  appendCampaignEvent,
  isoNow,
  readContact,
} from "../logs/sessionLog.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../exitCodes.js";
import { registerAskHumanWatch, type WatchResult } from "../watch.js";

export function registerAskHumanCommand(program: Command): void {
  program
    .command("ask-human")
    .description(
      "Write a human_question event and register a watch that resumes your session when the operator replies",
    )
    .requiredOption("--campaign-id <id>", "Campaign ID")
    .requiredOption("--question <text>", "Question to ask the operator")
    .option("--contact-id <id>", "Optional contact ID (campaign-level if omitted)")
    .option("--context <text>", "Optional context/framing for observer and agent")
    .action(
      async (opts: {
        campaignId: string;
        question: string;
        contactId?: string;
        context?: string;
      }) => {
        if (!opts.question.trim()) {
          outputError(INPUT_ERROR, "--question must be non-empty");
          process.exit(INPUT_ERROR);
          return;
        }

        const config = await loadAppConfig();
        if (!config.watch || !config.watch.enabled) {
          outputError(
            INPUT_ERROR,
            "ask-human requires watch.enabled=true in outreach.config.yaml",
          );
          process.exit(INPUT_ERROR);
          return;
        }
        if (
          !config.watch.callback_prompt_human_input ||
          !config.watch.callback_prompt_human_input_timeout
        ) {
          outputError(
            INFRA_ERROR,
            "watch.callback_prompt_human_input and watch.callback_prompt_human_input_timeout must be configured (see outreach.config.example.yaml)",
          );
          process.exit(INFRA_ERROR);
          return;
        }

        if (opts.contactId) {
          try {
            await readContact(opts.contactId);
          } catch (err) {
            process.stderr.write(
              `warn: ${(err as Error).message}\n`,
            );
          }
        }

        const questionTs = isoNow();
        const event: Record<string, unknown> = {
          ts: questionTs,
          type: "human_question",
          campaign_id: opts.campaignId,
          question: opts.question,
        };
        if (opts.contactId) event.contact_id = opts.contactId;
        if (opts.context) event.context = opts.context;

        await appendCampaignEvent(opts.campaignId, event);

        let watchResult: WatchResult;
        try {
          watchResult = await registerAskHumanWatch({
            campaignId: opts.campaignId,
            contactId: opts.contactId,
          });
        } catch {
          watchResult = { status: "failed", error: "sundial unavailable" };
        }

        if (watchResult.schedule_id) {
          const watchEvent: Record<string, unknown> = {
            ts: isoNow(),
            type: "watch",
            channel: "human_input",
            watch_schedule_id: watchResult.schedule_id,
            watch_status: watchResult.status,
          };
          if (opts.contactId) watchEvent.contact_id = opts.contactId;
          await appendCampaignEvent(opts.campaignId, watchEvent);
        }

        outputJson({
          campaign_id: opts.campaignId,
          contact_id: opts.contactId ?? null,
          question_ts: questionTs,
          watch: watchResult,
        });
        process.exit(SUCCESS);
      },
    );
}
