import { Command, InvalidArgumentError } from "commander";
import { loadAppConfig } from "../appConfig.js";
import {
  appendCampaignEvent,
  assertCampaignHeader,
  CampaignHeaderError,
  isoNow,
} from "../logs/sessionLog.js";
import { outputJson, outputError } from "../output.js";
import { SUCCESS, INPUT_ERROR } from "../exitCodes.js";

// Custom parser for `--field <a,b,c>`. Accepts comma-separated values on one
// flag only; repeating the flag rejects with a clear error pointing at the
// comma-separated syntax (avoids Commander's default last-wins overwrite).
function parseFieldList(
  value: string,
  previous: string[] | undefined,
): string[] {
  if (previous !== undefined) {
    throw new InvalidArgumentError(
      "--field may be specified only once; use a comma-separated list (e.g. --field first_name,address).",
    );
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description(
      "Retrieve user identity fields on demand (agent-gated pull with audit)",
    )
    .option("--list", "Enumerate available identity keys (no values)")
    .option(
      "--field <a,b,c>",
      "Comma-separated list of identity fields to retrieve",
      parseFieldList,
    )
    .option(
      "--force",
      "Bypass the reflection threshold (recorded as forced in audit)",
    )
    .option(
      "--campaign-id <id>",
      "Optional campaign ID — when present, append an identity_access audit event",
    )
    .action(
      async (opts: {
        list?: boolean;
        field?: string[];
        force?: boolean;
        campaignId?: string;
      }) => {
        // Mutual exclusion: --list and --field.
        if (opts.list && opts.field !== undefined) {
          outputError(
            INPUT_ERROR,
            "--list and --field are mutually exclusive.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // --force without --field has no meaning.
        if (opts.force && opts.field === undefined) {
          outputError(
            INPUT_ERROR,
            "--force is only meaningful with --field.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Validate campaign header before doing any work — refuses to create
        // a headerless campaign JSONL via the audit append (issue #78).
        if (opts.campaignId) {
          try {
            await assertCampaignHeader(opts.campaignId);
          } catch (err) {
            if (err instanceof CampaignHeaderError) {
              outputError(INPUT_ERROR, err.message);
              process.exit(INPUT_ERROR);
              return;
            }
            throw err;
          }
        }

        const config = await loadAppConfig();
        const { user_name, extraFields } = config.identity;

        // --list: enumerate keys only (user_name first, then extraFields keys).
        if (opts.list) {
          outputJson({
            fields: ["user_name", ...Object.keys(extraFields)],
          });
          process.exit(SUCCESS);
          return;
        }

        // Default (no flags): return user_name only.
        if (opts.field === undefined) {
          outputJson({ user_name });
          process.exit(SUCCESS);
          return;
        }

        // --field path from here on.
        const requested = opts.field;

        if (requested.length === 0) {
          outputError(
            INPUT_ERROR,
            "--field must contain at least one non-empty field name.",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Resolve against the union of {user_name} + extraFields keys.
        // Unknown-field check fires BEFORE the reflection threshold — a
        // typo-laden over-pull should say "typo," not "reflect."
        const availableSet = new Set<string>([
          "user_name",
          ...Object.keys(extraFields),
        ]);
        const unknown = requested.filter((k) => !availableSet.has(k));
        if (unknown.length > 0) {
          process.stderr.write(
            JSON.stringify({
              error: "not_found",
              message: `Unknown identity fields: ${unknown.join(", ")}. Run \`outreach whoami --list\` to see available keys.`,
              unknown,
            }) + "\n",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Reflection threshold. Denominator is extraFields.size
        // (user_name excluded from both numerator and denominator).
        const requestedPullable = requested.filter((k) => k !== "user_name");
        const available = Object.keys(extraFields).length;
        const triggers =
          available > 0 &&
          requestedPullable.length >= 3 &&
          requestedPullable.length / available > 0.8;

        if (triggers && !opts.force) {
          const pct = Math.round(
            (requestedPullable.length / available) * 100,
          );
          process.stderr.write(
            JSON.stringify({
              error: "excessive_pull",
              message: `Requested ${requestedPullable.length} of ${available} pullable identity fields (${pct}%). Reflect on whether the immediate task actually needs all of these — each value you pull lands in your context and risks echoing into later drafts. Prefer fetching just what you'll use in the next reply. If you've thought it through and genuinely need all of them, re-run the same command with --force.`,
              requested: requestedPullable.length,
              available,
            }) + "\n",
          );
          process.exit(INPUT_ERROR);
          return;
        }

        // Build the response map. `user_name` is queryable like any other key.
        const fields: Record<string, string> = {};
        for (const k of requested) {
          if (k === "user_name") {
            fields[k] = user_name;
          } else {
            // Known-good by the unknown check above.
            fields[k] = extraFields[k];
          }
        }

        const forced = triggers && opts.force === true;
        let audited = false;

        if (opts.campaignId) {
          await appendCampaignEvent(opts.campaignId, {
            ts: isoNow(),
            type: "identity_access",
            fields: requested,
            forced,
            contact_id: null,
          });
          audited = true;
        }

        const payload: Record<string, unknown> = { fields };
        if (audited) payload.audited = true;
        outputJson(payload);
        process.exit(SUCCESS);
      },
    );
}
