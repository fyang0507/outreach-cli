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

  // Look for outreach.config.json in project root (relative to dist/)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(thisDir, "..", "outreach.config.json");

  try {
    const raw = await readFile(configPath, "utf-8");
    _cached = JSON.parse(raw) as AppConfig;
    return _cached;
  } catch {
    // Return defaults if config file not found
    _cached = getDefaults();
    return _cached;
  }
}

function getDefaults(): AppConfig {
  return {
    voice_agent: {
      system_prompt_template: {
        persona: "You are a helpful phone assistant making a call on behalf of the user.",
        conversation_style: "Be natural and conversational. Keep responses concise. Listen carefully and respond to what was actually said.",
        ivr_instructions: "When you hear an automated phone menu, use the send_dtmf tool to press the appropriate keypad buttons.",
        call_screening_instructions: "If the call is being screened, clearly state who you are and why you're calling.",
        ending_instructions: "Use the end_call tool when your objective has been accomplished or the conversation has naturally concluded.",
      },
    },
    gemini: {
      model: "models/gemini-3.1-flash-live-preview",
      speech: { voice_name: "Aoede", language_code: null },
      generation: { temperature: null, top_p: null, top_k: null, max_output_tokens: null },
      thinking: { thinking_level: "minimal", include_thoughts: false },
      vad: { start_of_speech_sensitivity: null, end_of_speech_sensitivity: null, prefix_padding_ms: null, silence_duration_ms: null },
      turn_taking: { activity_handling: "START_OF_ACTIVITY_INTERRUPTS" },
      transcription: { input_language_codes: null, output_language_codes: null },
    },
  };
}
