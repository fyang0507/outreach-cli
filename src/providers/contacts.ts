/**
 * macOS Contacts (AddressBook) read-only access and routed contact search.
 *
 * The AddressBook is not one database: it is one SQLite store per account
 * source, and the stores disagree with each other. Four schema facts are
 * load-bearing here, each verified on a real machine:
 *
 *   1. The `Z_ENT` value for `ABCDContact` is per-store (22 in one, 21 in
 *      another). It is resolved from `Z_PRIMARYKEY`, never hardcoded.
 *   2. Column sets differ per store (`ZEXTERNALIDENTIFIER` exists in one and
 *      not another), so the SELECT list is intersected with `PRAGMA table_info`
 *      rather than fixed.
 *   3. Filtering by entity is mandatory: one store holds 1618 `ABCDInfo` rows
 *      and a single real contact.
 *   4. Stores overlap heavily — one is a stale mirror — so records are deduped
 *      on `ZEXTERNALUUID` (falling back to a normalized name|organization key).
 *      Skipping this doubles roughly half the result set.
 */

import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePhone } from "./messages.js";
import {
  TEXT_SIMILARITIES,
  canonicalizeEmail,
  fold,
  meanScore,
  ngrams,
  phoneDigits,
  sharedSuffixLength,
} from "./contactMatch.js";

// --- Types ---

export interface ContactPhone {
  /** E.164-ish, via the shared `normalizePhone()` used by the sms channel. */
  number: string;
  label: string | null;
}

export interface ContactEmail {
  address: string;
  label: string | null;
}

export interface Contact {
  /** "First Last", falling back to the organization; null when both are empty. */
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  job_title: string | null;
  phones: ContactPhone[];
  emails: ContactEmail[];
  note: string | null;
  /** Source store directory names this contact was assembled from. */
  sources: string[];
}

export interface ContactStore {
  /** The `Sources/<uuid>` directory name. */
  source: string;
  path: string;
}

/** Which atom a match came from; surfaced as `matched_on`. */
export type ContactField =
  | "name"
  | "organization"
  | "job_title"
  | "phone"
  | "email"
  | "name_organization"
  | "note";

export interface ContactAtom {
  value: string;
  field: ContactField;
  folded: string;
}

export interface ContactIndexEntry {
  contact: Contact;
  atoms: ContactAtom[];
  /** Union of every atom's bigrams; drives the text-route prefilter. */
  grams: Set<string>;
  phoneDigits: string[];
  emails: string[];
}

export type ContactIndex = ContactIndexEntry[];

export type QueryKind = "phone" | "email" | "text" | "empty";

/** `text_fallback` is the text route reached after a structured route found nothing. */
export type MatchRoute = "phone" | "email" | "text" | "text_fallback";

export interface ContactMatch {
  contact: Contact;
  /** 0..1. Structured routes report query coverage; the text route reports the ensemble mean. */
  score: number;
  confidence: "high" | "low";
  matched_on: ContactField[];
  route: MatchRoute;
}

export interface FindContactsResult {
  query: string;
  kind: QueryKind;
  route: MatchRoute;
  count: number;
  /** Array order is the rank. */
  matches: ContactMatch[];
}

export interface LoadContactsOptions {
  /** Defaults to `storePaths()`; injectable so tests can point at a fixture store. */
  stores?: ContactStore[];
  /** Read `ZABCDNOTE` (default true). */
  includeNotes?: boolean;
}

export interface BuildContactIndexOptions {
  /** Make notes searchable. Off by default — notes are `--verbose`-only. */
  includeNotes?: boolean;
}

export interface FindContactsOptions {
  limit?: number;
  /** Score note atoms too (they are only present if the index was built with them). */
  verbose?: boolean;
}

export interface ContactsAccessReport {
  ok: boolean;
  stores: number;
  contacts: number;
  hint?: string;
}

/** Raised when stores are present but unreadable — almost always Full Disk Access. */
export class ContactsAccessError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "ContactsAccessError";
    this.hint = hint;
  }
}

// --- Constants ---

