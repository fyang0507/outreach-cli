/**
 * Post-build hook:
 *   1. `chmod +x dist/cli.js` so the `outreach` bin stays executable even on
 *      filesystems that don't preserve the exec bit (e.g. Google Drive FUSE).
 *   2. Best-effort installation of <data_repo>/.agents/skills/outreach as an
 *      agent skill symlink to skills/outreach/ when a workspace is configured.
 *
 * Resolves the data repo via the same helper the CLI uses (dist/dataRepo.js)
 * so env var, dev config, and walk-up precedence all match runtime.
 */

import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

chmodSync("dist/cli.js", 0o755);

const { resolveDataRepo } = await import("../dist/dataRepo.js");

try {
  const { path: dataRepo } = resolveDataRepo();
  const dest = join(dataRepo, ".agents", "skills", "outreach");
  const source = resolve("skills/outreach");
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(source, dest, "dir");
  console.log(`Agent skill symlink installed -> ${dest} -> ${source}`);
} catch (err) {
  console.log(`Agent skill symlink skipped: ${(err).message}`);
}
