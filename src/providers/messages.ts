import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Types ---

export interface MessageEntry {
  text: string | null;
  is_from_me: boolean;
  date: string; // ISO 8601
  attachments?: string[];
  reactions?: { emoji: string; is_from_me: boolean }[];
}

// --- Phone normalization ---

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const nums = digits.replace(/\D/g, "");
  if (nums.length === 10) return `+1${nums}`;
  if (nums.length === 11 && nums.startsWith("1")) return `+${nums}`;
  return `+${nums}`;
}

// --- CoreData date conversion ---

function coreDataToIso(raw: number): string {
  return new Date((raw / 1_000_000_000 + 978_307_200) * 1000).toISOString();
}

// --- attributedBody fallback parser ---

function extractTextFromAttributedBody(blob: Buffer): string | null {
  try {
    // Apple-internal attribute keys that appear as strings in the blob but
    // are not user-visible text.
    const isInternalAttr = (s: string) =>
      s.startsWith("__kIM") ||
      /^NS[A-Z][a-z]/.test(s) ||
      /^at_\d+_[A-F0-9-]/.test(s);

    // --- Strategy 1: typedstream length-prefixed extraction ---
    // In the typedstream/NSKeyedArchiver format, the string content of an
    // NSAttributedString is stored as: \x01+ <length> <utf8-bytes>.
    // The length uses ASN.1-style encoding (single byte < 0x80, or 0x81 NN,
    // or 0x82 HH LL for longer strings).
    for (let i = 0; i < blob.length - 3; i++) {
      if (blob[i] !== 0x01) continue;
      const tag = blob[i + 1]!;
      if (tag !== 0x2b /* + */ && tag !== 0x2a /* * */) continue;

      let len: number;
      let dataStart: number;
      const b = blob[i + 2]!;
      if (b < 0x80) {
        len = b;
        dataStart = i + 3;
      } else if (b === 0x81) {
        if (i + 3 >= blob.length) continue;
        len = blob[i + 3]!;
        dataStart = i + 4;
      } else if (b === 0x82) {
        if (i + 4 >= blob.length) continue;
        len = (blob[i + 3]! << 8) | blob[i + 4]!;
        dataStart = i + 5;
      } else {
        continue;
      }

      if (len <= 0 || dataStart + len > blob.length) continue;

      const text = blob
        .subarray(dataStart, dataStart + len)
        .toString("utf-8")
        .replace(/\uFFFD+$/, "");
      if (text && !isInternalAttr(text)) return text;
    }

    // --- Strategy 2: fallback — printable runs after NSString marker ---
    // Collect runs in positional order and return the first non-internal one.
    // This handles blobs where the \x01+ marker is absent or non-standard.
    const binStr = blob.toString("binary");
    const nsIdx = binStr.indexOf("NSString");
    if (nsIdx === -1) return null;

    const after = blob.subarray(nsIdx + 8); // "NSString".length === 8
    const runs: { start: number; length: number }[] = [];
    let runStart = -1;
    for (let i = 0; i < after.length; i++) {
      const byte = after[i]!;
      if (byte >= 0x20 && byte !== 0x7f) {
        if (runStart === -1) runStart = i;
      } else {
        if (runStart !== -1) {
          runs.push({ start: runStart, length: i - runStart });
          runStart = -1;
        }
      }
    }
    if (runStart !== -1) {
      runs.push({ start: runStart, length: after.length - runStart });
    }

    // Iterate in positional order — text content precedes attribute names
    for (const run of runs) {
      if (run.length < 2) continue;

      let text = after
        .subarray(run.start, run.start + run.length)
        .toString("utf-8")
        .replace(/\uFFFD+$/, "");

      // Strip +<len> prefix: the byte after '+' encodes the UTF-8 *byte* length
      if (text.length > 2 && text.charCodeAt(0) === 0x2b) {
        const candidateLen = text.charCodeAt(1);
        const rest = text.substring(2);
        if (
          Math.abs(candidateLen - Buffer.byteLength(rest, "utf-8")) <= 2
        ) {
          text = rest;
        }
      }

      if (!text || isInternalAttr(text)) continue;
      return text;
    }

    return null;
  } catch {
    return null;
  }
}

// --- Tapback resolution ---

const TAPBACK_EMOJI: Record<number, string> = {
  2000: "\u2764\ufe0f", // love
  2001: "\ud83d\udc4d", // like
  2002: "\ud83d\udc4e", // dislike
  2003: "\ud83d\ude02", // laugh
  2004: "\u203c\ufe0f", // emphasis
  2005: "\u2753",       // question
};

function parseTapbackTarget(guid: string): string | null {
  // Format: "p:X/GUID" or "bp:GUID" — extract GUID after last "/"
  const slashIdx = guid.lastIndexOf("/");
  if (slashIdx === -1) return null;
  return guid.substring(slashIdx + 1);
}

// --- Read message history ---

