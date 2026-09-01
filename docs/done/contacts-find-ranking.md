# Contacts Find — Ranking and Matching Reference

Shipped in v4.8.0 ([#122](https://github.com/fyang0507/outreach-cli/issues/122),
[#123](https://github.com/fyang0507/outreach-cli/pull/123)).

`outreach contacts find` resolves a name, organization, phone number or email
address against the Mac's own Contacts. This is the rationale behind its
matching behavior — the reasoning a future change needs so it does not quietly
undo a tuned decision. `AGENTS.md` carries the command surface and output
contract; this file carries the *why*.

Implementation: `src/providers/contacts/`. Tests: `tests/unit/contacts.test.mjs`.

## How the design was chosen

The voter set and aggregation are **measured, not assumed**. The evaluation
built 1412 labeled cases by perturbing every contact in a real address book —
typo, dropped character, swapped first/last, partial name, case change, phone
suffixes, email variants — and scored each candidate design on whether the
known-correct contact ranked first.

| Design | top-1 | Verdict |
|---|---|---|
| Score averaging (four voters, plain mean) | ~96% | **Shipped** |
| Rank fusion — RRF | 85.5% | Rejected |
| Rank fusion — vote counting (`value_counts`) | 85.0% | Rejected |
| Max-of-scores | 76.8% | Rejected |

Rank fusion loses because it discards score magnitude, which is exactly the
signal separating a strong match from a mediocre one; on a real query it
produced a flat three-way tie between the right answer and two wrong ones.

Also evaluated and rejected:

- **Ablation showed no algorithm is load-bearing** — leave-one-out moved top-1
  by at most 0.4pp. Four voters match eight at half the cost, so the ensemble
  was cut from nine to four.
- **MT metrics (chrF, TER)** are sentence-level and misbehave on short strings:
  TER scores a typo case 0.00 because word-level edits are brittle, and chrF
  scores `Smith`/`Smyth` 0.26 because high-order n-grams are too sparse on
  names. Neither improved the ensemble; both added ~50% latency. (BLEU is
  n-gram precision, not edit distance — roughly what the Dice voter already
  does.)
- **Phonetic algorithms** (Soundex, Metaphone) are Latin-only and contribute
  nothing to the ~50% of a bilingual address book that is CJK. Worth +0.1pp
  when present.
- **Trimmed mean** beat plain mean at ~10 voters but loses at four, where
  trimming discards half the signal. It cost 4pp on typo queries.

Measured result: **~97% top-1, 99.6% top-3, ~1.2ms/query** at 2000 contacts.

CJK is handled by the Dice-bigram and containment voters, which do not depend
on whitespace tokenization. Known gap: no pinyin romanization, so a romanized
query will not find a hanzi-stored name.

## Text route

- The text score is the plain (untrimmed) mean of exactly four voters — Jaro-Winkler, token-sort, Dice over character bigrams, and substring containment — each taken as the contact's best searchable atom under that voter. The voter set and the aggregation are measured, not incidental; `tests/unit/contacts.test.mjs` recomputes a real score from the primitives so a swapped voter or a trimmed mean fails the suite.
- Text matches below `MIN_TEXT_SCORE` (0.25) are not reported at all. Jaro-Winkler is non-zero for essentially any pair of non-empty strings, so without a floor a nonsense query fills the whole `--limit` with ~0.1-scored noise instead of answering "no". Measured on a real book, nonsense tops out around 0.16 while a typo'd real query scores ~0.67.
- The 60-candidate bigram prefilter is a speed knob, never a result cap: `findContacts` raises it to at least the caller's `limit`, and a query too short to have a bigram (one character) skips it entirely rather than falling back to load order.

## Confidence

`confidence` is the field agents act on, and `skills/outreach/contacts.md`
tells them `high` is safe to use directly. That makes it a correctness
surface, not a display hint.

- `confidence` is `high` for text scores >= 0.5, for an exact or local-part-equal email, and for a phone query that is both fully covered by a stored number's tail *and* at least seven digits long. A bare last-four is always `low`: plenty of unrelated numbers end in the same four digits, so covering the whole query proves nothing there.
- On `text_fallback`, a hit whose evidence is *only* the field the structured route just rejected is capped at `low` (`capFallbackConfidence`). The phone route is exact — a number either shares a subscriber tail or it does not — but the text fallback then scores the query's digits against the phone atoms as characters, so one mistyped digit used to return a *different* contact's number at `high`, the value the skill doc calls safe to dial directly, while the same query fully covered by a stored number correctly returned `low`. Only same-field evidence is capped: a fallback that matched the contact's name (`ashley.parker@nowhere.example`, or `90210` inside an organization name) is a legitimate `high`. The score is left alone; this is a confidence rule, not a second floor.

## Phone and email routes

- A stored number's trailing extension (`(201) 820-1234 ext. 56`, `x56`, `, 56`) is split off before `normalizePhone` and reported as a separate `extension` field. Folding it into the digits produced `+201820123456` — not the contact's number, valid-looking as an Egyptian one, and a tail the phone route could never match. Two extensions behind one main number are two endpoints, so the per-record phone union keys on number *and* extension.
- The email substring tier needs a local part of at least three characters and scores by how much of the stored local the query covered. `a@nowhere.example` used to return every contact with an "a" in its address at a flat 0.7 — a field of exact ties is not the rank the output contract promises, and it hid the text fallback that answers better.
- The email route compares dot-insensitive local parts whenever the two domains differ, because dot handling is a per-provider rule: a stored `charles.devore@gmail.com` canonicalizes to a dotless local, and without this the correctly-spelled `charles.devore@newcompany.example` would miss while the misspelled `charlesdevore@…` hit. Within one domain the canonical local still rules, so `dcole@example.com` stays a different mailbox from `d.cole@example.com`.

## Store reading and dedup

- Duplicate phone/email rows are unioned per record, not only across stores — a single AddressBook record really can hold the same number twice.
- Records with no `ZEXTERNALUUID` fall back to a `name|organization` dedupe key, but two rows sharing that key *inside one store* stay two contacts. Cross-store it is the stale mirror the key exists to fold; within a store it is two cards in the user's own Contacts.app, and merging them hands back one contact carrying two strangers' phone numbers.
- One unreadable store is skipped, not fatal: `loadContacts` collects it into `options.unreadable`, `contacts find` reports it as `unreadable_sources`, and `health` reports the contacts it *could* read rather than 0. Only losing every store throws. The Full Disk Access hint is attached to permission errors alone (`EPERM`/`EACCES`/`SQLITE_CANTOPEN`); a corrupt or truncated store says so instead, rather than sending the operator to grant a permission they already have.
- The legacy top-level `AddressBook-v22.abcddb` is read last, after the per-account sources, so live data wins every conflicting field. It holds 0 `ABCDContact` rows on this machine while its own `Z_PRIMARYKEY` high-water mark records 7797 historical `ABCDRecord`s — it was the primary before the move to `Sources/`, and a machine that never migrated would otherwise be indistinguishable from an empty address book.

## The four schema traps

`AddressBook-v22` is an undocumented private schema, and the per-account stores
disagree with each other. Each of these is a silent bug if missed, and each has
a fixture-based regression in `tests/unit/contacts.test.mjs`:

1. **`Z_ENT` for `ABCDContact` is per-store** — 22 in one store on the
   development machine, 21 in another. It is resolved from `Z_PRIMARYKEY`,
   never hardcoded. Hardcoding returns a different entity from the wrong store.
2. **Column sets differ per store** — `ZEXTERNALIDENTIFIER` exists in one and
   not another, so the SELECT list is intersected with `PRAGMA table_info`
   rather than fixed. A fixed list throws `no such column`.
3. **Entity filtering is mandatory** — one source holds 1618 `ABCDInfo` rows
   and a single real contact.
4. **Cross-store dedup on `ZEXTERNALUUID`** — verified 79/79 overlap between
   the two overlapping stores. One store is a stale mirror last written years
   earlier; without dedup roughly half the result set comes back doubled.

Store discovery matches `AddressBook-v<N>.abcddb` and takes the highest N, so a
future schema-generation bump does not make a populated Mac look like an empty
address book. The sidecars (`-wal`, `-shm`) and backups do not match.

Reading requires Full Disk Access — the same grant `sms history` already needs
for `chat.db`. It does **not** require the Contacts (`kTCCServiceAddressBook`)
permission, so the feature costs no new consent prompt.
