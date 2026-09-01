import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  buildContactIndex,
  checkContactsAccess,
  classifyQuery,
  findContacts,
  loadContacts,
  matchEmail,
  matchPhone,
  matchText,
  splitExtension,
  storePaths,
} from "../../dist/providers/contacts/index.js";
import {
  TEXT_SIMILARITIES,
  canonicalizeEmail,
  containment,
  dice,
  fold,
  jaro,
  jaroWinkler,
  levenshtein,
  levenshteinSimilarity,
  meanScore,
  ngrams,
  phoneDigits,
  sharedSuffixLength,
  tokenSort,
  tokens,
} from "../../dist/providers/contacts/similarity.js";

// --- Fixture stores ---
//
// Every test here builds its own AddressBook-shaped SQLite stores in a temp
// directory and hands them to `loadContacts({ stores })`. The real AddressBook
// under ~/Library is never opened: it is the user's data, and its schema quirks
// (per-store Z_ENT, per-store column sets, junk entity rows, cross-store
// duplicates) are exactly what these fixtures reproduce deliberately.

const DEFAULT_RECORD_COLUMNS = [
  "ZFIRSTNAME",
  "ZLASTNAME",
  "ZORGANIZATION",
  "ZJOBTITLE",
  "ZEXTERNALUUID",
];

/** Write one AddressBook-shaped store at an exact path. */
function writeStore(path, spec) {
  const db = new Database(path);
  const recordColumns = spec.recordColumns ?? DEFAULT_RECORD_COLUMNS;

  try {
    db.exec(`
      CREATE TABLE Z_PRIMARYKEY (
        Z_ENT INTEGER PRIMARY KEY,
        Z_NAME TEXT,
        Z_SUPER INTEGER,
        Z_MAX INTEGER
      );
      CREATE TABLE ZABCDRECORD (
        Z_PK INTEGER PRIMARY KEY,
        Z_ENT INTEGER,
        ${recordColumns.map((column) => `${column} TEXT`).join(",\n        ")}
      );
    `);
    if (spec.phoneTable !== false) {
      db.exec(`
        CREATE TABLE ZABCDPHONENUMBER (
          Z_PK INTEGER PRIMARY KEY,
          ZOWNER INTEGER,
          ZFULLNUMBER TEXT,
          ZLABEL TEXT,
          ZLASTFOURDIGITS TEXT
        );
      `);
    }
    if (spec.emailTable !== false) {
      db.exec(`
        CREATE TABLE ZABCDEMAILADDRESS (
          Z_PK INTEGER PRIMARY KEY,
          ZOWNER INTEGER,
          ZADDRESS TEXT,
          ZLABEL TEXT
        );
      `);
    }
    if (spec.noteTable !== false) {
      db.exec(`
        CREATE TABLE ZABCDNOTE (
          Z_PK INTEGER PRIMARY KEY,
          ZCONTACT INTEGER,
          ZTEXT TEXT
        );
      `);
    }

    const entities = spec.entities ?? { ABCDContact: 22 };
    const entityStatement = db.prepare(
      "INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)",
    );
    for (const [name, entity] of Object.entries(entities)) {
      entityStatement.run(entity, name);
    }

    for (const record of spec.records ?? []) {
      const { pk, entity = "ABCDContact", ...fields } = record;
      const columns = Object.keys(fields).filter((column) =>
        recordColumns.includes(column),
      );
      const placeholders = columns.map(() => ", ?").join("");
      db.prepare(
        `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT${columns.length ? `, ${columns.join(", ")}` : ""})
         VALUES (?, ?${placeholders})`,
      ).run(pk, entities[entity], ...columns.map((column) => fields[column] ?? null));
    }

    for (const phone of spec.phones ?? []) {
      db.prepare(
        "INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER, ZLABEL, ZLASTFOURDIGITS) VALUES (?, ?, ?, ?)",
      ).run(
        phone.owner,
        phone.number ?? null,
        phone.label === undefined ? null : phone.label,
        phone.lastFour ?? null,
      );
    }

    for (const email of spec.emails ?? []) {
      db.prepare(
        "INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS, ZLABEL) VALUES (?, ?, ?)",
      ).run(email.owner, email.address ?? null, email.label === undefined ? null : email.label);
    }

    for (const note of spec.notes ?? []) {
      db.prepare("INSERT INTO ZABCDNOTE (ZCONTACT, ZTEXT) VALUES (?, ?)").run(
        note.owner,
        note.text ?? null,
      );
    }
  } finally {
    db.close();
  }
}

function createStore(sourcesDir, spec) {
  const dir = join(sourcesDir, spec.source);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "AddressBook-v22.abcddb");
  writeStore(path, spec);
  return { source: spec.source, path };
}

/**
 * The legacy store that sits *beside* `Sources` rather than inside it — the
 * pre-Sources primary, which `storePaths` names `top-level`.
 */
function createTopLevelStore(root, spec) {
  const path = join(root, "AddressBook-v22.abcddb");
  writeStore(path, spec);
  return { source: "top-level", path };
}

/**
 * A store at an arbitrary schema generation, for the version-tolerance tests.
 * `AddressBook-v22` is a generation, not a fixed name, so discovery matches
 * `AddressBook-v<N>.abcddb` and prefers the highest N it finds.
 */
function createStoreAtVersion(sourcesDir, source, version, spec) {
  const dir = join(sourcesDir, source);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `AddressBook-v${version}.abcddb`);
  writeStore(path, spec);
  return { source, path };
}

/** A file that exists where a store belongs but is not a database. */
function createDamagedStore(sourcesDir, source) {
  mkdirSync(join(sourcesDir, source), { recursive: true });
  const path = join(sourcesDir, source, "AddressBook-v22.abcddb");
  writeFileSync(path, "not a database");
  return { source, path };
}

/** Build the fixture stores, run `body` against them, then delete the temp dir. */
function withStores(specs, body) {
  return withSourcesDir(specs, (root, stores) => body(stores));
}

/**
 * Same, but hands the body the Sources *directory* as well — what
 * `OUTREACH_CONTACTS_SOURCES_DIR` points the CLI at, so the command itself can
 * be exercised without touching the machine's own AddressBook.
 *
 * The fixture mirrors the real layout — `<root>/Sources/<uuid>/` with the
 * legacy store's slot at `<root>/` — so the top-level store `storePaths` also
 * reads is reachable from a test as `dirname(sourcesDir)`.
 */
