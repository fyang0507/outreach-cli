import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const STATIC_PROMPT_PATH = join(thisDir, "..", "..", "prompts", "voice-agent.md");

let _staticPrompt: string | null = null;

async function loadStaticPrompt(): Promise<string> {
  if (_staticPrompt) return _staticPrompt;
  _staticPrompt = await readFile(STATIC_PROMPT_PATH, "utf-8");
  return _staticPrompt;
}

export interface SystemInstructionParams {
  persona: string;
  objective?: string;
  hangupWhen?: string;
  welcomeGreeting?: string;
}

export async function buildSystemInstruction(params: SystemInstructionParams): Promise<string> {
  const staticPrompt = await loadStaticPrompt();
  const parts: string[] = [];

  parts.push(`## Who you are\n${params.persona}`);

  if (params.objective) {
    parts.push(`## Your objective\n${params.objective}`);
  }

  if (params.welcomeGreeting) {
    parts.push(`## Opening line\nWhen the call connects and someone answers, start by saying: "${params.welcomeGreeting}"`);
  }

  if (params.hangupWhen) {
    parts.push(`## When to end the call specifically\n${params.hangupWhen}`);
  }

  parts.push(staticPrompt);

  return parts.join("\n\n");
}
