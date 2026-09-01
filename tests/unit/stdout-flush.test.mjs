import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `outputJson()` + `process.exit()` is the shape that silently truncates a
// JSON-only CLI: when stdout is a pipe the write is async, exit() does not wait
// for it to drain, and a payload past the pipe buffer (64KB on macOS) reaches
// the caller cut off mid-string — with exit 0, so nothing distinguishes it from
// output the caller simply failed to parse. These tests hold the whole command
// surface to the rule, including the commands that need live Twilio/Gmail/
// Discord credentials and so can never be exercised here.

const SRC_COMMANDS = fileURLToPath(new URL("../../src/commands", import.meta.url));
const OUTPUT_MODULE = fileURLToPath(new URL("../../dist/output.js", import.meta.url));

/** Every .ts file under src/commands, as { path, source }. */
function commandSources(dir = SRC_COMMANDS, rel = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const label = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...commandSources(abs, label));
    else if (entry.name.endsWith(".ts")) out.push({ path: label, source: readFileSync(abs, "utf8") });
  }
  return out;
}

/** Drop line comments so a comment *about* the rule never trips the rule. */
function stripComments(source) {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

test("no command exits a success path with process.exit(SUCCESS)", () => {
  const offenders = commandSources()
    .filter(({ source }) => /process\.exit\(SUCCESS\)/.test(stripComments(source)))
    .map(({ path }) => path);

  assert.deepEqual(
    offenders,
    [],
    `these commands would truncate a large payload on a pipe; set process.exitCode = SUCCESS instead: ${offenders.join(", ")}`,
  );
});

test("no command follows outputJson() with an immediate process.exit()", () => {
  // Broader than the SUCCESS check: process.exit(0) or process.exit(code) right
  // after the payload truncates it just the same.
  //
  // `call call/init.ts` is not an exception to this — it ends its success path
  // with `return SUCCESS`, and its caller's `process.exit(code)` is deliberate
  // and load-bearing: init fork()s the daemon with an "ipc" stdio channel, and
  // that channel keeps the parent's event loop alive even after child.unref(),
  // so init would hang forever waiting on its own daemon if it fell through to
  // a natural exit. Its payload is a status line plus a fixed-shape preflight
  // report — bounded, and nowhere near the pipe buffer.
  const offenders = [];

  for (const { path, source } of commandSources()) {
    const lines = stripComments(source).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("outputJson(")) continue;

      // Walk to the line closing the outputJson(...) call.
      let depth = 0;
      let end = i;
      for (; end < lines.length; end++) {
        for (const ch of lines[end]) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        if (depth <= 0) break;
      }

      // The next statement that isn't blank.
      const next = lines.slice(end + 1).find((line) => line.trim() !== "");
      if (next && next.trim().startsWith("process.exit(")) {
        offenders.push(`${path}:${i + 1}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `outputJson() immediately followed by process.exit(): ${offenders.join(", ")}`);
});

test("a payload past the pipe buffer survives outputJson() + process.exitCode", () => {
  // The contract documented on outputJson(), exercised end to end against a
  // real pipe. spawnSync gives the child a pipe, which is the failing case; a
  // redirect to a file is not, because file writes are synchronous.
  const dir = mkdtempSync(join(tmpdir(), "outreach-flush-"));
  try {
    const script = join(dir, "emit.mjs");
    writeFileSync(
      script,
      `import { outputJson } from ${JSON.stringify(OUTPUT_MODULE)};\n` +
        `outputJson({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, filler: "x".repeat(40) })) });\n` +
        `process.exitCode = 0;\n`,
    );

    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.length > 65536, `expected > 64KB, got ${run.stdout.length}`);
    assert.equal(JSON.parse(run.stdout).rows.length, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
