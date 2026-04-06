import type { VoiceAgentConfig } from "../appConfig.js";

export interface SystemInstructionParams {
  persona?: string;
  objective?: string;
  hangupWhen?: string;
  welcomeGreeting?: string;
  voiceAgentConfig: VoiceAgentConfig;
}

export function buildSystemInstruction(params: SystemInstructionParams): string {
  const t = params.voiceAgentConfig.system_prompt_template;
  const parts: string[] = [];

  // Persona — CLI override > config default
  parts.push(`## Who you are\n${params.persona || t.persona}`);

  // Objective
  if (params.objective) {
    parts.push(`## Your objective\n${params.objective}`);
  }

  // Welcome greeting
  if (params.welcomeGreeting) {
    parts.push(`## Opening line\nWhen the call connects and someone answers, start by saying: "${params.welcomeGreeting}"`);
  }

  // Hangup condition
  if (params.hangupWhen) {
    parts.push(`## When to end the call specifically\n${params.hangupWhen}`);
  }

  // Standard instructions from config
  parts.push(`## Phone navigation (IVR)\n${t.ivr_instructions}`);
  parts.push(`## Call screening\n${t.call_screening_instructions}`);
  parts.push(`## Ending the call\n${t.ending_instructions}`);
  parts.push(`## Conversation style\n${t.conversation_style}`);

  return parts.join("\n\n");
}
