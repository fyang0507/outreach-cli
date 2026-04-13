import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { outreachConfig } from "../config.js";
import { loadAppConfig } from "../appConfig.js";

// --- Constants ---

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];
const REDIRECT_PORT = 8089;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

// Token stored in data repo so it syncs across machines via git
async function getTokenPath(): Promise<string> {
  const config = await loadAppConfig();
  return join(config.data_repo_path, "outreach", "gmail-token.json");
}

// --- Types ---

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyToId?: string;
  replyAll?: boolean;
  attachments?: string[];
}

export interface SendEmailResult {
  to: string;
  cc?: string[];
  subject: string;
  messageId: string;
  threadId: string;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  body?: string;
  attachments?: { filename: string; mimeType: string; size: number }[];
}

export interface EmailThread {
  thread_id: string;
  subject: string;
  messages: EmailSummary[];
}

// --- Auth + token management ---

function createOAuth2Client(): OAuth2Client {
  if (!outreachConfig.GMAIL_CLIENT_ID || !outreachConfig.GMAIL_CLIENT_SECRET) {
    throw new Error(
      "GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env",
    );
  }
  return new google.auth.OAuth2(
    outreachConfig.GMAIL_CLIENT_ID,
    outreachConfig.GMAIL_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

async function loadStoredToken(client: OAuth2Client): Promise<boolean> {
  try {
    const tokenPath = await getTokenPath();
    const content = await readFile(tokenPath, "utf-8");
    const tokens = JSON.parse(content);
    client.setCredentials(tokens);
    return true;
  } catch {
    return false;
  }
}

async function saveToken(client: OAuth2Client): Promise<void> {
  const tokenPath = await getTokenPath();
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(client.credentials), "utf-8");
}

async function authorizeInteractive(client: OAuth2Client): Promise<void> {
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  process.stderr.write(`\nAuthorize Gmail access: ${authUrl}\n`);

  // Auto-open browser on macOS
  try {
    execSync(`open "${authUrl}"`, { stdio: "ignore" });
    process.stderr.write("Browser opened. Waiting for callback...\n");
  } catch {
    process.stderr.write("Open the URL above in your browser.\n");
  }

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 60s"));
    }, 60_000);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      if (url.pathname === "/oauth2callback" && code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h3>Authorization successful. You can close this tab.</h3>");
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end("Missing code parameter");
      }
    });

    server.listen(REDIRECT_PORT);
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await saveToken(client);
}

// Module-level cache
let _gmailClient: gmail_v1.Gmail | null = null;

export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  if (_gmailClient) return _gmailClient;

  const auth = createOAuth2Client();
  const loaded = await loadStoredToken(auth);

  if (!loaded) {
    await authorizeInteractive(auth);
  }

  // Auto-persist on token refresh
  auth.on("tokens", async () => {
    await saveToken(auth);
  });

  _gmailClient = google.gmail({ version: "v1", auth });
  return _gmailClient;
}

export async function checkGmailAuth(): Promise<{
  ok: boolean;
  error?: string;
  hint?: string;
  email?: string;
}> {
  if (!outreachConfig.GMAIL_CLIENT_ID || !outreachConfig.GMAIL_CLIENT_SECRET) {
    return {
      ok: false,
      error: "credentials_missing",
      hint: "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env",
    };
  }

  const auth = createOAuth2Client();
  const loaded = await loadStoredToken(auth);
  if (!loaded) {
    return {
      ok: false,
      error: "not_authorized",
      hint: "Run 'outreach email send' or 'outreach email history' to trigger OAuth flow",
    };
  }

  try {
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    return { ok: true, email: profile.data.emailAddress ?? undefined };
  } catch (err) {
    const msg = (err as Error).message;
    const tokenPath = await getTokenPath();
    return {
      ok: false,
      error: "auth_failed",
      hint: msg.includes("invalid_grant")
        ? `Token expired. Delete ${tokenPath} and re-authorize`
        : `Gmail auth check failed: ${msg}`,
    };
  }
}

// --- Helpers ---

// Cached self-email
let _selfEmail: string | null = null;

