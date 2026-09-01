/**
 * Folding the per-store rows into one contact list.
 *
 * The fourth schema trap (`stores.ts` holds the other three): stores overlap
 * heavily — one is a stale mirror — so records are deduped on `ZEXTERNALUUID`
 * (falling back to a normalized name|organization key, which only folds records
 * from *different* stores). Skipping this doubles roughly half the result set.
 */

import {
  DAMAGED_STORE_HINT,
  FULL_DISK_ACCESS_HINT,
  readStore,
  storeFailure,
  storePaths,
  type RawContact,
} from "./stores.js";
import {
  ContactsAccessError,
  type Contact,
  type ContactEmail,
  type ContactPhone,
  type ContactStore,
  type ContactStoreFailure,
} from "./types.js";

/**
 * Trap 4. `ZEXTERNALUUID` is the real cross-store identity (verified 79/79
 * overlap). Records without one fall back to name|organization — but only when
 * there is something to key on: an unnamed, organization-less record (a bare
 * phone number) would otherwise collapse together with every other one. The
 * fallback is flagged as such because it is only safe *across* stores; see
 * `loadContacts` for the same-store case.
 *
 * `fallback` is true for the name|organization key, which is a guess at
 * identity rather than an identity: two rows can share it and still be two
 * people.
 */
function dedupeKey(raw: RawContact): { key: string; fallback: boolean } {
  if (raw.uuid) return { key: `uuid:${raw.uuid}`, fallback: false };
  const parts = [raw.first, raw.last, raw.organization].map((value) =>
    (value ?? "").toLowerCase().trim(),
  );
  if (!parts.some(Boolean)) return { key: `row:${raw.source}:${raw.pk}`, fallback: true };
  return { key: `name:${parts.join("|")}`, fallback: true };
}

/**
 * Append the numbers this contact does not already have. A single AddressBook
 * record can hold the same `ZABCDPHONENUMBER` twice (verified on the real book),
 * so this runs on the very first record too — not only on the cross-store merge.
 * First occurrence wins, so the label that was seen first is kept.
 */
function unionPhones(into: ContactPhone[], incoming: readonly ContactPhone[]): void {
  // The extension is part of the identity: one main number with two extensions
  // is two endpoints, not a duplicated row.
  const keyOf = (phone: ContactPhone): string => `${phone.number}|${phone.extension ?? ""}`;
  const known = new Set(into.map(keyOf));
  for (const phone of incoming) {
    const key = keyOf(phone);
    if (known.has(key)) continue;
    known.add(key);
    into.push(phone);
  }
}

/** Same as `unionPhones`, keyed on the lowercased address. */
function unionEmails(into: ContactEmail[], incoming: readonly ContactEmail[]): void {
  const known = new Set(into.map((email) => email.address.toLowerCase()));
  for (const email of incoming) {
    const key = email.address.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    into.push(email);
  }
}

function toContact(raw: RawContact): Contact {
  const name = [raw.first, raw.last].filter(Boolean).join(" ").trim();
  const contact: Contact = {
    name: name || raw.organization,
    first_name: raw.first,
    last_name: raw.last,
    organization: raw.organization,
    job_title: raw.jobTitle,
    phones: [],
    emails: [],
    note: raw.note,
    sources: [raw.source],
  };
  unionPhones(contact.phones, raw.phones);
  unionEmails(contact.emails, raw.emails);
  return contact;
}

/** Prefer non-null scalars, union phones/emails/sources. One store is a stale mirror. */
function mergeContact(into: Contact, raw: RawContact): void {
  if (!into.first_name) into.first_name = raw.first;
  if (!into.last_name) into.last_name = raw.last;
  if (!into.organization) into.organization = raw.organization;
  if (!into.job_title) into.job_title = raw.jobTitle;
  if (!into.note) into.note = raw.note;

  const name = [into.first_name, into.last_name].filter(Boolean).join(" ").trim();
  into.name = name || into.organization;

  unionPhones(into.phones, raw.phones);
  unionEmails(into.emails, raw.emails);

  if (!into.sources.includes(raw.source)) into.sources.push(raw.source);
}

/**
 * Read every store and fold the overlapping records into one contact list.
 *
 * A store that throws is skipped rather than fatal — `readStore` is already
 * per-store tolerant of a missing entity, a missing table and missing columns,
 * and a store that is damaged at query time is the same class of problem: one
 * bad source must not turn every other source's contacts into an error. The
 * skipped stores are reported through `options.unreadable` so the answer can
 * say what it missed. Only losing *every* store is fatal, because then there is
 * no answer to give at all.
 */
export function loadContacts(
  options: {
    /** Defaults to `storePaths()`; injectable so tests can point at a fixture store. */
    stores?: ContactStore[];
    /** Read `ZABCDNOTE` (default true). */
    includeNotes?: boolean;
    /**
     * Collects the stores that could not be read. A caller that passes this can
     * report a partial answer honestly; one that does not still gets the
     * contacts from every store that *was* readable.
     */
    unreadable?: ContactStoreFailure[];
  } = {},
): Contact[] {
  const includeNotes = options.includeNotes ?? true;
  const stores = options.stores ?? storePaths();
  const unreadable = options.unreadable ?? [];

  const merged = new Map<string, Contact>();
  let readable = 0;

  for (const store of stores) {
    let records: RawContact[];
    try {
      records = readStore(store, includeNotes);
    } catch (err) {
      unreadable.push(storeFailure(store, err));
      continue;
    }
    readable++;

    for (const raw of records) {
      const { key, fallback } = dedupeKey(raw);
      const existing = merged.get(key);
      // A name collision *inside one store* is two cards in the user's own
      // Contacts.app — two different John Smiths, not the stale cross-store
      // mirror the fallback key exists to fold. Merging them would hand back
      // one contact carrying two strangers' phone numbers.
      if (existing && fallback && existing.sources.includes(raw.source)) {
        merged.set(`row:${raw.source}:${raw.pk}`, toContact(raw));
      } else if (existing) {
        mergeContact(existing, raw);
      } else {
        merged.set(key, toContact(raw));
      }
    }
  }

  if (stores.length > 0 && readable === 0) {
    const failure = unreadable[0];
    throw new ContactsAccessError(
      failure.message,
      failure.permission ? FULL_DISK_ACCESS_HINT : DAMAGED_STORE_HINT,
    );
  }

  return [...merged.values()];
}
