import { Command } from "commander";
import {
  resolveChannel,
  fetchMessages,
  type DiscordMessage,
} from "../../providers/discord.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, OPERATION_FAILED } from "../../exitCodes.js";

// Discord snowflake epoch (2015-01-01T00:00:00Z) in ms.
const DISCORD_EPOCH = 1420070400000n;

/** Synthesize the snowflake for an instant, usable as an `after`/`before` bound. */
function snowflakeFromIso(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --since date "${iso}" (expected ISO 8601)`);
  }
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}

/**
 * Lean wire shape — omit empty/default fields to keep the JSON token-cheap for
 * the digesting agent. Author collapses to a username string; `bot` appears
 * only when true; `content`/`reply_to`/`attachments` only when present.
 */
function serialize(m: DiscordMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    ts: m.timestamp,
    author: m.author.username,
  };
  if (m.author.bot) out.bot = true;
  if (m.content) out.content = m.content;
  if (m.referenced_message_id) out.reply_to = m.referenced_message_id;
  if (m.attachments.length > 0) {
    out.attachments = m.attachments.map((a) => {
      const att: Record<string, unknown> = { url: a.url, name: a.filename, size: a.size };
      if (a.content_type) att.type = a.content_type;
      return att;
    });
  }
  return out;
}

export function registerHistoryCommand(parent: Command): void {
  parent
    .command("history")
    .description("Read recent messages from a Discord channel")
    .requiredOption("--channel <id|name>", "Target channel id or name")
    .option("--limit <n>", "Max messages to return (default 50)", "50")
    .option("--after <message_id>", "Only messages newer than this id (cursor)")
    .option("--before <message_id>", "Only messages older than this id")
    .option(
      "--since <iso>",
      "Only messages after this ISO 8601 time (coarser than --after)",
    )
    .option(
      "--count",
      "Triage mode: return only the count + newest_id, omit message bodies",
    )
    .action(
      async (opts: {
        channel: string;
        limit: string;
        after?: string;
        before?: string;
        since?: string;
        count?: boolean;
      }) => {
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isInteger(limit) || limit < 1) {
          outputError(INPUT_ERROR, `Invalid --limit "${opts.limit}"`);
          process.exit(INPUT_ERROR);
          return;
        }

        try {
          // Explicit --after wins; otherwise derive a cursor from --since.
          const after =
            opts.after ?? (opts.since ? snowflakeFromIso(opts.since) : undefined);

          const channel = await resolveChannel(opts.channel);
          const messages = await fetchMessages(channel.id, {
            limit,
            after,
            before: opts.before,
          });

          const envelope: Record<string, unknown> = {
            channel: { id: channel.id, name: channel.name },
            count: messages.length,
            newest_id: messages[messages.length - 1]?.id ?? null,
            has_more: messages.length === limit,
          };
          if (!opts.count) envelope.messages = messages.map(serialize);

          outputJson(envelope);
          process.exit(SUCCESS);
        } catch (err) {
          const message = (err as Error).message;
          // --since parse failure is a user-input error.
          if (/^Invalid --since/.test(message)) {
            outputError(INPUT_ERROR, message);
            process.exit(INPUT_ERROR);
            return;
          }
          outputError(OPERATION_FAILED, message);
          process.exit(OPERATION_FAILED);
        }
      },
    );
}
