import { Command } from "commander";
import { requireRuntime } from "../../runtime.js";
import { sendToDaemon } from "../../daemon/ipc.js";
import { outreachConfig } from "../../config.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface PlaceOptions {
  to: string;
  from?: string;
  campaign?: string;
  ttsProvider?: string;
  sttProvider?: string;
  voice?: string;
  welcomeGreeting?: string;
  objective?: string;
  persona?: string;
  hangupWhen?: string;
  backend?: string;
}

export function registerPlaceCommand(parent: Command): void {
  parent
    .command("place")
    .description("Place an outbound call")
    .requiredOption("--to <number>", "Destination phone number")
    .option("--from <number>", "Caller ID phone number")
    .option("--campaign <id>", "Campaign ID for session log")
    .option("--tts-provider <provider>", "TTS provider (conversation-relay backend)", "ElevenLabs")
    .option("--stt-provider <provider>", "STT provider (conversation-relay backend)", "Deepgram")
    .option("--voice <voiceId>", "Voice ID for TTS (conversation-relay backend)")
    .option("--welcome-greeting <text>", "Initial greeting text")
    .option("--objective <text>", "Call objective for the AI agent")
    .option("--persona <text>", "Persona/role for the AI agent")
    .option("--hangup-when <text>", "Condition for ending the call")
    .option("--backend <backend>", "Call backend: gemini-live or conversation-relay", "gemini-live")
    .action(async (opts: PlaceOptions) => {
      const from = opts.from || outreachConfig.OUTREACH_DEFAULT_FROM;
      if (!from) {
        outputError(INPUT_ERROR, "No --from number provided and OUTREACH_DEFAULT_FROM is not set");
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
        const result = await sendToDaemon("call.place", {
          to: opts.to,
          from,
          campaign: opts.campaign,
          ttsProvider: opts.ttsProvider,
          sttProvider: opts.sttProvider,
          voice: opts.voice,
          welcomeGreeting: opts.welcomeGreeting,
          objective: opts.objective,
          persona: opts.persona,
          hangupWhen: opts.hangupWhen,
          backend: opts.backend,
        });

        const res = result as { error?: string; message?: string };
        if (res.error) {
          outputError(INFRA_ERROR, res.message ?? res.error);
          process.exit(INFRA_ERROR);
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
