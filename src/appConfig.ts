import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { resolveDataRepo, locateDevConfig, type ResolutionSource } from "./dataRepo.js";

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
  config_path: string;
  config_source: ResolutionSource;
  identity: IdentityConfig;
  call: CallConfig;
  voice_agent: VoiceAgentConfig;
  gemini: GeminiConfig;
  watch?: WatchConfig;
}

let _cached: AppConfig | null = null;

export async function loadAppConfig(): Promise<AppConfig> {
  if (_cached) return _cached;

  // Resolve data repo location first — let resolveDataRepo errors propagate.
  const resolved = resolveDataRepo();
  const primaryPath = join(resolved.path, "outreach", "config.yaml");

  let configPath: string;
  let raw: string;

  if (existsSync(primaryPath)) {
    configPath = primaryPath;
    raw = await readFile(configPath, "utf-8");
  } else if (resolved.source === "dev") {
    // Dev fallback: the dev pointer lives beside the CLI. Read the dev file
    // itself as the config source so devs who haven't run `outreach setup`
    // keep working off their .dev.yaml.
    const dev = locateDevConfig();
    if (!dev) {
      // Shouldn't happen — resolveDataRepo returned "dev" which means the
      // dev file was found. Guard anyway.
      throw new Error(
        `outreach: resolveDataRepo() returned source=dev but outreach.config.dev.yaml could not be located. Run \`outreach setup\` to scaffold ${primaryPath}.`,
      );
    }
    configPath = dev.path;
    raw = await readFile(configPath, "utf-8");
  } else {
    throw new Error(
      `outreach: config file not found at ${primaryPath}. Run \`outreach setup\` to scaffold it in the data repo.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `outreach: ${configPath} is not valid YAML: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`outreach: ${configPath} did not parse to an object`);
  }

  const config = parsed as Record<string, unknown>;

  // The resolved data repo path wins. If the (dev-fallback) config file
  // declares its own `data_repo_path`, tolerate but ignore it.
  config.data_repo_path = resolved.path;

  // Default call config if not present
  if (!config.call || typeof config.call !== "object") {
    (config as Record<string, unknown>).call = { max_duration_seconds: 300 };
  }
  const call = config.call as Record<string, unknown>;
  if (call.max_duration_seconds == null || typeof call.max_duration_seconds !== "number") {
    call.max_duration_seconds = 300;
  }

  if (!config.identity || typeof config.identity !== "object" || Array.isArray(config.identity)) {
    throw new Error(`outreach: ${configPath} missing required section 'identity'`);
  }
  const identity = config.identity as Record<string, unknown>;
  if (typeof identity.user_name !== "string" || identity.user_name.trim() === "") {
    throw new Error(`outreach: ${configPath} — identity.user_name is required and must be a non-empty string`);
  }

  // `bio` was removed in favor of flat structured fields. Reject with a migration hint.
  if ("bio" in identity) {
    throw new Error(
      `outreach: ${configPath} — \`identity.bio\` is no longer supported. Split structured fields out as top-level keys under \`identity\` (first_name, legal_name, address, phone, email), and put any free-text remainder under \`identity.other\`.`,
    );
  }

  // Walk remaining keys: strings (kept) / null / empty-string (dropped) / anything else (reject).
  // Expand `~/` on user-entered string values (identity fields are user-entered).
  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(identity)) {
    if (key === "user_name") continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      throw new Error(
        `outreach: ${configPath} — identity.${key} must be a string — nested objects are not allowed under 'identity'. Use a flat map.`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `outreach: ${configPath} — value for 'identity.${key}' must be a string (got ${typeof value}).`,
      );
    }
    if (value === "") continue;
    let expanded = value;
    if (expanded === "~") expanded = homedir();
    else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
    extraFields[key] = expanded;
  }

  // Overwrite identity with the sealed shape downstream code reads.
  (config as Record<string, unknown>).identity = {
    user_name: identity.user_name,
    extraFields,
  } satisfies IdentityConfig;

  if (!config.voice_agent || typeof config.voice_agent !== "object") {
    throw new Error(`outreach: ${configPath} missing required section 'voice_agent'`);
  }
  if (!config.gemini || typeof config.gemini !== "object") {
    throw new Error(`outreach: ${configPath} missing required section 'gemini'`);
  }

  const gemini = config.gemini as Record<string, unknown>;
  const voiceAgent = config.voice_agent as Record<string, unknown>;

  if (!voiceAgent.default_persona || typeof voiceAgent.default_persona !== "string") {
    throw new Error(`outreach: ${configPath} — voice_agent.default_persona is required`);
  }
  if (!gemini.model || typeof gemini.model !== "string") {
    throw new Error(`outreach: ${configPath} — gemini.model is required`);
  }
  if (!gemini.speech || typeof gemini.speech !== "object") {
    throw new Error(`outreach: ${configPath} — gemini.speech is required`);
  }
  const speech = gemini.speech as Record<string, unknown>;
  if (!speech.voice_name || typeof speech.voice_name !== "string") {
    throw new Error(`outreach: ${configPath} — gemini.speech.voice_name is required`);
  }
  if (!gemini.thinking || typeof gemini.thinking !== "object") {
    throw new Error(`outreach: ${configPath} — gemini.thinking is required`);
  }
  const thinking = gemini.thinking as Record<string, unknown>;
  if (!thinking.thinking_level || typeof thinking.thinking_level !== "string") {
    throw new Error(`outreach: ${configPath} — gemini.thinking.thinking_level is required`);
  }
  if (!gemini.turn_taking || typeof gemini.turn_taking !== "object") {
    throw new Error(`outreach: ${configPath} — gemini.turn_taking is required`);
  }
  const turnTaking = gemini.turn_taking as Record<string, unknown>;
  if (!turnTaking.activity_handling || typeof turnTaking.activity_handling !== "string") {
    throw new Error(`outreach: ${configPath} — gemini.turn_taking.activity_handling is required`);
  }

  // Validate watch config (optional section)
  if (config.watch != null) {
    if (typeof config.watch !== "object") {
      throw new Error(`outreach: ${configPath} — watch must be an object`);
    }
    const watch = config.watch as Record<string, unknown>;
    if (watch.enabled == null || typeof watch.enabled !== "boolean") {
      watch.enabled = false;
    }
    if (!watch.callback_agent || typeof watch.callback_agent !== "string") {
      throw new Error(`outreach: ${configPath} — watch.callback_agent is required when watch section is present`);
    }
    if (!watch.callback_prompt || typeof watch.callback_prompt !== "string") {
      throw new Error(`outreach: ${configPath} — watch.callback_prompt is required when watch section is present`);
    }
    if (watch.default_timeout_hours == null || typeof watch.default_timeout_hours !== "number") {
      watch.default_timeout_hours = 72;
    }
    if (watch.poll_interval_minutes == null || typeof watch.poll_interval_minutes !== "number") {
      watch.poll_interval_minutes = 2;
    }
  }

  // Attach resolution metadata for health/debug surfaces.
  config.config_path = configPath;
  config.config_source = resolved.source;

  _cached = config as unknown as AppConfig;
  return _cached;
}