function withSourcesDir(specs, body) {
  const root = mkdtempSync(join(tmpdir(), "outreach-contacts-test-"));
  const sourcesDir = join(root, "Sources");
  mkdirSync(sourcesDir, { recursive: true });
  try {
    return body(sourcesDir, specs.map((spec) => createStore(sourcesDir, spec)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loadFrom(specs, options = {}) {
  return withStores(specs, (stores) => loadContacts({ stores, ...options }));
}

const byName = (contacts) => new Map(contacts.map((contact) => [contact.name, contact]));
const names = (matches) => matches.map((match) => match.contact.name);

// --- Trap 1: the ABCDContact entity id differs per store ---

test("contacts from stores with different ABCDContact entity ids are all found", () => {
  const contacts = loadFrom([
    {
      source: "store-ent-22",
      entities: { ABCDContact: 22, ABCDInfo: 17 },
      records: [
        { pk: 1, ZFIRSTNAME: "Ashley", ZLASTNAME: "Parker", ZEXTERNALUUID: "u-ashley" },
      ],
    },
    {
      source: "store-ent-21",
      // Same table, different entity numbering: a hardcoded 22 finds nothing here.
      entities: { ABCDContact: 21, ABCDInfo: 22 },
      records: [
        { pk: 1, ZFIRSTNAME: "Brian", ZLASTNAME: "Davis", ZEXTERNALUUID: "u-brian" },
        { pk: 2, entity: "ABCDInfo", ZFIRSTNAME: "Info", ZLASTNAME: "Row" },
      ],
    },
  ]);

  assert.deepEqual(
    contacts.map((contact) => contact.name).sort(),
    ["Ashley Parker", "Brian Davis"],
  );
});

test("a store whose Z_PRIMARYKEY has no ABCDContact row contributes nothing", () => {
  const contacts = loadFrom([
    {
      source: "store-no-contact-entity",
      entities: { ABCDInfo: 17 },
      records: [{ pk: 1, entity: "ABCDInfo", ZFIRSTNAME: "Info", ZLASTNAME: "Row" }],
    },
  ]);

  assert.deepEqual(contacts, []);
});

// --- Trap 2: column sets differ per store ---

test("stores with different ZABCDRECORD column sets load without throwing", () => {
  const specs = [
    {
      source: "store-extra-column",
      recordColumns: [...DEFAULT_RECORD_COLUMNS, "ZEXTERNALIDENTIFIER"],
      records: [
        {
          pk: 1,
          ZFIRSTNAME: "Ashley",
          ZLASTNAME: "Parker",
          ZJOBTITLE: "Estimator",
          ZEXTERNALUUID: "u-ashley",
          ZEXTERNALIDENTIFIER: "ABPerson-1",
        },
      ],
    },
    {
      source: "store-missing-columns",
      // No ZJOBTITLE, no ZEXTERNALUUID, and no email/note tables at all.
      recordColumns: ["ZFIRSTNAME", "ZLASTNAME", "ZORGANIZATION"],
      emailTable: false,
      noteTable: false,
      records: [{ pk: 1, ZFIRSTNAME: "Brian", ZLASTNAME: "Davis", ZORGANIZATION: "Designer Appliances" }],
      phones: [{ owner: 1, number: "(201) 820-0370", label: "_$!<Work>!$_" }],
    },
  ];

  let contacts;
  assert.doesNotThrow(() => {
    contacts = loadFrom(specs);
  });

  const found = byName(contacts);
  assert.equal(found.get("Ashley Parker")?.job_title, "Estimator");
  const brian = found.get("Brian Davis");
  assert.equal(brian?.job_title, null);
  assert.equal(brian?.organization, "Designer Appliances");
  assert.deepEqual(brian?.phones, [{ number: "+12018200370", label: "work", extension: null }]);
  assert.deepEqual(brian?.emails, []);
});

// --- Trap 3: entity filtering ---

test("ABCDInfo and ABCDGroup rows are excluded from the contact list", () => {
  const junk = [];
  for (let i = 0; i < 40; i++) {
    junk.push({ pk: 100 + i, entity: "ABCDInfo", ZFIRSTNAME: "Info", ZORGANIZATION: "Junk Info Row" });
  }

  const contacts = loadFrom([
    {
      source: "store-with-junk",
      entities: { ABCDContact: 22, ABCDInfo: 17, ABCDGroup: 19 },
      records: [
        { pk: 1, ZFIRSTNAME: "Ashley", ZLASTNAME: "Parker", ZEXTERNALUUID: "u-ashley" },
        { pk: 2, entity: "ABCDGroup", ZORGANIZATION: "Junk Group" },
        ...junk,
      ],
      // A phone owned by a junk row must not leak onto the real contact.
      phones: [
        { owner: 1, number: "+1 (551) 261-3888", label: "_$!<Mobile>!$_" },
        { owner: 100, number: "+1 (628) 555-7712", label: "_$!<Mobile>!$_" },
      ],
    },
  ]);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, "Ashley Parker");
  assert.deepEqual(contacts[0].phones, [{ number: "+15512613888", label: "mobile", extension: null }]);
});

// --- Trap 4: cross-store dedup ---

test("the same ZEXTERNALUUID across two stores yields one merged contact", () => {
  const contacts = loadFrom([
    {
      source: "store-current",
      records: [
        { pk: 1, ZFIRSTNAME: "Fred", ZLASTNAME: "Yang", ZEXTERNALUUID: "u-fred" },
      ],
      phones: [{ owner: 1, number: "+1 (551) 261-3888", label: "_$!<Mobile>!$_" }],
      emails: [{ owner: 1, address: "fred@example.com", label: "_$!<Work>!$_" }],
    },
    {
      // The stale 2023 mirror: same person, partly different data.
      source: "store-stale-mirror",
      records: [
        {
          pk: 7,
          ZFIRSTNAME: "Fred",
          ZORGANIZATION: "Outreach Labs",
          ZJOBTITLE: "Operator",
          ZEXTERNALUUID: "u-fred",
        },
      ],
      phones: [
        { owner: 7, number: "+1 (551) 261-3888", label: "_$!<Mobile>!$_" },
        { owner: 7, number: "(628) 555-7712", label: "_$!<Home>!$_" },
      ],
      emails: [{ owner: 7, address: "FRED@example.com", label: null }],
    },
  ]);

  assert.equal(contacts.length, 1);
  const fred = contacts[0];
  assert.equal(fred.name, "Fred Yang");
  // Non-null wins on both sides: the last name only exists in the first store,
  // the organization and job title only in the mirror.
  assert.equal(fred.last_name, "Yang");
  assert.equal(fred.organization, "Outreach Labs");
  assert.equal(fred.job_title, "Operator");
  assert.deepEqual(fred.phones, [
    { number: "+15512613888", label: "mobile", extension: null },
    { number: "+16285557712", label: "home", extension: null },
  ]);
  // The duplicate address differs only in case and is not added twice.
  assert.deepEqual(fred.emails, [{ address: "fred@example.com", label: "work" }]);
  assert.deepEqual(fred.sources.sort(), ["store-current", "store-stale-mirror"]);
});

test("when both stores hold a conflicting value, the first store listed wins", () => {
  // Nothing in the schema says which store is fresher, so the merge is
  // resolved by the caller-supplied store order and stays deterministic.
  const specs = [
    {
      source: "store-first",
      records: [
        { pk: 1, ZFIRSTNAME: "Fred", ZORGANIZATION: "Outreach Labs", ZEXTERNALUUID: "u-fred" },
      ],
    },
    {
      source: "store-second",
      records: [
        { pk: 1, ZFIRSTNAME: "Fred", ZORGANIZATION: "Outreach Labs (old)", ZEXTERNALUUID: "u-fred" },
      ],
    },
  ];

  assert.equal(loadFrom(specs)[0].organization, "Outreach Labs");
  assert.equal(loadFrom([specs[1], specs[0]])[0].organization, "Outreach Labs (old)");
});

test("records without ZEXTERNALUUID dedupe on name|organization", () => {
  const contacts = loadFrom([
    {
      source: "store-a",
      records: [
        { pk: 1, ZFIRSTNAME: "Karen", ZLASTNAME: "Bell", ZORGANIZATION: "Bell Insulation" },
        { pk: 2, ZFIRSTNAME: "Karen", ZLASTNAME: "Bell", ZORGANIZATION: "Bell Roofing" },
      ],
      phones: [{ owner: 1, number: "(415) 555-0143", label: "_$!<Mobile>!$_" }],
    },
    {
      source: "store-b",
      records: [
        { pk: 5, ZFIRSTNAME: "Karen", ZLASTNAME: "Bell", ZORGANIZATION: "Bell Insulation" },
      ],
      phones: [{ owner: 5, number: "(628) 555-7712", label: "_$!<Home>!$_" }],
    },
  ]);

  // Two contacts share the name, so select on the key that actually separates them.
  assert.equal(contacts.length, 2);
  const insulation = contacts.filter((c) => c.organization === "Bell Insulation");
  const roofing = contacts.filter((c) => c.organization === "Bell Roofing");
  assert.equal(insulation.length, 1);
  assert.equal(insulation[0].name, "Karen Bell");
  assert.deepEqual(insulation[0].phones, [
    { number: "+14155550143", label: "mobile", extension: null },
    { number: "+16285557712", label: "home", extension: null },
  ]);
  assert.deepEqual(insulation[0].sources.sort(), ["store-a", "store-b"]);
  // A different organization is a different person, not a merge target.
  assert.equal(roofing.length, 1);
  assert.deepEqual(roofing[0].phones, []);
});

test("nameless, organization-less records do not collapse into one contact", () => {
  const contacts = loadFrom([
    {
      source: "store-a",
      records: [{ pk: 1 }],
      phones: [{ owner: 1, number: "(415) 555-0143", label: null }],
    },
    {
      source: "store-b",
      records: [{ pk: 1 }],
      phones: [{ owner: 1, number: "(628) 555-7712", label: null }],
    },
  ]);

  assert.equal(contacts.length, 2);
  assert.deepEqual(
    contacts.flatMap((contact) => contact.phones.map((phone) => phone.number)).sort(),
    ["+14155550143", "+16285557712"],
  );
});

// --- Duplicate child rows inside a single record ---

test("two same-name records inside one store stay two contacts", () => {
  // The name|organization key exists to fold the stale *cross-store* mirror of
  // a record that has no ZEXTERNALUUID. Applied inside a single store it merges
  // two cards the user's own Contacts.app shows separately, and hands back one
  // contact carrying two strangers' phone numbers — at high confidence, since
  // the name matches perfectly.
  const contacts = loadFrom([
    {
      source: "store-namesakes",
      records: [
        { pk: 1, ZFIRSTNAME: "John", ZLASTNAME: "Smith" },
        { pk: 2, ZFIRSTNAME: "John", ZLASTNAME: "Smith" },
      ],
      phones: [
        { owner: 1, number: "+1 (415) 555-0101", label: null },
        { owner: 2, number: "+1 (628) 555-0202", label: null },
      ],
    },
  ]);

  assert.equal(contacts.length, 2);
  assert.deepEqual(
    contacts.map((contact) => contact.phones.map((phone) => phone.number)),
    [["+14155550101"], ["+16285550202"]],
  );

  // ...while the same two names in *different* stores are still the one
  // cross-store record the fallback key is for (covered above as well).
  const mirrored = loadFrom([
    {
      source: "store-a",
      records: [{ pk: 1, ZFIRSTNAME: "John", ZLASTNAME: "Smith" }],
      phones: [{ owner: 1, number: "+1 (415) 555-0101", label: null }],
    },
    {
      source: "store-b",
      records: [{ pk: 9, ZFIRSTNAME: "John", ZLASTNAME: "Smith" }],
      phones: [{ owner: 9, number: "+1 (415) 555-0101", label: null }],
    },
  ]);
  assert.equal(mirrored.length, 1);
  assert.deepEqual(mirrored[0].sources, ["store-a", "store-b"]);
});

test("duplicate phone and email rows inside one record are emitted once", () => {
  // Not a cross-store merge: one store, one record, two identical child rows —
  // which the real AddressBook genuinely contains. The union has to run on the
  // first record too, not only when a second store contributes the same values.
  const contacts = loadFrom([
    {
      source: "store-duplicate-rows",
      records: [{ pk: 407, ZFIRSTNAME: "Brian", ZLASTNAME: "Davis", ZEXTERNALUUID: "u-brian" }],
      phones: [
        { owner: 407, number: "+1 (813) 500-1416", label: "_$!<Mobile>!$_" },
        // Same number, written differently: normalization makes them equal.
        { owner: 407, number: "813-500-1416", label: "_$!<Mobile>!$_" },
        { owner: 407, number: "(628) 555-7712", label: "_$!<Home>!$_" },
      ],
      emails: [
        { owner: 407, address: "Brian.Davis@Designerappliances.com", label: "_$!<Work>!$_" },
        { owner: 407, address: "brian.davis@designerappliances.com", label: "_$!<Work>!$_" },
      ],
    },
  ]);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].sources.length, 1, "this contact must never have been merged");
  assert.deepEqual(contacts[0].phones, [
    { number: "+18135001416", label: "mobile", extension: null },
    { number: "+16285557712", label: "home", extension: null },
  ]);
  assert.deepEqual(contacts[0].emails, [
    { address: "Brian.Davis@Designerappliances.com", label: "work" },
  ]);
});

// --- Phone labels ---

test("phone labels are decoded from Apple's encoding", () => {
  const contacts = loadFrom([
    {
      source: "store-labels",
      records: [{ pk: 1, ZFIRSTNAME: "Ashley", ZLASTNAME: "Parker", ZEXTERNALUUID: "u-ashley" }],
      phones: [
        { owner: 1, number: "+1 (551) 261-3888", label: "_$!<Mobile>!$_" },
        { owner: 1, number: "(415) 555-0143", label: "" },
        { owner: 1, number: "(628) 555-7712", label: null },
        { owner: 1, number: "(201) 820-0370", label: "Beach House" },
        // No digits at all: a formatting artifact, not a phone number.
        { owner: 1, number: "---", label: "_$!<Home>!$_" },
      ],
    },
  ]);

  assert.deepEqual(contacts[0].phones, [
    { number: "+15512613888", label: "mobile", extension: null },
    { number: "+14155550143", label: null, extension: null },
    { number: "+16285557712", label: null, extension: null },
    { number: "+12018200370", label: "beach house", extension: null },
  ]);
});

// --- Stored extensions ---

test("splitExtension separates a trailing extension from the dialable number", () => {
  for (const [raw, dialable, extension] of [
    ["(201) 820-1234 ext. 56", "(201) 820-1234", "56"],
    ["201-820-1234 x56", "201-820-1234", "56"],
    ["+1 201 820 1234, 56", "+1 201 820 1234", "56"],
    ["555-1234;9", "555-1234", "9"],
  ]) {
    const split = splitExtension(raw);
    assert.equal(split.dialable.trim(), dialable, raw);
    assert.equal(split.extension, extension, raw);
  }

  // Nothing that is not an extension may be shortened: an international number
  // and a bare "x1234" (an extension of nothing) stay whole.
  for (const raw of ["+44 20 7946 0958", "(201) 820-1234", "x1234", "---"]) {
    assert.deepEqual(splitExtension(raw), { dialable: raw, extension: null }, raw);
  }
});

test("a stored extension is kept out of the E.164 number and stays findable", () => {
  const contacts = loadFrom([
    {
      source: "store-extension",
      records: [{ pk: 1, ZFIRSTNAME: "Ext", ZLASTNAME: "Person", ZEXTERNALUUID: "u-ext" }],
      phones: [{ owner: 1, number: "(201) 820-1234 ext. 56", label: "_$!<Work>!$_" }],
    },
  ]);

  // Folding the extension into the digits produced "+201820123456": twelve
  // digits, a valid-looking Egyptian number, and not this contact's number.
  assert.deepEqual(contacts[0].phones, [
    { number: "+12018201234", label: "work", extension: "56" },
  ]);

  // And the phone route can reach it again: the indexed digits used to end in
  // the extension, so the query shared no suffix with them at all.
  const index = buildContactIndex(contacts);
  const result = findContacts(index, "2018201234");
  assert.equal(result.route, "phone");
  assert.equal(result.matches[0].contact.name, "Ext Person");
  assert.equal(result.matches[0].confidence, "high");
  assert.equal(matchPhone(index, "2018201234").length, 1);
});

test("one number with two extensions is two endpoints, not a duplicate row", () => {
  const contacts = loadFrom([
    {
      source: "store-two-extensions",
      records: [{ pk: 1, ZORGANIZATION: "Front Desk Inc", ZEXTERNALUUID: "u-desk" }],
      phones: [
        { owner: 1, number: "(201) 820-1234 ext. 56", label: "_$!<Work>!$_" },
        { owner: 1, number: "(201) 820-1234 ext. 57", label: "_$!<Work>!$_" },
        { owner: 1, number: "(201) 820-1234 ext. 56", label: "_$!<Work>!$_" },
      ],
    },
  ]);

  assert.deepEqual(
    contacts[0].phones.map((phone) => phone.extension),
    ["56", "57"],
  );
});

// --- The shared search fixture ---

const SEARCH_STORES = [
  {
    source: "search-primary",
    entities: { ABCDContact: 22, ABCDInfo: 17 },
    records: [
      { pk: 1, ZFIRSTNAME: "Fred", ZLASTNAME: "Yang", ZORGANIZATION: "Outreach Labs", ZEXTERNALUUID: "u-fred" },
      {
        pk: 2,
        ZFIRSTNAME: "Ashley",
        ZLASTNAME: "Parker",
        ZORGANIZATION: "Insulation Expert",
        ZJOBTITLE: "Estimator",
        ZEXTERNALUUID: "u-ashley",
      },
      { pk: 3, ZFIRSTNAME: "Brian", ZLASTNAME: "Davis", ZORGANIZATION: "Designer Appliances", ZEXTERNALUUID: "u-brian" },
      { pk: 4, ZFIRSTNAME: "Ab", ZLASTNAME: "Kim", ZEXTERNALUUID: "u-ab" },
      { pk: 5, ZFIRSTNAME: "Dana", ZLASTNAME: "Cole", ZEXTERNALUUID: "u-dana" },
      { pk: 6, ZFIRSTNAME: "Karen", ZLASTNAME: "Bell", ZORGANIZATION: "Bell Insulation", ZEXTERNALUUID: "u-karen" },
      { pk: 7, ZFIRSTNAME: "Fred", ZLASTNAME: "Nolan", ZORGANIZATION: "Appliance Design Group", ZEXTERNALUUID: "u-nolan" },
      { pk: 8, ZFIRSTNAME: "Sam", ZLASTNAME: "Yang", ZORGANIZATION: "Yang Family Dental", ZEXTERNALUUID: "u-sam" },
      { pk: 9, ZORGANIZATION: "Corner Market 90210", ZEXTERNALUUID: "u-market" },
    ],
    phones: [
      { owner: 1, number: "+1 (551) 261-3888", label: "_$!<Mobile>!$_" },
      { owner: 2, number: "(415) 555-0143", label: "_$!<Home>!$_" },
      { owner: 3, number: "201-820-0370", label: "" },
      { owner: 6, number: "+1 (628) 555-7712", label: "Beach House" },
    ],
    emails: [
      { owner: 3, address: "Brian.Davis@Designerappliances.com", label: "_$!<Work>!$_" },
      { owner: 4, address: "ab@gmail.com", label: null },
      { owner: 5, address: "d.cole@example.com", label: "_$!<Home>!$_" },
    ],
    notes: [{ owner: 2, text: "Met at the Marin trade show" }],
  },
];

const SEARCH_CONTACTS = loadFrom(SEARCH_STORES, { includeNotes: true });
const SEARCH_INDEX = buildContactIndex(SEARCH_CONTACTS);
const SEARCH_INDEX_WITH_NOTES = buildContactIndex(SEARCH_CONTACTS, { includeNotes: true });

test("the search fixture loaded the expected contacts", () => {
  assert.equal(SEARCH_CONTACTS.length, 9);
  // An organization-only record still gets a display name.
  assert.equal(byName(SEARCH_CONTACTS).get("Corner Market 90210")?.first_name, null);
});

// --- Query classification ---

test("classifyQuery routes phone, email and text queries", () => {
  assert.equal(classifyQuery("+1 (551) 261-3888"), "phone");
  assert.equal(classifyQuery("5512613888"), "phone");
  assert.equal(classifyQuery("551-261-3888"), "phone");
  assert.equal(classifyQuery("3888"), "phone");

  assert.equal(classifyQuery("a@b.com"), "email");
  assert.equal(classifyQuery("Brian.Davis@Designerappliances.com"), "email");

  assert.equal(classifyQuery("Ashley"), "text");
  assert.equal(classifyQuery("SM2"), "text");
  assert.equal(classifyQuery("7-Eleven"), "text");
  // Three digits is not enough to be a phone number.
  assert.equal(classifyQuery("551"), "text");

  assert.equal(classifyQuery(""), "empty");
  assert.equal(classifyQuery("   "), "empty");
});

// --- Phone route ---

test("every formatting of one number resolves to the same contact", () => {
  for (const query of [
    "+1 (551) 261-3888",
    "5512613888",
    "551-261-3888",
    "+1 551.261.3888",
    "2613888",
    "3888",
  ]) {
    const result = findContacts(SEARCH_INDEX, query);
    assert.equal(result.kind, "phone", query);
    assert.equal(result.route, "phone", query);
    assert.equal(result.matches[0].contact.name, "Fred Yang", query);
    // The whole query is covered by the stored number's tail.
    assert.equal(result.matches[0].score, 1, query);
    assert.deepEqual(result.matches[0].matched_on, ["phone"], query);
  }
});

test("a fully covered query is high confidence only once it is a real number", () => {
  // Coverage alone is trivially true for a short query, so it cannot be the
  // whole confidence rule: every number in the book ends in *some* four digits.
  for (const query of ["+1 (551) 261-3888", "5512613888", "2613888"]) {
    assert.equal(findContacts(SEARCH_INDEX, query).matches[0].confidence, "high", query);
  }
  for (const query of ["3888", "13888", "613888"]) {
    const result = findContacts(SEARCH_INDEX, query);
    assert.equal(result.matches[0].contact.name, "Fred Yang", query);
    assert.equal(result.matches[0].confidence, "low", query);
  }
});

test("a bare last-four is low confidence for every contact that shares it", () => {
  const contacts = loadFrom([
    {
      source: "store-last-four",
      records: [
        { pk: 1, ZFIRSTNAME: "Alice", ZLASTNAME: "One", ZEXTERNALUUID: "u-1" },
        { pk: 2, ZFIRSTNAME: "Bob", ZLASTNAME: "Two", ZEXTERNALUUID: "u-2" },
        { pk: 3, ZFIRSTNAME: "Cara", ZLASTNAME: "Three", ZEXTERNALUUID: "u-3" },
      ],
      phones: [
        { owner: 1, number: "+1 (551) 261-3888", label: null },
        { owner: 2, number: "+1 (628) 777-3888", label: null },
        { owner: 3, number: "+1 (415) 200-3888", label: null },
      ],
    },
  ]);
  const index = buildContactIndex(contacts);

  const hits = matchPhone(index, "3888");
  assert.equal(hits.length, 3);
  // Three unrelated people, one shared tail: none of them is a certain match.
  assert.ok(
    hits.every((hit) => hit.confidence === "low"),
    "a four-digit query must not report any contact as high confidence",
  );

  // The same tail inside a full number still identifies exactly one person.
  const full = matchPhone(index, "5512613888");
  assert.equal(full[0].entry.contact.name, "Alice One");
  assert.equal(full[0].confidence, "high");
  assert.ok(full.slice(1).every((hit) => hit.confidence === "low"));
});

test("a number nobody has produces no phone hit", () => {
  assert.deepEqual(matchPhone(SEARCH_INDEX, "13125551234"), []);
  const result = findContacts(SEARCH_INDEX, "+1 (312) 555-1234");
  assert.equal(result.kind, "phone");
  assert.equal(result.route, "text_fallback");
});

test("longer shared suffixes rank ahead of shorter ones", () => {
  const contacts = loadFrom([
    {
      source: "store-suffix",
      records: [
        { pk: 1, ZFIRSTNAME: "Exact", ZLASTNAME: "Match", ZEXTERNALUUID: "u-1" },
        { pk: 2, ZFIRSTNAME: "Tail", ZLASTNAME: "Only", ZEXTERNALUUID: "u-2" },
      ],
      phones: [
        { owner: 1, number: "+1 (551) 261-3888", label: null },
        { owner: 2, number: "+1 (628) 777-3888", label: null },
      ],
    },
  ]);
  const index = buildContactIndex(contacts);

  const hits = matchPhone(index, "5512613888");
  assert.deepEqual(
    hits.map((hit) => hit.entry.contact.name),
    ["Exact Match", "Tail Only"],
  );
  assert.equal(hits[0].confidence, "high");
  // A shared last-four is a weaker claim and says so.
  assert.equal(hits[1].confidence, "low");
  assert.ok(hits[1].score < hits[0].score);
});

// --- Email route ---

test("email matching is case-insensitive", () => {
  const result = findContacts(SEARCH_INDEX, "BRIAN.DAVIS@DESIGNERAPPLIANCES.COM");
  assert.equal(result.kind, "email");
  assert.equal(result.route, "email");
  assert.equal(result.matches[0].contact.name, "Brian Davis");
  assert.equal(result.matches[0].score, 1);
  assert.equal(result.matches[0].confidence, "high");
});

test("gmail plus-tags and dots are ignored", () => {
  for (const query of ["a.b+tag@gmail.com", "ab+anything@gmail.com", "A.B@GMAIL.COM"]) {
    const result = findContacts(SEARCH_INDEX, query);
    assert.equal(result.route, "email", query);
    assert.equal(result.matches[0].contact.name, "Ab Kim", query);
    assert.equal(result.matches[0].score, 1, query);
  }
});

test("dots are not stripped for non-gmail domains", () => {
  // Stored: d.cole@example.com. Only gmail treats "dcole" as the same mailbox.
  assert.deepEqual(matchEmail(SEARCH_INDEX, "dcole@example.com"), []);
  const result = findContacts(SEARCH_INDEX, "dcole@example.com");
  assert.equal(result.kind, "email");
  assert.equal(result.route, "text_fallback");

  // The stored spelling still matches exactly.
  const exact = findContacts(SEARCH_INDEX, "D.Cole@Example.com");
  assert.equal(exact.route, "email");
  assert.equal(exact.matches[0].contact.name, "Dana Cole");
});

test("a dotted gmail address still matches the same human at another domain", () => {
  // gmail's dot rule is domain-specific, so the stored local canonicalizes to
  // "charlesdevore". Comparing that against a *dotted* local at some other
  // domain has to ignore dots on both sides, or the correctly-spelled query
  // loses to the misspelled one.
  const contacts = loadFrom([
    {
      source: "store-devore",
      records: [{ pk: 1, ZFIRSTNAME: "Charles", ZLASTNAME: "DeVore", ZEXTERNALUUID: "u-charles" }],
      emails: [{ owner: 1, address: "charles.devore@gmail.com", label: "_$!<Home>!$_" }],
    },
  ]);
  const index = buildContactIndex(contacts);

  for (const query of [
    "charles.devore@newcompany.example",
    "charlesdevore@newcompany.example",
    "Charles.DeVore@NewCompany.Example",
  ]) {
    const result = findContacts(index, query);
    assert.equal(result.route, "email", query);
    assert.equal(result.matches[0].contact.name, "Charles DeVore", query);
    assert.equal(result.matches[0].confidence, "high", query);
    assert.equal(result.matches[0].score, 0.9, query);
  }

  // A dotted fragment at another domain is still only the substring tier.
  const partial = findContacts(index, "charles.devo@newcompany.example");
  assert.equal(partial.route, "email");
  assert.equal(partial.matches[0].confidence, "low");

  // And the real address still outranks all of them.
  assert.equal(findContacts(index, "charles.devore@gmail.com").matches[0].score, 1);
});

test("the same local part on another domain still ranks below an exact address", () => {
  const result = findContacts(SEARCH_INDEX, "ab@otherdomain.com");
  assert.equal(result.route, "email");
  assert.equal(result.matches[0].contact.name, "Ab Kim");
  assert.equal(result.matches[0].confidence, "high");
  assert.ok(result.matches[0].score < 1);
});

test("a local-part substring is a low-confidence email hit", () => {
  // "ian.davis" is only a fragment of the stored "brian.davis" local part.
  const result = findContacts(SEARCH_INDEX, "ian.davis@elsewhere.example");
  assert.equal(result.route, "email");
  assert.equal(result.matches[0].contact.name, "Brian Davis");
  assert.equal(result.matches[0].confidence, "low");
});

test("a one-character local part is not a substring hit for half the book", () => {
  // Every address containing an "a" used to come back at an identical 0.7, so
  // the limit filled with noise, "array order is the rank" was not true of a
  // field of exact ties, and the text fallback that would have answered was
  // never reached. Same failure `MIN_TEXT_SCORE` exists to prevent.
  assert.deepEqual(matchEmail(SEARCH_INDEX, "a@nowhere.example"), []);

  const result = findContacts(SEARCH_INDEX, "a@nowhere.example", { limit: 50 });
  assert.equal(result.kind, "email");
  assert.equal(result.route, "text_fallback");
  const scores = result.matches.map((match) => match.score);
  assert.deepEqual([...new Set(scores)], scores, "a rank cannot be a field of ties");
});

test("substring email hits rank by how much of the stored local they cover", () => {
  const contacts = loadFrom([
    {
      source: "store-coverage",
      records: [
        { pk: 1, ZFIRSTNAME: "Dev", ZLASTNAME: "Short", ZEXTERNALUUID: "u-short" },
        { pk: 2, ZFIRSTNAME: "Dev", ZLASTNAME: "Long", ZEXTERNALUUID: "u-long" },
      ],
      emails: [
        { owner: 1, address: "devx@a.example", label: null },
        { owner: 2, address: "devlongername@b.example", label: null },
      ],
    },
  ]);
  const index = buildContactIndex(contacts);

  const hits = matchEmail(index, "dev@nowhere.example");
  assert.deepEqual(
    hits.map((hit) => hit.entry.contact.name),
    ["Dev Short", "Dev Long"],
  );
  // "dev" is three quarters of one local and a fifth of the other: a real rank,
  // not two hits tied at a flat 0.7 in load order.
  assert.ok(hits[0].score > hits[1].score);
  // A guess about a different domain is still only a guess.
  assert.ok(hits.every((hit) => hit.confidence === "low"));
  // And it never outranks an equal-local hit, whatever it covered.
  assert.ok(hits[0].score < 0.9);
});

// --- Text route ---

test("an exact organization ranks first", () => {
  const result = findContacts(SEARCH_INDEX, "Designer Appliances");
  assert.equal(result.kind, "text");
  assert.equal(result.route, "text");
  assert.equal(result.matches[0].contact.name, "Brian Davis");
  assert.equal(result.matches[0].score, 1);
  assert.equal(result.matches[0].confidence, "high");
  assert.ok(result.matches[0].matched_on.includes("organization"));
  // "Appliance Design Group" shares both words and still does not tie it.
  assert.ok(result.matches[0].score > result.matches[1].score);
  assert.notEqual(result.matches[1].contact.name, "Brian Davis");
});

test("a typo still ranks the right contact first", () => {
  const result = findContacts(SEARCH_INDEX, "insultion expert");
  assert.equal(result.matches[0].contact.name, "Ashley Parker");
  assert.equal(result.matches[0].confidence, "high");
  // "Bell Insulation" is the near-miss this has to beat.
  assert.ok(result.matches[0].score > (result.matches[1]?.score ?? 0));
});

test("a swapped first/last name ranks the right contact first", () => {
  const result = findContacts(SEARCH_INDEX, "Yang Fred");
  assert.equal(result.matches[0].contact.name, "Fred Yang");
  assert.equal(result.matches[0].confidence, "high");
  assert.ok(names(result.matches).includes("Sam Yang"));
  assert.notEqual(names(result.matches)[0], "Sam Yang");
});

test("a partial name query finds the contact", () => {
  const result = findContacts(SEARCH_INDEX, "Ashley");
  assert.equal(result.matches[0].contact.name, "Ashley Parker");
  assert.ok(result.matches[0].matched_on.includes("name"));
});

test("the limit caps the match list without changing the ranking", () => {
  const all = findContacts(SEARCH_INDEX, "Fred", { limit: 50 });
  const capped = findContacts(SEARCH_INDEX, "Fred", { limit: 2 });
  assert.equal(capped.count, 2);
  assert.deepEqual(names(capped.matches), names(all.matches).slice(0, 2));
});

// --- Fallback ---

test("a digits-only query with no phone hit falls back to the text route", () => {
  const result = findContacts(SEARCH_INDEX, "90210");
  assert.equal(result.kind, "phone");
  assert.equal(result.route, "text_fallback");
  assert.equal(result.matches[0].contact.name, "Corner Market 90210");
});

test("an unknown address falls back to text and can still find the person", () => {
  const result = findContacts(SEARCH_INDEX, "ashley.parker@nowhere.example");
  assert.equal(result.kind, "email");
  assert.equal(result.route, "text_fallback");
  assert.equal(result.matches[0].contact.name, "Ashley Parker");
});

test("a phone query the phone route rejected is never high confidence as text", () => {
  // One mistyped digit falls out of the exact phone route into fuzzy text,
  // where the digit string scores well against the stored number *as
  // characters*. The asymmetry is the bug: a query a stored number fully
  // covers is correctly "low", so a query that matches nothing must not be
  // "high" — the field the skill doc calls safe to dial directly.
  const result = findContacts(SEARCH_INDEX, "5512613887", { limit: 50 });
  assert.equal(result.kind, "phone");
  assert.equal(result.route, "text_fallback");
  assert.equal(result.matches[0].contact.name, "Fred Yang");
  assert.deepEqual(result.matches[0].matched_on, ["phone"]);
  // The score is untouched: the fix is the confidence rule, not a new floor.
  assert.ok(result.matches[0].score >= 0.5, `score was ${result.matches[0].score}`);
  assert.ok(
    result.matches.every((match) => match.confidence === "low"),
    "a phone fallback that matched only phone atoms is never high confidence",
  );

  // The number nobody has, from the phone-route test above, behaves the same.
  const unknown = findContacts(SEARCH_INDEX, "+1 (312) 555-1234", { limit: 50 });
  assert.equal(unknown.route, "text_fallback");
  assert.ok(unknown.matches.every((match) => match.confidence === "low"));
});

test("an email query the email route rejected is not high confidence on email atoms", () => {
  // A typo'd local part at the right domain: the email route is exact and says
  // no, so the fuzzy hit on the same address string cannot say "safe to use".
  const result = findContacts(SEARCH_INDEX, "brain.davis@designerappliances.com", { limit: 50 });
  assert.equal(result.route, "text_fallback");
  assert.equal(result.matches[0].contact.name, "Brian Davis");
  assert.deepEqual(result.matches[0].matched_on, ["email"]);
  assert.ok(result.matches[0].score >= 0.5, `score was ${result.matches[0].score}`);
  assert.equal(result.matches[0].confidence, "low");
});

test("a structured query that falls back onto a name keeps its confidence", () => {
  // The cap is about evidence, not about the route: an address that matched the
  // person's *name* is a legitimate high-confidence answer, and so is a number
  // that turned out to be part of an organization name.
  const byName = findContacts(SEARCH_INDEX, "ashley.parker@nowhere.example");
  assert.equal(byName.route, "text_fallback");
  assert.equal(byName.matches[0].contact.name, "Ashley Parker");
  assert.ok(byName.matches[0].matched_on.includes("name"));
  assert.equal(byName.matches[0].confidence, "high");

  const digits = findContacts(SEARCH_INDEX, "90210");
  assert.equal(digits.route, "text_fallback");
  assert.equal(digits.matches[0].contact.name, "Corner Market 90210");
  assert.equal(digits.matches[0].confidence, "high");
});

// --- Notes ---

test("notes are read only when asked for and searched only when indexed", () => {
  const withoutNotes = loadFrom(SEARCH_STORES, { includeNotes: false });
  assert.equal(byName(withoutNotes).get("Ashley Parker").note, null);
  assert.equal(byName(SEARCH_CONTACTS).get("Ashley Parker").note, "Met at the Marin trade show");

  const noteHits = matchText(SEARCH_INDEX_WITH_NOTES, "Marin trade show", {
    includeNotes: true,
  });
  assert.equal(noteHits[0].entry.contact.name, "Ashley Parker");
  assert.ok(noteHits[0].matched_on.includes("note"));

  const withoutNoteAtoms = matchText(SEARCH_INDEX, "Marin trade show");
  assert.ok(
    withoutNoteAtoms.every((hit) => !hit.matched_on.includes("note")),
    "notes must not be searchable in a non-verbose index",
  );
});

// --- Empty results ---

test("a query nobody matches is an empty result, not a throw", () => {
  // Deliberately shares no character with any atom in the fixture, so every
  // voter scores 0 and the contact is dropped rather than returned at rank 9.
  const result = findContacts(SEARCH_INDEX, "qwzjqwzj");
  assert.equal(result.kind, "text");
  assert.equal(result.count, 0);
  assert.deepEqual(result.matches, []);
});

test("an empty query is an empty result", () => {
  for (const query of ["", "   "]) {
    const result = findContacts(SEARCH_INDEX, query);
    assert.equal(result.kind, "empty");
    assert.equal(result.count, 0);
    assert.deepEqual(result.matches, []);
  }
});

test("a punctuation-only query folds away to nothing rather than matching everything", () => {
  // These fold to "", which every atom trivially "contains" — the prefilter
  // keeps them all and the scoring has to be what rejects them.
  for (const query of ["!!!", "#$%^", "..."]) {
    const result = findContacts(SEARCH_INDEX, query);
    assert.equal(result.count, 0, query);
  }
});

test("searching an empty index is an empty result", () => {
  const empty = buildContactIndex([]);
  for (const query of ["Ashley", "5512613888", "a@b.com"]) {
    const result = findContacts(empty, query);
    assert.equal(result.count, 0, query);
    assert.deepEqual(result.matches, [], query);
  }
});

// --- The matching core ---
//
// The four-voter plain mean is the measured design, not an implementation
// detail: a trimmed mean, a dropped voter or a swapped voter all change
// measured accuracy. These tests fail on any of those substitutions.

test("the text ensemble is exactly four named voters in a fixed order", () => {
  assert.deepEqual(
    TEXT_SIMILARITIES.map((similarity) => similarity.name),
    ["jaroWinkler", "tokenSort", "dice", "containment"],
  );
});

test("scores are combined by a plain mean, not a trimmed one", () => {
  // A trimmed mean would discard the 0 and return 1 for the first case.
  assert.equal(meanScore([0, 1, 1, 1]), 0.75);
  assert.equal(meanScore([0, 0, 0, 1]), 0.25);
  assert.equal(meanScore([0.5]), 0.5);
  assert.equal(meanScore([]), 0);
});

test("a text score is the mean of each voter's best atom", () => {
  const query = "insultion expert";
  const hit = matchText(SEARCH_INDEX, query)[0];
  assert.equal(hit.entry.contact.name, "Ashley Parker");

  // Recomputed from the primitives rather than restated as a magic number, so
  // removing a voter, reordering the aggregation or swapping in a different
  // similarity all break this.
  const best = (fn) =>
    hit.entry.atoms.reduce((max, atom) => Math.max(max, fn(query, atom.value)), 0);
  const expected =
    (best(jaroWinkler) + best(tokenSort) + best((a, b) => dice(a, b)) + best(containment)) / 4;

  assert.equal(hit.score, expected);
  // Every voter is load-bearing: none of them alone equals the ensemble here.
  for (const fn of [jaroWinkler, tokenSort, (a, b) => dice(a, b), containment]) {
    assert.notEqual(best(fn), expected);
  }
});

// --- The score floor ---

test("a nonsense query with only incidental character overlap returns nothing", () => {
  // Jaro-Winkler is non-zero for almost any pair of non-empty strings, so
  // without a floor these fill the whole limit with ~0.1-scored noise.
  for (const query of ["zzzqqxk", "xqvzkj", "wqxzjv"]) {
    const result = findContacts(SEARCH_INDEX, query, { limit: 10 });
    assert.equal(result.count, 0, query);
    assert.deepEqual(result.matches, [], query);
  }
});

test("every reported text match clears the score floor and is classified by it", () => {
  // Mirrors MIN_TEXT_SCORE and HIGH_CONFIDENCE_TEXT_SCORE in contacts.ts:
  // anything weaker than the floor is not a candidate, and `confidence` — the
  // one field the skill doc tells agents to act on — is pinned to the
  // threshold rather than left to whatever the classifier happens to do.
  const seen = new Set();
  for (const query of ["Fred", "Designer Appliances", "insultion expert", "Bell", "Yang Fred"]) {
    const result = findContacts(SEARCH_INDEX, query, { limit: 50 });
    assert.ok(result.count > 0, query);
    assert.ok(
      result.matches.every((match) => match.score >= 0.25),
      `${query}: ${JSON.stringify(result.matches.map((m) => m.score))}`,
    );
    for (const match of result.matches) {
      assert.equal(
        match.confidence,
        match.score >= 0.5 ? "high" : "low",
        `${query}: ${match.contact.name} scored ${match.score}`,
      );
      seen.add(match.confidence);
    }
  }
  // Both sides of the threshold have to be exercised, or a classifier stuck on
  // one answer would satisfy the loop above.
  assert.deepEqual([...seen].sort(), ["high", "low"]);
});

// --- Prefilter and candidate limit ---

const CROWD_STORES = [
  {
    source: "store-crowd",
    records: [
      ...Array.from({ length: 61 }, (_, i) => ({
        pk: i + 1,
        ZFIRSTNAME: `Oscar${i}`,
        ZLASTNAME: "Filler",
        ZEXTERNALUUID: `u-filler-${i}`,
      })),
      // Loaded last, and the best match for "o". A one-character query has no
      // bigram, so a prefilter built on bigrams cannot rank it above the crowd:
      // it survives only if short queries skip the prefilter entirely.
      { pk: 999, ZFIRSTNAME: "Oz", ZEXTERNALUUID: "u-oz" },
    ],
  },
];

const CROWD_INDEX = buildContactIndex(loadFrom(CROWD_STORES));

test("a one-character query is scored against the whole index, not the first candidates", () => {
  assert.equal(CROWD_INDEX.length, 62);

  const hits = matchText(CROWD_INDEX, "o");
  assert.equal(hits[0].entry.contact.name, "Oz", "the best match must not be cut before scoring");
  assert.ok(hits[0].score > hits[1].score);
});

test("the candidate prefilter does not cap how many matches a large limit returns", () => {
  // 61 contacts match "Oscar Filler" well above the floor, so a limit of 100
  // must return all of them — the 60-candidate prefilter is a speed knob.
  const result = findContacts(CROWD_INDEX, "Oscar Filler", { limit: 100 });
  assert.ok(result.count >= 61, `expected >= 61 matches, got ${result.count}`);
  assert.equal(result.count, result.matches.length);

  // The default limit still only pays for the default candidate set.
  assert.equal(findContacts(CROWD_INDEX, "Oscar Filler").count, 10);
});

// --- Similarity primitives ---

test("fold normalizes case, diacritics, punctuation and whitespace", () => {
  assert.equal(fold("  O'Néil-Smith\tJr. "), "o neil smith jr");
  assert.equal(fold("Fred   Yang"), "fred yang");
  assert.equal(fold("!!!"), "");
  assert.equal(fold(null), "");
  assert.equal(fold(undefined), "");
});

test("tokens and ngrams decompose a folded string", () => {
  assert.deepEqual(tokens("Fred  Yang"), ["fred", "yang"]);
  assert.deepEqual(tokens("###"), []);
  assert.deepEqual([...ngrams("abc")], ["ab", "bc"]);
  // Spaces are dropped before gramming, so word boundaries do not split grams.
  assert.deepEqual([...ngrams("ab c")], ["ab", "bc"]);
  // A string shorter than the gram width contributes itself.
  assert.deepEqual([...ngrams("a")], ["a"]);
  assert.deepEqual([...ngrams("")], []);
});

test("levenshtein and its similarity behave on the classic pair", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("same", "same"), 0);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshteinSimilarity("same", "same"), 1);
  assert.equal(levenshteinSimilarity("abc", "abd"), 1 - 1 / 3);
  // Nothing to compare is not a match.
  assert.equal(levenshteinSimilarity("", ""), 0);
});

