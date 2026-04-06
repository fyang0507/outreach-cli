import { config } from "dotenv";

config();

/**
 * Environment config — secrets and infrastructure only.
 * Application behavior config lives in outreach.config.json (loaded by appConfig.ts).
 */
export interface OutreachConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  OUTREACH_DEFAULT_FROM: string;
  OUTREACH_PERSONAL_CALLER_ID: string;
  OUTREACH_WEBHOOK_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
}

export const outreachConfig: OutreachConfig = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  OUTREACH_DEFAULT_FROM: process.env.OUTREACH_DEFAULT_FROM ?? "",
  OUTREACH_PERSONAL_CALLER_ID: process.env.OUTREACH_PERSONAL_CALLER_ID ?? "",
  OUTREACH_WEBHOOK_URL: process.env.OUTREACH_WEBHOOK_URL ?? "",
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
};
