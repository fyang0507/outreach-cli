import { outreachConfig } from "../config.js";

// --- Types ---

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
}

export interface DiscordAttachment {
  url: string;
  filename: string;
  content_type: string | null;
  size: number;
}

export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  timestamp: string;
  attachments: DiscordAttachment[];
  referenced_message_id: string | null;
}

const API_BASE = "https://discord.com/api/v10";

// Discord text channel type.
const TEXT_CHANNEL = 0;

// Discord caps GET .../messages at 100 per request.
const MAX_PAGE = 100;

// Discord caps message content at 2000 chars; chunk below that with headroom.
const MAX_CHUNK = 1900;

// Discord message flag: suppress push/desktop notifications (silent message).
const SUPPRESS_NOTIFICATIONS = 1 << 12;

// --- Request helper ---

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bot ${outreachConfig.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Perform a Discord REST request and centralize non-2xx handling.
 * Throws Error with status + Discord's JSON `message`. On 429, surfaces a
 * "rate limited, retry after Ns" message and does NOT auto-retry.
 */
async function discordFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: authHeaders(),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.ok) {
    if (res.status === 204) return undefined;
    return await res.json();
  }

  // Parse the error body (Discord returns JSON for errors).
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body — fall through with empty payload
  }

  if (res.status === 429) {
    const retryAfter =
      typeof payload.retry_after === "number" ? payload.retry_after : undefined;
    const secs = retryAfter !== undefined ? retryAfter : "?";
    throw new Error(`Discord 429: rate limited, retry after ${secs}s`);
  }

  const message =
    typeof payload.message === "string" ? payload.message : res.statusText;
  throw new Error(`Discord ${res.status}: ${message}`);
}

// --- Channel listing / resolution ---

export async function listChannels(): Promise<DiscordChannel[]> {
  const guild = outreachConfig.DISCORD_GUILD_ID;
  const raw = (await discordFetch(`/guilds/${guild}/channels`)) as Array<{
    id: string;
    name: string;
    type: number;
    parent_id: string | null;
  }>;
  return raw.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    parent_id: c.parent_id ?? null,
  }));
}

function normalizeName(input: string): string {
  return input.replace(/^#/, "").toLowerCase();
}

export async function resolveChannel(nameOrId: string): Promise<DiscordChannel> {
  const channels = await listChannels();

  // All-digit input is treated as a channel id.
  if (/^\d+$/.test(nameOrId)) {
    const byId = channels.find((c) => c.id === nameOrId);
    if (byId) return byId;
    throw new Error(`Discord channel id "${nameOrId}" not found in guild`);
  }

  // Name resolution: match among text channels only so a voice channel and a
  // text channel sharing a name resolve to the text one.
  const target = normalizeName(nameOrId);
  const textChannels = channels.filter((c) => c.type === TEXT_CHANNEL);
  const matches = textChannels.filter((c) => normalizeName(c.name) === target);

  if (matches.length === 1) return matches[0]!;

  const available = textChannels.map((c) => c.name).join(", ") || "(none)";
  if (matches.length === 0) {
    throw new Error(
      `No text channel named "${nameOrId}" found. Available text channels: ${available}`,
    );
  }
  throw new Error(
    `Ambiguous text channel name "${nameOrId}" (${matches.length} matches). Available text channels: ${available}`,
  );
}

// --- Channel creation ---

export async function createChannel(
  name: string,
  opts: { topic?: string; categoryId?: string } = {},
): Promise<DiscordChannel> {
  const guild = outreachConfig.DISCORD_GUILD_ID;
  const body: Record<string, unknown> = { name, type: TEXT_CHANNEL };
  if (opts.topic !== undefined) body.topic = opts.topic;
  if (opts.categoryId !== undefined) body.parent_id = opts.categoryId;

  const c = (await discordFetch(`/guilds/${guild}/channels`, {
    method: "POST",
    body,
  })) as {
    id: string;
    name: string;
    type: number;
    parent_id: string | null;
  };
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    parent_id: c.parent_id ?? null,
  };
}

// --- Posting messages ---

/**
 * Split content into ordered chunks of <=MAX_CHUNK chars, preferring to break
 * on newline boundaries.
 */
function chunkContent(content: string): string[] {
  if (content.length <= MAX_CHUNK) return [content];

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > MAX_CHUNK) {
    const window = remaining.slice(0, MAX_CHUNK);
    // Prefer the last newline within the window so we break on a boundary.
    const newlineIdx = window.lastIndexOf("\n");
    const splitAt = newlineIdx > 0 ? newlineIdx : MAX_CHUNK;
    chunks.push(remaining.slice(0, splitAt));
    // Drop a single boundary newline if that's where we split.
    remaining =
      newlineIdx > 0 ? remaining.slice(splitAt + 1) : remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function postMessage(
  channelId: string,
  content: string,
  opts: { silent?: boolean } = {},
): Promise<{ id: string }[]> {
  const chunks = chunkContent(content);
  const ids: { id: string }[] = [];
  for (const chunk of chunks) {
    const body: Record<string, unknown> = { content: chunk };
    if (opts.silent) body.flags = SUPPRESS_NOTIFICATIONS;
    const msg = (await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body,
    })) as { id: string };
    ids.push({ id: msg.id });
  }
  return ids;
}