test("jaro and jaroWinkler score transpositions and shared prefixes", () => {
  assert.ok(Math.abs(jaro("martha", "marhta") - 0.9444444) < 1e-6);
  // The prefix bonus lifts it; the plain Jaro score does not move.
  assert.ok(Math.abs(jaroWinkler("martha", "marhta") - 0.9611111) < 1e-6);
  assert.equal(jaroWinkler("same", "same"), 1);
  assert.equal(jaro("abc", ""), 0);
  assert.equal(jaro("abc", "xyz"), 0);
});

test("dice compares character bigrams", () => {
  assert.equal(dice("night", "nacht"), 0.25);
  assert.equal(dice("same", "same"), 1);
  assert.equal(dice("abc", ""), 0);
});

test("tokenSort ignores token order", () => {
  assert.equal(tokenSort("Fred Yang", "Yang Fred"), 1);
  assert.ok(tokenSort("Fred Yang", "Fred Nolan") < 1);
});

test("containment rewards a query contained in the candidate", () => {
  assert.equal(containment("Fred Yang", "Fred Yang"), 1);
  assert.equal(containment("Fred", "Fred Yang"), 0.9);
  // Half the query's tokens appear, so half of the 0.8 partial credit.
  assert.equal(containment("Fred Nolan", "Fred Yang"), 0.4);
  assert.equal(containment("", "Fred Yang"), 0);
  assert.equal(containment("Fred", ""), 0);
});

