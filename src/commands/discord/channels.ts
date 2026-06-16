import { Command } from "commander";
import { listChannels, createChannel } from "../../providers/discord.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, OPERATION_FAILED } from "../../exitCodes.js";

// Discord text channel type.
const TEXT_CHANNEL = 0;
// Discord category type, used to resolve --category.
const CATEGORY_CHANNEL = 4;

function normalizeName(input: string): string {
  return input.replace(/^#/, "").toLowerCase();
}

export function registerChannelsCommand(parent: Command): void {
  const channels = parent
    .command("channels")
    .description("List or create Discord channels");

  channels
    .command("list")
    .description("List text channels in the guild")
    .action(async () => {
      try {
        const all = await listChannels();
        const text = all
          .filter((c) => c.type === TEXT_CHANNEL)
          .map((c) => ({ id: c.id, name: c.name, type: c.type }));
        outputJson({ channels: text });
        process.exit(SUCCESS);
      } catch (err) {
        outputError(OPERATION_FAILED, (err as Error).message);
        process.exit(OPERATION_FAILED);
      }
    });

  channels
    .command("create")
    .description("Create a text channel (idempotent on name)")
    .requiredOption("--name <name>", "Channel name (single-quote in the shell)")
    .option("--topic <text>", "Channel topic")
    .option("--category <id|name>", "Parent category id or name")
    .action(
      async (opts: { name: string; topic?: string; category?: string }) => {
        try {
          const all = await listChannels();

          // Reuse an existing text channel with the same normalized name
          // rather than creating a duplicate.
          const target = normalizeName(opts.name);
          const existing = all.find(
            (c) => c.type === TEXT_CHANNEL && normalizeName(c.name) === target,
          );
          if (existing) {
            outputJson({
              channel: { id: existing.id, name: existing.name },
              existed: true,
            });
            process.exit(SUCCESS);
            return;
          }

          let categoryId: string | undefined;
          if (opts.category !== undefined) {
            if (/^\d+$/.test(opts.category)) {
              categoryId = opts.category;
            } else {
              const wanted = normalizeName(opts.category);
              const category = all.find(
                (c) =>
                  c.type === CATEGORY_CHANNEL &&
                  normalizeName(c.name) === wanted,
              );
              if (!category) {
                const available =
                  all
                    .filter((c) => c.type === CATEGORY_CHANNEL)
                    .map((c) => c.name)
                    .join(", ") || "(none)";
                outputError(
                  OPERATION_FAILED,
                  `No category named "${opts.category}" found. Available categories: ${available}`,
                );
                process.exit(OPERATION_FAILED);
                return;
              }
              categoryId = category.id;
            }
          }

          const created = await createChannel(opts.name, {
            topic: opts.topic,
            categoryId,
          });
          outputJson({ channel: { id: created.id, name: created.name } });
          process.exit(SUCCESS);
        } catch (err) {
          outputError(OPERATION_FAILED, (err as Error).message);
          process.exit(OPERATION_FAILED);
        }
      },
    );
}
