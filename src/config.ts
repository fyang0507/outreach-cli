import { config } from "dotenv";

config();

export interface OutreachConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  OUTREACH_DEFAULT_FROM: string;
  OUTREACH_PERSONAL_CALLER_ID: string;
  OUTREACH_WEBHOOK_URL: string;
}

export const outreachConfig: OutreachConfig = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  OUTREACH_DEFAULT_FROM: process.env.OUTREACH_DEFAULT_FROM ?? "",
  OUTREACH_PERSONAL_CALLER_ID: process.env.OUTREACH_PERSONAL_CALLER_ID ?? "",
  OUTREACH_WEBHOOK_URL: process.env.OUTREACH_WEBHOOK_URL ?? "",
};
