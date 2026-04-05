import { connect } from "node:net";

const SOCKET_PATH = "/tmp/outreach-daemon.sock";
const DEFAULT_TIMEOUT_MS = 10_000;

export function sendToDaemon(method: string, params: object, timeoutMs?: number): Promise<unknown> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    let data = "";

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC timeout: daemon did not respond within ${timeout / 1000}s`));
    }, timeout);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ method, params }) + "\n");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString();
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx !== -1) {
        clearTimeout(timer);
        const line = data.slice(0, newlineIdx);
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("Invalid JSON from daemon"));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot connect to daemon at ${SOCKET_PATH}: ${err.message}`,
        ),
      );
    });
  });
}
