import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import twilio from "twilio";
import { loadAppConfig, type AppConfig } from "../appConfig.js";
import { buildSystemInstruction } from "../audio/systemInstruction.js";
import { GeminiLiveSession } from "../audio/geminiLive.js";
import { ensureDataDirs } from "../logs/sessionLog.js";
import { missingRequiredCallEnv, REQUIRED_CALL_ENV } from "../config.js";

// Every probe is bounded: the preflight answers a single IPC request, so a hung
// round trip would surface to the operator as "daemon not responding" — the one
// diagnosis that is never true here.
const TWILIO_TIMEOUT_MS = 8_000;
const GEMINI_CONNECT_TIMEOUT_MS = 10_000;
const GEMINI_SETTLE_MS = 750;
const WEBHOOK_TIMEOUT_MS = 8_000;
// Per-probe bounds are not enough: on a slow-but-alive network they sum past the
// CLI's IPC budget, and the CLI would then report "daemon not responding" and
// kill the daemon holding the real report. Whatever has finished by this point is
// returned, with the stalled probe named.
const PREFLIGHT_BUDGET_MS = 25_000;
// The order checks are pushed in, so a budget exhaustion can name what never ran.
const CHECK_ORDER = [
  "env",
  "config",
  "system_instruction",
  "transcripts_dir",
  "twilio_auth",
  "caller_ids",
  "gemini_live",
  "webhook",
];

