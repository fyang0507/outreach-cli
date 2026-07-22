import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfigRelativePath } from "../../dist/dataRepo.js";

test("relative data_repo_path is anchored to the dev config", () => {
  assert.equal(
    resolveConfigRelativePath("/mounted/drive/Projects/outreach-cli/outreach.config.dev.yaml", "../fred-agent"),
    "/mounted/drive/Projects/fred-agent",
  );
});

test("absolute data_repo_path is preserved", () => {
  assert.equal(
    resolveConfigRelativePath("/mounted/drive/Projects/outreach-cli/outreach.config.dev.yaml", "/data/fred-agent"),
    "/data/fred-agent",
  );
});
