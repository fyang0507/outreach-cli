import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadAppConfig } from "./appConfig.js";

const execFile = promisify(execFileCb);

export interface WatchResult {
  schedule_id?: string;
  status: "created" | "reactivated" | "updated" | "skipped" | "failed";
  error?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function registerReplyWatch(opts: {
  campaignId: string;
  contactId: string;
  channel: "sms" | "email";
  contactName?: string;
}): Promise<WatchResult> {
  const config = await loadAppConfig();
  if (!config.watch || !config.watch.enabled) {
    return { status: "skipped" };
  }

  const {
    callback_command,
    callback_prompt,
    default_timeout_hours,
    poll_interval_minutes,
  } = config.watch;

  const name = `outreach-${sanitize(opts.campaignId)}-${sanitize(opts.contactId)}-${opts.channel}`;

  const trigger = `outreach reply-check --campaign-id ${opts.campaignId} --contact-id ${opts.contactId} --channel ${opts.channel}`;

  // Resolve prompt template, then shell-quote and append to command
  const prompt = callback_prompt
    .replace(/\{contact_id\}/g, opts.contactId)
    .replace(/\{campaign_id\}/g, opts.campaignId)
    .replace(/\{channel\}/g, opts.channel)
    .replace(/\{contact_name\}/g, opts.contactName ?? opts.contactId);

  // Run the agent from the data repo so it has access to skills and campaign data
  const callback = `cd ${shellQuote(config.data_repo_path)} && ${callback_command} ${shellQuote(prompt)}`;

  try {
    const { stdout } = await execFile(
      "sundial",
      [
        "add",
        "--type",
        "poll",
        "--trigger",
        trigger,
        "--interval",
        `${poll_interval_minutes}m`,
        "--timeout",
        `${default_timeout_hours}h`,
        "--once",
        "--refresh",
        "--command",
        callback,
        "--name",
        name,
        "--json",
      ],
      { timeout: 10_000 },
    );

    const result = JSON.parse(stdout) as Record<string, unknown>;
    return {
      schedule_id: result.id as string | undefined,
      status: result.status as "created" | "reactivated" | "updated",
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return { status: "failed", error: "sundial not installed" };
    }
    return { status: "failed", error: error.message };
  }
}