const ADDRESS_BOOK_DIR = join(homedir(), "Library", "Application Support", "AddressBook");
const DEFAULT_SOURCES_DIR = join(ADDRESS_BOOK_DIR, "Sources");
const STORE_FILENAME = "AddressBook-v22.abcddb";

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

const FULL_DISK_ACCESS_HINT =
  "Grant Full Disk Access to the terminal/Codex app for contact search.";

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
 * Default number of candidates surviving the bigram prefilter and scored by the
 * full ensemble. It is a speed knob, not a result cap: `findContacts` raises it
 * to at least the caller's `limit` so `--limit 500` can actually return 500.
 */
const TEXT_CANDIDATE_LIMIT = 60;
/** Below this many digits a query is text, not a phone number. */
const MIN_PHONE_SUFFIX_DIGITS = 4;
/**
 * A phone query shorter than a subscriber number is a fragment: plenty of
 * unrelated numbers end in the same four digits, so covering the whole query
 * proves nothing. Below this, a suffix hit is never high confidence.
 */
const MIN_HIGH_CONFIDENCE_PHONE_DIGITS = 7;
const DEFAULT_LIMIT = 10;
/** Text scores at or above this are reported as high confidence. */
const HIGH_CONFIDENCE_TEXT_SCORE = 0.5;
/**
 * Text scores below this are not reported at all. Jaro-Winkler is non-zero for
 * essentially any pair of non-empty strings, so without a floor a nonsense
 * query ("zzzqqxk") fills the whole limit with 0.1-scored noise instead of
 * answering "no". Measured on the real book: nonsense tops out around 0.16
 * while a genuine typo'd query ("insultion expert") scores 0.67, so the gap is
 * wide and this sits in it.
 */
const MIN_TEXT_SCORE = 0.25;
/** Width of the index n-grams; a query shorter than this cannot be prefiltered. */
const GRAM_SIZE = 2;

// --- Store discovery ---

