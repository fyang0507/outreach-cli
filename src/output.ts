export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/** `details` carries machine-readable context (e.g. a preflight report) alongside the message. */
export function outputError(code: number, message: string, details?: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ error: code, message, ...details }) + "\n");
}