test("phone digits and shared suffixes are computed on digits alone", () => {
  assert.equal(phoneDigits("+1 (551) 261-3888"), "15512613888");
  assert.equal(phoneDigits(null), "");
  assert.equal(sharedSuffixLength("15512613888", "5512613888"), 10);
  assert.equal(sharedSuffixLength("3888", "16283888"), 4);
  assert.equal(sharedSuffixLength("1234", "5678"), 0);
});

test("canonicalizeEmail strips plus-tags always and dots only for Google", () => {
  const gmail = canonicalizeEmail("A.B+tag@Gmail.com");
  assert.equal(gmail.local, "ab");
  assert.equal(gmail.domain, "gmail.com");
  assert.equal(gmail.canonical, "ab@gmail.com");

  const other = canonicalizeEmail("D.Cole+x@Example.com");
  assert.equal(other.local, "d.cole");
  assert.equal(other.canonical, "d.cole@example.com");
  // The dotless form exists for cross-domain comparison only.
  assert.equal(other.localDotless, "dcole");

  const malformed = canonicalizeEmail("notanemail");
  assert.equal(malformed.domain, "");
  assert.equal(malformed.canonical, "notanemail");
});

// --- Store discovery and the readiness probe ---

test("storePaths lists only directories holding an AddressBook file", () => {
  withSourcesDir(SEARCH_STORES, (dir) => {
    mkdirSync(join(dir, "empty-source"), { recursive: true });
    const found = storePaths(dir);
    assert.deepEqual(
      found.map((store) => store.source),
      ["search-primary"],
    );
  });
  assert.deepEqual(storePaths(join(tmpdir(), "outreach-contacts-does-not-exist")), []);
});

