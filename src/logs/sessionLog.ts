import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TranscriptEntry {
  speaker: "remote" | "local";
  text: string;
  ts: number;
}

const BASE_DIR = join(homedir(), ".outreach");
const SESSIONS_DIR = join(BASE_DIR, "sessions");
const TRANSCRIPTS_DIR = join(BASE_DIR, "transcripts");

export async function ensureLogDirs(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await mkdir(TRANSCRIPTS_DIR, { recursive: true });
}

export async function appendEvent(
  campaignId: string,
  event: object,
): Promise<void> {
  await ensureLogDirs();
  const filePath = join(SESSIONS_DIR, `${campaignId}.jsonl`);
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

export async function readLog(campaignId: string): Promise<object[]> {
  const filePath = join(SESSIONS_DIR, `${campaignId}.jsonl`);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as object);
}

export async function writeTranscript(
  callId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  await ensureLogDirs();
  const filePath = join(TRANSCRIPTS_DIR, `${callId}.jsonl`);
  const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, data, "utf-8");
}