// --- Reading messages ---

interface RawDiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  timestamp: string;
  attachments: {
    url: string;
    filename: string;
    content_type?: string | null;
    size: number;
  }[];
  message_reference?: { message_id?: string } | null;
}

function mapMessage(raw: RawDiscordMessage): DiscordMessage {
  return {
    id: raw.id,
    content: raw.content,
    author: {
      id: raw.author.id,
      username: raw.author.username,
      bot: Boolean(raw.author.bot),
    },
    timestamp: raw.timestamp,
    attachments: (raw.attachments ?? []).map((a) => ({
      url: a.url,
      filename: a.filename,
      content_type: a.content_type ?? null,
      size: a.size,
    })),
    referenced_message_id: raw.message_reference?.message_id ?? null,
  };
}

async function fetchPage(
  channelId: string,
  params: URLSearchParams,
): Promise<RawDiscordMessage[]> {
  return (await discordFetch(
    `/channels/${channelId}/messages?${params.toString()}`,
  )) as RawDiscordMessage[];
}

/**
 * Fetch messages from a channel, returned in chronological order
 * (oldest -> newest). Pages internally up to `limit` since Discord caps each
 * request at 100, and always returns messages newest-first.
 *
 * Cursors: pass `after` (a message id / snowflake) to fetch only messages
 * newer than it — the digest "everything since my last read" path. `before`
 * fetches messages older than it. Discord treats `before`/`after` as mutually
 * exclusive; when both are given, `after` drives paging and `before` is
 * applied client-side as an upper bound.
 *
 * NOTE: `content` and `attachments` come back empty unless the bot has the
 * Message Content privileged intent enabled and Read Message History
 * permission on the channel.
 */
export async function fetchMessages(
  channelId: string,
  opts: { limit?: number; after?: string; before?: string } = {},
): Promise<DiscordMessage[]> {
  const limit = Math.max(1, opts.limit ?? 50);
  const collected: RawDiscordMessage[] = [];

  if (opts.after) {
    // Forward pagination. With `after`, Discord returns the oldest messages
    // above the cursor (descending within the page), so we advance by the
    // NEWEST id seen — page[0] — until we reach `limit` or run dry.
    let after = opts.after;
    while (collected.length < limit) {
      const want = Math.min(MAX_PAGE, limit - collected.length);
      const params = new URLSearchParams({
        limit: String(want),
        after,
      });
      const page = await fetchPage(channelId, params);
      const bounded = opts.before
        ? page.filter((m) => m.id < opts.before!)
        : page;
      collected.push(...bounded);
      if (page.length < want || bounded.length < page.length) break;
      after = page[0]!.id;
    }
  } else {
    // Backward pagination from most-recent, advancing by the OLDEST id seen.
    let before = opts.before;
    while (collected.length < limit) {
      const want = Math.min(MAX_PAGE, limit - collected.length);
      const params = new URLSearchParams({ limit: String(want) });
      if (before) params.set("before", before);
      const page = await fetchPage(channelId, params);
      if (page.length === 0) break;
      collected.push(...page);
      if (page.length < want) break;
      before = page[page.length - 1]!.id;
    }
  }

  // Discord delivers newest-first; return chronological for digestion.
  return collected
    .map(mapMessage)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- Health ---

export async function checkDiscordAuth(): Promise<Record<string, unknown>> {
  const token = outreachConfig.DISCORD_BOT_TOKEN;
  const guild = outreachConfig.DISCORD_GUILD_ID;

  if (!token || !guild) {
    return {
      ok: false,
      hint: "Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env",
    };
  }

  let guildName: string;
  try {
    const g = (await discordFetch(`/guilds/${guild}`)) as { name: string };
    guildName = g.name;
  } catch (err) {
    const message = (err as Error).message;
    if (/Discord 401:/.test(message)) {
      return {
        ok: false,
        hint: "Invalid DISCORD_BOT_TOKEN — regenerate the bot token and update .env",
      };
    }
    if (/Discord 40[34]:/.test(message)) {
      return {
        ok: false,
        hint: "Bot not in guild or missing permissions — invite the bot to DISCORD_GUILD_ID with View Channels and Read Message History (the latter, plus the Message Content intent, is required for `discord history`)",
      };
    }
    return { ok: false, hint: message };
  }

  let botUser: string | undefined;
  try {
    const me = (await discordFetch(`/users/@me`)) as {
      username: string;
      discriminator?: string;
    };
    botUser =
      me.discriminator && me.discriminator !== "0"
        ? `${me.username}#${me.discriminator}`
        : me.username;
  } catch {
    // bot user is informational; ignore failures here
  }

  return { ok: true, guild_name: guildName, bot_user: botUser };
}