async function getSelfEmail(
  gmail: gmail_v1.Gmail,
): Promise<string> {
  if (_selfEmail) return _selfEmail;
  const profile = await gmail.users.getProfile({ userId: "me" });
  _selfEmail = profile.data.emailAddress ?? "";
  return _selfEmail;
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

function parseAddressList(value: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

function extractPlainText(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string | null {
  if (!payload) return null;

  // Direct text/plain part
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  return null;
}

function extractAttachmentMetadata(
  payload: gmail_v1.Schema$MessagePart | undefined,
): { filename: string; mimeType: string; size: number }[] {
  if (!payload) return [];
  const result: { filename: string; mimeType: string; size: number }[] = [];

  if (payload.filename && payload.body?.attachmentId) {
    result.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body.size ?? 0,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      result.push(...extractAttachmentMetadata(part));
    }
  }

  return result;
}

// --- Send ---

export async function sendEmail(
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  const gmail = await getGmailClient();
  const selfEmail = await getSelfEmail(gmail);

  let subject = opts.subject;
  let toAddr = opts.to;
  let ccAddrs: string[] = opts.cc ? parseAddressList(opts.cc) : [];
  const threadId: string | undefined = undefined;
  let inReplyTo = "";
  let references = "";
  let replyThreadId: string | undefined;

  // Threading: fetch original message for reply
  if (opts.replyToId) {
    const original = await gmail.users.messages.get({
      userId: "me",
      id: opts.replyToId,
      format: "metadata",
      metadataHeaders: [
        "From",
        "To",
        "Cc",
        "Subject",
        "Message-ID",
        "References",
      ],
    });

    const headers = original.data.payload?.headers;
    const origMessageId = getHeader(headers, "Message-ID");
    const origReferences = getHeader(headers, "References");
    const origFrom = getHeader(headers, "From");
    const origTo = getHeader(headers, "To");
    const origCc = getHeader(headers, "Cc");
    const origSubject = getHeader(headers, "Subject");

    inReplyTo = origMessageId;
    references = origReferences
      ? `${origReferences} ${origMessageId}`
      : origMessageId;
    replyThreadId = original.data.threadId ?? undefined;

    // Auto-set subject if not explicitly provided with Re:
    if (!subject.toLowerCase().startsWith("re:")) {
      subject = origSubject.toLowerCase().startsWith("re:")
        ? origSubject
        : `Re: ${origSubject}`;
    }

    // Reply-all (default when replyToId is set)
    const replyAll = opts.replyAll !== false;
    if (replyAll) {
      // To = original sender
      if (!opts.to) toAddr = origFrom;
      // Cc = original To + Cc minus self
      if (!opts.cc) {
        const allRecipients = [
          ...parseAddressList(origTo),
          ...parseAddressList(origCc),
        ];
        ccAddrs = allRecipients.filter(
          (a) => !a.toLowerCase().includes(selfEmail.toLowerCase()),
        );
      }
    } else {
      // Reply to sender only
      if (!opts.to) toAddr = origFrom;
    }
  }

  // Build MIME message
  const mailOpts: Record<string, unknown> = {
    from: selfEmail,
    to: toAddr,
    subject,
    text: opts.body,
  };

  if (ccAddrs.length > 0) mailOpts.cc = ccAddrs.join(", ");
  if (opts.bcc) mailOpts.bcc = opts.bcc;
  if (inReplyTo) {
    mailOpts.inReplyTo = inReplyTo;
    mailOpts.references = references;
  }

  if (opts.attachments && opts.attachments.length > 0) {
    mailOpts.attachments = opts.attachments.map((filePath) => ({
      path: filePath,
    }));
  }

  const mail = new MailComposer(mailOpts);
  const message = await mail.compile().build();
  const raw = message
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: replyThreadId ?? threadId,
    },
  });

  return {
    to: toAddr,
    cc: ccAddrs.length > 0 ? ccAddrs : undefined,
    subject,
    messageId: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
  };
}

// --- Search ---

export interface SearchThread {
  thread_id: string;
  subject: string;
  messages: EmailSummary[];
}