/** Every `Sources/<uuid>/AddressBook-v22.abcddb` present under `sourcesDir`. */
export function storePaths(sourcesDir: string = contactsSourcesDir()): ContactStore[] {
  if (!existsSync(sourcesDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(sourcesDir);
  } catch (err) {
    throw new ContactsAccessError(
      `Contacts sources directory exists but cannot be listed: ${(err as Error).message}. ${FULL_DISK_ACCESS_HINT}`,
      FULL_DISK_ACCESS_HINT,
    );
  }

  const stores: ContactStore[] = [];
  for (const source of entries) {
    const path = join(sourcesDir, source, STORE_FILENAME);
    if (existsSync(path)) stores.push({ source, path });
  }
  return stores;
}

// --- Store reading ---

/** Apple encodes stock labels as `_$!<Mobile>!$_`; custom labels are stored raw. */
function decodeLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = /^_\$!<(.+)>!\$_$/.exec(raw);
  return (match ? match[1] : raw).toLowerCase();
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

interface RawContact {
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

function readStore(store: ContactStore, includeNotes: boolean): RawContact[] {
  let db: Database.Database;
  try {
    db = new Database(store.path, { readonly: true });
  } catch (err) {
    throw new ContactsAccessError(
      `Contacts database exists but cannot be opened: ${(err as Error).message}. ${FULL_DISK_ACCESS_HINT}`,
      FULL_DISK_ACCESS_HINT,
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
        byPk.get(owner)?.phones.push({
          number: normalizePhone(raw),
          label: decodeLabel(phoneRow["ZLABEL"]),
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

// --- Dedup and merge ---

/**
 * Trap 4. `ZEXTERNALUUID` is the real cross-store identity (verified 79/79
 * overlap). Records without one fall back to name|organization — but only when
 * there is something to key on: an unnamed, organization-less record (a bare
 * phone number) would otherwise collapse together with every other one.
 */
function dedupeKey(raw: RawContact): string {
  if (raw.uuid) return `uuid:${raw.uuid}`;
  const parts = [raw.first, raw.last, raw.organization].map((value) =>
    (value ?? "").toLowerCase().trim(),
  );
  if (!parts.some(Boolean)) return `row:${raw.source}:${raw.pk}`;
  return `name:${parts.join("|")}`;
}

/**
 * Append the numbers this contact does not already have. A single AddressBook
 * record can hold the same `ZABCDPHONENUMBER` twice (verified on the real book),
 * so this runs on the very first record too — not only on the cross-store merge.
 * First occurrence wins, so the label that was seen first is kept.
 */
function unionPhones(into: ContactPhone[], incoming: readonly ContactPhone[]): void {
  const known = new Set(into.map((phone) => phone.number));
  for (const phone of incoming) {
    if (known.has(phone.number)) continue;
    known.add(phone.number);
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

/** Read every store and fold the overlapping records into one contact list. */
export function loadContacts(options: LoadContactsOptions = {}): Contact[] {
  const includeNotes = options.includeNotes ?? true;
  const stores = options.stores ?? storePaths();

  const merged = new Map<string, Contact>();
  for (const store of stores) {
    for (const raw of readStore(store, includeNotes)) {
      const key = dedupeKey(raw);
      const existing = merged.get(key);
      if (existing) mergeContact(existing, raw);
      else merged.set(key, toContact(raw));
    }
  }
  return [...merged.values()];
}

// --- Index ---

/**
 * Precompute the searchable atoms, their bigrams and the structured keys.
 * Scoring is field-agnostic: an atom is just a string to compare against, and
 * a contact's score for one similarity is its best atom under that similarity.
 */
export function buildContactIndex(
  contacts: Contact[],
  options: BuildContactIndexOptions = {},
): ContactIndex {
  const includeNotes = options.includeNotes ?? false;

  return contacts.map((contact) => {
    const atoms: ContactAtom[] = [];
    const push = (value: string | null | undefined, field: ContactField): void => {
      if (!value || !value.trim()) return;
      atoms.push({ value, field, folded: fold(value) });
    };

    push(contact.name, "name");
    push(contact.first_name, "name");
    push(contact.last_name, "name");
    push(contact.organization, "organization");
    push(contact.job_title, "job_title");
    // Pooled blob so "Fred Yang Acme" scores against one string rather than
    // splitting its evidence across two atoms.
    push([contact.name, contact.organization].filter(Boolean).join(" "), "name_organization");
    for (const phone of contact.phones) push(phone.number, "phone");
    for (const email of contact.emails) {
      push(email.address, "email");
      push(email.address.split("@")[0], "email");
    }
    if (includeNotes) push(contact.note, "note");

    const grams = new Set<string>();
    for (const atom of atoms) {
      for (const gram of ngrams(atom.value, 2)) grams.add(gram);
    }

    return {
      contact,
      atoms,
      grams,
      phoneDigits: contact.phones.map((phone) => phoneDigits(phone.number)),
      emails: contact.emails.map((email) => email.address),
    };
  });
}

// --- Query classification ---

/**
 * Route selection. An "@" with non-space on both sides is an address; an
 * all-numeric-ish query with enough digits is a phone number; everything else
 * is free text. Note that "551" (3 digits) is text, not a phone number.
 */
export function classifyQuery(query: string): QueryKind {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return "empty";
  if (trimmed.includes("@") && /\S@\S/.test(trimmed)) return "email";
  const digits = phoneDigits(trimmed);
  const nonPhoneChars = trimmed.replace(/[\d\s()+.\-]/g, "").length;
  if (digits.length >= MIN_PHONE_SUFFIX_DIGITS && nonPhoneChars === 0) return "phone";
  return "text";
}

// --- Structured route: phone ---

interface RoutedHit {
  entry: ContactIndexEntry;
  score: number;
  confidence: "high" | "low";
  matched_on: ContactField[];
}

/**
 * Rank by longest shared digit suffix (>= 4). Deterministic, no similarity
 * scoring: phone numbers either agree on a tail or they don't. `score` is the
 * fraction of the query that the tail covered, so a query fully contained in a
 * stored number scores 1.
 *
 * Full coverage alone is not enough for high confidence: it is trivially true
 * for the weakest possible query, and a bare last-four would otherwise report
 * every contact ending in those digits as a certain match. Confidence therefore
 * also requires the query to be at least a subscriber-length number, so a
 * number that merely happens to end in the same four digits stays low.
 */
export function matchPhone(index: ContactIndex, queryDigits: string): RoutedHit[] {
  if (queryDigits.length < MIN_PHONE_SUFFIX_DIGITS) return [];

  const hits: Array<RoutedHit & { suffix: number }> = [];
  for (const entry of index) {
    let best = 0;
    for (const digits of entry.phoneDigits) {
      const shared = sharedSuffixLength(queryDigits, digits);
      if (shared >= MIN_PHONE_SUFFIX_DIGITS && shared > best) best = shared;
    }
    if (!best) continue;
    const coversQuery = best === queryDigits.length;
    hits.push({
      entry,
      suffix: best,
      score: best / queryDigits.length,
      confidence:
        coversQuery && queryDigits.length >= MIN_HIGH_CONFIDENCE_PHONE_DIGITS
          ? "high"
          : "low",
      matched_on: ["phone"],
    });
  }

  return hits.sort((a, b) => b.suffix - a.suffix);
}

// --- Structured route: email ---

/**
 * Rank exact canonical address > equal local part > local-part substring.
 * A substring-only hit is a guess about a different domain, so it is reported
 * low confidence while the two equality tiers are high.
 *
 * The two local-part tiers compare *dotless* locals whenever the domains
 * differ. Dot handling is a per-provider rule (only Google ignores dots), so
 * canonicalization can only apply it to the address's own domain — and then
 * comparing a dot-stripped gmail local against a dotted local at some other
 * domain misses the person entirely: stored `charles.devore@gmail.com` would
 * lose `charles.devore@newcompany.example` while matching the misspelled
 * `charlesdevore@newcompany.example`. Within one domain the canonical local
 * still rules, so `dcole@example.com` remains a different mailbox from
 * `d.cole@example.com`.
 */
export function matchEmail(index: ContactIndex, query: string): RoutedHit[] {
  const target = canonicalizeEmail(query);

  const hits: Array<RoutedHit & { rank: number }> = [];
  for (const entry of index) {
    let rank = 0;
    for (const address of entry.emails) {
      const candidate = canonicalizeEmail(address);
      const sameDomain = candidate.domain === target.domain;
      const targetLocal = sameDomain ? target.local : target.localDotless;
      const candidateLocal = sameDomain ? candidate.local : candidate.localDotless;
      if (candidate.canonical === target.canonical) rank = Math.max(rank, 3);
      else if (targetLocal && candidateLocal === targetLocal) rank = Math.max(rank, 2);
      else if (targetLocal && candidateLocal.includes(targetLocal)) rank = Math.max(rank, 1);
    }
    if (!rank) continue;
    hits.push({
      entry,
      rank,
      score: rank === 3 ? 1 : rank === 2 ? 0.9 : 0.7,
      confidence: rank >= 2 ? "high" : "low",
      matched_on: ["email"],
    });
  }

  return hits.sort((a, b) => b.rank - a.rank);
}

// --- Text route ---

/**
 * Bigram-overlap prefilter, then the four-voter ensemble on the survivors.
 * The prefilter exists purely for speed; the substring bonus keeps short
 * queries ("Fred") from being crowded out by long, gram-rich candidates.
 *
 * A query too short to have a bigram skips the prefilter entirely and scores
 * the whole index. Its only "gram" is the one character itself, which can never
 * appear in an index built from bigrams, so every overlap would be 0 and the
 * candidate cut would fall back to load order — silently dropping contacts that
 * score better than the ones it kept.
 */
export function matchText(
  index: ContactIndex,
  query: string,
  options: { candidates?: number; includeNotes?: boolean } = {},
): RoutedHit[] {
  const candidateLimit = options.candidates ?? TEXT_CANDIDATE_LIMIT;
  const includeNotes = options.includeNotes ?? false;
  const queryGrams = ngrams(query, GRAM_SIZE);
  const queryFolded = fold(query);
  const prefilterable = queryFolded.replace(/\s+/g, "").length >= GRAM_SIZE;

  const prefiltered = prefilterable
    ? index
        .map((entry) => {
          let overlap = 0;
          for (const gram of queryGrams) if (entry.grams.has(gram)) overlap++;
          const substring = entry.atoms.some(
            (atom) => atom.folded.includes(queryFolded) || queryFolded.includes(atom.folded),
          );
          return {
            entry,
            prescore: (queryGrams.size ? overlap / queryGrams.size : 0) + (substring ? 0.5 : 0),
          };
        })
        .sort((a, b) => b.prescore - a.prescore)
        .slice(0, candidateLimit)
    : index.map((entry) => ({ entry }));

  const hits: RoutedHit[] = [];
  for (const { entry } of prefiltered) {
    const atoms = includeNotes
      ? entry.atoms
      : entry.atoms.filter((atom) => atom.field !== "note");
    if (!atoms.length) continue;

    // One score per voter: the contact's best atom under that voter. The final
    // score is their plain mean — measured, and not a trimmed mean.
    const perVoter: number[] = [];
    const matchedFields = new Set<ContactField>();
    for (const { fn } of TEXT_SIMILARITIES) {
      let best = 0;
      let bestField: ContactField | null = null;
      for (const atom of atoms) {
        const score = fn(query, atom.value);
        if (score > best) {
          best = score;
          bestField = atom.field;
        }
      }
      perVoter.push(best);
      if (bestField) matchedFields.add(bestField);
    }

    // Below the floor the "match" is coincidental character overlap, not a
    // candidate: report nothing rather than pad the limit with noise.
    const score = meanScore(perVoter);
    if (score < MIN_TEXT_SCORE) continue;
    hits.push({
      entry,
      score,
      confidence: score >= HIGH_CONFIDENCE_TEXT_SCORE ? "high" : "low",
      matched_on: [...matchedFields],
    });
  }

  return hits.sort((a, b) => b.score - a.score);
}

// --- Router ---

function toMatches(hits: RoutedHit[], route: MatchRoute, limit: number): ContactMatch[] {
  return hits.slice(0, limit).map((hit) => ({
    contact: hit.entry.contact,
    score: hit.score,
    confidence: hit.confidence,
    matched_on: hit.matched_on,
    route,
  }));
}

/**
 * Route the query, then rank. A structured route that finds nothing falls back
 * to text: a phone-shaped query with no suffix hit may still be an extension
 * or an account number written in a name, and an unknown address often shares
 * a token with the contact's name.
 */
export function findContacts(
  index: ContactIndex,
  query: string,
  options: FindContactsOptions = {},
): FindContactsResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const includeNotes = options.verbose === true;
  const kind = classifyQuery(query);
  // The prefilter must never be the thing that caps the answer: a caller asking
  // for 500 matches gets at least 500 candidates scored.
  const candidates = Math.max(TEXT_CANDIDATE_LIMIT, limit);

  if (kind === "empty") {
    return { query, kind, route: "text", count: 0, matches: [] };
  }

  const textFallback = (): FindContactsResult => {
    const matches = toMatches(
      matchText(index, query, { includeNotes, candidates }),
      "text_fallback",
      limit,
    );
    return { query, kind, route: "text_fallback", count: matches.length, matches };
  };

  if (kind === "phone") {
    const hits = matchPhone(index, phoneDigits(query));
    if (!hits.length) return textFallback();
    const matches = toMatches(hits, "phone", limit);
    return { query, kind, route: "phone", count: matches.length, matches };
  }

  if (kind === "email") {
    const hits = matchEmail(index, query);
    if (!hits.length) return textFallback();
    const matches = toMatches(hits, "email", limit);
    return { query, kind, route: "email", count: matches.length, matches };
  }

  const matches = toMatches(
    matchText(index, query, { includeNotes, candidates }),
    "text",
    limit,
  );
  return { query, kind, route: "text", count: matches.length, matches };
}

// --- Health probe ---

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
      hint: `No Contacts stores found under ${sourcesDir}. Open Contacts.app once to create one, and grant Full Disk Access to the terminal/Codex app for contact search.`,
    };
  }

  try {
    const contacts = loadContacts({ stores, includeNotes: false });
    return { ok: true, stores: stores.length, contacts: contacts.length };
  } catch (err) {
    return {
      ok: false,
      stores: stores.length,
      contacts: 0,
      hint:
        err instanceof ContactsAccessError
          ? err.message
          : `Contacts database could not be read: ${(err as Error).message}. ${FULL_DISK_ACCESS_HINT}`,
    };
  }
}
