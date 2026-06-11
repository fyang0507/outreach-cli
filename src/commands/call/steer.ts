import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR, OPERATION_FAILED } from "../../exitCodes.js";

interface SteerOptions {
  id: string;
  text: string;
  mode: string;
}

export function registerSteerCommand(parent: Command): void {
  parent
    .command("steer")
    .description("Inject text into a live call's Gemini session mid-conversation")
    .requiredOption("--id <callId>", "Call ID")
    .requiredOption("--text <note>", "Text to inject into the live session")
    .option(
      "--mode <mode>",
      "nudge = realtime hint folded into the agent's own voice (no turn restart); say = verbatim turn",
      "nudge",
    )
    .action(async (opts: SteerOptions) => {
      const mode = opts.mode ?? "nudge";
      if (mode !== "nudge" && mode !== "say") {
        outputError(INPUT_ERROR, `Invalid --mode '${mode}'. Use 'nudge' or 'say'.`);
        process.exit(INPUT_ERROR);
        return;
      }

      try {
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      try {
        const result = await sendToDaemon("call.steer", {
          id: opts.id,
          text: opts.text,
          mode,
        });

        const res = result as { error?: string; message?: string };
        if (res.error) {
          const code = res.error === "session_not_found" ? INPUT_ERROR
            : res.error === "call_not_active" || res.error === "bridge_not_ready" ? OPERATION_FAILED
            : INFRA_ERROR;
          outputError(code, res.message ?? res.error);
          process.exit(code);
          return;
        }

        outputJson(result);
        process.exit(SUCCESS);
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
