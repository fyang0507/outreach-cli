import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadAppConfig } from "./appConfig.js";

const execFile = promisify(execFileCb);

export interface WatchResult {
  schedule_id?: string;
  // "skipped"/"failed" are set by this module; any other value is sundial's
  // status string passed through verbatim (e.g. "active", "refreshed").
  status: "skipped" | "failed" | string;
  error?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function registerReplyWatch(opts: {
  campaignId: string;
  contactId: string;
  channel: "sms" | "email";
}): Promise<WatchResult> {
  const config = await loadAppConfig();
  if (!config.watch || !config.watch.enabled) {
    return { status: "skipped" };
  }

  const { default_timeout_hours, poll_interval_minutes } = config.watch;

  const name = `outreach-${sanitize(opts.campaignId)}-${sanitize(opts.contactId)}-${opts.channel}`;

  // Both the trigger and the callback are hidden internal `outreach` subcommands.
  // They share the same argument signature, and the callback resolves the prompt
  // + session resume at fire time by reading config and campaign state.
  const trigger = `outreach reply-check --campaign-id ${opts.campaignId} --contact-id ${opts.contactId} --channel ${opts.channel}`;
  const callback = `outreach callback-dispatch --campaign-id ${opts.campaignId} --contact-id ${opts.contactId} --channel ${opts.channel}`;

  // --detach releases sundial's per-schedule mutex as soon as the callback is
  // spawned, so the agent's nested `outreach email send` can refresh this same
  // schedule without hitting "currently firing". Outcome observability lives in
  // the campaign JSONL's `callback_run` event + per-run log file, not sundial.
  try {
    const { stdout } = await execFile(
      "sundial",
      [
        "add",
        "poll",
        "--trigger",
        trigger,
        "--interval",
        `${poll_interval_minutes}m`,
        "--timeout",
        `${default_timeout_hours}h`,
        "--once",
        "--refresh",
        "--detach",
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
      status: result.status as string,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return { status: "failed", error: "sundial not installed" };
    }
    return { status: "failed", error: error.message };
  }
}
