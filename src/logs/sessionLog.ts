import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAppConfig } from "../appConfig.js";

export interface TranscriptEntry {
  speaker: "remote" | "local";
  text: string;
  ts: number;
}

let _sessionsDir: string | null = null;
let _transcriptsDir: string | null = null;

async function getDataDirs(): Promise<{ sessionsDir: string; transcriptsDir: string }> {
  if (_sessionsDir && _transcriptsDir) {
    return { sessionsDir: _sessionsDir, transcriptsDir: _transcriptsDir };
  }
  const config = await loadAppConfig();
  const outreachDir = join(config.data_repo_path, "outreach");
  _sessionsDir = join(outreachDir, "sessions");
  _transcriptsDir = join(outreachDir, "transcripts");
  return { sessionsDir: _sessionsDir, transcriptsDir: _transcriptsDir };
}

export async function ensureLogDirs(): Promise<void> {
  const { sessionsDir, transcriptsDir } = await getDataDirs();
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });
}

export async function appendEvent(
  campaignId: string,
  event: object,
): Promise<void> {
  await ensureLogDirs();
  const { sessionsDir } = await getDataDirs();
  const filePath = join(sessionsDir, `${campaignId}.jsonl`);
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

export async function readLog(campaignId: string): Promise<object[]> {
  const { sessionsDir } = await getDataDirs();
  const filePath = join(sessionsDir, `${campaignId}.jsonl`);
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
  const { transcriptsDir } = await getDataDirs();
  const filePath = join(transcriptsDir, `${callId}.jsonl`);
  const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, data, "utf-8");
}
