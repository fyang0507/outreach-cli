import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
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
  "https://www.googleapis.com/auth/calendar.events",
];
const REDIRECT_PORT = 8089;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

// Token stored in data repo so it syncs across machines via git
export async function getTokenPath(): Promise<string> {
  const config = await loadAppConfig();
  return join(config.data_repo_path, "outreach", "gmail-token.json");
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

  process.stderr.write(`\nAuthorize Google access: ${authUrl}\n`);

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

// --- Cached auth client ---

let _authClient: OAuth2Client | null = null;

export async function getAuthClient(): Promise<OAuth2Client> {
  if (_authClient) return _authClient;

  const auth = createOAuth2Client();
  const loaded = await loadStoredToken(auth);

  if (!loaded) {
    await authorizeInteractive(auth);
  }

  // Auto-persist on token refresh
  auth.on("tokens", async () => {
    await saveToken(auth);
  });

  _authClient = auth;
  return _authClient;
}

// --- Health check (credentials + token only, no API calls) ---

export async function checkGoogleAuth(): Promise<{
  ok: boolean;
  error?: string;
  hint?: string;
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
      hint: "Run any Google-backed command to trigger OAuth flow",
    };
  }

  return { ok: true };
}