test("checkContactsAccess reports readable stores", () => {
  withSourcesDir(SEARCH_STORES, (dir) => {
    const report = checkContactsAccess({ sourcesDir: dir });
    assert.equal(report.ok, true);
    assert.equal(report.stores, 1);
    assert.equal(report.contacts, 9);
    assert.equal(report.hint, undefined);
  });
});

test("checkContactsAccess explains an empty sources directory", () => {
  withSourcesDir([], (dir) => {
    const report = checkContactsAccess({ sourcesDir: dir });
    assert.equal(report.ok, false);
    assert.equal(report.stores, 0);
    assert.equal(report.contacts, 0);
    assert.ok(report.hint.includes(dir));
    assert.match(report.hint, /Full Disk Access/);
  });
});

test("checkContactsAccess reports an unreadable store rather than throwing", () => {
  withSourcesDir([], (dir) => {
    createDamagedStore(dir, "broken-source");
    const report = checkContactsAccess({ sourcesDir: dir });
    assert.equal(report.ok, false);
    assert.equal(report.stores, 1);
    assert.ok(report.hint.length > 0);
    // A truncated or corrupt file is damage, not a denied permission: sending
    // the operator to System Settings to grant access they already have is a
    // worse answer than saying what actually happened.
    assert.doesNotMatch(report.hint, /Full Disk Access/);
    assert.match(report.hint, /not a readable Contacts database/);
    assert.match(report.hint, /broken-source/);
  });
});