export interface PreflightCheck {
  name: string;
  ok: boolean;
  status: "pass" | "fail" | "skipped";
  detail?: string;
  hint?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

function pass(name: string, detail?: string): PreflightCheck {
  return { name, ok: true, status: "pass", ...(detail ? { detail } : {}) };
}

function fail(name: string, detail: string, hint: string): PreflightCheck {
  return { name, ok: false, status: "fail", detail, hint };
}

// A skipped check is not a readiness failure — it is a probe we deliberately
// declined to run, or one whose prerequisite already failed further up the list.
function skipped(name: string, detail: string): PreflightCheck {
  return { name, ok: true, status: "skipped", detail };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type TwilioClient = ReturnType<typeof twilio>;

async function checkTwilioAuth(accountSid: string, client: TwilioClient): Promise<PreflightCheck> {
  try {
    const account = await client.api.v2010.accounts(accountSid).fetch();
    if (account.status !== "active") {
      return fail(
        "twilio_auth",
        `account ${account.friendlyName} status is '${account.status}'`,
        "A suspended or closed Twilio account cannot place calls — check billing/status in the Twilio console.",
      );
    }
    return pass("twilio_auth", `${account.friendlyName} (status: active)`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const hint = status === 401
      ? "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env are wrong — copy them from the Twilio console dashboard."
      : "Could not reach the Twilio API — check network access, then retry 'outreach call init'.";
    const detail = status
      ? `Twilio API returned HTTP ${status}: ${(err as Error).message}`
      : (err as Error).message;
    return fail("twilio_auth", detail, hint);
  }
}

async function checkCallerIds(
  client: TwilioClient,
  twilioNumber: string,
  personalNumber: string,
): Promise<PreflightCheck> {
  try {
    const details: string[] = [];
    const problems: string[] = [];

    // Independent lookups, issued together: run serially they alone can eat most
    // of the preflight budget on a slow network.
    const [twilioNumberOwned, personalVerified] = await Promise.all([
      client.incomingPhoneNumbers.list({ phoneNumber: twilioNumber, limit: 1 }).then((list) => list.length > 0),
      client.outgoingCallerIds.list({ phoneNumber: personalNumber, limit: 1 }).then((list) => list.length > 0),
    ]);

    if (twilioNumberOwned) {
      details.push(`TWILIO_DEFAULT_FROM_NUMBER ${twilioNumber} is on the account`);
    } else {
      problems.push(`TWILIO_DEFAULT_FROM_NUMBER ${twilioNumber} is not a phone number on this Twilio account`);
    }

    // A personal caller ID is usable if Twilio has verified it, or if the account
    // happens to own it (e.g. the same number as TWILIO_DEFAULT_FROM_NUMBER).
    const personalOwned = personalVerified
      ? false
      : (await client.incomingPhoneNumbers.list({ phoneNumber: personalNumber, limit: 1 })).length > 0;
    if (personalVerified) {
      details.push(`PERSONAL_CALLER_ID ${personalNumber} is a verified caller ID`);
    } else if (personalOwned) {
      details.push(`PERSONAL_CALLER_ID ${personalNumber} is on the account`);
    } else {
      problems.push(`PERSONAL_CALLER_ID ${personalNumber} is neither a verified caller ID nor a number on this account`);
    }

    if (problems.length > 0) {
      return fail(
        "caller_ids",
        [...problems, ...details].join("; "),
        "Twilio rejects an unverified caller ID at call time with error 21210/21212, which would fail the call rather than init. " +
          "Verify the number under Phone Numbers > Manage > Verified Caller IDs in the Twilio console, or set the variable to a number the account owns.",
      );
    }
    return pass("caller_ids", details.join("; "));
  } catch (err) {
    return fail(
      "caller_ids",
      (err as Error).message,
      "Could not read the account's phone numbers / verified caller IDs — check network access and that the auth token has API access.",
    );
  }
}

async function checkTranscriptsDir(dir: string): Promise<PreflightCheck> {
  // mkdir -p resolves happily on a directory that already exists but cannot be
  // written to (permissions, read-only mount, full disk) — exactly the case that
  // destroys a completed call's transcript. Only a real write proves the path.
  const probePath = join(dir, ".preflight-write-probe");
  try {
    await ensureDataDirs();
    await writeFile(probePath, "");
    return pass("transcripts_dir", dir);
  } catch (err) {
    return fail(
      "transcripts_dir",
      `${dir}: ${(err as Error).message}`,
      "The transcript directory must be creatable and writable, otherwise a completed call loses its whole transcript. Check the path and its permissions.",
    );
  } finally {
    try {
      await unlink(probePath);
    } catch {
      // never written, or already gone
    }
  }
}

async function checkGeminiLive(
  apiKey: string,
  appConfig: AppConfig,
  systemInstruction: string,
): Promise<PreflightCheck> {
  const session = new GeminiLiveSession({
    apiKey,
    geminiConfig: appConfig.gemini,
    systemInstruction,
    onAudio: () => {},
    onTranscript: () => {},
    onToolCall: () => {},
    onEnd: () => {},
  });
  try {
    await withTimeout(session.connect(), GEMINI_CONNECT_TIMEOUT_MS, "Gemini Live connect");
    // connect() resolves when the socket opens, which a bad API key and a rejected
    // model/voice both survive — the rejection arrives as a close ~50ms later.
    // Without this settle window the check is a false green.
    await new Promise((resolve) => setTimeout(resolve, GEMINI_SETTLE_MS));
    if (session.isClosed) {
      return fail(
        "gemini_live",
        `Gemini closed the session right after connecting${session.closeReason ? `: ${session.closeReason}` : ""}`,
        `Usually an invalid GOOGLE_GENERATIVE_AI_API_KEY, or a gemini.model / gemini.speech.voice_name in ${appConfig.config_path} that the Live API rejects.`,
      );
    }
    return pass(
      "gemini_live",
      `connected: model ${appConfig.gemini.model}, voice ${appConfig.gemini.speech.voice_name}`,
    );
  } catch (err) {
    return fail(
      "gemini_live",
      (err as Error).message,
      `Check GOOGLE_GENERATIVE_AI_API_KEY, and that gemini.model and gemini.speech.voice_name in ${appConfig.config_path} are accepted by the Live API.`,
    );
  } finally {
    session.close();
  }
}

async function checkWebhook(webhookUrl: string, instanceId: string): Promise<PreflightCheck> {
  if (!webhookUrl) {
    return fail(
      "webhook",
      "no webhook URL is configured for this daemon",
      "Set OUTREACH_WEBHOOK_URL or run 'outreach call init' so runtime.json records the tunnel URL.",
    );
  }

  const probeUrl = `${webhookUrl.replace(/\/$/, "")}/health`;
  let res: Response;
  try {
    res = await fetch(probeUrl, { signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
  } catch (err) {
    return fail(
      "webhook",
      `${probeUrl} is unreachable: ${(err as Error).message}`,
      "The tunnel is down or its URL is stale. Run 'outreach call teardown' then 'outreach call init' to get a fresh tunnel.",
    );
  }

  if (!res.ok) {
    const hint = res.status === 502 || res.status === 504
      ? "ngrok is answering but nothing is listening behind it (offline tunnel). Run 'outreach call teardown' then 'outreach call init'."
      : `Something other than this daemon answered ${probeUrl}. Check what owns the tunnel URL.`;
    return fail("webhook", `${probeUrl} returned HTTP ${res.status}`, hint);
  }

  let body: { instance_id?: string };
  try {
    body = (await res.json()) as { instance_id?: string };
  } catch (err) {
    return fail(
      "webhook",
      `${probeUrl} did not return JSON: ${(err as Error).message}`,
      // init's reuse path never rebuilds a tunnel, so "re-run init" would loop on
      // the same failure.
      "The tunnel URL points at some other service, not this daemon. Run 'outreach call teardown' then 'outreach call init' to rebuild the tunnel.",
    );
  }

  if (body.instance_id !== instanceId) {
    return fail(
      "webhook",
      `${probeUrl} reached a different process (instance_id ${body.instance_id ?? "missing"}, expected ${instanceId})`,
      "The tunnel points at another daemon (a stale ngrok URL or a second daemon on this port). Run 'outreach call teardown' then 'outreach call init'.",
    );
  }

  return pass("webhook", `${probeUrl} reaches this daemon (instance_id ${instanceId})`);
}

/**
 * Validate everything a call needs, from inside the daemon that will place it —
 * the CLI cannot see the daemon's env snapshot, resolved config or credentials,
 * so a CLI-side preflight would only be a proxy for state it cannot observe.
 * Running here also warms the DNS/TLS/connection paths the real call uses.
 *
 * Checks run sequentially and a failure never aborts the rest: the agent that
 * invoked init deserves the whole setup checklist in one response. The whole run
 * is bounded, so a stalling probe still produces a report instead of a timeout.
 */
export async function runPreflight(opts: {
  webhookUrl: string;
  instanceId: string;
  activeCalls: number;
}): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exhausted = await Promise.race([
      runChecks(checks, opts).then(() => false),
      new Promise<true>((resolve) => {
        budgetTimer = setTimeout(() => resolve(true), PREFLIGHT_BUDGET_MS);
      }),
    ]);
    // Whatever is still in flight keeps running on its own bound and closes its
    // own resources; the report describes what we know now.
    if (exhausted) recordBudgetExhaustion(checks);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

/** Name the probe that stalled, so the report is still a diagnosis. */
function recordBudgetExhaustion(checks: PreflightCheck[]): void {
  const completed = new Set(checks.map((check) => check.name));
  let stalled = true;
  for (const name of CHECK_ORDER) {
    if (completed.has(name)) continue;
    checks.push(
      stalled
        ? fail(
            name,
            `still running when the ${PREFLIGHT_BUDGET_MS / 1000}s preflight budget ran out`,
            "This probe is stalling rather than failing — usually a network path that accepts connections but never answers. Check connectivity to Twilio, Gemini and the tunnel, then retry.",
          )
        : skipped(name, "the preflight budget ran out before this check"),
    );
    stalled = false;
  }
}

async function runChecks(
  checks: PreflightCheck[],
  opts: { webhookUrl: string; instanceId: string; activeCalls: number },
): Promise<void> {
  // 1. env
  const missingEnv = missingRequiredCallEnv();
  checks.push(
    missingEnv.length === 0
      ? pass("env", `all ${REQUIRED_CALL_ENV.length} required variables are set`)
      : fail(
          "env",
          `missing: ${missingEnv.join(", ")}`,
          "Set these in .env. Both caller IDs are required: 'call place' dials from PERSONAL_CALLER_ID by default and from TWILIO_DEFAULT_FROM_NUMBER for --from-twilio/--call-operator.",
        ),
  );

  // 2. config
  let appConfig: AppConfig | undefined;
  try {
    appConfig = await loadAppConfig();
    checks.push(pass("config", `${appConfig.config_path} (source: ${appConfig.config_source})`));
  } catch (err) {
    checks.push(fail(
      "config",
      (err as Error).message,
      "Set OUTREACH_DATA_REPO, create outreach.config.dev.yaml with data_repo_path, or start the daemon from a workspace containing .agents/workspace.yaml.",
    ));
  }

  // 3. system_instruction
  let systemInstruction: string | undefined;
  if (!appConfig) {
    checks.push(skipped("system_instruction", "config did not load"));
  } else {
    try {
      systemInstruction = await buildSystemInstruction({
        identity: appConfig.identity,
        persona: appConfig.voice_agent.default_persona,
      });
      checks.push(pass("system_instruction", `rendered ${systemInstruction.length} chars`));
    } catch (err) {
      checks.push(fail(
        "system_instruction",
        (err as Error).message,
        "prompts/voice-agent.md must be readable next to the installed CLI — reinstall or re-run 'npm run build'.",
      ));
    }
  }

  // 4. transcripts_dir
  if (!appConfig) {
    checks.push(skipped("transcripts_dir", "config did not load"));
  } else {
    checks.push(await checkTranscriptsDir(join(appConfig.data_repo_path, "outreach", "transcripts")));
  }

  // 5. twilio_auth
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  let client: TwilioClient | undefined;
  if (!accountSid || !authToken) {
    checks.push(skipped("twilio_auth", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set (see the env check)"));
  } else {
    client = twilio(accountSid, authToken, { timeout: TWILIO_TIMEOUT_MS });
    const authCheck = await checkTwilioAuth(accountSid, client);
    checks.push(authCheck);
    // Unusable credentials would only produce a second, identical failure below.
    if (!authCheck.ok) client = undefined;
  }

  // 6. caller_ids
  const twilioNumber = process.env.TWILIO_DEFAULT_FROM_NUMBER;
  const personalNumber = process.env.PERSONAL_CALLER_ID;
  if (!twilioNumber || !personalNumber) {
    checks.push(skipped("caller_ids", "TWILIO_DEFAULT_FROM_NUMBER / PERSONAL_CALLER_ID are not set (see the env check)"));
  } else if (!client) {
    checks.push(skipped("caller_ids", "twilio_auth did not pass"));
  } else {
    checks.push(await checkCallerIds(client, twilioNumber, personalNumber));
  }

  // 7. gemini_live
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (opts.activeCalls > 0) {
    checks.push(skipped(
      "gemini_live",
      `${opts.activeCalls} call(s) in progress already prove this path, and Gemini Live caps concurrent sessions per API key (3 on the free tier) — a probe session could exhaust that quota mid-call`,
    ));
  } else if (!apiKey) {
    checks.push(skipped("gemini_live", "GOOGLE_GENERATIVE_AI_API_KEY is not set (see the env check)"));
  } else if (!appConfig || !systemInstruction) {
    checks.push(skipped("gemini_live", "config / system instruction did not load"));
  } else {
    checks.push(await checkGeminiLive(apiKey, appConfig, systemInstruction));
  }

  // 8. webhook
  checks.push(await checkWebhook(opts.webhookUrl, opts.instanceId));
}
