import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface VoiceAgentConfig {
  system_prompt_template: {
    persona: string;
    conversation_style: string;
    ivr_instructions: string;
    call_screening_instructions: string;
    ending_instructions: string;
  };
}

export interface GeminiConfig {
  model: string;
  speech: {
    voice_name: string;
    language_code: string | null;
  };
  generation: {
    temperature: number | null;
    top_p: number | null;
    top_k: number | null;
    max_output_tokens: number | null;
  };
  thinking: {
    thinking_level: "minimal" | "low" | "medium" | "high";
    include_thoughts: boolean;
  };
  vad: {
    start_of_speech_sensitivity: "START_SENSITIVITY_LOW" | "START_SENSITIVITY_HIGH" | null;
    end_of_speech_sensitivity: "END_SENSITIVITY_LOW" | "END_SENSITIVITY_HIGH" | null;
    prefix_padding_ms: number | null;
    silence_duration_ms: number | null;
  };
  turn_taking: {
    activity_handling: "START_OF_ACTIVITY_INTERRUPTS" | "NO_INTERRUPTION";
  };
  transcription: {
    input_language_codes: string[] | null;
    output_language_codes: string[] | null;
  };
}

export interface AppConfig {
  voice_agent: VoiceAgentConfig;
  gemini: GeminiConfig;
}

let _cached: AppConfig | null = null;

export async function loadAppConfig(): Promise<AppConfig> {
  if (_cached) return _cached;

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(thisDir, "..", "outreach.config.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `outreach.config.json not found at ${configPath}. This file is required — copy it from the project root.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `outreach.config.json is not valid JSON: ${(err as Error).message}`
    );
  }

  const config = parsed as Record<string, unknown>;

  // Validate required top-level sections
  if (!config.voice_agent || typeof config.voice_agent !== "object") {
    throw new Error("outreach.config.json: missing required section 'voice_agent'");
  }
  if (!config.gemini || typeof config.gemini !== "object") {
    throw new Error("outreach.config.json: missing required section 'gemini'");
  }

  const gemini = config.gemini as Record<string, unknown>;
  const voiceAgent = config.voice_agent as Record<string, unknown>;

  // Validate required gemini fields
  if (!gemini.model || typeof gemini.model !== "string") {
    throw new Error("outreach.config.json: gemini.model is required");
  }
  if (!gemini.speech || typeof gemini.speech !== "object") {
    throw new Error("outreach.config.json: gemini.speech is required");
  }
  const speech = gemini.speech as Record<string, unknown>;
  if (!speech.voice_name || typeof speech.voice_name !== "string") {
    throw new Error("outreach.config.json: gemini.speech.voice_name is required");
  }
  if (!gemini.thinking || typeof gemini.thinking !== "object") {
    throw new Error("outreach.config.json: gemini.thinking is required");
  }
  const thinking = gemini.thinking as Record<string, unknown>;
  if (!thinking.thinking_level || typeof thinking.thinking_level !== "string") {
    throw new Error("outreach.config.json: gemini.thinking.thinking_level is required");
  }
  if (!gemini.turn_taking || typeof gemini.turn_taking !== "object") {
    throw new Error("outreach.config.json: gemini.turn_taking is required");
  }
  const turnTaking = gemini.turn_taking as Record<string, unknown>;
  if (!turnTaking.activity_handling || typeof turnTaking.activity_handling !== "string") {
    throw new Error("outreach.config.json: gemini.turn_taking.activity_handling is required");
  }

  // Validate required voice_agent fields
  if (!voiceAgent.system_prompt_template || typeof voiceAgent.system_prompt_template !== "object") {
    throw new Error("outreach.config.json: voice_agent.system_prompt_template is required");
  }
  const spt = voiceAgent.system_prompt_template as Record<string, unknown>;
  for (const field of ["persona", "conversation_style", "ivr_instructions", "call_screening_instructions", "ending_instructions"]) {
    if (!spt[field] || typeof spt[field] !== "string") {
      throw new Error(`outreach.config.json: voice_agent.system_prompt_template.${field} is required`);
    }
  }

  _cached = parsed as AppConfig;
  return _cached;
}