test("one damaged store does not take the readable ones down with it", () => {
  withSourcesDir(SEARCH_STORES, (dir, stores) => {
    const damaged = createDamagedStore(dir, "broken-source");
    const unreadable = [];
    const contacts = loadContacts({
      stores: [...stores, damaged],
      includeNotes: false,
      unreadable,
    });

    // readStore is already per-store tolerant of a missing entity, table and
    // columns; a store that throws at query time is the same class of problem.
    assert.equal(contacts.length, 9);
    assert.deepEqual(
      unreadable.map((failure) => failure.source),
      ["broken-source"],
    );
    assert.equal(unreadable[0].permission, false);
    assert.doesNotMatch(unreadable[0].message, /Full Disk Access/);
  });
});

test("checkContactsAccess counts what it could read when one store is damaged", () => {
  withSourcesDir(SEARCH_STORES, (dir) => {
    createDamagedStore(dir, "broken-source");
    const report = checkContactsAccess({ sourcesDir: dir });
    assert.equal(report.ok, false);
    assert.equal(report.stores, 2);
    // Not 0: nine contacts were readable and reporting none of them hides
    // which half of the address book is actually missing.
    assert.equal(report.contacts, 9);
    assert.match(report.hint, /broken-source/);
    assert.doesNotMatch(report.hint, /Full Disk Access/);
  });
});

