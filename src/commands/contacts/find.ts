import { Command } from "commander";
import {
  contactsSourcesDir,
  storePaths,
  loadContacts,
  buildContactIndex,
  findContacts,
  checkContactsAccess,
  ContactsAccessError,
  type ContactMatch,
  type ContactStoreFailure,
} from "../../providers/contacts/index.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

/**
 * Concise wire shape: null/empty fields are omitted entirely so a match costs
 * only what it actually knows. Array order is the rank, so no per-match rank
 * field is emitted. `--verbose` adds the scoring evidence and the note.
 */
function serialize(match: ContactMatch, verbose: boolean): Record<string, unknown> {
  const contact = match.contact;
  const out: Record<string, unknown> = {};

  if (contact.name) out.name = contact.name;
  if (contact.organization) out.organization = contact.organization;
  if (contact.job_title) out.job_title = contact.job_title;

  if (contact.phones.length > 0) {
    out.phones = contact.phones.map((phone) => {
      const entry: Record<string, unknown> = { number: phone.number };
      if (phone.label) entry.label = phone.label;
      // Present only when the stored number carried one; `number` is always
      // dialable on its own.
      if (phone.extension) entry.extension = phone.extension;
      return entry;
    });
  }

  if (contact.emails.length > 0) {
    out.emails = contact.emails.map((email) => {
      const entry: Record<string, unknown> = { address: email.address };
      if (email.label) entry.label = email.label;
      return entry;
    });
  }

  out.confidence = match.confidence;

  if (verbose) {
    // Three decimals: enough to order two near-ties, short enough to stay cheap.
    out.score = Math.round(match.score * 1000) / 1000;
    out.matched_on = match.matched_on;
    if (contact.note) out.note = contact.note;
  }

  return out;
}

export function registerFindCommand(parent: Command): void {
  parent
    .command("find")
    .description("Search local Contacts by name, organization, phone or email")
    .option("--query <text>", "Name, organization, phone number or email address")
    .option("--limit <n>", "Max matches to return", "10")
    .option("--verbose", "Include score, matched_on and notes")
    .action(async (opts: { query?: string; limit: string; verbose?: boolean }) => {
      // Checked by hand rather than via requiredOption so the failure stays on
      // the JSON output contract.
      if (opts.query === undefined) {
        outputError(INPUT_ERROR, "--query is required");
        process.exit(INPUT_ERROR);
        return;
      }

      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1) {
        outputError(INPUT_ERROR, "--limit must be a positive integer");
        process.exit(INPUT_ERROR);
        return;
      }

      const verbose = opts.verbose === true;

      // Discover first so the store list can be reused by the load below, and
      // so "no stores at all" is reported as an infra problem rather than as a
      // search that legitimately matched nothing. The directory is resolved
      // once and threaded through, so the readiness hint below can never
      // describe a different directory than the one just searched.
      const sourcesDir = contactsSourcesDir();

      let stores;
      try {
        stores = storePaths(sourcesDir);
      } catch (err) {
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
        return;
      }

      if (stores.length === 0) {
        const report = checkContactsAccess({ sourcesDir });
        outputError(
          INFRA_ERROR,
          report.hint ??
            "No Contacts stores found. Run 'outreach health' to check contacts readiness.",
        );
        process.exit(INFRA_ERROR);
        return;
      }

      let contacts;
      // Stores that could not be read. One damaged source does not fail the
      // lookup, but a partial answer has to say that it is partial.
      const unreadable: ContactStoreFailure[] = [];
      try {
        // Notes are verbose-only, so a plain search never pays to read them.
        contacts = loadContacts({ stores, includeNotes: verbose, unreadable });
      } catch (err) {
        if (err instanceof ContactsAccessError) {
          outputError(INFRA_ERROR, err.message);
        } else {
          outputError(
            INFRA_ERROR,
            `Failed to read contacts: ${(err as Error).message}. Run 'outreach health' to check contacts readiness.`,
          );
        }
        process.exit(INFRA_ERROR);
        return;
      }

      const index = buildContactIndex(contacts, { includeNotes: verbose });
      const result = findContacts(index, opts.query, { limit, verbose });

      const payload: Record<string, unknown> = {
        query: result.query,
        count: result.count,
      };

      if (verbose) {
        // How the query was read, and which route actually answered it —
        // `text_fallback` means a phone/email-shaped query found no structured
        // hit and was re-run as text.
        payload.kind = result.kind;
        payload.route = result.route;
      }

      if (unreadable.length > 0) {
        payload.unreadable_sources = unreadable.map((failure) => ({
          source: failure.source,
          message: failure.message,
        }));
      }

      payload.matches = result.matches.map((match) => serialize(match, verbose));

      outputJson(payload);
      // process.exitCode, not process.exit(): see outputJson() in src/output.ts.
      process.exitCode = SUCCESS;
    });
}
