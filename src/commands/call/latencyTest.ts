import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outreachConfig } from "../../config.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR, TIMEOUT } from "../../exitCodes.js";
import { summarizeLatency, type LatencySummaryResult } from "./latency.js";

interface LatencyTestOptions {
  to: string;
  from?: string;
  maxDuration?: string;
  timeout?: string;
  holdAfterGreeting?: string;
  dryRun?: boolean;
  experimentalLocalVad?: boolean;
}

interface DaemonResult {
  error?: string;
  message?: string;
  id?: string;
  status?: string;
}

const DEFAULT_MAX_DURATION_SEC = 30;
const DEFAULT_HOLD_AFTER_GREETING_SEC = 3;
const POLL_INTERVAL_MS = 1000;
const TRANSCRIPT_WAIT_MS = 10_000;

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (seconds)`);
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEndedCall(id: string, timeoutSec: number): Promise<DaemonResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  let latest: DaemonResult = { id, status: "unknown" };

  while (Date.now() < deadline) {
    const result = await sendToDaemon("call.status", { id }) as DaemonResult;
    if (result.error) return result;
    latest = result;
    if (result.status === "ended") return result;
    await delay(POLL_INTERVAL_MS);
  }

  return latest;
}

async function waitForLatencySummary(id: string): Promise<LatencySummaryResult> {
  const deadline = Date.now() + TRANSCRIPT_WAIT_MS;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      return await summarizeLatency(id);
    } catch (err) {
      lastError = err as Error;
      await delay(250);
    }
  }

  throw lastError ?? new Error(`Transcript for ${id} was not ready within ${TRANSCRIPT_WAIT_MS / 1000}s`);
}

export function registerLatencyTestCommand(parent: Command): void {
  parent
    .command("latency-test")
    .description("Place a short no-AMD test call, wait for it to end, and summarize pickup latency")
    .option("--to <number>", "Destination phone number")
    .option("--from <number>", "Caller ID phone number")
    .option("--max-duration <seconds>", "Max call duration in seconds (default: 30)")
    .option("--timeout <seconds>", "How long to wait for the call to end (default: max duration + 30s)")
    .option("--hold-after-greeting <seconds>", "Seconds to keep the call open after first audible greeting (default: 3)")
    .option("--experimental-local-vad", "Use experimental bridge-side endpointing during the test call")
    .option("--dry-run", "Validate settings and daemon readiness without placing a call")
    .action(async (opts: LatencyTestOptions) => {
      if (!opts.to && !opts.dryRun) {
        outputError(INPUT_ERROR, "--to is required");
        process.exit(INPUT_ERROR);
        return;
      }

      const from = opts.from || outreachConfig.OUTREACH_DEFAULT_FROM;
      if (!from) {
        outputError(INPUT_ERROR, "No --from number provided and OUTREACH_DEFAULT_FROM is not set");
        process.exit(INPUT_ERROR);
        return;
      }

      let maxDurationSec: number;
      let timeoutSec: number;
      let holdAfterGreetingSec: number;
      try {
        maxDurationSec = parsePositiveInteger(opts.maxDuration, "--max-duration") ?? DEFAULT_MAX_DURATION_SEC;
        timeoutSec = parsePositiveInteger(opts.timeout, "--timeout") ?? maxDurationSec + 30;
        holdAfterGreetingSec = parsePositiveInteger(opts.holdAfterGreeting, "--hold-after-greeting") ?? DEFAULT_HOLD_AFTER_GREETING_SEC;
      } catch (err) {
        outputError(INPUT_ERROR, (err as Error).message);
        process.exit(INPUT_ERROR);
        return;
      }

      try {
        const runtime = await requireRuntime();
        if (opts.dryRun) {
          outputJson({
            dry_run: true,
            would_place_call: Boolean(opts.to),
            to: opts.to ?? null,
            from,
            objective: "Greet me briefly, then end the call.",
            amd: false,
            max_duration_sec: maxDurationSec,
            timeout_sec: timeoutSec,
            hold_after_greeting_sec: holdAfterGreetingSec,
            auto_hangup_after_first_outbound_audio_played_ms: holdAfterGreetingSec * 1000,
            experimental_local_vad: Boolean(opts.experimentalLocalVad),
            webhook_url: runtime.webhook_url,
            daemon_pid: runtime.daemon_pid,
          });
          process.exit(SUCCESS);
          return;
        }
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      let id: string | undefined;
      try {
        const placed = await sendToDaemon("call.place", {
          to: opts.to,
          from,
          objective: "Greet me briefly, then end the call.",
          maxDuration: maxDurationSec,
          amd: false,
          experimentalLocalVad: opts.experimentalLocalVad,
          autoHangupAfterFirstOutboundAudioPlayedMs: holdAfterGreetingSec * 1000,
        }) as DaemonResult;

        if (placed.error || !placed.id) {
          outputError(INFRA_ERROR, placed.message ?? placed.error ?? "Call placement failed");
          process.exit(INFRA_ERROR);
          return;
        }

        id = placed.id;
        const finalStatus = await waitForEndedCall(id, timeoutSec);

        if (finalStatus.error) {
          outputError(INFRA_ERROR, finalStatus.message ?? finalStatus.error);
          process.exit(INFRA_ERROR);
          return;
        }

        if (finalStatus.status !== "ended") {
          await sendToDaemon("call.hangup", { id }).catch(() => undefined);
          outputError(TIMEOUT, `Call ${id} did not end within ${timeoutSec}s; hangup was requested.`);
          process.exit(TIMEOUT);
          return;
        }

        outputJson({
          id,
          status: finalStatus.status,
          latency: await waitForLatencySummary(id),
        });
        process.exit(SUCCESS);
      } catch (err) {
        if (id) {
          await sendToDaemon("call.hangup", { id }).catch(() => undefined);
        }
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
