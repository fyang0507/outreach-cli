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
      reject(new Error(`Daemon not responding (timed out after ${timeout / 1000}s). Try 'outreach call teardown' then 'outreach call init'.`));
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
          reject(new Error("Daemon returned invalid response. Try 'outreach call teardown' then 'outreach call init'."));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        reject(new Error("Daemon not running. Run 'outreach call init' to start it."));
      } else {
        reject(new Error(`Cannot connect to daemon: ${err.message}. Try 'outreach call teardown' then 'outreach call init'.`));
      }
    });
  });
}
