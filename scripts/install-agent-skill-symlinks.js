/**
 * Post-build hook:
 *   1. `chmod +x dist/cli.js` so the `outreach` bin stays executable even on
 *      filesystems that don't preserve the exec bit (e.g. Google Drive FUSE).
 *   2. Best-effort installation of shipped agent skills as symlinks under
 *      <data_repo>/.agents/skills/ when a workspace is configured.
 *
 * Resolves the data repo via the same helper the CLI uses (dist/dataRepo.js)
 * so env var, dev config, and walk-up precedence all match runtime.
 */

import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

chmodSync("dist/cli.js", 0o755);

const { resolveDataRepo } = await import("../dist/dataRepo.js");

try {
  const { path: dataRepo } = resolveDataRepo();
  const skills = ["outreach", "contact-operator"];

  for (const skill of skills) {
    const dest = join(dataRepo, ".agents", "skills", skill);
    const source = resolve("skills", skill);
    // Emit a RELATIVE target. An absolute target bakes this machine's checkout
    // path into the data repo, so moving or re-cloning either repo silently
    // leaves the data repo's committed symlinks pointing at a dead path.
    const linkTarget = relative(dirname(dest), source);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(linkTarget, dest, "dir");
    console.log(`Agent skill symlink installed -> ${dest} -> ${linkTarget}`);
  }
} catch (err) {
  console.log(`Agent skill symlink skipped: ${(err).message}`);
}
