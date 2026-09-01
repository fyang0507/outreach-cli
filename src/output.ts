/**
 * Write the command's JSON result to stdout.
 *
 * Callers must follow this with `process.exitCode = SUCCESS` on the success
 * path, never `process.exit(SUCCESS)`. When stdout is a pipe rather than a TTY,
 * the write is asynchronous, and `process.exit()` does not wait for it to
 * drain: a payload larger than the pipe buffer (64KB on macOS) reached the
 * caller truncated mid-string, with exit 0 — unparseable JSON wearing a success
 * code, which is the worst failure shape a JSON-only CLI has. Setting the code
 * instead lets node exit on its own once stdout has flushed.
 *
 * `outputError` paths keep their immediate `process.exit()`: those payloads are
 * one short line, and an error path is the one place where exiting promptly
 * matters more than draining.
 */
export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/** `details` carries machine-readable context (e.g. a preflight report) alongside the message. */
export function outputError(code: number, message: string, details?: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ error: code, message, ...details }) + "\n");
}
