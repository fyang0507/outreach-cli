/**
 * Read-only macOS Contacts (AddressBook) access and routed contact search.
 *
 * The subsystem, in dependency order:
 *
 *   `types.ts`       the shared contact/store data model
 *   `similarity.ts`  pure string-similarity and normalization arithmetic
 *   `stores.ts`      store discovery and per-store SQLite reading
 *   `dedupe.ts`      cross-store merge into one contact list
 *   `searchIndex.ts` the searchable projection of a contact
 *   `routes.ts`      query classification and the phone/email/text routes
 *   `search.ts`      the router over those routes
 *
 * This file is the public surface — nothing outside `src/providers/contacts/`
 * should import the modules above directly — plus the `outreach health` probe,
 * which needs discovery and loading but no searching.
 */

import { loadContacts } from "./dedupe.js";
import {
  DAMAGED_STORE_HINT,
  FULL_DISK_ACCESS_HINT,
  contactsSourcesDir,
  isPermissionError,
  storePaths,
} from "./stores.js";
import { ContactsAccessError, type ContactStore, type ContactStoreFailure } from "./types.js";

export { ContactsAccessError } from "./types.js";
export type { ContactStoreFailure } from "./types.js";
export { contactsSourcesDir, splitExtension, storePaths } from "./stores.js";
export { loadContacts } from "./dedupe.js";
export { buildContactIndex } from "./searchIndex.js";
export { classifyQuery, matchEmail, matchPhone, matchText } from "./routes.js";
export { findContacts } from "./search.js";
export type { ContactMatch } from "./search.js";

export interface ContactsAccessReport {
  ok: boolean;
  stores: number;
  contacts: number;
  hint?: string;
}

/** Readiness check for `outreach health`: are the stores present and readable? */
export function checkContactsAccess(
  options: { sourcesDir?: string } = {},
): ContactsAccessReport {
  const sourcesDir = options.sourcesDir ?? contactsSourcesDir();

  let stores: ContactStore[];
  try {
    stores = storePaths(sourcesDir);
  } catch (err) {
    return {
      ok: false,
      stores: 0,
      contacts: 0,
      hint: (err as ContactsAccessError).message,
    };
  }

  if (!stores.length) {
    return {
      ok: false,
      stores: 0,
      contacts: 0,
      hint: `No Contacts stores found under ${sourcesDir}. Open Contacts.app once to create one, and grant Full Disk Access to the terminal/Codex app for contact search. Stores are matched as AddressBook-v<N>.abcddb; if Contacts is populated and this persists, macOS may have changed the store layout.`,
    };
  }

  try {
    const unreadable: ContactStoreFailure[] = [];
    const contacts = loadContacts({ stores, includeNotes: false, unreadable });
    // Some stores read and some did not: not ready, but the contact count is
    // the number actually readable rather than a flat 0.
    if (unreadable.length > 0) {
      return {
        ok: false,
        stores: stores.length,
        contacts: contacts.length,
        hint: `${unreadable.length} of ${stores.length} Contacts stores could not be read. ${unreadable
          .map((failure) => failure.message)
          .join(" ")}`,
      };
    }
    return { ok: true, stores: stores.length, contacts: contacts.length };
  } catch (err) {
    return {
      ok: false,
      stores: stores.length,
      contacts: 0,
      hint:
        err instanceof ContactsAccessError
          ? err.message
          : `Contacts database could not be read: ${(err as Error).message}. ${
              isPermissionError(err) ? FULL_DISK_ACCESS_HINT : DAMAGED_STORE_HINT
            }`,
    };
  }
}
