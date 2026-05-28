/**
 * Post-build hook:
 *   1. `chmod +x dist/cli.js` so the `outreach` bin stays executable even on
 *      filesystems that don't preserve the exec bit (e.g. Google Drive FUSE).
 *   2. Best-effort mirror of skills/outreach/ to
 *      <data_repo>/.agents/skills/outreach/ when a workspace is configured.
 *
 * Resolves the data repo via the same helper the CLI uses (dist/dataRepo.js)
 * so env var, dev config, and walk-up precedence all match runtime.
 */

import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

chmodSync("dist/cli.js", 0o755);

const { resolveDataRepo } = await import("../dist/dataRepo.js");

try {
  const { path: dataRepo } = resolveDataRepo();
  const dest = join(dataRepo, ".agents", "skills", "outreach");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync("skills/outreach", dest, { recursive: true });
  console.log(`Skills synced → ${dest}`);
} catch (err) {
  console.log(`Skills sync skipped: ${(err).message}`);
}
