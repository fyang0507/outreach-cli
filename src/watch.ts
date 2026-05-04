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
    return { status: "failed", error: formatSundialError(err) };
  }
}

export async function registerAskHumanWatch(opts: {
  campaignId: string;
  contactId?: string;
}): Promise<WatchResult> {
  const config = await loadAppConfig();
  if (!config.watch || !config.watch.enabled) {
    return { status: "skipped" };
  }

  const { default_timeout_hours, poll_interval_minutes } = config.watch;

  // One schedule per campaign — multiple outstanding questions share it; the
  // trigger re-derives the baseline from the latest human_question each poll.
  const name = `outreach-${sanitize(opts.campaignId)}-ask-human`;
  const contactArg = opts.contactId ?? "__campaign__";

  const trigger = `outreach ask-human-check --campaign-id ${opts.campaignId} --contact-id ${contactArg}`;
  const callback = `outreach callback-dispatch --campaign-id ${opts.campaignId} --contact-id ${contactArg} --channel human_input`;

  // sundial --timeout is a hard outer safety cap (2x the soft timeout); the
  // trigger itself fires on the soft timeout by exit-code-0ing when elapsed.
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
        `${default_timeout_hours * 2}h`,
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
    return { status: "failed", error: formatSundialError(err) };
  }
}

// sundial CLI emits structured JSON on stdout for both success and failure
// (e.g. {"error":"duplicate schedule exists","hint":"..."}). Node's execFile
// rejects on non-zero exit but attaches stdout/stderr to the error object —
// which the previous catch dropped, leaving callers with just "Command failed
// with exit code 1." Surface the structured error instead so future watcher
// failures are debuggable (issue #82).
function formatSundialError(err: unknown): string {
  const error = err as NodeJS.ErrnoException & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    killed?: boolean;
    signal?: string | null;
  };
  if (error.code === "ENOENT") return "sundial not installed";
  if (error.killed && error.signal === "SIGTERM") {
    return "sundial add poll timed out (>10s) — daemon may be stuck";
  }
  const stdout = (error.stdout?.toString() ?? "").trim();
  const stderr = (error.stderr?.toString() ?? "").trim();
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const parts = [parsed.error, parsed.hint].filter(Boolean);
      if (parts.length > 0) return `sundial: ${parts.join(" — ")}`;
    } catch {
      // Not JSON — fall through to raw output.
    }
    return `sundial: ${stdout}`;
  }
  if (stderr) return `sundial: ${stderr}`;
  return error.message;
}
