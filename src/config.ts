import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env"), quiet: true });

/**
 * Environment config — secrets and infrastructure only.
 * Application behavior config lives in <data_repo>/outreach/config.yaml
 * (loaded by appConfig.ts).
 */
export interface OutreachConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  PERSONAL_CALLER_ID: string;
  TWILIO_DEFAULT_FROM_NUMBER: string;
  OUTREACH_WEBHOOK_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_DEFAULT_CHANNEL: string;
}

export const outreachConfig: OutreachConfig = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  PERSONAL_CALLER_ID: process.env.PERSONAL_CALLER_ID ?? "",
  TWILIO_DEFAULT_FROM_NUMBER: process.env.TWILIO_DEFAULT_FROM_NUMBER ?? "",
  OUTREACH_WEBHOOK_URL: process.env.OUTREACH_WEBHOOK_URL ?? "",
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID ?? "",
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET ?? "",
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? "",
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? "",
  DISCORD_DEFAULT_CHANNEL: process.env.DISCORD_DEFAULT_CHANNEL ?? "",
};
