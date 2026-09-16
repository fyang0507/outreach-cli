import { GoogleGenAI, Live } from "@google/genai";
import { WebSocket } from "ws";

class GeminiLiveClient extends GoogleGenAI {
  withTransport(factory: ConstructorParameters<typeof Live>[2]): Live {
    // This client explicitly uses the Gemini API, whose Live URL carries the
    // API key. Vertex's separate authorization callback is never used.
    return new Live(this.apiClient, { addAuthHeaders: async () => {} }, factory);
  }
}

/** Own the socket while the SDK is still waiting for setupComplete. */
export function createGeminiLive(apiKey: string): { live: Live; cancel: () => void } {
  let terminate = () => {};
  const client = new GeminiLiveClient({ apiKey, vertexai: false });
  const live = client.withTransport({
    create(url, headers, callbacks) {
      let socket: WebSocket | undefined;
      return {
        connect() {
          socket = new WebSocket(url, { headers });
          terminate = () => socket?.terminate();
          socket.onopen = callbacks.onopen;
          socket.onerror = callbacks.onerror;
          socket.onclose = callbacks.onclose;
          socket.onmessage = callbacks.onmessage;
        },
        send(message) {
          if (!socket) throw new Error("Gemini WebSocket is not connected");
          socket.send(message);
        },
        close() {
          socket?.close();
        },
      };
    },
  });
  return { live, cancel: () => terminate() };
}
