import { Command } from "commander";
import { ensureDaemon } from "../../daemon/lifecycle.js";
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
}

export function registerPlaceCommand(parent: Command): void {
  parent
    .command("place")
    .description("Place an outbound call")
    .requiredOption("--to <number>", "Destination phone number")
    .option("--from <number>", "Caller ID phone number")
    .option("--campaign <id>", "Campaign ID for session log")
    .option("--tts-provider <provider>", "TTS provider", "ElevenLabs")
    .option("--stt-provider <provider>", "STT provider", "Deepgram")
    .option("--voice <voiceId>", "Voice ID for TTS")
    .option("--welcome-greeting <text>", "Initial greeting text")
    .action(async (opts: PlaceOptions) => {
      const from = opts.from || outreachConfig.OUTREACH_DEFAULT_FROM;
      if (!from) {
        outputError(INPUT_ERROR, "No --from number provided and OUTREACH_DEFAULT_FROM is not set");
        process.exit(INPUT_ERROR);
        return;
      }

      try {
        await ensureDaemon();
      } catch (err) {
        outputError(INFRA_ERROR, `Failed to start daemon: ${(err as Error).message}`);
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
