import { Command } from "commander";
import { spawn } from "node:child_process";
import { loadAppConfig } from "../appConfig.js";
import { getAgentAdapter } from "../agents.js";
import {
  appendCampaignEvent,
  findLatestCallbackSession,
  isoNow,
  readContact,
} from "../logs/sessionLog.js";
import { outputError } from "../output.js";
import { INFRA_ERROR } from "../exitCodes.js";

// Hidden subcommand — sundial's --command target. Never listed in `outreach --help`.
// Resolves the callback prompt, resumes the last agent session if one exists for
// this (contact, channel) tuple, captures the new session ID from the agent's
// structured output, and appends a callback_session event to the campaign JSONL
// so the next callback can resume.

function resolvePrompt(
  template: string,
  opts: {
    campaignId: string;
    contactId: string;
    channel: string;
    contactName: string;
  },
): string {
  return template
    .replace(/\{contact_id\}/g, opts.contactId)
    .replace(/\{campaign_id\}/g, opts.campaignId)
    .replace(/\{channel\}/g, opts.channel)
    .replace(/\{contact_name\}/g, opts.contactName);
}

function runAgent(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      reject(new Error("empty argv"));
      return;
    }
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      stdout += s;
      // Mirror agent output so sundial logs see it.
      process.stdout.write(s);
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout }));
  });
}

export function registerCallbackDispatchCommand(program: Command): void {
  program
    .command("callback-dispatch", { hidden: true })
    .description(
      "[internal] Sundial callback target — spawns the configured agent, resuming prior session when available",
    )
    .requiredOption("--campaign-id <id>", "Campaign ID")
    .requiredOption("--contact-id <id>", "Contact ID")
    .requiredOption("--channel <channel>", 'Channel: "sms" or "email"')
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

        const config = await loadAppConfig();
        if (!config.watch || !config.watch.enabled) {
          outputError(
            INFRA_ERROR,
            "watch is disabled — callback-dispatch requires an enabled watch config.",
          );
          process.exit(INFRA_ERROR);
          return;
        }

        const { callback_agent, callback_prompt } = config.watch;

        let adapter;
        try {
          adapter = getAgentAdapter(callback_agent);
        } catch (err) {
          outputError(INFRA_ERROR, (err as Error).message);
          process.exit(INFRA_ERROR);
          return;
        }

        let contactName = opts.contactId;
        try {
          const contact = await readContact(opts.contactId);
          if (contact.name) contactName = contact.name;
        } catch {
          // Missing contact shouldn't block the callback — fall back to the ID.
        }

        const prompt = resolvePrompt(callback_prompt, {
          campaignId: opts.campaignId,
          contactId: opts.contactId,
          channel: opts.channel,
          contactName,
        });

        const prior = await findLatestCallbackSession(
          opts.campaignId,
          opts.contactId,
          opts.channel,
        );

        // Agent mismatch (config changed) invalidates the stored session.
        const canResume = prior !== null && prior.agent === callback_agent;

        const argv = canResume
          ? adapter.buildResumeArgs(prior.agent_session_id, prompt)
          : adapter.buildCreateArgs(prompt);

        let result = await runAgent(argv, config.data_repo_path);

        // Resume can fail if the session file is gone (expired, moved, etc).
        // Fall back to a fresh session so the callback still produces work.
        if (canResume && result.code !== 0) {
          const freshArgv = adapter.buildCreateArgs(prompt);
          result = await runAgent(freshArgv, config.data_repo_path);
        }

        let sessionId: string | undefined;
        try {
          sessionId = adapter.parseSessionId(result.stdout);
        } catch {
          sessionId = undefined;
        }

        if (sessionId) {
          await appendCampaignEvent(opts.campaignId, {
            ts: isoNow(),
            contact_id: opts.contactId,
            type: "callback_session",
            channel: opts.channel,
            agent: callback_agent,
            agent_session_id: sessionId,
          });
        }

        process.exit(result.code);
      },
    );
}
