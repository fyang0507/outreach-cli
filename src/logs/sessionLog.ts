import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppConfig } from "../appConfig.js";

export interface TranscriptEntry {
  speaker: "remote" | "local";
  text: string;
  ts: number;
}

let _dirs: { contactsDir: string; campaignsDir: string; transcriptsDir: string } | null = null;

async function getDataDirs(): Promise<{ contactsDir: string; campaignsDir: string; transcriptsDir: string }> {
  if (_dirs) return _dirs;
  const config = await loadAppConfig();
  const outreachDir = join(config.data_repo_path, "outreach");
  _dirs = {
    contactsDir: join(outreachDir, "contacts"),
    campaignsDir: join(outreachDir, "campaigns"),
    transcriptsDir: join(outreachDir, "transcripts"),
  };
  return _dirs;
}

export async function ensureDataDirs(): Promise<void> {
  const { contactsDir, campaignsDir, transcriptsDir } = await getDataDirs();
  await mkdir(contactsDir, { recursive: true });
  await mkdir(campaignsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });
}

export async function appendCampaignEvent(
  campaignId: string,
  event: object,
): Promise<void> {
  const { campaignsDir } = await getDataDirs();
  await mkdir(campaignsDir, { recursive: true });
  const filePath = join(campaignsDir, `${campaignId}.jsonl`);
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

export async function writeTranscript(
  callId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  const { transcriptsDir } = await getDataDirs();
  await mkdir(transcriptsDir, { recursive: true });
  const filePath = join(transcriptsDir, `${callId}.jsonl`);
  const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, data, "utf-8");
}
