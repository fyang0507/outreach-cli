import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IdentityConfig } from "../appConfig.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const STATIC_PROMPT_PATH = join(thisDir, "..", "..", "prompts", "voice-agent.md");

let _staticPrompt: string | null = null;

async function loadStaticPrompt(): Promise<string> {
  if (_staticPrompt) return _staticPrompt;
  _staticPrompt = await readFile(STATIC_PROMPT_PATH, "utf-8");
  return _staticPrompt;
}

export interface SystemInstructionParams {
  identity: IdentityConfig;
  persona: string;
  objective?: string;
  hangupWhen?: string;
}

export async function buildSystemInstruction(params: SystemInstructionParams): Promise<string> {
  const staticPrompt = await loadStaticPrompt();
  const parts: string[] = [];

  // Layer 1: Phone mechanics (universal)
  parts.push(staticPrompt);

  // Layer 2: Identity from config
  const userName = params.identity.user_name;
  let identityBlock = `## Identity\nYou are an AI phone assistant calling on behalf of ${userName}. Always identify yourself as '${userName}'s assistant' when asked. Never pretend to be human.`;
  if (params.identity.bio) {
    identityBlock += `\nAbout ${userName}: ${params.identity.bio}`;
  }
  parts.push(identityBlock);

  // Layer 2b: Current date/time context
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  parts.push(`## Context\nToday is ${dateStr}. Current time is ${timeStr}.`);

  // Layer 3: Persona (behavioral guidance)
  parts.push(`## Behavioral guidance\n${params.persona}`);

  // Layer 4: Objective
  if (params.objective) {
    parts.push(`## Your objective\n${params.objective}`);
  }

  // Layer 5: Hangup condition
  if (params.hangupWhen) {
    parts.push(`## When to end the call specifically\n${params.hangupWhen}`);
  }

  return parts.join("\n\n");
}
