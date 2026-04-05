import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR, OPERATION_FAILED } from "../../exitCodes.js";

interface SayOptions {
  id: string;
  message: string;
  voice?: string;
  interrupt: boolean;
}

export function registerSayCommand(parent: Command): void {
  parent
    .command("say")
    .description("Speak a message via TTS")
    .requiredOption("--id <callId>", "Call ID")
    .requiredOption("--message <text>", "Message to speak")
    .option("--voice <voiceId>", "Override TTS voice")
    .option("--interrupt", "Stop current audio before speaking", false)
    .action(async (opts: SayOptions) => {
      try {
        await requireRuntime();
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      try {
        const result = await sendToDaemon("call.say", {
          id: opts.id,
          message: opts.message,
          voice: opts.voice,
          interrupt: opts.interrupt,
        });

        const res = result as { error?: string; message?: string };
        if (res.error) {
          const code = res.error === "session_not_found" ? INPUT_ERROR
            : res.error === "call_not_active" ? OPERATION_FAILED
            : INFRA_ERROR;
          outputError(code, res.message ?? res.error);
          process.exit(code);
          return;
        }

        outputJson(result);
        process.exit(SUCCESS);
      } catch (err) {
        outputError(INFRA_ERROR, `IPC error: ${(err as Error).message}`);
        process.exit(INFRA_ERROR);
      }
    });
}
