import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

const exampleUrl = new URL("../../outreach.config.dev.yaml.example", import.meta.url);

async function loadExampleConfig(t) {
  const config = parse(await readFile(exampleUrl, "utf8"));
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
  const { loadAppConfig } = await import("../../dist/appConfig.js");
  return { loadAppConfig, configPath };
}

test("the shipped Gemini 3.8 configuration loads", async (t) => {
  const { loadAppConfig, configPath } = await loadExampleConfig(t);
  const loaded = await loadAppConfig();
  assert.equal(loaded.gemini.model, "gemini-3.8-live");
  assert.equal(loaded.gemini.speech.voice_name, "Aoede");
  assert.equal(loaded.config_path, configPath);
  assert.equal(loaded.config_source, "env");
});