test("the legacy top-level store is read, and ranks behind the per-account sources", () => {
  withSourcesDir(SEARCH_STORES, (dir) => {
    createTopLevelStore(dirname(dir), {
      records: [
        { pk: 1, ZFIRSTNAME: "Legacy", ZLASTNAME: "Only", ZEXTERNALUUID: "u-legacy" },
        // The same person the live source holds, with a stale organization.
        {
          pk: 2,
          ZFIRSTNAME: "Fred",
          ZLASTNAME: "Yang",
          ZORGANIZATION: "Stale Labs",
          ZEXTERNALUUID: "u-fred",
        },
      ],
      phones: [{ owner: 1, number: "+1 (312) 555-1234", label: "_$!<Mobile>!$_" }],
    });

    // Listed last, so the live per-account stores win every conflicting field.
    assert.deepEqual(
      storePaths(dir).map((store) => store.source),
      ["search-primary", "top-level"],
    );

    const contacts = loadContacts({ stores: storePaths(dir), includeNotes: false });
    const found = byName(contacts);
    assert.equal(contacts.length, 10);
    assert.deepEqual(found.get("Legacy Only").phones, [
      { number: "+13125551234", label: "mobile", extension: null },
    ]);
    assert.equal(found.get("Fred Yang").organization, "Outreach Labs");
  });
});

// --- The `contacts find` command ---

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function runFind(sourcesDir, args) {
  return spawnSync(process.execPath, [CLI_PATH, "contacts", "find", ...args], {
    encoding: "utf8",
    env: { ...process.env, OUTREACH_CONTACTS_SOURCES_DIR: sourcesDir },
  });
}

const CLI_STORES = [
  {
    source: "cli-store",
    records: [
      {
        pk: 1,
        ZFIRSTNAME: "Ashley",
        ZLASTNAME: "Parker",
        ZORGANIZATION: "Insulation Expert",
        ZEXTERNALUUID: "u-ashley",
      },
      { pk: 2, ZFIRSTNAME: "Dana", ZLASTNAME: "Cole", ZEXTERNALUUID: "u-dana" },
    ],
    phones: [
      { owner: 1, number: "+1 (551) 261-3888", label: "_$!<Mobile>!$_" },
      // Same number twice on one record, and one with no label at all.
      { owner: 1, number: "551-261-3888", label: "_$!<Mobile>!$_" },
      { owner: 2, number: "(415) 555-0143", label: null },
    ],
    notes: [{ owner: 1, text: "Met at the Marin trade show" }],
  },
];

