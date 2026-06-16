import { Command } from "commander";
import { resolveChannel, postMessage } from "../../providers/discord.js";
import { outreachConfig } from "../../config.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, OPERATION_FAILED } from "../../exitCodes.js";

export function registerPostCommand(parent: Command): void {
  parent
    .command("post")
    .description("Post a message to a Discord channel")
    .requiredOption("--body <text>", "Message body (single-quote in the shell)")
    .option("--channel <id|name>", "Target channel id or name")
    .action(
      async (opts: { body: string; channel?: string }) => {
        const target =
          opts.channel ?? (outreachConfig.DISCORD_DEFAULT_CHANNEL || "#general");

        try {
          const channel = await resolveChannel(target);
          const messages = await postMessage(channel.id, opts.body);
          outputJson({
            channel: { id: channel.id, name: channel.name },
            messages: messages.map((m) => m.id),
            chunks: messages.length,
          });
          process.exit(SUCCESS);
        } catch (err) {
          outputError(OPERATION_FAILED, (err as Error).message);
          process.exit(OPERATION_FAILED);
        }
      },
    );
}