export async function searchEmails(opts: {
  query: string;
  limit?: number;
}): Promise<SearchThread[]> {
  const gmail = await getGmailClient();
  const limit = opts.limit ?? 10;

  const list = await gmail.users.messages.list({
    userId: "me",
    q: opts.query,
    maxResults: limit,
  });

  const messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  if (messageIds.length === 0) return [];

  // Fetch metadata only (no body) — lightweight for search
  const summaries: EmailSummary[] = [];
  for (const id of messageIds) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
    });
    summaries.push(messageToSummary(msg.data, false));
  }

  // Group by thread
  const threadMap = new Map<string, EmailSummary[]>();
  for (const s of summaries) {
    const existing = threadMap.get(s.threadId);
    if (existing) {
      existing.push(s);
    } else {
      threadMap.set(s.threadId, [s]);
    }
  }

  // Build thread-grouped output, chronological within each thread
  const threads: SearchThread[] = [];
  for (const [threadId, messages] of threadMap) {
    messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    threads.push({
      thread_id: threadId,
      subject: messages[0].subject,
      messages,
    });
  }

  return threads;
}

// --- History ---

function messageToSummary(
  msg: gmail_v1.Schema$Message,
  includeBody: boolean,
): EmailSummary {
  const headers = msg.payload?.headers;
  const attachments = extractAttachmentMetadata(msg.payload);

  const summary: EmailSummary = {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: getHeader(headers, "From"),
    to: parseAddressList(getHeader(headers, "To")),
    cc: parseAddressList(getHeader(headers, "Cc")),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: msg.snippet ?? "",
    hasAttachments: attachments.length > 0,
  };

  if (includeBody) {
    summary.body = extractPlainText(msg.payload) ?? msg.snippet ?? "";
  }

  if (attachments.length > 0) {
    summary.attachments = attachments;
  }

  return summary;
}

export async function readEmailHistory(opts: {
  address?: string;
  threadId?: string;
  limit?: number;
}): Promise<EmailSummary[]> {
  const gmail = await getGmailClient();
  const limit = opts.limit ?? 20;

  if (opts.threadId) {
    // Thread mode — full messages with body
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: opts.threadId,
      format: "full",
    });

    const messages = thread.data.messages ?? [];
    return messages.map((m) => messageToSummary(m, true));
  }

  // Address mode — list + batch metadata
  if (!opts.address) {
    throw new Error("Either --address or --thread-id is required");
  }

  const list = await gmail.users.messages.list({
    userId: "me",
    q: `from:${opts.address} OR to:${opts.address}`,
    maxResults: limit,
  });

  const messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  if (messageIds.length === 0) return [];

  // Fetch full messages (with body)
  const summaries: EmailSummary[] = [];
  for (const id of messageIds) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    summaries.push(messageToSummary(msg.data, true));
  }

  // Return chronological order (reverse Gmail's newest-first)
  summaries.reverse();
  return summaries;
}

// --- Thread-grouped history ---

export async function readEmailThreads(opts: {
  threadIds?: string[];
  address?: string;
  limit?: number;
}): Promise<EmailThread[]> {
  if (opts.threadIds && opts.threadIds.length > 0) {
    // Thread-ID path: fetch each thread individually
    const results = await Promise.allSettled(
      opts.threadIds.map((tid) => readEmailHistory({ threadId: tid })),
    );

    const threads: EmailThread[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled" && r.value.length > 0) {
        threads.push({
          thread_id: opts.threadIds[i]!,
          subject: r.value[0]!.subject,
          messages: r.value,
        });
      }
    }

    // Sort chronologically by first message date
    threads.sort(
      (a, b) =>
        new Date(a.messages[0]!.date).getTime() -
        new Date(b.messages[0]!.date).getTime(),
    );
    return threads;
  }

  // Address fallback: fetch flat list, group by threadId
  if (!opts.address) return [];

  const messages = await readEmailHistory({
    address: opts.address,
    limit: opts.limit ?? 10,
  });
  if (messages.length === 0) return [];

  // Group by threadId
  const groups = new Map<string, EmailSummary[]>();
  for (const msg of messages) {
    const existing = groups.get(msg.threadId);
    if (existing) {
      existing.push(msg);
    } else {
      groups.set(msg.threadId, [msg]);
    }
  }

  const threads: EmailThread[] = [];
  for (const [tid, msgs] of groups) {
    threads.push({
      thread_id: tid,
      subject: msgs[0]!.subject,
      messages: msgs,
    });
  }

  // Sort chronologically by first message date
  threads.sort(
    (a, b) =>
      new Date(a.messages[0]!.date).getTime() -
      new Date(b.messages[0]!.date).getTime(),
  );
  return threads;
}