test("contacts find emits one JSON object on stdout and omits empty fields", () => {
  withSourcesDir(CLI_STORES, (dir) => {
    const run = runFind(dir, ["--query", "Ashley", "--limit", "1"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");

    const payload = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(payload), ["query", "count", "matches"]);
    assert.equal(payload.query, "Ashley");
    assert.equal(payload.count, 1);

    const match = payload.matches[0];
    // No job_title, no emails, no score/matched_on without --verbose.
    assert.deepEqual(Object.keys(match), ["name", "organization", "phones", "confidence"]);
    assert.equal(match.name, "Ashley Parker");
    assert.equal(match.confidence, "high");
    // Duplicated rows on one record are still emitted once.
    assert.deepEqual(match.phones, [{ number: "+15512613888", label: "mobile" }]);

    // An unlabeled number carries no label key at all.
    const dana = JSON.parse(runFind(dir, ["--query", "Dana Cole", "--limit", "1"]).stdout)
      .matches[0];
    assert.equal(dana.name, "Dana Cole");
    assert.deepEqual(Object.keys(dana), ["name", "phones", "confidence"]);
    assert.deepEqual(dana.phones, [{ number: "+14155550143" }]);
  });
});

test("contacts find --verbose adds the scoring evidence and the note", () => {
  withSourcesDir(CLI_STORES, (dir) => {
    const run = runFind(dir, ["--query", "Ashley", "--limit", "1", "--verbose"]);
    assert.equal(run.status, 0, run.stderr);

    const payload = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(payload), ["query", "count", "kind", "route", "matches"]);
    assert.equal(payload.kind, "text");
    assert.equal(payload.route, "text");

    const match = payload.matches[0];
    assert.ok(typeof match.score === "number");
    assert.ok(Array.isArray(match.matched_on));
    assert.equal(match.note, "Met at the Marin trade show");
  });
});

test("contacts find reports zero matches as an ordinary result", () => {
  withSourcesDir(CLI_STORES, (dir) => {
    for (const query of ["zzzqqxk", "", "   "]) {
      const run = runFind(dir, ["--query", query]);
      assert.equal(run.status, 0, query);
      assert.equal(run.stderr, "", query);
      const payload = JSON.parse(run.stdout);
      assert.equal(payload.count, 0, query);
      assert.deepEqual(payload.matches, [], query);
    }
  });
});

test("contacts find rejects a missing query and a bad limit as INPUT_ERROR", () => {
  withSourcesDir(CLI_STORES, (dir) => {
    const missing = runFind(dir, []);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.deepEqual(JSON.parse(missing.stderr), {
      error: 1,
      message: "--query is required",
    });

    for (const limit of ["0", "-3", "abc"]) {
      const run = runFind(dir, ["--query", "Ashley", "--limit", limit]);
      assert.equal(run.status, 1, limit);
      assert.equal(run.stdout, "", limit);
      assert.equal(JSON.parse(run.stderr).error, 1, limit);
    }
  });
});

test("contacts find emits an extension only when the stored number has one", () => {
  withSourcesDir(
    [
      {
        source: "ext-store",
        records: [
          { pk: 1, ZFIRSTNAME: "Ext", ZLASTNAME: "Person", ZEXTERNALUUID: "u-ext" },
          { pk: 2, ZFIRSTNAME: "Plain", ZLASTNAME: "Person", ZEXTERNALUUID: "u-plain" },
        ],
        phones: [
          { owner: 1, number: "(201) 820-1234 ext. 56", label: "_$!<Work>!$_" },
          { owner: 2, number: "(415) 555-0143", label: null },
        ],
      },
    ],
    (dir) => {
      const ext = JSON.parse(runFind(dir, ["--query", "Ext Person", "--limit", "1"]).stdout);
      assert.deepEqual(ext.matches[0].phones, [
        { number: "+12018201234", label: "work", extension: "56" },
      ]);

      const plain = JSON.parse(runFind(dir, ["--query", "Plain Person", "--limit", "1"]).stdout);
      assert.deepEqual(plain.matches[0].phones, [{ number: "+14155550143" }]);
    },
  );
});

test("contacts find answers from the readable stores and names the one it skipped", () => {
  withSourcesDir(CLI_STORES, (dir) => {
    createDamagedStore(dir, "broken-source");
    const run = runFind(dir, ["--query", "Ashley", "--limit", "1"]);

    // One damaged source used to abort the whole lookup with an INFRA_ERROR.
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.matches[0].name, "Ashley Parker");
    // A partial answer has to say that it is partial.
    assert.deepEqual(
      payload.unreadable_sources.map((store) => store.source),
      ["broken-source"],
    );
    assert.doesNotMatch(payload.unreadable_sources[0].message, /Full Disk Access/);
  });
});

test("a result larger than the pipe buffer reaches a piped caller intact", () => {
  // `outputJson()` followed by `process.exit()` does not wait for an async
  // stdout write to drain: piped output stopped at exactly one 64KB buffer,
  // mid-string, and still exited 0 — a caller had no signal the JSON it just
  // failed to parse was truncated rather than malformed.
  const filler = "Organization Number ".repeat(20);
  withSourcesDir(
    [
      {
        source: "big-store",
        records: Array.from({ length: 300 }, (_, i) => ({
          pk: i + 1,
          ZFIRSTNAME: `Person${i}`,
          ZLASTNAME: "Filler",
          ZORGANIZATION: `${filler}${i}`,
          ZEXTERNALUUID: `u-big-${i}`,
        })),
      },
    ],
    (dir) => {
      // spawnSync gives the child a pipe, which is the failing case.
      const run = runFind(dir, [
        "--verbose",
        "--limit",
        "300",
        "--query",
        "Organization Number",
      ]);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.stdout.length > 65536, `expected > 64KB, got ${run.stdout.length}`);

      const payload = JSON.parse(run.stdout);
      assert.equal(payload.count, 300);
      assert.equal(payload.matches.length, 300);
    },
  );
});

test("contacts find reports missing stores as INFRA_ERROR with a Full Disk Access hint", () => {
  withSourcesDir([], (dir) => {
    const run = runFind(dir, ["--query", "Ashley"]);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    const error = JSON.parse(run.stderr);
    assert.equal(error.error, 2);
    assert.match(error.message, /Full Disk Access/);
  });
});

test("contacts find reports an unreadable store as INFRA_ERROR", () => {
  withSourcesDir([], (dir) => {
    createDamagedStore(dir, "broken-source");
    const run = runFind(dir, ["--query", "Ashley"]);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    assert.equal(JSON.parse(run.stderr).error, 2);
  });
});


// --- Store discovery is schema-generation tolerant ---

test("a store at a newer schema generation is still discovered", () => {
  const root = mkdtempSync(join(tmpdir(), "outreach-contacts-test-"));
  const sourcesDir = join(root, "Sources");
  mkdirSync(sourcesDir, { recursive: true });
  try {
    // Only a v23 store exists: hardcoding "AddressBook-v22.abcddb" would make a
    // populated address book look empty.
    createStoreAtVersion(sourcesDir, "future", 23, {
      source: "future",
      records: [
        { pk: 1, ZFIRSTNAME: "Nova", ZLASTNAME: "Vega", ZEXTERNALUUID: "u-nova" },
      ],
    });

    const stores = storePaths(sourcesDir);
    assert.equal(stores.length, 1);
    assert.match(stores[0].path, /AddressBook-v23\.abcddb$/);

    const contacts = loadContacts({ stores });
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, "Nova Vega");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("when two generations sit side by side the newest one wins", () => {
  const root = mkdtempSync(join(tmpdir(), "outreach-contacts-test-"));
  const sourcesDir = join(root, "Sources");
  mkdirSync(sourcesDir, { recursive: true });
  try {
    // A migrated account can leave the old store behind. Reading both would
    // double every contact that was migrated.
    createStoreAtVersion(sourcesDir, "migrated", 22, {
      source: "migrated",
      records: [
        { pk: 1, ZFIRSTNAME: "Stale", ZLASTNAME: "Copy", ZEXTERNALUUID: "u-stale" },
      ],
    });
    createStoreAtVersion(sourcesDir, "migrated", 23, {
      source: "migrated",
      records: [
        { pk: 1, ZFIRSTNAME: "Fresh", ZLASTNAME: "Copy", ZEXTERNALUUID: "u-fresh" },
      ],
    });

    const stores = storePaths(sourcesDir);
    assert.equal(stores.length, 1, "one store per source directory, not one per generation");
    assert.match(stores[0].path, /AddressBook-v23\.abcddb$/);

    const names = loadContacts({ stores }).map((contact) => contact.name);
    assert.deepEqual(names, ["Fresh Copy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that only resembles a store filename is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "outreach-contacts-test-"));
  const sourcesDir = join(root, "Sources");
  const dir = join(sourcesDir, "noise");
  mkdirSync(dir, { recursive: true });
  try {
    // The -shm/-wal sidecars and backups live beside the store; matching them
    // would open a non-database as a database.
    for (const name of [
      "AddressBook-v22.abcddb-wal",
      "AddressBook-v22.abcddb-shm",
      "AddressBook-v22.abcddb.backup",
      "AddressBook.abcddb",
      "AddressBook-vX.abcddb",
    ]) {
      writeFileSync(join(dir, name), "not a database");
    }

    assert.deepEqual(storePaths(sourcesDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
