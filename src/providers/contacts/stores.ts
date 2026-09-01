/**
 * Where the macOS AddressBook stores live, and how to read one.
 *
 * The AddressBook is not one database: it is one SQLite store per account
 * source, and the stores disagree with each other. Three schema facts are
 * load-bearing in this file, each verified on a real machine:
 *
 *   1. The `Z_ENT` value for `ABCDContact` is per-store (22 in one, 21 in
 *      another). It is resolved from `Z_PRIMARYKEY`, never hardcoded.
 *   2. Column sets differ per store (`ZEXTERNALIDENTIFIER` exists in one and
 *      not another), so the SELECT list is intersected with `PRAGMA table_info`
 *      rather than fixed.
 *   3. Filtering by entity is mandatory: one store holds 1618 `ABCDInfo` rows
 *      and a single real contact.
 *
 * The fourth trap — the stores overlap heavily, so their records have to be
 * folded together — belongs to `dedupe.ts`; see `dedupeKey` there.
 *
 * A fifth store, the legacy top-level `AddressBook-v22.abcddb` beside
 * `Sources/`, is read last; see `storePaths`.
 */

import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizePhone } from "../messages.js";
import { phoneDigits } from "./similarity.js";
import {
  ContactsAccessError,
  type ContactEmail,
  type ContactPhone,
  type ContactStore,
  type ContactStoreFailure,
} from "./types.js";

const ADDRESS_BOOK_DIR = join(homedir(), "Library", "Application Support", "AddressBook");
const DEFAULT_SOURCES_DIR = join(ADDRESS_BOOK_DIR, "Sources");
/**
 * `v22` is a schema generation, not a fixed name. Apple last bumped it in macOS
 * 10.8 and it has held for over a decade, but hardcoding it means a future bump
 * would make a Mac full of contacts look like an empty address book — the
 * feature would report "no stores" rather than fail, which is the worst shape
 * for this to break in. Any generation is matched and the highest wins.
 */
const STORE_FILENAME_PATTERN = /^AddressBook-v(\d+)\.abcddb$/;

/**
 * Where to look for stores. `OUTREACH_CONTACTS_SOURCES_DIR` overrides the real
 * AddressBook — the same shape of escape hatch as `OUTREACH_DATA_REPO`, and
 * what lets the `contacts find` command itself be tested end to end against
 * fixture stores instead of whatever happens to be in the user's Contacts.
 */
export function contactsSourcesDir(): string {
  const override = process.env.OUTREACH_CONTACTS_SOURCES_DIR?.trim();
  return override ? override : DEFAULT_SOURCES_DIR;
}

export const FULL_DISK_ACCESS_HINT =
  "Grant Full Disk Access to the terminal/Codex app for contact search.";

/**
 * A store that opens but does not behave like an AddressBook is damaged, not
 * forbidden. Sending the operator to System Settings to grant a permission they
 * already have is worse than saying nothing, so the two hints are kept apart
 * and chosen by the actual error.
 */
export const DAMAGED_STORE_HINT =
  "The file is present but is not a readable Contacts database; Contacts.app can rebuild it.";

/**
 * Source name for the legacy top-level store, which has no `Sources/<uuid>`
 * directory to be named after.
 */
const TOP_LEVEL_STORE_SOURCE = "top-level";

/**
 * Record columns worth reading. `ZNICKNAME`, `ZMIDDLENAME` and `ZDEPARTMENT`
 * are deliberately absent: measured population is 0.0%, so they add SELECT
 * surface and atoms for nothing.
 */
const WANTED_RECORD_COLUMNS = [
  "Z_PK",
  "ZFIRSTNAME",
  "ZLASTNAME",
  "ZORGANIZATION",
  "ZJOBTITLE",
  "ZEXTERNALUUID",
];

/**
 * The newest-generation store file directly inside `dir`, or null if there is
 * none. A directory that cannot be listed counts as holding no store rather
 * than as an error: one unreadable account directory must not hide the others,
 * and `loadContacts` already reports per-store read failures.
 */
function findStoreFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let best: { name: string; version: number } | null = null;
  for (const name of entries) {
    const match = STORE_FILENAME_PATTERN.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (!best || version > best.version) best = { name, version };
  }

  return best ? join(dir, best.name) : null;
}

