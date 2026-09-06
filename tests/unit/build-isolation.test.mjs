import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

for (const configured of [false, true]) {
test(`build preserves skill catalogs and skips runtime config (workspace env: ${configured})`, () => {
  const fixture = mkdtempSync(join(tmpdir(), "outreach-cli-build-"));
  try {
    const checkout = join(fixture, "checkout");
    const catalog = join(fixture, "workspace", ".agents", "skills");
    mkdirSync(checkout);
    const names = ["outreach","contact-operator"];
    for (const name of names) {
      mkdirSync(join(catalog, name), { recursive: true });
      writeFileSync(join(catalog, name, "SKILL.md"), "consumer-owned sentinel\n");
    }
    for (const entry of ["package.json","tsconfig.json","src","scripts","skills","tests"]) {
      const source = join(repoRoot, entry);
      if (existsSync(source)) cpSync(source, join(checkout, entry), { recursive: true });
    }
    symlinkSync(join(repoRoot, "node_modules"), join(checkout, "node_modules"), "dir");
    writeFileSync(join(checkout, ".env"), "FAKE_BUILD_SENTINEL=never-load\n");
    writeFileSync(join(checkout, "outreach.config.dev.yaml"), "deliberately: [invalid\n");
    writeFileSync(join(checkout, "publish.config.dev.yaml"), "deliberately: [invalid\n");
    mkdirSync(join(checkout, ".agents"));
    writeFileSync(join(checkout, ".agents", "workspace.yaml"), "deliberately: [invalid\n");
    const readLog = join(fixture, "config-reads.log");
    const guard = join(fixture, "guard.cjs");
    writeFileSync(guard, String.raw`
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const log = process.env.BUILD_READ_LOG;
const append = fs.appendFileSync;
function rejectConfig(path) {
  if (/(^|[/\\])(?:\.env|(?:outreach|publish)\.config\.dev\.yaml)$|[/\\]\.agents[/\\]workspace\.yaml$/.test(String(path))) {
    append(log, String(path) + "\n");
    throw new Error("Build must not inspect runtime configuration");
  }
}
for (const name of ["accessSync", "existsSync", "lstatSync", "statSync", "openSync", "readFileSync", "access", "lstat", "stat", "open", "readFile"]) {
  const original = fs[name];
  fs[name] = function (path, ...args) {
    rejectConfig(path);
    return original.call(this, path, ...args);
  };
}
for (const name of ["access", "lstat", "stat", "open", "readFile"]) {
  const original = fs.promises[name];
  fs.promises[name] = function (path, ...args) {
    rejectConfig(path);
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
`);
    const run = spawnSync("npm", ["run", "build"], {
      cwd: checkout,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--require="${guard}"`,
        BUILD_READ_LOG: readLog,
        ...(configured ? {
          OUTREACH_DATA_REPO: join(fixture, "workspace"),
          PUBLISH_DATA_REPO: join(fixture, "workspace"),
          PUBLISH_SKILLS_DIR: catalog,
          NTN_GATEWAY_DATA_REPO: join(fixture, "workspace"),
        } : {}),
      },
    });
    assert.equal(run.status, 0, run.error?.message ?? `${run.stdout}\n${run.stderr}`);
    assert.equal(existsSync(readLog), false, "even swallowed configuration reads are forbidden");
    assert.deepEqual(readdirSync(catalog).sort(), [...names].sort());
    for (const name of names) {
      assert.equal(lstatSync(join(catalog, name)).isSymbolicLink(), false);
      assert.deepEqual(readdirSync(join(catalog, name)), ["SKILL.md"]);
      assert.equal(readFileSync(join(catalog, name, "SKILL.md"), "utf8"), "consumer-owned sentinel\n");
    }
    const binary = join(checkout, "dist/cli.js");
    assert.ok(statSync(binary).mode & 0o111, "CLI remains executable after build");
    assert.ok(readFileSync(binary, "utf8").startsWith("#!/usr/bin/env node"), "real compilation produced the CLI");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
}
