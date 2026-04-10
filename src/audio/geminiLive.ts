import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Tool, type ThinkingLevel, type ActivityHandling } from "@google/genai";
import type { GeminiConfig } from "../appConfig.js";

export interface GeminiLiveSessionOptions {
  apiKey: string;
  geminiConfig: GeminiConfig;
  systemInstruction: string;
  onAudio: (base64Pcm: string) => void;
  onTranscript: (speaker: "remote" | "local", text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, id: string) => void;
  onEnd: () => void;
}

const DEFAULT_TOOLS: Tool[] = [{
  functionDeclarations: [{
    name: "send_dtmf",
    description: "Send DTMF keypad tones to navigate phone menus (IVR systems). Use when you hear options like 'press 1 for...'",
    parameters: {
      type: Type.OBJECT,
      properties: {
        digits: { type: Type.STRING, description: "Digits to send, e.g. '1' or '123#'" }
      },
      required: ["digits"]
    }
  }, {
    name: "end_call",
    description: "End the phone call. Use when your objective is met or the conversation is naturally over.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: "Brief reason for ending the call" }
      },
      required: ["reason"]
    }
  }]
}];

export class GeminiLiveSession {
  private session: Awaited<ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>> | null = null;
  private opts: GeminiLiveSessionOptions;
  private closed = false;

  constructor(opts: GeminiLiveSessionOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.opts.apiKey });
    const gc = this.opts.geminiConfig;

    // Build generation config — only include non-null values
    const generationConfig: Record<string, unknown> = {};
    if (gc.generation.temperature !== null) generationConfig.temperature = gc.generation.temperature;
    if (gc.generation.top_p !== null) generationConfig.topP = gc.generation.top_p;
    if (gc.generation.top_k !== null) generationConfig.topK = gc.generation.top_k;
    if (gc.generation.max_output_tokens !== null) generationConfig.maxOutputTokens = gc.generation.max_output_tokens;

    // Build VAD config — only include non-null values
    const vadConfig: Record<string, unknown> = {};
    if (gc.vad.start_of_speech_sensitivity !== null) vadConfig.startOfSpeechSensitivity = gc.vad.start_of_speech_sensitivity;
    if (gc.vad.end_of_speech_sensitivity !== null) vadConfig.endOfSpeechSensitivity = gc.vad.end_of_speech_sensitivity;
    if (gc.vad.prefix_padding_ms !== null) vadConfig.prefixPaddingMs = gc.vad.prefix_padding_ms;
    if (gc.vad.silence_duration_ms !== null) vadConfig.silenceDurationMs = gc.vad.silence_duration_ms;

    // Build transcription config
    const inputTranscription: Record<string, unknown> = {};
    if (gc.transcription.input_language_codes) inputTranscription.languageCodes = gc.transcription.input_language_codes;
    const outputTranscription: Record<string, unknown> = {};
    if (gc.transcription.output_language_codes) outputTranscription.languageCodes = gc.transcription.output_language_codes;

    this.session = await ai.live.connect({
      model: gc.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: gc.speech.voice_name,
            },
          },
          ...(gc.speech.language_code ? { languageCode: gc.speech.language_code } : {}),
        },
        systemInstruction: this.opts.systemInstruction,
        tools: DEFAULT_TOOLS,
        inputAudioTranscription: inputTranscription,
        outputAudioTranscription: outputTranscription,
        // Thinking config
        ...(gc.thinking.thinking_level !== "minimal" || gc.thinking.include_thoughts ? {
          thinkingConfig: {
            thinkingLevel: gc.thinking.thinking_level.toUpperCase() as ThinkingLevel,
            includeThoughts: gc.thinking.include_thoughts,
          },
        } : {}),
        // Generation config overrides
        ...generationConfig,
        // VAD config
        ...(Object.keys(vadConfig).length > 0 ? {
          realtimeInputConfig: {
            automaticActivityDetection: vadConfig,
            activityHandling: gc.turn_taking.activity_handling as ActivityHandling,
          },
        } : {
          realtimeInputConfig: {
            activityHandling: gc.turn_taking.activity_handling as ActivityHandling,
          },
        }),
      },
      callbacks: {
        onopen: () => {
          console.log("[gemini-live] Connected");
        },
        onmessage: (msg: LiveServerMessage) => {
          this.handleMessage(msg);
        },
        onerror: (e: ErrorEvent) => {
          console.error("[gemini-live] Error:", e.error ?? e.message ?? e);
        },
        onclose: (_e: CloseEvent) => {
          console.log("[gemini-live] Connection closed");
          if (!this.closed) {
            this.closed = true;
            this.opts.onEnd();
          }
        },
      },
    });
  }

  private handleMessage(msg: LiveServerMessage): void {
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
          this.opts.onAudio(part.inlineData.data);
        }
      }
    }

    if (msg.serverContent?.inputTranscription?.text) {
      this.opts.onTranscript("remote", msg.serverContent.inputTranscription.text);
    }

    if (msg.serverContent?.outputTranscription?.text) {
      this.opts.onTranscript("local", msg.serverContent.outputTranscription.text);
    }

    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        if (fc.name && fc.id) {
          this.opts.onToolCall(fc.name, (fc.args as Record<string, unknown>) ?? {}, fc.id);
        }
      }
    }
  }

  sendAudio(base64Pcm16k: string): void {
    if (!this.session || this.closed) return;
    this.session.sendRealtimeInput({
      audio: {
        data: base64Pcm16k,
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  sendToolResponse(functionCallId: string, name: string, result: Record<string, unknown>): void {
    if (!this.session || this.closed) return;
    this.session.sendToolResponse({
      functionResponses: [{
        id: functionCallId,
        name,
        response: result,
      }],
    });
  }

  rebindCallbacks(cbs: {
    onAudio: GeminiLiveSessionOptions["onAudio"];
    onTranscript: GeminiLiveSessionOptions["onTranscript"];
    onToolCall: GeminiLiveSessionOptions["onToolCall"];
    onEnd: GeminiLiveSessionOptions["onEnd"];
  }): void {
    this.opts.onAudio = cbs.onAudio;
    this.opts.onTranscript = cbs.onTranscript;
    this.opts.onToolCall = cbs.onToolCall;
    this.opts.onEnd = cbs.onEnd;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // ignore close errors
      }
      this.session = null;
    }
  }
}
