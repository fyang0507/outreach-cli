import { Command } from "commander";
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { relative } from "node:path";
import { loadAppConfig } from "../appConfig.js";
import { getAgentAdapter } from "../agents.js";
import {
  appendCampaignEvent,
  buildCallbackLogPath,
  findLatestCallbackRun,
  isoNow,
  readContact,
} from "../logs/sessionLog.js";
import { outputError } from "../output.js";
import { INFRA_ERROR } from "../exitCodes.js";

// Hidden subcommand — sundial's --command target. Never listed in `outreach --help`.
// Resolves the callback prompt, resumes the last agent session if one exists for
// this (contact, channel) tuple, spawns the agent while teeing stdout/stderr to
// a per-run log file, and appends a callback_run event to the campaign JSONL
// summarizing what happened (exit code, session capture, log file path).

interface RunOutcome {
  code: number;
  stdout: string;
}

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

// Filesystem-safe ISO-like stamp: "20260416T211842Z".
function fsTsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function runAgent(
  argv: string[],
  cwd: string,
  logStream: WriteStream,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      reject(new Error("empty argv"));
      return;
    }
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    logStream.write(
      `\n--- ${new Date().toISOString()} spawn: ${argv.map((a) => JSON.stringify(a)).join(" ")}\n`,
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      stdout += s;
      logStream.write(s);
      process.stdout.write(s);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      logStream.write(s);
      process.stderr.write(s);
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

        const prior = await findLatestCallbackRun(
          opts.campaignId,
          opts.contactId,
          opts.channel,
        );

        // Agent mismatch (config changed) invalidates the stored session.
        const canResume = prior !== null && prior.agent === callback_agent;
        const resumed = canResume;
        const priorSessionId = canResume ? prior!.session_id : undefined;

        const startedAt = new Date();
        const logPath = await buildCallbackLogPath({
          campaignId: opts.campaignId,
          contactId: opts.contactId,
          channel: opts.channel,
          fsTsStamp: fsTsStamp(startedAt),
        });
        const logStream = createWriteStream(logPath, { flags: "a" });

        const argv = canResume
          ? adapter.buildResumeArgs(priorSessionId!, prompt)
          : adapter.buildCreateArgs(prompt);

        let result = await runAgent(argv, config.data_repo_path, logStream);
        let fellBackToFresh = false;

        // Resume can fail if the session file is gone (expired, moved, etc).
        // Fall back to a fresh session so the callback still produces work.
        if (canResume && result.code !== 0) {
          fellBackToFresh = true;
          const freshArgv = adapter.buildCreateArgs(prompt);
          result = await runAgent(freshArgv, config.data_repo_path, logStream);
        }

        let newSessionId: string | undefined;
        try {
          newSessionId = adapter.parseSessionId(result.stdout);
        } catch {
          newSessionId = undefined;
        }

        await new Promise<void>((resolve) => logStream.end(resolve));

        const endedAt = new Date();
        const durationMs = endedAt.getTime() - startedAt.getTime();

        // Store the log path relative to data_repo_path so the JSONL stays
        // portable across machines that share the data repo.
        const logFileRel = relative(config.data_repo_path, logPath);

        await appendCampaignEvent(opts.campaignId, {
          ts: isoNow(),
          contact_id: opts.contactId,
          type: "callback_run",
          channel: opts.channel,
          agent: callback_agent,
          resumed: resumed && !fellBackToFresh,
          prior_session_id: priorSessionId ?? null,
          fell_back_to_fresh: fellBackToFresh,
          exit_code: result.code,
          duration_ms: durationMs,
          session_captured: newSessionId !== undefined,
          new_session_id: newSessionId ?? null,
          log_file: logFileRel,
        });

        process.exit(result.code);
      },
    );
}