/**
 * Every `Sources/<uuid>/AddressBook-v<N>.abcddb` under `sourcesDir`, followed by
 * the legacy top-level store that sits beside `Sources`.
 *
 * The top-level store is the pre-Sources primary. On this machine it holds 0
 * `ABCDContact` rows while its own `Z_PRIMARYKEY` still records a high-water
 * mark of 7797 `ABCDRecord`s, i.e. it was the primary once and everything has
 * since moved into per-account sources. It is read anyway because a machine
 * that never migrated would otherwise be indistinguishable from an empty
 * address book, and reading it is nearly free: `readStore` resolves `Z_ENT`,
 * intersects the SELECT list and filters by entity per store, and the merge
 * dedupes whatever it finds. It is listed *last* so the live per-account stores
 * win every conflicting field.
 */
export function storePaths(sourcesDir: string = contactsSourcesDir()): ContactStore[] {
  const stores: ContactStore[] = [];

  if (existsSync(sourcesDir)) {
    let entries: string[];
    try {
      entries = readdirSync(sourcesDir);
    } catch (err) {
      throw new ContactsAccessError(
        `Contacts sources directory exists but cannot be listed: ${(err as Error).message}. ${FULL_DISK_ACCESS_HINT}`,
        FULL_DISK_ACCESS_HINT,
      );
    }

    for (const source of entries) {
      const path = findStoreFile(join(sourcesDir, source));
      if (path) stores.push({ source, path });
    }
  }

  const topLevel = findStoreFile(dirname(sourcesDir));
  if (topLevel) stores.push({ source: TOP_LEVEL_STORE_SOURCE, path: topLevel });

  return stores;
}

/**
 * Whether an error is the machine refusing access rather than the file being
 * damaged. `EPERM`/`EACCES` is the sandbox; `SQLITE_CANTOPEN` ("unable to open
 * database file") is what better-sqlite3 reports for the same denial.
 */
export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "SQLITE_CANTOPEN") return true;
  return /permission denied|operation not permitted|unable to open database file/i.test(
    (err as Error | null)?.message ?? "",
  );
}

export function storeFailure(store: ContactStore, err: unknown): ContactStoreFailure {
  const permission = isPermissionError(err);
  return {
    source: store.source,
    permission,
    message: `Contacts store "${store.source}" could not be read: ${(err as Error).message}. ${
      permission ? FULL_DISK_ACCESS_HINT : DAMAGED_STORE_HINT
    }`,
  };
}

/** Apple encodes stock labels as `_$!<Mobile>!$_`; custom labels are stored raw. */
function decodeLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = /^_\$!<(.+)>!\$_$/.exec(raw);
  return (match ? match[1] : raw).toLowerCase();
}

/**
 * A trailing extension, and the digits that are actually dialable without it.
 *
 * `normalizePhone` keeps only digits, so an extension stored in the same field
 * lands inside the E.164 string: `(201) 820-1234 ext. 56` becomes
 * `+201820123456` — twelve digits, no longer the contact's number, and a
 * subscriber tail the phone route can never share a suffix with. Splitting the
 * extension off first restores both. `contacts find` is the first place in this
 * repo that runs `normalizePhone` over *stored* AddressBook text rather than an
 * operator-supplied argument, which is why this is needed here and nowhere else.
 */
const EXTENSION_SUFFIX = /(?:[,;]|\b(?:ext|extn|x)\.?)\s*(\d[\d\s.-]*)\s*$/i;

export function splitExtension(raw: string): { dialable: string; extension: string | null } {
  const match = EXTENSION_SUFFIX.exec(raw);
  if (!match) return { dialable: raw, extension: null };
  const dialable = raw.slice(0, match.index);
  const extension = phoneDigits(match[1]);
  // "x1234" on its own is a number, not an extension of nothing.
  if (!phoneDigits(dialable) || !extension) return { dialable: raw, extension: null };
  return { dialable, extension };
}

