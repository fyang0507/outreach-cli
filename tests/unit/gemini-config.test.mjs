import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

const exampleUrl = new URL("../../outreach.config.dev.yaml.example", import.meta.url);

async function loadExampleConfig(t, modify = () => {}) {
  const config = parse(await readFile(exampleUrl, "utf8"));
  modify(config);
  const dir = await mkdtemp(join(tmpdir(), "outreach-gemini-config-"));
  const previousDataRepo = process.env.OUTREACH_DATA_REPO;
  t.after(async () => {
    if (previousDataRepo === undefined) delete process.env.OUTREACH_DATA_REPO;
    else process.env.OUTREACH_DATA_REPO = previousDataRepo;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "outreach"));
  const configPath = join(dir, "outreach", "config.yaml");
  await writeFile(configPath, stringify(config));
  process.env.OUTREACH_DATA_REPO = dir;
  // The loader caches successful reads; isolate each case without adding a production reset hook.
  const moduleUrl = new URL("../../dist/appConfig.js", import.meta.url);
  moduleUrl.searchParams.set("test", randomUUID());
  const { loadAppConfig } = await import(moduleUrl.href);
  return { loadAppConfig, configPath };
}

test("the shipped config loads Gemini 3.8 without a thinking section", async (t) => {
  const { loadAppConfig, configPath } = await loadExampleConfig(t);
  const loaded = await loadAppConfig();
  assert.equal(loaded.gemini.model, "gemini-3.8-live");
  assert.equal(Object.hasOwn(loaded.gemini, "thinking"), false);
  assert.equal(loaded.gemini.speech.voice_name, "Aoede");
  assert.equal(loaded.config_path, configPath);
  assert.equal(loaded.config_source, "env");
});

for (const [description, value] of [
  ["a configured object", { thinking_level: "low", include_thoughts: false }],
  ["an empty object", {}],
  ["null", null],
]) {
  test(`stale gemini.thinking is rejected even when it is ${description}`, async (t) => {
    const { loadAppConfig, configPath } = await loadExampleConfig(t, (config) => {
      config.gemini.thinking = value;
    });
    await assert.rejects(loadAppConfig, (error) => {
      assert.match(error.message, /gemini\.thinking/);
      assert.match(error.message, /remove|no longer supported|unsupported/i);
      assert.ok(error.message.includes(configPath), "identify the config file to repair");
      return true;
    });
  });
}
