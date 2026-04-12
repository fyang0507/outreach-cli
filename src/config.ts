import { config } from "dotenv";

config({ quiet: true });

/**
 * Environment config — secrets and infrastructure only.
 * Application behavior config lives in outreach.config.json (loaded by appConfig.ts).
 */
export interface OutreachConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  OUTREACH_DEFAULT_FROM: string;
  OUTREACH_WEBHOOK_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
}

export const outreachConfig: OutreachConfig = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  OUTREACH_DEFAULT_FROM: process.env.OUTREACH_DEFAULT_FROM ?? "",
  OUTREACH_WEBHOOK_URL: process.env.OUTREACH_WEBHOOK_URL ?? "",
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID ?? "",
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET ?? "",
};
