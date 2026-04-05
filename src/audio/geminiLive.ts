import { GoogleGenAI, Modality, type LiveServerMessage, type FunctionCall } from "@google/genai";

export interface GeminiLiveSessionOptions {
  apiKey: string;
  model: string;
  systemInstruction: string;
  voiceName: string;
  tools?: object[];
  onAudio: (base64Pcm: string) => void;
  onTranscript: (speaker: "remote" | "local", text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, id: string) => void;
  onEnd: () => void;
}

const DEFAULT_TOOLS = [{
  functionDeclarations: [{
    name: "send_dtmf",
    description: "Send DTMF keypad tones to navigate phone menus (IVR systems). Use when you hear options like 'press 1 for...'",
    parameters: {
      type: "OBJECT" as const,
      properties: {
        digits: { type: "STRING" as const, description: "Digits to send, e.g. '1' or '123#'" }
      },
      required: ["digits"]
    }
  }, {
    name: "end_call",
    description: "End the phone call. Use when your objective is met or the conversation is naturally over.",
    parameters: {
      type: "OBJECT" as const,
      properties: {
        reason: { type: "STRING" as const, description: "Brief reason for ending the call" }
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

    const tools = this.opts.tools ?? DEFAULT_TOOLS;

    this.session = await ai.live.connect({
      model: this.opts.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.opts.voiceName,
            },
          },
        },
        systemInstruction: this.opts.systemInstruction,
        tools,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
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
    // Handle audio data from model response
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
          this.opts.onAudio(part.inlineData.data);
        }
      }
    }

    // Handle input transcription (what the remote party said)
    if (msg.serverContent?.inputTranscription?.text) {
      this.opts.onTranscript("remote", msg.serverContent.inputTranscription.text);
    }

    // Handle output transcription (what Gemini said)
    if (msg.serverContent?.outputTranscription?.text) {
      this.opts.onTranscript("local", msg.serverContent.outputTranscription.text);
    }

    // Handle tool calls
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