function text(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Columns a table actually has. `PRAGMA table_info` on a missing table returns
 * no rows, so an empty set doubles as "this table is not in this store".
 */
function availableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * One `ZABCDRECORD` row, before any cross-store folding: kept distinct from
 * `Contact` because it carries the two per-row fields `dedupe.ts` keys on and
 * then discards (`pk`, and a singular `source`, against `Contact.sources`).
 */
export interface RawContact {
  uuid: string | null;
  first: string | null;
  last: string | null;
  organization: string | null;
  jobTitle: string | null;
  phones: ContactPhone[];
  emails: ContactEmail[];
  note: string | null;
  source: string;
  pk: number;
}

export function readStore(store: ContactStore, includeNotes: boolean): RawContact[] {
  let db: Database.Database;
  try {
    db = new Database(store.path, { readonly: true });
  } catch (err) {
    const hint = isPermissionError(err) ? FULL_DISK_ACCESS_HINT : DAMAGED_STORE_HINT;
    throw new ContactsAccessError(
      `Contacts database exists but cannot be opened: ${(err as Error).message}. ${hint}`,
      hint,
    );
  }

  try {
    // Trap 1: the entity id for ABCDContact differs per store.
    const entityRow = db
      .prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ABCDContact'")
      .get() as { Z_ENT?: number } | undefined;
    const entity = entityRow?.Z_ENT;
    if (entity == null) return [];

    // Trap 2: a fixed SELECT list throws "no such column" on some stores.
    const recordColumns = availableColumns(db, "ZABCDRECORD");
    if (!recordColumns.has("Z_PK") || !recordColumns.has("Z_ENT")) return [];
    const selected = WANTED_RECORD_COLUMNS.filter((column) => recordColumns.has(column));

    // Trap 3: without the entity filter this returns 1618 ABCDInfo rows here.
    const rows = db
      .prepare(`SELECT ${selected.join(", ")} FROM ZABCDRECORD WHERE Z_ENT = ?`)
      .all(entity) as Array<Record<string, unknown>>;

    const byPk = new Map<number, RawContact>();
    for (const row of rows) {
      const pk = row["Z_PK"];
      if (typeof pk !== "number") continue;
      byPk.set(pk, {
        uuid: text(row, "ZEXTERNALUUID"),
        first: text(row, "ZFIRSTNAME"),
        last: text(row, "ZLASTNAME"),
        organization: text(row, "ZORGANIZATION"),
        jobTitle: text(row, "ZJOBTITLE"),
        phones: [],
        emails: [],
        note: null,
        source: store.source,
        pk,
      });
    }

    const phoneColumns = availableColumns(db, "ZABCDPHONENUMBER");
    if (phoneColumns.has("ZOWNER") && phoneColumns.has("ZFULLNUMBER")) {
      const label = phoneColumns.has("ZLABEL") ? "ZLABEL" : "NULL AS ZLABEL";
      const phoneRows = db
        .prepare(`SELECT ZOWNER, ZFULLNUMBER, ${label} FROM ZABCDPHONENUMBER`)
        .all() as Array<Record<string, unknown>>;
      for (const phoneRow of phoneRows) {
        const owner = phoneRow["ZOWNER"];
        const raw = phoneRow["ZFULLNUMBER"];
        if (typeof owner !== "number" || typeof raw !== "string") continue;
        // A number with no digits is a formatting artifact, not a phone number.
        if (!phoneDigits(raw)) continue;
        const { dialable, extension } = splitExtension(raw);
        byPk.get(owner)?.phones.push({
          number: normalizePhone(dialable),
          label: decodeLabel(phoneRow["ZLABEL"]),
          extension,
        });
      }
    }

    const emailColumns = availableColumns(db, "ZABCDEMAILADDRESS");
    if (emailColumns.has("ZOWNER") && emailColumns.has("ZADDRESS")) {
      const label = emailColumns.has("ZLABEL") ? "ZLABEL" : "NULL AS ZLABEL";
      const emailRows = db
        .prepare(`SELECT ZOWNER, ZADDRESS, ${label} FROM ZABCDEMAILADDRESS`)
        .all() as Array<Record<string, unknown>>;
      for (const emailRow of emailRows) {
        const owner = emailRow["ZOWNER"];
        const address = emailRow["ZADDRESS"];
        if (typeof owner !== "number" || typeof address !== "string" || !address.trim()) continue;
        byPk.get(owner)?.emails.push({
          address: address.trim(),
          label: decodeLabel(emailRow["ZLABEL"]),
        });
      }
    }

    if (includeNotes) {
      const noteColumns = availableColumns(db, "ZABCDNOTE");
      if (noteColumns.has("ZCONTACT") && noteColumns.has("ZTEXT")) {
        const noteRows = db
          .prepare("SELECT ZCONTACT, ZTEXT FROM ZABCDNOTE WHERE ZTEXT IS NOT NULL")
          .all() as Array<Record<string, unknown>>;
        for (const noteRow of noteRows) {
          const owner = noteRow["ZCONTACT"];
          const body = noteRow["ZTEXT"];
          if (typeof owner !== "number" || typeof body !== "string" || !body.trim()) continue;
          const contact = byPk.get(owner);
          if (contact) contact.note = body.trim();
        }
      }
    }

    return [...byPk.values()];
  } finally {
    db.close();
  }
}
