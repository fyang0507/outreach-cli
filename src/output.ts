export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

export function outputError(code: number, message: string): void {
  process.stderr.write(JSON.stringify({ error: code, message }) + "\n");
}
