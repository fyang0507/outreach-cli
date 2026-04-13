/**
 * Copies skills/ to <data_repo_path>/.agents/skills/ so the agent workspace
 * always has skill docs matching the current CLI build.
 */

import { readFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const config = parse(readFileSync("outreach.config.yaml", "utf8"));
let dataRepo = config.data_repo_path;
if (dataRepo.startsWith("~/")) {
  dataRepo = join(process.env.HOME, dataRepo.slice(2));
}

const dest = join(dataRepo, ".agents", "skills");
mkdirSync(dest, { recursive: true });
cpSync("skills", dest, { recursive: true });
console.log(`Skills synced → ${dest}`);
