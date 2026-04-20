/**
 * Copies skills/outreach/ to <data_repo>/.agents/skills/outreach/
 * so the agent workspace always has skill docs matching the current CLI build.
 *
 * Resolves the data repo via the same helper the CLI uses (dist/dataRepo.js)
 * so env var, dev config, and walk-up precedence all match runtime.
 */

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { resolveDataRepo } = await import("../dist/dataRepo.js");
const { path: dataRepo } = resolveDataRepo();

const dest = join(dataRepo, ".agents", "skills", "outreach");
mkdirSync(dest, { recursive: true });
cpSync("skills/outreach", dest, { recursive: true });
console.log(`Skills synced → ${dest}`);
