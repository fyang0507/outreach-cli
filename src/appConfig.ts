import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

// Sealed interface — no index signature leaking into the rest of the codebase.
// Freeform user keys land in `extraFields`, populated at load time from the
// parsed YAML after stripping `user_name` and nulls.
//
// Promotion recipe for a new reserved identity key (e.g. pronouns, display_name):
//   1. Widen this IdentityConfig interface with the new field.
//   2. Pluck the field in the loader below (alongside user_name).
//   3. Render it explicitly in src/audio/systemInstruction.ts (Layer 2).
//   4. Wire it into src/commands/callbackDispatch.ts resolvePrompt + its call site.
export interface IdentityConfig {
  user_name: string;
  extraFields: Record<string, string>;
}

export interface CallConfig {
  max_duration_seconds: number;
}

export interface VoiceAgentConfig {
  default_persona: string;
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

export interface WatchConfig {
  enabled: boolean;
  callback_agent: string;
  callback_prompt: string;
  callback_prompt_human_input?: string;
  callback_prompt_human_input_timeout?: string;
  default_timeout_hours: number;
  poll_interval_minutes: number;
}

export interface AppConfig {
  data_repo_path: string;
  identity: IdentityConfig;
  call: CallConfig;
  voice_agent: VoiceAgentConfig;
  gemini: GeminiConfig;
  watch?: WatchConfig;
}

let _cached: AppConfig | null = null;

export async function loadAppConfig(): Promise<AppConfig> {
  if (_cached) return _cached;

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(thisDir, "..", "outreach.config.yaml");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `outreach.config.yaml not found at ${configPath}. This file is required.`
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `outreach.config.yaml is not valid YAML: ${(err as Error).message}`
    );
  }

  const config = parsed as Record<string, unknown>;

  // Validate data_repo_path (required)
  if (!config.data_repo_path || typeof config.data_repo_path !== "string") {
    throw new Error("outreach.config.yaml: data_repo_path is required");
  }
  // Expand ~ to home directory
  if ((config.data_repo_path as string).startsWith("~/")) {
    config.data_repo_path = join(homedir(), (config.data_repo_path as string).slice(2));
  }

  // Default call config if not present
  if (!config.call || typeof config.call !== "object") {
    (config as Record<string, unknown>).call = { max_duration_seconds: 300 };
  }
  const call = config.call as Record<string, unknown>;
  if (call.max_duration_seconds == null || typeof call.max_duration_seconds !== "number") {
    call.max_duration_seconds = 300;
  }

  if (!config.identity || typeof config.identity !== "object" || Array.isArray(config.identity)) {
    throw new Error("outreach.config.yaml: missing required section 'identity'");
  }
  const identity = config.identity as Record<string, unknown>;
  if (typeof identity.user_name !== "string" || identity.user_name.trim() === "") {
    throw new Error("outreach.config.yaml: identity.user_name is required and must be a non-empty string");
  }

  // `bio` was removed in favor of flat structured fields. Reject with a migration hint.
  if ("bio" in identity) {
    throw new Error(
      "outreach.config.yaml: `identity.bio` is no longer supported. Split structured fields out as top-level keys under `identity` (first_name, legal_name, address, phone, email), and put any free-text remainder under `identity.other`.",
    );
  }

  // Walk remaining keys: strings (kept) / null / empty-string (dropped) / anything else (reject).
  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(identity)) {
    if (key === "user_name") continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      throw new Error(
        `outreach.config.yaml: identity.${key} must be a string — nested objects are not allowed under 'identity'. Use a flat map.`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `outreach.config.yaml: value for 'identity.${key}' must be a string (got ${typeof value}).`,
      );
    }
    if (value === "") continue;
    extraFields[key] = value;
  }

  // Overwrite identity with the sealed shape downstream code reads.
  (config as Record<string, unknown>).identity = {
    user_name: identity.user_name,
    extraFields,
  } satisfies IdentityConfig;

  if (!config.voice_agent || typeof config.voice_agent !== "object") {
    throw new Error("outreach.config.yaml: missing required section 'voice_agent'");
  }
  if (!config.gemini || typeof config.gemini !== "object") {
    throw new Error("outreach.config.yaml: missing required section 'gemini'");
  }

  const gemini = config.gemini as Record<string, unknown>;
  const voiceAgent = config.voice_agent as Record<string, unknown>;

  if (!voiceAgent.default_persona || typeof voiceAgent.default_persona !== "string") {
    throw new Error("outreach.config.yaml: voice_agent.default_persona is required");
  }
  if (!gemini.model || typeof gemini.model !== "string") {
    throw new Error("outreach.config.yaml: gemini.model is required");
  }
  if (!gemini.speech || typeof gemini.speech !== "object") {
    throw new Error("outreach.config.yaml: gemini.speech is required");
  }
  const speech = gemini.speech as Record<string, unknown>;
  if (!speech.voice_name || typeof speech.voice_name !== "string") {
    throw new Error("outreach.config.yaml: gemini.speech.voice_name is required");
  }
  if (!gemini.thinking || typeof gemini.thinking !== "object") {
    throw new Error("outreach.config.yaml: gemini.thinking is required");
  }
  const thinking = gemini.thinking as Record<string, unknown>;
  if (!thinking.thinking_level || typeof thinking.thinking_level !== "string") {
    throw new Error("outreach.config.yaml: gemini.thinking.thinking_level is required");
  }
  if (!gemini.turn_taking || typeof gemini.turn_taking !== "object") {
    throw new Error("outreach.config.yaml: gemini.turn_taking is required");
  }
  const turnTaking = gemini.turn_taking as Record<string, unknown>;
  if (!turnTaking.activity_handling || typeof turnTaking.activity_handling !== "string") {
    throw new Error("outreach.config.yaml: gemini.turn_taking.activity_handling is required");
  }

  // Validate watch config (optional section)
  if (config.watch != null) {
    if (typeof config.watch !== "object") {
      throw new Error("outreach.config.yaml: watch must be an object");
    }
    const watch = config.watch as Record<string, unknown>;
    if (watch.enabled == null || typeof watch.enabled !== "boolean") {
      watch.enabled = false;
    }
    if (!watch.callback_agent || typeof watch.callback_agent !== "string") {
      throw new Error("outreach.config.yaml: watch.callback_agent is required when watch section is present");
    }
    if (!watch.callback_prompt || typeof watch.callback_prompt !== "string") {
      throw new Error("outreach.config.yaml: watch.callback_prompt is required when watch section is present");
    }
    if (watch.default_timeout_hours == null || typeof watch.default_timeout_hours !== "number") {
      watch.default_timeout_hours = 72;
    }
    if (watch.poll_interval_minutes == null || typeof watch.poll_interval_minutes !== "number") {
      watch.poll_interval_minutes = 2;
    }
  }

  _cached = parsed as AppConfig;
  return _cached;
}