export function readMessageHistory(
  phone: string,
  options: { limit?: number; sinceDays?: number } = {},
): MessageEntry[] {
  const normalized = normalizePhone(phone);
  const limit = options.limit ?? 50;
  const dbPath = join(homedir(), "Library", "Messages", "chat.db");

  const db = new Database(dbPath, { readonly: true });
  try {
    // Build date filter
    let dateFilter = "";
    const params: unknown[] = [normalized];
    if (options.sinceDays !== undefined) {
      // CoreData nanoseconds since 2001-01-01
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - options.sinceDays);
      const coreDataNs =
        (sinceDate.getTime() / 1000 - 978_307_200) * 1_000_000_000;
      dateFilter = " AND m.date >= ?";
      params.push(coreDataNs);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT m.ROWID, m.text, m.attributedBody, m.is_from_me, m.date,
                m.cache_has_attachments, m.associated_message_type,
                m.associated_message_guid, m.guid
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE c.chat_identifier = ?${dateFilter}
         ORDER BY m.date DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
      ROWID: number;
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      date: number;
      cache_has_attachments: number;
      associated_message_type: number | null;
      associated_message_guid: string | null;
      guid: string;
    }>;

    // Separate regular messages from tapbacks
    const regularMessages: Array<{
      rowId: number;
      text: string | null;
      isFromMe: boolean;
      date: string;
      hasAttachments: boolean;
      guid: string;
    }> = [];
    const tapbacks: Array<{
      type: number;
      isFromMe: boolean;
      targetGuid: string | null;
    }> = [];

    for (const row of rows) {
      const assocType = row.associated_message_type ?? 0;
      if (assocType >= 2000 && assocType <= 2006) {
        tapbacks.push({
          type: assocType,
          isFromMe: row.is_from_me === 1,
          targetGuid: row.associated_message_guid
            ? parseTapbackTarget(row.associated_message_guid)
            : null,
        });
      } else if (assocType >= 3000 && assocType <= 3006) {
        // Removal — record to cancel adds
        tapbacks.push({
          type: assocType,
          isFromMe: row.is_from_me === 1,
          targetGuid: row.associated_message_guid
            ? parseTapbackTarget(row.associated_message_guid)
            : null,
        });
      } else {
        let text = row.text;
        if (text === null && row.attributedBody) {
          text = extractTextFromAttributedBody(row.attributedBody);
        }
        regularMessages.push({
          rowId: row.ROWID,
          text,
          isFromMe: row.is_from_me === 1,
          date: coreDataToIso(row.date),
          hasAttachments: row.cache_has_attachments === 1,
          guid: row.guid,
        });
      }
    }

    // Fetch attachments for messages that have them
    const attachmentStmt = db.prepare(
      `SELECT a.mime_type, a.uti FROM attachment a
       JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
       WHERE maj.message_id = ?`,
    );

    const attachmentsByRowId = new Map<number, string[]>();
    for (const msg of regularMessages) {
      if (!msg.hasAttachments) continue;
      const atts = attachmentStmt.all(msg.rowId) as Array<{
        mime_type: string | null;
        uti: string | null;
      }>;
      const types = atts
        .map((a) => a.mime_type ?? a.uti ?? "unknown")
        .filter(Boolean);
      if (types.length > 0) {
        attachmentsByRowId.set(msg.rowId, types);
      }
    }

    // Resolve tapbacks: net adds minus removals, keyed by (targetGuid, type % 1000, isFromMe)
    const tapbackMap = new Map<
      string,
      { emoji: string; is_from_me: boolean }
    >();
    for (const tb of tapbacks) {
      if (!tb.targetGuid) continue;
      const baseType = tb.type >= 3000 ? tb.type - 1000 : tb.type;
      const key = `${tb.targetGuid}:${baseType}:${tb.isFromMe}`;
      if (tb.type >= 3000) {
        tapbackMap.delete(key);
      } else {
        const emoji = TAPBACK_EMOJI[baseType];
        if (emoji) {
          tapbackMap.set(key, { emoji, is_from_me: tb.isFromMe });
        }
      }
    }

    // Group tapbacks by target guid
    const reactionsByGuid = new Map<
      string,
      { emoji: string; is_from_me: boolean }[]
    >();
    for (const [key, reaction] of tapbackMap) {
      const guid = key.split(":")[0]!;
      let arr = reactionsByGuid.get(guid);
      if (!arr) {
        arr = [];
        reactionsByGuid.set(guid, arr);
      }
      arr.push(reaction);
    }

    // Build result in chronological order (reverse of DESC)
    const result: MessageEntry[] = [];
    for (let i = regularMessages.length - 1; i >= 0; i--) {
      const msg = regularMessages[i]!;
      const entry: MessageEntry = {
        text: msg.text,
        is_from_me: msg.isFromMe,
        date: msg.date,
      };
      const atts = attachmentsByRowId.get(msg.rowId);
      if (atts) entry.attachments = atts;
      const reactions = reactionsByGuid.get(msg.guid);
      if (reactions && reactions.length > 0) entry.reactions = reactions;
      result.push(entry);
    }

    return result;
  } finally {
    db.close();
  }
}

// --- Send iMessage ---

export function sendIMessage(to: string, body: string): void {
  const script = `on run argv
  set theRecipient to item 1 of argv
  set theMessage to item 2 of argv
  tell application "Messages"
    set targetBuddy to buddy theRecipient of (service 1 whose service type is iMessage)
    send theMessage to targetBuddy
  end tell
end run`;

  execFileSync("osascript", ["-", normalizePhone(to), body], {
    input: script,
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
